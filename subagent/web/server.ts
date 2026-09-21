/**
 * HTTP 服务器生命周期管理 + 路由分发 + SSE 推送封装。
 *
 * 基于 Node.js 内置 http 模块，无外部依赖。
 */

import * as http from "node:http";
import type { AgentConfig, AgentScope } from "../agents.js";
import type { SingleResult } from "../core.js";
import {
	handleStatic,
	handleApiAgents,
	handleApiStats,
	handleApiProviderModels,
	handleApiAgentSave,
	handleApiAgentOriginal,
	handleApiAgentRestore,
	handleApiAgentCreate,
	handleApiAgentGenerate,
	handleApiAgentDelete,
} from "./routes-api.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface ServerContext {
	/** Agent 发现函数 */
	discoverAgents: (
		cwd: string,
		scope?: AgentScope,
	) => { agents: AgentConfig[]; projectAgentsDir: string | null };
	/** 单 agent 执行函数 */
	runSingleAgent: (
		defaultCwd: string,
		agent: AgentConfig,
		task: string,
		cwd?: string,
		signal?: AbortSignal,
		onProgress?: (result: Partial<SingleResult>) => void,
		defaultProvider?: string,
		defaultModel?: string,
	) => Promise<SingleResult>;
	/** 父会话默认 provider */
	defaultProvider?: string;
	/** 父会话默认 model */
	defaultModel?: string;
}

// ---------------------------------------------------------------------------
// 模块级状态
//
// globalThis 持久化：pi 扩展热重载时模块变量会重置，
// 但底层 HTTP server 还在运行。通过 globalThis 跨重载保持引用，
// 确保 stopServer() 始终能找到并关闭正在运行的 server。
// ---------------------------------------------------------------------------

const STORAGE_KEY = "__pi_subagent_web_server__";

interface ServerStorage {
	server: http.Server | null;
	port: number | null;
}

function getStorage(): ServerStorage {
	if (!(globalThis as any)[STORAGE_KEY]) {
		(globalThis as any)[STORAGE_KEY] = { server: null, port: null };
	}
	return (globalThis as any)[STORAGE_KEY];
}

let server: http.Server | null = null;
let currentPort: number | null = null;

/** 同步模块变量与 globalThis 存储 */
function syncStorage(): void {
	const st = getStorage();
	st.server = server;
	st.port = currentPort;
}

/** 从 globalThis 恢复 server 引用（用于热重载后找回还在运行的 server） */
function recoverFromStorage(): void {
	const st = getStorage();
	if (st.server && !server) {
		server = st.server;
		currentPort = st.port;
	}
}

// ---------------------------------------------------------------------------
// 生命周期管理
// ---------------------------------------------------------------------------

/**
 * 启动 HTTP 服务器。
 * @param port 监听端口（0 = 随机分配）
 * @param ctx  服务器上下文（提供路由处理所需的方法）
 * @returns resolve 时返回实际绑定的端口号
 */
export function startServer(port: number, ctx: ServerContext): Promise<number> {
	// 热重载后尝试恢复之前的 server 引用
	recoverFromStorage();

	// 如果旧 server 还在运行且端口匹配，直接复用
	if (server?.listening && currentPort === port) {
		return Promise.resolve(currentPort);
	}

	return new Promise((resolve, reject) => {
		const srv = createServer(ctx);
		srv.requestTimeout = 30_000;

		srv.on("error", (err: any) => {
			if (err.code === "EADDRINUSE") {
				// 端口被占用：尝试关闭旧 server，再用随机端口重试
				stopServer().then(() => {
					const fallbackPort = 0;
					const fallback = createServer(ctx);
					fallback.requestTimeout = 30_000;
					fallback.listen(fallbackPort, () => {
						server = fallback;
						const addr = fallback.address();
						currentPort = typeof addr === "object" && addr ? addr.port : 0;
						syncStorage();
						console.log(`[pi-subagent] Port ${port} was in use, fell back to port ${currentPort}`);
						resolve(currentPort);
					});
					fallback.on("error", (fallbackErr: any) => {
						reject(fallbackErr);
					});
				}).catch(reject);
			} else {
				reject(err);
			}
		});

		srv.listen(port, () => {
			server = srv;
			const addr = srv.address();
			currentPort = typeof addr === "object" && addr ? addr.port : port;
			syncStorage();
			resolve(currentPort);
		});
	});
}

/**
 * 停止 HTTP 服务器，等待端口释放后 resolve。
 * 返回 true 表示已关闭，false 表示没有运行的服务器。
 */
export function stopServer(): Promise<boolean> {
	return new Promise((resolve) => {
		// 先尝试从 globalThis 恢复（应对热重载后模块变量丢失的情况）
		recoverFromStorage();

		if (!server) {
			resolve(false);
			return;
		}
		const srv = server;

		// 立即清除所有引用，包括 globalThis
		server = null;
		currentPort = null;
		syncStorage();

		// 关闭所有活跃连接（Node >= 18），让正在响应的请求立即断开
		try { srv.closeAllConnections?.(); } catch {}

		const timeout = setTimeout(() => {
			try { srv.closeAllConnections?.(); } catch {}
			resolve(true);
		}, 2000);

		srv.close(() => {
			clearTimeout(timeout);
			resolve(true);
		});
	});
}

/**
 * 获取服务器当前运行状态。
 */
export function getServerStatus(): { running: boolean; port: number | null } {
	return { running: server !== null, port: currentPort };
}

// ---------------------------------------------------------------------------
// 路由分发
// ---------------------------------------------------------------------------

/**
 * 创建 HTTP 服务器实例（含路由分发）。
 *
 * 路由规则：
 *   GET  /api/agents       → handleApiAgents
 *   GET  /api/stats        → handleApiStats
 *   GET  / | /static/*     → handleStatic
 *   其余                   → 404
 */
export function createServer(ctx: ServerContext): http.Server {
	return http.createServer((req, res) => {
		// ---- CORS ----
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		const url = new URL(
			req.url ?? "/",
			`http://${req.headers.host ?? "localhost"}`,
		);
		const pathname = url.pathname;

		try {
			if (pathname === "/api/provider-models" && req.method === "GET") {
				void handleApiProviderModels(ctx, req, res);
			} else if (pathname === "/api/agents/generate" && req.method === "POST") {
				void handleApiAgentGenerate(ctx, req, res);
			} else if (pathname === "/api/agents" && req.method === "POST") {
				void handleApiAgentCreate(ctx, req, res);
			} else if (pathname === "/api/agents" && req.method === "GET") {
				void handleApiAgents(ctx, req, res);
			} else if (pathname === "/api/stats" && req.method === "GET") {
				void handleApiStats(ctx, req, res);
			} else if (pathname.startsWith("/api/agents/") && req.method === "DELETE") {
				void handleApiAgentDelete(ctx, req, res);
			} else if (pathname.startsWith("/api/agents/") && req.method === "PUT") {
				void handleApiAgentSave(ctx, req, res);
			} else if (pathname.match(/^\/api\/agents\/[^\/]+\/original$/) && req.method === "GET") {
				void handleApiAgentOriginal(ctx, req, res);
			} else if (pathname.match(/^\/api\/agents\/[^\/]+\/restore$/) && req.method === "POST") {
				void handleApiAgentRestore(ctx, req, res);
			} else if (
				pathname === "/" ||
				pathname.startsWith("/static/") ||
				pathname === "/index.html"
			) {
				void handleStatic(req, res);
			} else {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Not found" }));
			}
		} catch (err: any) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: err.message ?? "Internal server error" }));
		}
	});
}

// ---------------------------------------------------------------------------
// SSE 辅助函数
// ---------------------------------------------------------------------------


