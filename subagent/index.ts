/**
 * Subagent (SDK) — Extension Entry Point
 *
 * 通过 SDK 方式（createAgentSession + SessionManager.inMemory）
 * 实现功能完全对等的 subagent 插件。
 *
 * 支持 single / parallel / chain 三种模式，支持实时流式更新和 TUI 渲染。
 */

import * as os from "node:os";
import * as path from "node:path";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme, CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "./agents";
import {
	runSingleAgent,
	runParallelAgents,
	runChainAgents,
	getFinalOutput,
	isFailedResult,
	truncateParallelOutput,
	type SingleResult,
	type UsageStats,
} from "./core";
import { ensureExampleAgents } from "./init-examples";
import { createAccumulator, resolveBudget } from "./budget";
import { recordAgentCall, loadStats, getStatsSummary, formatStatsTable, backfillFromSessions, type StatsPeriod } from "./stats";
import { startServer, stopServer } from "./web/server.js";
import { runtimeRegistry } from "./runtime";
import { RuntimePanelController, openControlOverlay, attachPanelIfUI } from "./panel";
import { resolveProgressText } from "./runtime-events";
import {
	renderAgentList,
	formatAgentSummary,
	formatAgentError,
	buildRosterInjection,
} from "./agent-list";

/** 会话级单例：面板控制器自管理生命周期（列表清空时自行卸载） */
const runtimePanel = new RuntimePanelController(runtimeRegistry);

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const MAX_PARALLEL_TASKS = 8;
const COLLAPSED_ITEM_COUNT = 10;

/** roster 注入：最多列出的 agent 数 */
const ROSTER_MAX_ITEMS = 15;
/** roster 注入：描述截断宽度（可见列宽） */
const ROSTER_DESC_WIDTH = 30;
/** roster 注入：逃生开关，设为 "0"/"false" 关闭 */
const ROSTER_ENV = "PI_SUBAGENT_ROSTER";

// ---------------------------------------------------------------------------
// 参数 Schema
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
	agent: Type.String({ description: "Agent 名称" }),
	task: Type.String({ description: "任务描述" }),
	cwd: Type.Optional(Type.String()),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Agent 名称" }),
	task: Type.String({
		description: "任务描述，支持 {previous} 占位符引用上一步输出",
	}),
	cwd: Type.Optional(Type.String()),
});

const AgentScopeSchema = StringEnum(["global", "project", "both"] as const, {
	description: 'Which agent directories to use. Use "both" to include project-local agents.',
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent 名称（single 模式）" })),
	task: Type.Optional(Type.String({ description: "任务描述（single 模式）" })),
	tasks: Type.Optional(
		Type.Array(TaskItem, { description: "并行任务列表" }),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, { description: "链式步骤列表" }),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "运行项目 agent 前确认。默认 true。",
			default: true,
		}),
	),
	cwd: Type.Optional(
		Type.String({ description: "工作目录（single 模式）" }),
	),
});

// ---------------------------------------------------------------------------
// TUI 渲染辅助函数
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview =
				command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine =
					limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg(
					"warning",
					`:${startLine}${endLine ? `-${endLine}` : ""}`,
				);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text =
				themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return (
				themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath))
			);
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview =
				argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(
	messages: import("@earendil-works/pi-ai").Message[],
): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text")
					items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({
						type: "toolCall",
						name: part.name,
						args: part.arguments,
					});
			}
		}
	}
	return items;
}

function renderDisplayItems(
	items: DisplayItem[],
	expanded: boolean,
	limit: number,
	theme: any,
): string {
	const toShow = expanded ? items : items.slice(-limit);
	const skipped = !expanded && items.length > limit ? items.length - limit : 0;
	let text = "";
	if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
	for (const item of toShow) {
		if (item.type === "text") {
			const preview = expanded
				? item.text
				: item.text.split("\n").slice(0, 3).join("\n");
			text += `${theme.fg("toolOutput", preview)}\n`;
		} else {
			text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
		}
	}
	return text.trimEnd();
}

function aggregateUsage(results: SingleResult[]) {
	const total = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
	};
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

let _toolDefinition: ToolDefinition<any> | undefined;

export function getToolDefinition(): ToolDefinition<any> {
	if (!_toolDefinition) {
		throw new Error("Tool not registered yet");
	}
	return _toolDefinition;
}

export default function (pi: ExtensionAPI) {
	// ---- 首次安装示例 agent 生成（惰性：在 session_start 时执行） ----
	pi.on("session_start", async (_event, ctx) => {
		const userAgentsDir = path.join(getAgentDir(), "agents");
		const created = ensureExampleAgents(userAgentsDir);
		if (created.length > 0) {
			ctx.ui.notify(
				`pi-subagent 已创建示例 agent: ${created.join(", ")}`,
				"info",
			);
		}
	});

	// ---- 自动注入可用 agent roster（模型自发感知自定义 agent，无需 AGENTS.md） ----
	//
	// 每轮 before_agent_start 时重建 system prompt，所以追加不会累积；
	// roster 按 name 显式排序，集合不变时字节稳定 → 前缀缓存不受影响。
	pi.on("before_agent_start", async (event, ctx) => {
		const flag = process.env[ROSTER_ENV];
		const roster = buildRosterInjection(
			{
				systemPrompt: event.systemPrompt,
				selectedTools: event.systemPromptOptions?.selectedTools,
				projectTrusted: ctx.isProjectTrusted(),
				cwd: ctx.cwd,
				rosterDisabled: flag === "0" || flag === "false",
			},
			discoverAgents,
			{ maxItems: ROSTER_MAX_ITEMS, descWidth: ROSTER_DESC_WIDTH },
		);
		if (!roster) return;

		return { systemPrompt: `${event.systemPrompt}\n\n${roster}` };
	});

	// ---- 注册包内 skill 目录（由 Pi 直接从包路径加载，卸载即消失） ----
	const extensionDir = path.dirname(fileURLToPath(import.meta.url));
	const packageRoot = path.resolve(extensionDir, "..");
	const skillsDir = path.resolve(packageRoot, "skills");
	pi.on("resources_discover", async () => ({
		skillPaths: [skillsDir],
	}));

	// ---- 运行期干预入口 ----
	// 入口仅保留斜杠命令 /agents-ps（快捷键全部取消）。浮层异常与注册表异常
	// 均不得逸出：入口处理失败最多降级为「无浮层」。
	const openInterventionOverlay = async (ctx: any) => {
		if (!ctx.hasUI) return;
		try {
			if (runtimeRegistry.list().length === 0) {
				ctx.ui.notify("没有运行中的子代理", "info");
				return;
			}
			await openControlOverlay(ctx.ui, runtimeRegistry);
		} catch {
			// 静默：面板/浮层异常绝不反噬，入口处理不得抛出
		}
	};

	pi.registerTool({
		name: "subagent",
		label: "Subagent (SDK)",
		description: [
			"通过 SDK 隔离上下文派发任务给子代理。支持 single/parallel/chain 三种模式。",
			`默认 agent 作用域为 "global"（从 ${path.join(getAgentDir(), "agents")}）。`,
			`要启用项目本地 agent，将 agentScope 设为 "both" 或 "project"（从 ${CONFIG_DIR_NAME}/agents）。`,
			"SDK 版 —— 使用 createAgentSession 替代子进程 spawn，支持自定义 provider/auth。",
		].join(" "),
		parameters: SubagentParams,

		// =====================================================================
		// execute
		// =====================================================================

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// 每次工具调用一个累加器：chain/parallel/single 的全部 run 共享
			const budget = createAccumulator(resolveBudget());
			// 预算耗尽时向父会话提示一次（UI 异常绝不反噬执行）
			const notifyBudgetHit = (results: SingleResult[]): void => {
				if (!results.some((r) => r.errorMessage?.includes("预算已耗尽"))) return;
				if (!ctx.hasUI) return;
				try {
					ctx.ui.notify("子代理预算已耗尽：在跑任务已中止，后续任务已跳过", "warning");
				} catch {
					// UI 异常绝不反噬执行
				}
			};

			// 有 UI 才挂面板；attach 幂等，列表清空时控制器自行卸载。
			// UI 异常绝不反噬子代理执行：挂载失败最多导致可见性降级。
			attachPanelIfUI(ctx, runtimePanel);
			const agentScope: AgentScope = params.agentScope ?? "global";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			// 获取当前会话的默认 provider/model（用于 agent 继承兜底）
			const defaultProvider = ctx.model?.provider;
			const defaultModel = ctx.model?.id;

			// ---- 列表模式 ----
			if (params.agent === "list" && !params.task && !params.tasks && !params.chain) {
				return {
					content: [{ type: "text", text: formatAgentSummary(agents) }],
				};
			}

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount =
				Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			if (modeCount !== 1) {
				const available = formatAgentList(agents, 10);
				return {
					content: [
						{
							type: "text",
							text: `请提供三种模式的其中一种。可用 agent: ${available.text}`,
						},
					],
					details: {
						mode: "single" as const,
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						results: [] as SingleResult[],
					},
				};
			}

			// 项目 agent 确认
			if (
				(agentScope === "project" || agentScope === "both") &&
				params.confirmProjectAgents !== false &&
				ctx.hasUI
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain)
					for (const step of params.chain)
						requestedAgentNames.add(step.agent);
				if (params.tasks)
					for (const t of params.tasks)
						requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter(
						(a): a is AgentConfig => a?.source === "project",
					);

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested
						.map((a) => a.name)
						.join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"运行项目本地 agent？",
						`Agent: ${names}\n来源: ${dir}\n\n项目 agent 受仓库控制。只在信任的仓库中继续。`,
					);
					if (!ok)
						return {
							content: [
								{
									type: "text",
									text: "已取消：项目 agent 未获批准。",
								},
							],
							details: {
								mode: (hasChain
									? "chain"
									: hasTasks
										? "parallel"
										: "single") as "single" | "parallel" | "chain",
								agentScope,
								projectAgentsDir: discovery.projectAgentsDir,
								results: [] as SingleResult[],
							},
						};
				}
			}

			// ---- Chain 模式 ----
			if (params.chain && params.chain.length > 0) {
				const chainLength = params.chain.length;
				const results = await runChainAgents(
					ctx.cwd,
					agents,
					params.chain,
					signal,
					defaultProvider,
					defaultModel,
					(chainResults, currentAction) => {
						if (onUpdate) {
							const last = chainResults[chainResults.length - 1];
							onUpdate({
								content: [
									{
										type: "text",
										text: resolveProgressText(
											currentAction,
											`Chain: step ${last.step ?? chainResults.length}/${chainLength}...`,
										),
									},
								],
								details: {
									mode: "chain" as const,
									agentScope,
									projectAgentsDir: discovery.projectAgentsDir,
									results: chainResults,
								},
							});
						}
					},
					budget,
				);
				for (const r of results) recordAgentCall(r.agent, r);
				notifyBudgetHit(results);
				return formatResults(results, "chain", agentScope, discovery.projectAgentsDir);
			}

			// ---- Parallel 模式 ----
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{
								type: "text",
								text: `最多支持 ${MAX_PARALLEL_TASKS} 个并行任务（当前 ${params.tasks.length} 个）。`,
							},
						],
						isError: true,
						details: {
							mode: "parallel" as const,
							agentScope,
							projectAgentsDir: discovery.projectAgentsDir,
							results: [] as SingleResult[],
						},
					};
				}
				const results = await runParallelAgents(
					ctx.cwd,
					agents,
					params.tasks,
					signal,
					defaultProvider,
					defaultModel,
					(parallelResults, currentAction) => {
						if (onUpdate) {
							const done = parallelResults.filter(
								(r) => r.exitCode !== -1,
							).length;
							const total = parallelResults.length;
							onUpdate({
								content: [
									{
										type: "text",
										text: resolveProgressText(
											currentAction,
											`Parallel: ${done}/${total} done, ${total - done} running...`,
										),
									},
								],
								details: {
									mode: "parallel" as const,
									agentScope,
									projectAgentsDir: discovery.projectAgentsDir,
									results: parallelResults,
								},
							});
						}
					},
					budget,
				);
				for (const r of results) recordAgentCall(r.agent, r);
				notifyBudgetHit(results);
				return formatResults(results, "parallel", agentScope, discovery.projectAgentsDir);
			}

			// ---- Single 模式 ----
			if (params.agent && params.task) {
				const agent = agents.find((a) => a.name === params.agent);
				if (!agent) {
					return {
						content: [
							{
								type: "text",
								text: formatAgentError(params.agent, agents),
							},
						],
						isError: true,
						details: {
							mode: "single" as const,
							agentScope,
							projectAgentsDir: discovery.projectAgentsDir,
							results: [] as SingleResult[],
						},
					};
				}
				// 用于闭包捕获：TypeScript 不能通过闭包边界收窄类型
				const resolvedAgent = agent;
				const result = await runSingleAgent(
					ctx.cwd,
					resolvedAgent,
					params.task,
					params.cwd,
					signal,
					(partial) => {
						if (onUpdate && partial.messages) {
							const emptyUsage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
							onUpdate({
								content: [
									{
										type: "text",
										// 优先展示当前动作（数据流 #3：面板与内嵌卡片同一状态）；
										// 未提供 currentAction 时保持原有 finalOutput / (running...) 行为。
										text: resolveProgressText(
											partial.currentAction,
											getFinalOutput(partial.messages),
										),
									},
								],
								details: {
									mode: "single" as const,
									agentScope,
									projectAgentsDir: discovery.projectAgentsDir,
									results: [{
										agent: resolvedAgent.name,
										agentSource: resolvedAgent.source,
										task: params.task,
										messages: partial.messages,
										usage: partial.usage ?? emptyUsage,
										exitCode: -1, // still running
										cwd: params.cwd ?? ctx.cwd,
									}],
								},
							});
						}
					},
					defaultProvider,
					defaultModel,
					{ mode: "single", slot: 0 },
					budget,
				);
				recordAgentCall(result.agent, result);
				notifyBudgetHit([result]);
				return formatResults([result], "single", agentScope, discovery.projectAgentsDir);
			}

			// 不应到达此处
			return {
				content: [{ type: "text", text: "无效参数。" }],
				details: {
					mode: "single" as const,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results: [] as SingleResult[],
				},
			};
		},

		// =====================================================================
		// renderCall
		// =====================================================================

		renderCall(args: any, theme: any, _context: any) {
			const scope: AgentScope = args.agentScope ?? "global";

			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = (step.task || "")
						.replace(/\{previous\}/g, "")
						.trim()
						.slice(0, 40);
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${cleanTask}`);
				}
				if (args.chain.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}

			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = (t.task || "").slice(0, 40);
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}

			// Single
			const agentName = args.agent || "...";
			const preview = args.task
				? args.task.length > 60
					? `${args.task.slice(0, 60)}...`
					: args.task
				: "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		// =====================================================================
		// renderResult
		// =====================================================================

		renderResult(
			result: AgentToolResult<SubagentDetails>,
			{ expanded }: { expanded: boolean },
			theme: any,
			_context: any,
		) {
			const details = result.details as
				| {
						mode: "single" | "parallel" | "chain";
						agentScope: AgentScope;
						projectAgentsDir: string | null;
						results: SingleResult[];
					}
				| undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(
					text?.type === "text" ? text.text : "(no output)",
					0,
					0,
				);
			}

			const mdTheme = getMarkdownTheme();

			// ---- Single ----
			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError
					? theme.fg("error", "✗")
					: theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header =
						`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason)
						header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(
							new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
						);
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(
							new Text(theme.fg("muted", "(no output)"), 0, 0),
						);
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(
												item.name,
												item.args,
												theme.fg.bind(theme),
											),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(
								new Markdown(finalOutput.trim(), 0, 0, mdTheme),
							);
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				// Collapsed
				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason)
					text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage)
					text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0)
					text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, false, COLLAPSED_ITEM_COUNT, theme)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT && !expanded)
						text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			// ---- Chain ----
			if (details.mode === "chain") {
				const successCount = details.results.filter(
					(r) => r.exitCode === 0,
				).length;
				const icon =
					successCount === details.results.length
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg(
									"accent",
									`${successCount}/${details.results.length} steps`,
								),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon =
							r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
						const items = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(
							new Text(
								theme.fg("muted", "Task: ") + theme.fg("dim", r.task),
								0,
								0,
							),
						);

						for (const item of items) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(
												item.name,
												item.args,
												theme.fg.bind(theme),
											),
										0,
										0,
									),
								);
							}
						}

						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(
								new Markdown(finalOutput.trim(), 0, 0, mdTheme),
							);
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage)
							container.addChild(
								new Text(theme.fg("dim", stepUsage), 0, 0),
							);
					}

					const usageStr = formatUsageStats(
						aggregateUsage(details.results),
					);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0),
						);
					}
					return container;
				}

				// Collapsed
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg(
						"accent",
						`${successCount}/${details.results.length} steps`,
					);
				for (const r of details.results) {
					const rIcon =
						r.exitCode === 0
							? theme.fg("success", "✓")
							: theme.fg("error", "✗");
					const items = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (items.length === 0)
						text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(items, false, 5, theme)}`;
				}
				const usageStr = formatUsageStats(
					aggregateUsage(details.results),
				);
				if (usageStr)
					text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				if (!expanded)
					text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			// ---- Parallel ----
			if (details.mode === "parallel") {
				const running = details.results.filter(
					(r) => r.exitCode === -1,
				).length;
				const successCount = details.results.filter(
					(r) => r.exitCode !== -1 && !isFailedResult(r),
				).length;
				const failCount = details.results.filter(
					(r) => r.exitCode !== -1 && isFailedResult(r),
				).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
						const items = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(
							new Text(
								theme.fg("muted", "Task: ") + theme.fg("dim", r.task),
								0,
								0,
							),
						);

						for (const item of items) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(
												item.name,
												item.args,
												theme.fg.bind(theme),
											),
										0,
										0,
									),
								);
							}
						}

						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(
								new Markdown(finalOutput.trim(), 0, 0, mdTheme),
							);
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage)
							container.addChild(
								new Text(theme.fg("dim", taskUsage), 0, 0),
							);
					}

					const usageStr = formatUsageStats(
						aggregateUsage(details.results),
					);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0),
						);
					}
					return container;
				}

				// Collapsed (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const items = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (items.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(items, false, 5, theme)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(
						aggregateUsage(details.results),
					);
					if (usageStr)
						text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded)
					text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const fallbackText = result.content[0];
			return new Text(
				fallbackText?.type === "text" ? fallbackText.text : "(no output)",
				0,
				0,
			);
		},
	} as ToolDefinition<typeof SubagentParams>);

	// ---- /agents 命令 ----
	pi.registerCommand("agents", {
		description: "列出所有可用 agent",
		handler: async (args: string, ctx: any) => {
			const discovery = discoverAgents(ctx.cwd, "both");
			const agents = discovery.agents;
			if (agents.length === 0) {
				ctx.ui.notify("没有找到 agent", "info");
				return;
			}
			await renderAgentList(ctx, agents);
		},
	});

	// ---- /agents-ps 命令（唯一干预入口）----
	// 作为斜杠命令：不依赖任何特殊按键，可绕开 macOS 等无法上报 Meta/增强按键序列
	// 的终端。实测斜杠命令在子代理运行中（回合进行时）也会被立即执行，不被排队。
	pi.registerCommand("agents-ps", {
		description: "查看运行中的子代理并干预（暂停 / 提问 / 注入 / 中止）",
		handler: async (_args: string, ctx: any) => {
			await openInterventionOverlay(ctx);
		},
	});

	// ---- /agents-web 命令 ----
	pi.registerCommand("agents-web", {
		description: "启动 Web Studio 管理面板（支持 --port 指定端口、stop 停止）",
		handler: async (args: string, ctx: any) => {
			const trimmed = args.trim();

			// 停止服务器（等待端口释放，避免 EADDRINUSE）
			if (trimmed === "stop") {
				await stopServer();
				ctx.ui.notify("Web Studio 服务器已停止", "info");
				return;
			}

			// 解析 --port 参数（默认 3000，范围 1-65535）
			const portMatch = trimmed.match(/--port\s+(\d+)/);
			let port = portMatch ? parseInt(portMatch[1], 10) : 3000;
			port = Math.max(1, Math.min(65535, port));

			// 获取当前会话默认 provider/model
			const defaultProvider = ctx.model?.provider;
			const defaultModel = ctx.model?.id;

			try {
				const actualPort = await startServer(port, {
					discoverAgents,
					runSingleAgent,
					defaultProvider,
					defaultModel,
				});

				const url = `http://localhost:${actualPort}`;

				// 自动打开浏览器（平台差异）
				const openCmd =
					process.platform === "darwin"
						? `open ${url}`
						: process.platform === "win32"
							? `start "" ${url}`
							: `xdg-open ${url}`;
				exec(openCmd, (err) => {
					if (err) {
						ctx.ui.notify(`Web Studio 已启动: ${url}（未能自动打开浏览器，请手动访问）`, "info");
					}
				});

				ctx.ui.notify(`Web Studio 已启动: ${url}`, "success");
			} catch (err: any) {
				ctx.ui.notify(`Web Studio 启动失败: ${err.message}`, "error");
			}
		},
	});

	// ---- /agents-stats 命令 ----
	pi.registerCommand("agents-stats", {
		description: "统计子 Agent 调用次数与用量（--backfill 回填历史 / today/7d/all 查询）",
		handler: async (args: string, ctx: any) => {
			const raw = args.trim();
			if (raw.includes("--backfill")) {
				const summary = backfillFromSessions();
				if (summary.scannedFiles === 0) {
					ctx.ui.notify("未找到会话日志，无法回填", "info");
					return;
				}
				const lines = [
					`历史回填完成：扫描 ${summary.scannedFiles} 个会话文件，处理 ${summary.events} 条调用（跳过已回填 ${summary.skipped} 条）`,
					`覆盖 ${summary.agents.length} 个 agent：${summary.agents.join(", ") || "(无)"}`,
					summary.failed > 0 ? `其中判定失败 ${summary.failed} 条（Agent failed 文本匹配）` : "无失败记录",
					`回填截止：${summary.lastBackfillAt || "(无)"}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				const allItems = getStatsSummary(loadStats(), "all");
				ctx.ui.notify(formatStatsTable(allItems, "all"), "info");
				return;
			}
			const period: StatsPeriod = raw === "today" || raw === "7d" ? raw : "all";
			const items = getStatsSummary(loadStats(), period);
			ctx.ui.notify(formatStatsTable(items, period), "info");
		},
	});
}

// ---------------------------------------------------------------------------
// formatResults 辅助函数
// ---------------------------------------------------------------------------

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	/** 预算归账契约标记：父会话 cost-radar 仅在 ===1 时解析 results[].usage */
	costContract: 1;
	results: SingleResult[];
}

function formatResults(
	results: SingleResult[],
	mode: "single" | "parallel" | "chain",
	agentScope: AgentScope,
	projectAgentsDir: string | null,
): { content: { type: "text"; text: string }[]; details: SubagentDetails; isError?: boolean } {
	const successCount = results.filter((r) => !isFailedResult(r)).length;

	const buildDetails = (): SubagentDetails => ({
		mode,
		agentScope,
		projectAgentsDir,
		costContract: 1,
		results,
	});

	if (mode === "single" && results.length === 1) {
		const r = results[0];
		if (isFailedResult(r)) {
			return {
				content: [
					{
						type: "text",
						text: `Agent failed: ${r.errorMessage || r.stopReason || "(unknown)"}`,
					},
				],
				details: buildDetails(),
				isError: true,
			};
		}
		return {
			content: [
				{
					type: "text",
					text: getFinalOutput(r.messages) || "(no output)",
				},
			],
			details: buildDetails(),
		};
	}

	if (mode === "chain") {
		const lastStep = results[results.length - 1];
		if (isFailedResult(lastStep)) {
			return {
				content: [
					{
						type: "text",
						text: `Chain stopped at step ${lastStep.step}: ${lastStep.errorMessage || lastStep.stopReason}`,
					},
				],
				details: buildDetails(),
				isError: true,
			};
		}
		return {
			content: [
				{
					type: "text",
					text: getFinalOutput(lastStep.messages) || "(no output)",
				},
			],
			details: buildDetails(),
		};
	}

	// Parallel
	const anyFailed = results.some((r) => isFailedResult(r));
	const summaries = results.map((r) => {
		const output = truncateParallelOutput(
			getFinalOutput(r.messages) ||
				(r.errorMessage ?? "(no output)"),
		);
		const status = isFailedResult(r)
			? `failed (${r.stopReason})`
			: "completed";
		return `### [${r.agent}] ${status}\n\n${output}`;
	});
	return {
		content: [
			{
				type: "text",
				text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
			},
		],
		details: buildDetails(),
		isError: anyFailed,
	};
}
