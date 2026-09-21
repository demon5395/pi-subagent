/**
 * API 路由处理器。
 *
 * 所有处理器签名统一为 (ctx, req, res) => Promise<void>，
 * 由 server.ts 的路由分发器调用。
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as os from "node:os";
import type * as http from "node:http";
import type { ServerContext } from "./server.js";
import type { AgentConfig } from "../agents.js";
import { getFinalOutput } from "../core.js";
import { loadStats, getStatsSummary, type StatsPeriod } from "../stats";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "public");

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
};

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function getMimeType(ext: string): string {
	return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * 检查请求路径是否在 PUBLIC_DIR 内，防止路径穿越攻击。
 */
function isPathSafe(requestedPath: string): boolean {
	const resolved = path.resolve(PUBLIC_DIR, requestedPath);
	return resolved.startsWith(PUBLIC_DIR);
}

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * 读取请求体内容（含大小限制防止 OOM）。
 */
function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let totalSize = 0;
		req.on("data", (chunk: Buffer) => {
			totalSize += chunk.length;
			if (totalSize > MAX_BODY_SIZE) {
				req.destroy(new Error("Request body too large"));
				reject(new Error(`Request body exceeds ${MAX_BODY_SIZE / 1024 / 1024}MB limit`));
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

// getFinalText 已废弃，使用从 core.js 导入的 getFinalOutput

/**
 * 从 URL 中提取查询参数 cwd，兜底使用 process.cwd()。
 */
function getCwd(req: http.IncomingMessage): string {
	const urlObj = new URL(
		req.url ?? "/",
		`http://${req.headers.host ?? "localhost"}`,
	);
	return urlObj.searchParams.get("cwd") ?? process.cwd();
}

// ---------------------------------------------------------------------------
// 静态文件处理
// ---------------------------------------------------------------------------

/**
 * 从 web/public/ 目录提供静态文件。
 *
 * - `/` → 自动寻找 index.html
 * - `/static/xxx` → 提供 public/xxx
 *
 * 包含路径安全检查，防止目录穿越。
 */
export async function handleStatic(
	_req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const urlObj = new URL(
		_req.url ?? "/",
		`http://${_req.headers.host ?? "localhost"}`,
	);
	let filePath = urlObj.pathname;

	// 去除 /static/ 前缀
	if (filePath.startsWith("/static/")) {
		filePath = filePath.slice("/static/".length);
	}

	// 根路径默认 index.html
	if (filePath === "/" || filePath === "") {
		filePath = "index.html";
	}

	// 去除前导 /
	const cleanPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;

	// 路径安全检查
	if (!isPathSafe(cleanPath)) {
		res.writeHead(403, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Forbidden: path traversal detected" }));
		return;
	}

	const fullPath = path.resolve(PUBLIC_DIR, cleanPath);

	try {
		await fs.access(fullPath);

		const stat = await fs.stat(fullPath);
		if (!stat.isFile()) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Not a file" }));
			return;
		}

		const ext = path.extname(fullPath).toLowerCase();
		const contentType = getMimeType(ext);
		const content = await fs.readFile(fullPath);
		res.writeHead(200, { "Content-Type": contentType });
		res.end(content);
	} catch (err: any) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "File not found" }));
		} else {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Internal server error" }));
		}
	}
}

// ---------------------------------------------------------------------------
// API: GET /api/agents
// ---------------------------------------------------------------------------

/**
 * 返回可用 agent 列表。
 * 查询参数：
 *   scope — "global" | "project" | "both"（默认 "global"）
 *   cwd   — 工作目录（默认 process.cwd()）
 *
 * 返回 JSON：{ agents: AgentConfig[], count: number }
 */
export async function handleApiAgents(
	ctx: ServerContext,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const urlObj = new URL(
		req.url ?? "/",
		`http://${req.headers.host ?? "localhost"}`,
	);
	const scope = urlObj.searchParams.get("scope") ?? "global";
	const cwd = getCwd(req);

	try {
		const result = ctx.discoverAgents(cwd, scope);
		// 标记预装 agent 以及是否被修改
		const agentsWithFlag = result.agents.map((a: AgentConfig) => {
			const preinstalledPath = path.join(PREINSTALLED_AGENTS_DIR, `${a.name}.md`);
			const isPreinstalled = fsSync.existsSync(preinstalledPath);
			let isModified = false;
			if (isPreinstalled && a.filePath) {
				try {
					const originalContent = fsSync.readFileSync(preinstalledPath, "utf-8");
					const currentContent = fsSync.readFileSync(a.filePath, "utf-8");
					isModified = originalContent !== currentContent;
				} catch {
					// 读取出错时不标记
				}
			}
			return { ...a, preinstalled: isPreinstalled, modified: isModified };
		});
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({ agents: agentsWithFlag, count: agentsWithFlag.length }),
		);
	} catch (err: any) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: err.message }));
	}
}

// ---------------------------------------------------------------------------
// API: POST /api/agents
// ---------------------------------------------------------------------------

/**
 * 创建新 agent — 在用户 agent 目录生成 .md 文件。
 * 请求体：{ name, description, tools?, provider?, model?, systemPrompt? }
 * 返回 JSON：{ success: true, filePath: string }
 */
export async function handleApiAgentCreate(
	_ctx: ServerContext,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	try {
		const body = await readBody(req);
		let data: any;
		try {
			data = JSON.parse(body);
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Invalid JSON body" }));
			return;
		}

		if (!data.name || !data.name.trim()) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Missing required field: name" }));
			return;
		}

		const agentName = data.name.trim();
		const userDir = path.join(os.homedir(), ".pi", "agent", "agents");

		// 确保目录存在
		try {
			await fs.mkdir(userDir, { recursive: true });
		} catch {}

		const filePath = path.join(userDir, `${agentName}.md`);

		// 检查是否已存在同名 agent
		try {
			await fs.access(filePath);
			res.writeHead(409, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: `Agent "${agentName}" already exists` }));
			return;
		} catch {
			// 文件不存在，继续
		}

		// 构建 frontmatter
		const fields: string[] = [];
		fields.push(`name: ${agentName}`);
		fields.push(`description: ${data.description || "Custom agent"}`);
		if (data.tools) {
			const tools = Array.isArray(data.tools) ? data.tools.join(", ") : String(data.tools);
			fields.push(`tools: ${tools}`);
		}
		if (data.provider) fields.push(`provider: ${data.provider}`);
		if (data.model) fields.push(`model: ${data.model}`);
		if (data.suggestedModel) fields.push(`suggested-model: ${data.suggestedModel}`);

		const systemPrompt = data.systemPrompt || `你是 ${agentName}，一个自定义 agent。请根据任务需求调整行为。`;
		const content = `---\n${fields.join("\n")}\n---\n\n${systemPrompt.trim()}\n`;

		try {
			await fs.writeFile(filePath, content, "utf-8");
		} catch (err: any) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: `Failed to create agent: ${err.message}` }));
			return;
		}

		res.writeHead(201, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ success: true, filePath }));
	} catch (err: any) {
		const errorMsg = err?.message ?? String(err ?? "Unknown error");
		process.stderr.write(`[pi-subagent] handleApiAgentCreate error: ${errorMsg}\n${err instanceof Error ? err.stack : ""}\n`);
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: errorMsg }));
	}
}

// ---------------------------------------------------------------------------
// API: POST /api/agents/generate
// ---------------------------------------------------------------------------

/**
 * AI 辅助生成 agent 配置。
 * 请求体：{ description: string }
 * 返回 JSON：{ name, description, tools, provider, model, systemPrompt }
 */
export async function handleApiAgentGenerate(
	ctx: ServerContext,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	try {
		const body = await readBody(req);
		let description: string;
		try {
			const parsed = JSON.parse(body);
			description = parsed.description;
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Invalid JSON body" }));
			return;
		}

		if (!description || typeof description !== "string") {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Missing required field: description" }));
			return;
		}

		const cwd = getCwd(req);
		const agentsResult = ctx.discoverAgents(cwd, "both");
		const toolList = agentsResult.agents
			.flatMap((a: AgentConfig) => a.tools || [])
			.filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
			.sort();

		const systemPrompt = `你是一个 Agent 配置生成器。根据用户的需求描述，生成一个最合适的 Agent 配置。

可用工具：${toolList.join(", ") || "read, bash, write, edit, grep, find, ls"}

你的输出必须是 JSON 格式（不要输出其他内容）：
{
  "name": "简短英文名，如 code-reviewer",
  "description": "简短中文描述，20字以内",
  "tools": ["read", "bash", "write"],
  "systemPrompt": "完整的系统提示词，200-500字，明确职责、行为规范、输出要求",
  "suggestedModel": "建议搭配的模型级别，如 sonnet 级别或 haiku 级别"
}`;

		const generatorAgent: AgentConfig = {
			name: "__agent_generator__",
			description: "Agent config generator",
			systemPrompt,
			tools: [],
		};

		const result = await ctx.runSingleAgent(
			cwd,
			generatorAgent,
			`用户需求：${description}`,
			undefined,
			undefined,
			undefined,
			ctx.defaultProvider,
			ctx.defaultModel,
		);

		const finalOutput = getFinalOutput(result.messages);

		// 健壮的 JSON 提取：依次尝试多种策略
		let parsed: any = null;

		// 策略 1：直接解析整段输出
		try {
			parsed = JSON.parse(finalOutput);
		} catch {}

		// 策略 2：从 markdown 代码块中提取
		if (!parsed) {
			const jsonMatch = finalOutput.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
			if (jsonMatch) {
				try {
					parsed = JSON.parse(jsonMatch[1].trim());
				} catch {}
			}
		}

		// 策略 3：查找第一个 { 到最后一个 } 之间的内容
		if (!parsed) {
			const firstBrace = finalOutput.indexOf("{");
			const lastBrace = finalOutput.lastIndexOf("}");
			if (firstBrace !== -1 && lastBrace > firstBrace) {
				try {
					parsed = JSON.parse(finalOutput.slice(firstBrace, lastBrace + 1));
				} catch {}
			}
		}

		// 策略 4：尝试修复常见 JSON 格式错误（多余逗号、单引号等）
		if (!parsed) {
			const looseMatch = finalOutput.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
			const candidate = looseMatch ? looseMatch[1].trim() : finalOutput;
			const firstBrace = candidate.indexOf("{");
			const lastBrace = candidate.lastIndexOf("}");
			if (firstBrace !== -1 && lastBrace > firstBrace) {
				let fixed = candidate.slice(firstBrace, lastBrace + 1);
				// 去掉多余逗号（数组/对象末尾的逗号）
				fixed = fixed.replace(/,\s*([}\]])/g, "$1");
				try {
					parsed = JSON.parse(fixed);
				} catch {}
			}
		}

		if (!parsed || !parsed.name || !parsed.description || !parsed.systemPrompt) {
			// 输出原始响应到 stderr 方便调试
			process.stderr.write(`[pi-subagent] AI generate raw response (first 500 chars): ${finalOutput.slice(0, 500)}\n`);
			throw new Error("AI 生成的配置格式异常，请重试");
		}

		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(parsed));
	} catch (err: any) {
		const errorMsg = err?.message ?? String(err ?? "Unknown error");
		process.stderr.write(`[pi-subagent] handleApiAgentGenerate error: ${errorMsg}\n${err instanceof Error ? err.stack : ""}\n`);
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: errorMsg }));
	}
}

// ---------------------------------------------------------------------------
// API: DELETE /api/agents/:name
// ---------------------------------------------------------------------------

/**
 * 删除自定义 agent（预装 agent 不允许删除）。
 * 路径：DELETE /api/agents/:name
 * 返回：{ success: true }
 */
export async function handleApiAgentDelete(
	ctx: ServerContext,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const agentName = extractAgentNameFromPath(req.url ?? "");
	if (!agentName) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Missing agent name" }));
		return;
	}

	// 检查是否为预装 agent
	const preinstalledPath = path.join(PREINSTALLED_AGENTS_DIR, `${agentName}.md`);
	try {
		await fs.access(preinstalledPath);
		res.writeHead(403, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Cannot delete pre-installed agent" }));
		return;
	} catch {
		// 非预装，继续
	}

	// 找到 agent 文件路径
	const cwd = getCwd(req);
	const agentsResult = ctx.discoverAgents(cwd, "both");
	const agent = agentsResult.agents.find((a: AgentConfig) => a.name === agentName);

	if (!agent || !agent.filePath) {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: `Agent "${agentName}" not found` }));
		return;
	}

	try {
		await fs.unlink(agent.filePath);
	} catch (err: any) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: `Failed to delete: ${err.message}` }));
		return;
	}

	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ success: true }));
}

// (已移除) API: POST /api/chat — 之前的功能已移除

// ---------------------------------------------------------------------------
// API: GET /api/stats
// ---------------------------------------------------------------------------

/**
 * 服务状态 + Agent 调用统计。
 * 路径：GET /api/stats?period=today|7d|all（默认 all）
 * 返回：{ status: "ok", timestamp, period, agents: StatsSummaryItem[], updatedAt }
 * 保留 status/timestamp 字段，前端状态栏（api.getStats）继续兼容。
 */
export async function handleApiStats(
	ctx: ServerContext,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const raw = url.searchParams.get("period") ?? "all";
	const period: StatsPeriod = raw === "today" || raw === "7d" ? raw : "all";
	const stats = loadStats();
	const body = {
		status: "ok" as const,
		timestamp: Date.now(),
		period,
		agents: getStatsSummary(stats, period),
		updatedAt: stats.updatedAt,
	};
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// API: GET /api/agents/:name/original
// API: POST /api/agents/:name/restore
// ---------------------------------------------------------------------------

/** 预装 agent 目录：包内 agents/ */
const PREINSTALLED_AGENTS_DIR = path.resolve(__dirname, "../../agents");

// ---------------------------------------------------------------------------
// API: GET /api/provider-models
// ---------------------------------------------------------------------------

/**
 * 读取 auth.json 中配置的 provider，返回可用 provider 列表。
 * 每个 provider 的 models 留空，模型可在编辑时手动输入。
 * 返回 JSON：[{ name: string, models: string[] }, ...]
 */
export async function handleApiProviderModels(
	_ctx: ServerContext,
	_req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");

	// 尝试从 pi-ai 内置模型目录读取各 provider 的模型列表
	let builtinProviderModels: Record<string, string[]> = {};
	try {
		const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
		const models = builtinModels();
		for (const provider of models.getProviders()) {
			if (provider.id === "radius") continue; // radius 是内部自动路由，不展示
			const modelList = provider.getModels().map((m: any) => m.id);
			builtinProviderModels[provider.id] = modelList;
		}
	} catch {
		// pi-ai 不可用，回退到空列表
	}

	try {
		const content = await fs.readFile(authPath, "utf-8");
		const auth: Record<string, any> = JSON.parse(content);
		const providers = Object.keys(auth).map((name) => ({
			name,
			models: builtinProviderModels[name] || [],
		}));
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(providers));
	} catch {
		// auth.json 不存在或格式错误，返回空列表
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify([]));
	}
}

// ---------------------------------------------------------------------------
// API: PUT /api/agents/:name
// ---------------------------------------------------------------------------

/**
 * 更新现有 agent 的 .md 文件。
 * 路径：PUT /api/agents/:name
 * 请求体：{ name, description, provider?, model?, tools?, systemPrompt }
 * 返回 JSON：{ success: true, filePath: string }
 */
export async function handleApiAgentSave(
	ctx: ServerContext,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const agentName = extractAgentNameFromPath(req.url ?? "");
	if (!agentName) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Missing agent name" }));
		return;
	}

	let body: string;
	try {
		body = await readBody(req);
	} catch (err: any) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: `Failed to read body: ${err.message}` }));
		return;
	}

	let data: any;
	try {
		data = JSON.parse(body);
	} catch {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Invalid JSON body" }));
		return;
	}

	// 找到 agent 文件路径
	const cwd = getCwd(req);
	const agentsResult = ctx.discoverAgents(cwd, "both");
	const agent = agentsResult.agents.find((a: AgentConfig) => a.name === agentName);

	if (!agent || !agent.filePath) {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: `Agent "${agentName}" not found` }));
		return;
	}

	// 构建 frontmatter
	const fields: string[] = [];
	fields.push(`name: ${data.name || agentName}`);
	fields.push(`description: ${data.description || agent.description || ""}`);
	if (data.tools && Array.isArray(data.tools) && data.tools.length > 0) {
		fields.push(`tools: ${data.tools.join(", ")}`);
	}
	if (data.provider) fields.push(`provider: ${data.provider}`);
	if (data.model) fields.push(`model: ${data.model}`);
	if (data.suggestedModel) fields.push(`suggested-model: ${data.suggestedModel}`);

	const systemPrompt = data.systemPrompt?.trim() || agent.systemPrompt?.trim() || "";
	const content = `---\n${fields.join("\n")}\n---\n\n${systemPrompt}\n`;

	try {
		await fs.writeFile(agent.filePath, content, "utf-8");
	} catch (err: any) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: `Failed to save: ${err.message}` }));
		return;
	}

	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ success: true, filePath: agent.filePath }));
}

/**
 * 获取预装 agent 的原始内容。
 * 路径：GET /api/agents/:name/original
 * 返回：{ exists: boolean, content?: string, frontmatter?: object }
 */
export async function handleApiAgentOriginal(
	_ctx: ServerContext,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const agentName = extractAgentNameFromPath(req.url ?? "");
	if (!agentName) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Missing agent name" }));
		return;
	}

	const filePath = path.join(PREINSTALLED_AGENTS_DIR, `${agentName}.md`);
	try {
		await fs.access(filePath);
		const content = await fs.readFile(filePath, "utf-8");
		// 解析 frontmatter
		const fmMatch = content.match(/---\n([\s\S]*?)\n---\n*([\s\S]*)/);
		const frontmatter: Record<string, string> = {};
		if (fmMatch) {
			for (const line of fmMatch[1].split("\n")) {
				const sep = line.indexOf(": ");
				if (sep > 0) frontmatter[line.slice(0, sep).trim()] = line.slice(sep + 2).trim();
			}
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ exists: true, content, frontmatter }));
	} catch {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ exists: false }));
	}
}

/**
 * 恢复预装 agent 到原始版本。
 * 路径：POST /api/agents/:name/restore
 * 返回：{ success: true }
 */
export async function handleApiAgentRestore(
	ctx: ServerContext,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const agentName = extractAgentNameFromPath(req.url ?? "");
	if (!agentName) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Missing agent name" }));
		return;
	}

	// 读取原始内容
	const srcPath = path.join(PREINSTALLED_AGENTS_DIR, `${agentName}.md`);
	let originalContent: string;
	try {
		originalContent = await fs.readFile(srcPath, "utf-8");
	} catch {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: `No pre-installed agent "${agentName}"` }));
		return;
	}

	// 找到用户文件路径
	const cwd = getCwd(req);
	const agentsResult = ctx.discoverAgents(cwd, "both");
	const agent = agentsResult.agents.find((a: AgentConfig) => a.name === agentName);
	if (!agent || !agent.filePath) {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: `Agent "${agentName}" not found` }));
		return;
	}

	try {
		// 先删除原文件（如果是软链则删除软链本身，不追溯目标），再写入新文件
		// 这样即使被其它程序改成了软链，也能恢复为普通文件
		await fs.rm(agent.filePath, { force: true });
		await fs.writeFile(agent.filePath, originalContent, "utf-8");
	} catch (err: any) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: `Failed to restore: ${err.message}` }));
		return;
	}

	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ success: true }));
}

/** 从 URL 路径中提取 agent name：/api/agents/:name/original → name */
function extractAgentNameFromPath(urlPath: string): string | null {
	const parts = urlPath.split("/");
	// /api/agents/:name/original → index of :name is parts[3]
	if (parts.length >= 4 && parts[1] === "api" && parts[2] === "agents") {
		return parts[3] || null;
	}
	return null;
}
