import * as os from "node:os";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConfig, AgentScope } from "./agents";

// ---------------------------------------------------------------------------
// 表格辅助
// ---------------------------------------------------------------------------

/** 按可见宽度补空格对齐 */
function padToWidth(s: string, targetWidth: number): string {
	const w = visibleWidth(s);
	return s + " ".repeat(Math.max(0, targetWidth - w));
}

/** source 中文化 */
function fmtSource(s: string): string {
	return s === "project" ? "项目" : "全局";
}

/** 计算来源列、名称列宽度 */
function calcColWidths(agents: AgentConfig[]) {
	const srcW = Math.max(visibleWidth("来源"), ...agents.map((a) => visibleWidth(fmtSource(a.source))));
	const nameW = Math.max(visibleWidth("名称"), ...agents.map((a) => visibleWidth(a.name)));
	return { srcW, nameW };
}

// ---------------------------------------------------------------------------
// 纯文本表格（非 TUI 降级 / tool result）
// ---------------------------------------------------------------------------

export function formatAgentSummary(agents: AgentConfig[]): string {
	if (agents.length === 0) return "none";
	const { srcW, nameW } = calcColWidths(agents);
	const h = `${padToWidth("来源", srcW)}  ${padToWidth("名称", nameW)}  简介`;
	const sep = "─".repeat(srcW) + "  " + "─".repeat(nameW) + "  " + "─".repeat(10);
	const rows = agents.map((a) => `${padToWidth(fmtSource(a.source), srcW)}  ${padToWidth(a.name, nameW)}  ${a.description}`);
	return [`可用 agent (${agents.length}):`, `  ${h}`, `  ${sep}`, ...rows.map((r) => `  ${r}`)].join("\n");
}

export function formatAgentError(unknownName: string, agents: AgentConfig[]): string {
	if (agents.length === 0) return `未知 agent: "${unknownName}"，且当前没有可用 agent。`;
	return [`未知 agent: "${unknownName}"`, "", formatAgentSummary(agents)].join("\n");
}

// ---------------------------------------------------------------------------
// Roster（注入 system prompt 的可用 agent 清单）
// ---------------------------------------------------------------------------

/** roster 标题（同时作为幂等标记：system prompt 已含它则不再注入） */
export const ROSTER_HEADING = "## 可用子代理（subagent 工具）";

export interface RosterOptions {
	/** 最多列出的 agent 数，默认 15 */
	maxItems?: number;
	/** 描述截断宽度（可见列宽），默认 30 */
	descWidth?: number;
}

/**
 * 清洗仓库可控文本，防 prompt 注入与格式破坏。
 *
 * project 作用域的 agent 描述来自仓库内的 `.pi/agents/*.md` frontmatter，
 * 属于不可信输入：去掉换行/制表、尖括号、反引号与控制字符。
 */
export function sanitizeRosterText(s: string): string {
	return s
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/[<>`]/g, "")
		.replace(/\s{2,}/g, " ")
		.trim();
}

/**
 * 按可见宽度截断纯文本（用于注入到 LLM 的内容）。
 *
 * 不能直接用 TUI 的 `truncateToWidth`：它会在截断处插入 ANSI 重置序列
 * （实测 `\x1b[0m`），这些字节会原样进入 system prompt。
 */
export function truncatePlainToWidth(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;

	const ellipsis = "...";
	const budget = maxWidth - visibleWidth(ellipsis);
	if (budget <= 0) return ellipsis.slice(0, Math.max(0, maxWidth));

	let out = "";
	let width = 0;
	for (const ch of text) {
		const w = visibleWidth(ch);
		if (width + w > budget) break;
		out += ch;
		width += w;
	}
	return out + ellipsis;
}

/**
 * 生成紧凑的 agent roster，用于追加到 system prompt。
 *
 * 排序必须显式：`readdirSync` 顺序不保证稳定，若沿用目录顺序会导致
 * system prompt 每轮字节不同，白掉前缀缓存。
 *
 * @returns 无 agent 时返回空串（调用方据此跳过注入）
 */
export function formatAgentRoster(
	agents: AgentConfig[],
	opts: RosterOptions = {},
): string {
	const maxItems = opts.maxItems ?? 15;
	const descWidth = opts.descWidth ?? 30;
	if (agents.length === 0) return "";

	const sorted = [...agents].sort((a, b) => {
		if (a.source !== b.source) return a.source === "global" ? -1 : 1;
		return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	});
	const listed = sorted.slice(0, maxItems);
	const rest = sorted.length - listed.length;

	const lines = [
		ROSTER_HEADING,
		"",
		'派发任务前先从这里取 agent 名，不要猜；完整列表用 subagent(agent:"list")。',
		...listed.map((a) => {
			const tag = a.source === "global" ? "[全局]" : "[项目]";
			const desc = truncatePlainToWidth(
				sanitizeRosterText(a.description),
				descWidth,
			);
			return `- ${a.name} ${tag} ${desc}`;
		}),
	];

	if (rest > 0) {
		lines.push(`- …其余 ${rest} 个用 subagent(agent:"list") 查看`);
	}

	if (listed.some((a) => a.source === "project")) {
		lines.push(
			"",
			'项目 agent 仅本仓库可用：调用时需 agentScope:"both"，且会请求用户批准。',
		);
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Roster 注入决策
// ---------------------------------------------------------------------------

export interface RosterInjectionInput {
	/** 当前 system prompt（用于幂等判断） */
	systemPrompt: string;
	/** 当前激活的工具名；不含 subagent 时不注入（子 agent 会话即如此） */
	selectedTools?: string[];
	/** 项目是否可信（决定是否暴露 .pi/agents） */
	projectTrusted: boolean;
	cwd: string;
	/** 逃生开关（如环境变量 PI_SUBAGENT_ROSTER=0） */
	rosterDisabled?: boolean;
}

/**
 * 决定本轮是否注入 roster，并返回要追加的文本（null = 不注入）。
 *
 * 抽成纯函数的原因：`index.ts` 依赖大量运行时模块，不便单测；
 * 决策逻辑（四道 guard + 作用域选择）才是真正需要验证的部分。
 *
 * `discover` 由调用方传入（不在本模块引入 `./agents` 的运行时依赖），
 * 保证本模块能被 `node --test` 直接加载。
 */
export function buildRosterInjection(
	input: RosterInjectionInput,
	discover: (
		cwd: string,
		scope: AgentScope,
	) => { agents: AgentConfig[] },
	opts: RosterOptions = {},
): string | null {
	// guard 1：subagent 工具未激活（子 agent 会话的工具白名单不含它）
	if (!input.selectedTools?.includes("subagent")) return null;
	// guard 2：逃生开关
	if (input.rosterDisabled) return null;
	// guard 3：system prompt 已含 roster，不重复追加
	if (input.systemPrompt.includes(ROSTER_HEADING)) return null;
	// guard 4：未信任仓库降级为 global 作用域
	const scope: AgentScope = input.projectTrusted ? "both" : "global";

	let agents: AgentConfig[];
	try {
		agents = discover(input.cwd, scope).agents;
	} catch {
		return null; // 发现失败不应阻断对话
	}

	const roster = formatAgentRoster(agents, opts);
	return roster.length > 0 ? roster : null;
}

// ---------------------------------------------------------------------------
// TUI 交互式列表（表格布局）
// ---------------------------------------------------------------------------

function buildListText(agents: AgentConfig[], selectedIndex: number, theme: any, availWidth: number): string {
	const lines: string[] = [];
	lines.push(theme.fg("toolTitle", theme.bold(`可用 Agent (${agents.length})`)));
	lines.push("");

	const { srcW, nameW } = calcColWidths(agents);
	const prefixW = 2; // "  " or "▶ "
	const gap = 2;
	const descW = Math.max(10, availWidth - prefixW - srcW - gap * 3 - nameW);

	// 表头
	lines.push(theme.fg("dim", `${padToWidth("来源", srcW)}${padToWidth("名称", nameW)}  简介`));
	lines.push(theme.fg("dim", `${padToWidth("──", srcW)}${padToWidth("--", nameW)}  ${padToWidth("------", descW)}`.replace(/[^- \u4e00-\u9fff]/g, "─")));

	// 数据行
	for (let i = 0; i < agents.length; i++) {
		const a = agents[i];
		const prefix = i === selectedIndex ? "▶ " : "  ";
		const row = `${prefix}${padToWidth(fmtSource(a.source), srcW)}${padToWidth(a.name, nameW)}  ${truncateToWidth(a.description, descW)}`;
		lines.push(i === selectedIndex ? theme.fg("accent", row) : theme.fg("text", row));
	}

	lines.push("");
	lines.push(theme.fg("dim", "↑↓ 导航  •  Enter 详情  •  Esc 关闭"));
	return lines.join("\n");
}

/**
 * 构建 TUI 详情页文本。
 */
function buildDetailText(agent: AgentConfig, theme: any): string {
	const lines: string[] = [];

	lines.push(
		theme.fg("accent", theme.bold(`── ${agent.name} ──`)),
	);
	lines.push("");
	lines.push(theme.fg("text", agent.description));
	lines.push("");

	const details: [string, string][] = [
		["来源", fmtSource(agent.source)],
		["工具", agent.tools?.join(", ") ?? "(默认)"],
		["文件", shortenHome(agent.filePath)],
	];
	if (agent.provider) details.push(["Provider", agent.provider]);
	if (agent.model) details.push(["Model", agent.model]);
	for (const [label, value] of details) {
		lines.push(`${theme.fg("muted", `${label}  `)}${theme.fg("text", value)}`);
	}

	lines.push("");
	lines.push(theme.fg("muted", "系统提示："));
	lines.push(theme.fg("dim", agent.systemPrompt.slice(0, 200)));

	lines.push("");
	lines.push(theme.fg("dim", "Enter 返回  •  Esc 关闭"));
	return lines.join("\n");
}

function shortenHome(filePath: string): string {
	const home = os.homedir();
	return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

/**
 * TUI 交互式 agent 列表。
 * 两级导航：列表 → 选中查看详情 → 返回列表。
 * 非 TUI 模式降级为纯文本输出。
 */
export async function renderAgentList(
	ctx: any,
	agents: AgentConfig[],
): Promise<void> {
	if (!ctx.hasUI) {
		// 降级：纯文本输出
		ctx.ui.notify(formatAgentSummary(agents), "info");
		return;
	}

	let selectedIndex = 0;
	let view: "list" | "detail" = "list";

	await ctx.ui.custom<void>((tui, theme, _kb, done) => ({
		render(width: number): string[] {
			const text =
				view === "list"
					? buildListText(agents, selectedIndex, theme, width)
					: buildDetailText(agents[selectedIndex], theme);
			return text.split("\n");
		},
		invalidate() {},
		handleInput(data: string) {
			if (view === "list") {
				if (matchesKey(data, Key.up)) {
					selectedIndex =
						(selectedIndex - 1 + agents.length) % agents.length;
					tui.requestRender();
				} else if (matchesKey(data, Key.down)) {
					selectedIndex = (selectedIndex + 1) % agents.length;
					tui.requestRender();
				} else if (matchesKey(data, Key.enter)) {
					view = "detail";
					tui.requestRender();
				} else if (matchesKey(data, Key.escape)) {
					done(undefined);
				}
			} else {
				// detail view
				if (matchesKey(data, Key.enter)) {
					view = "list";
					tui.requestRender();
				} else if (matchesKey(data, Key.escape)) {
					done(undefined);
				}
			}
		},
	}));
}
