/**
 * Agent 调用统计（按 agent + 日期聚合，同步写文件）。
 *
 * 仅依赖 node 内置模块 + type-only 类型导入，可被
 * `node --experimental-strip-types` 直接执行验证。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SingleResult } from "./core";

export type StatsPeriod = "today" | "7d" | "all";

export interface AgentDayStats {
	total: number;
	success: number;
	fail: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface AgentStats extends AgentDayStats {
	byDate: Record<string, AgentDayStats>;
}

export interface StatsFile {
	version: number;
	agents: Record<string, AgentStats>;
	updatedAt: string;
	lastBackfillAt?: string; // 历史回填截止时间（ISO），用于幂等
}

export interface StatsSummaryItem {
	agent: string;
	total: number;
	success: number;
	fail: number;
	input: number;
	output: number;
	cost: number;
	today: number;
	last7d: number;
}

const STATS_VERSION = 1;

export function getStatsFilePath(): string {
	return path.join(os.homedir(), ".pi", "agent", "agents-stats.json");
}

function emptyDay(): AgentDayStats {
	return { total: 0, success: 0, fail: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function emptyAgent(): AgentStats {
	return { ...emptyDay(), byDate: {} };
}

function toDateKey(d: Date): string {
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${dd}`;
}

function todayKey(): string {
	return toDateKey(new Date());
}

export function loadStats(filePath: string = getStatsFilePath()): StatsFile {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && parsed.agents && typeof parsed.agents === "object") {
			// 重建为无原型字典，避免 agent 名为 __proto__/constructor 时原型污染
			const agents = Object.create(null);
			Object.assign(agents, parsed.agents);
			return {
				version: parsed.version ?? STATS_VERSION,
				agents,
				updatedAt: parsed.updatedAt ?? "",
				lastBackfillAt: typeof parsed.lastBackfillAt === "string" ? parsed.lastBackfillAt : undefined,
			};
		}
	} catch {
		// 文件不存在或损坏：重置为空结构
	}
	return { version: STATS_VERSION, agents: Object.create(null), updatedAt: "" };
}

/** 与 core.ts isFailedResult 相同判定（内联避免运行时依赖 core.ts） */
function isFailed(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted"
	);
}

/**
 * 记录一次 agent 调用。同步写文件；任何失败仅 warn，绝不影响调用方。
 * filePath 参数供测试注入临时路径。
 */
export function recordAgentCall(
	agent: string,
	result: SingleResult,
	filePath: string = getStatsFilePath(),
): void {
	recordAgentCallAt(agent, result, todayKey(), filePath);
}

/**
 * 按指定日期记录一次 agent 调用（回填/测试用）。
 * 与 recordAgentCall 相同的数据结构与失败判定，日期由调用方指定。
 */
export function recordAgentCallAt(
	agent: string,
	result: SingleResult,
	dateKey: string,
	filePath: string = getStatsFilePath(),
): void {
	try {
		const stats = loadStats(filePath);
		const a = stats.agents[agent] ?? emptyAgent();
		const failed = isFailed(result);
		const u = result.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

		a.total++;
		if (failed) a.fail++;
		else a.success++;
		a.input += u.input || 0;
		a.output += u.output || 0;
		a.cacheRead += u.cacheRead || 0;
		a.cacheWrite += u.cacheWrite || 0;
		a.cost += u.cost || 0;

		const d = a.byDate[dateKey] ?? emptyDay();
		d.total++;
		if (failed) d.fail++;
		else d.success++;
		d.input += u.input || 0;
		d.output += u.output || 0;
		d.cacheRead += u.cacheRead || 0;
		d.cacheWrite += u.cacheWrite || 0;
		d.cost += u.cost || 0;
		a.byDate[dateKey] = d;

		stats.agents[agent] = a;
		stats.updatedAt = new Date().toISOString();
		fs.writeFileSync(filePath, JSON.stringify(stats, null, 2), "utf-8");
	} catch (err) {
		console.warn("[pi-subagent] recordAgentCallAt failed:", err);
	}
}

/** 合并 b 的聚合数据到 a（回填批量合并用） */
function mergeAgent(a: AgentStats, b: AgentStats): void {
	a.total += b.total;
	a.success += b.success;
	a.fail += b.fail;
	a.input += b.input;
	a.output += b.output;
	a.cacheRead += b.cacheRead;
	a.cacheWrite += b.cacheWrite;
	a.cost += b.cost;
	for (const [k, v] of Object.entries(b.byDate)) {
		const day = a.byDate[k] ?? emptyDay();
		day.total += v.total;
		day.success += v.success;
		day.fail += v.fail;
		day.input += v.input;
		day.output += v.output;
		day.cacheRead += v.cacheRead;
		day.cacheWrite += v.cacheWrite;
		day.cost += v.cost;
		a.byDate[k] = day;
	}
}

export interface BackfillSummary {
	scannedFiles: number;
	events: number;      // 本次处理的事件数
	skipped: number;     // 已回填跳过的事件数
	failed: number;      // 判定失败的事件数
	agents: string[];    // 覆盖的 agent（按名称排序）
	lastBackfillAt: string;
}

export function getDefaultSessionsDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "sessions");
}

/**
 * 从 pi 会话日志回填历史 subagent 调用。
 * 幂等：只处理 timestamp > stats.lastBackfillAt 的事件，处理完写入 lastBackfillAt。
 * 失败判定：关联 toolResult 文本含 "Agent failed"（single 模式失败场景）；其余默认成功。
 * token/成本无法从日志获取，记 0。
 */
export function backfillFromSessions(
	sessionsDir: string = getDefaultSessionsDir(),
	statsFilePath: string = getStatsFilePath(),
): BackfillSummary {
	const stats = loadStats(statsFilePath);
	const cutoff = stats.lastBackfillAt ? new Date(stats.lastBackfillAt).getTime() : 0;

	interface PendingEvent { agent: string; ts: number; failed: boolean; }

	// 第一遍：收集 subagent toolCall 事件（toolCallId → 事件信息），并用 toolResult 匹配失败标志
	const byId = new Map<string, PendingEvent>();
	const events: PendingEvent[] = [];
	let scannedFiles = 0;

	let dirs: string[] = [];
	try {
		dirs = fs.readdirSync(sessionsDir).filter((d) => {
			try { return fs.statSync(path.join(sessionsDir, d)).isDirectory(); } catch { return false; }
		});
	} catch {
		// sessions 目录不存在
	}

	for (const dir of dirs) {
		let files: string[] = [];
		try {
			files = fs.readdirSync(path.join(sessionsDir, dir)).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const file of files) {
			scannedFiles++;
			let content: string;
			try {
				content = fs.readFileSync(path.join(sessionsDir, dir, file), "utf-8");
			} catch {
				continue;
			}
			for (const line of content.split("\n")) {
				if (!line.trim()) continue;
				let j: any;
				try {
					j = JSON.parse(line);
				} catch {
					continue;
				}
				const ts = j.timestamp ? new Date(j.timestamp).getTime() : 0;
				if (!ts) continue;
				const msg = j.message;
				const contentArr = msg?.content;
				if (!Array.isArray(contentArr)) continue;

				// toolResult：匹配 toolCallId 设置失败标志
				if (msg.role === "toolResult" && msg.toolCallId) {
					const ev = byId.get(msg.toolCallId);
					if (ev) {
						const text = JSON.stringify(msg.content ?? "");
						// 失败输出为短文本（formatResults: "Agent failed: <error>"），长文中的字面量（如报告引用）不判定
						if (text.includes("Agent failed:") && text.length < 500) ev.failed = true;
					}
					continue;
				}

				// toolCall：解析 subagent 调用的 agent 名（single/chain/parallel）
				for (const c of contentArr) {
					if (!c || typeof c !== "object") continue;
					if (c.type !== "toolCall" || c.name !== "subagent" || !c.id) continue;
					let args: any;
					try {
						args = typeof c.arguments === "string" ? JSON.parse(c.arguments) : (c.arguments ?? {});
					} catch {
						continue;
					}
					const register = (agent: string) => {
						if (!agent) return;
						const ev: PendingEvent = { agent, ts, failed: false };
						byId.set(c.id, ev);
						events.push(ev);
					};
					if (typeof args.agent === "string") register(args.agent);
					if (Array.isArray(args.chain)) args.chain.forEach((x: any) => register(x?.agent));
					if (Array.isArray(args.tasks)) args.tasks.forEach((x: any) => register(x?.agent));
				}
			}
		}
	}

	// 过滤：只处理 lastBackfillAt 之后的事件
	const toProcess = events.filter((e) => e.ts > cutoff);
	const skipped = events.length - toProcess.length;

	// 批量聚合
	const merged = new Map<string, AgentStats>();
	for (const e of toProcess) {
		const a = merged.get(e.agent) ?? emptyAgent();
		a.total++;
		if (e.failed) a.fail++;
		else a.success++;
		const key = toDateKey(new Date(e.ts));
		const d = a.byDate[key] ?? emptyDay();
		d.total++;
		if (e.failed) d.fail++;
		else d.success++;
		a.byDate[key] = d;
		merged.set(e.agent, a);
	}

	// 合并进 stats 并一次性写盘
	let failed = 0;
	for (const e of toProcess) if (e.failed) failed++;
	for (const [agent, a] of merged) {
		const existing = stats.agents[agent] ?? emptyAgent();
		mergeAgent(existing, a);
		stats.agents[agent] = existing;
	}

	if (toProcess.length > 0) {
		const maxTs = Math.max(...toProcess.map((e) => e.ts));
		stats.lastBackfillAt = new Date(maxTs).toISOString();
		stats.updatedAt = new Date().toISOString();
		try {
			fs.writeFileSync(statsFilePath, JSON.stringify(stats, null, 2), "utf-8");
		} catch (err) {
			console.warn("[pi-subagent] backfillFromSessions write failed:", err);
		}
	}

	return {
		scannedFiles,
		events: toProcess.length,
		skipped,
		failed,
		agents: [...merged.keys()].sort(),
		lastBackfillAt: stats.lastBackfillAt ?? "",
	};
}

/** 汇总统计。period 过滤：today=今日有调用；7d=近7天有调用；all=全部 */
export function getStatsSummary(stats: StatsFile, period: StatsPeriod = "all"): StatsSummaryItem[] {
	const today = todayKey();
	const dates7 = new Set<string>();
	for (let i = 0; i < 7; i++) {
		const d = new Date();
		d.setDate(d.getDate() - i);
		const m = String(d.getMonth() + 1).padStart(2, "0");
		const dd = String(d.getDate()).padStart(2, "0");
		dates7.add(`${d.getFullYear()}-${m}-${dd}`);
	}

	const items: StatsSummaryItem[] = [];
	for (const [agent, a] of Object.entries(stats.agents)) {
		let todayCount = 0;
		let last7 = 0;
		for (const [date, day] of Object.entries(a.byDate)) {
			if (date === today) todayCount += day.total;
			if (dates7.has(date)) last7 += day.total;
		}
		items.push({
			agent,
			total: a.total,
			success: a.success,
			fail: a.fail,
			input: a.input,
			output: a.output,
			cost: a.cost,
			today: todayCount,
			last7d: last7,
		});
	}
	items.sort((x, y) => y.total - x.total);
	if (period === "today") return items.filter((i) => i.today > 0);
	if (period === "7d") return items.filter((i) => i.last7d > 0);
	return items;
}

/** 数字格式化：<1000 原样，<1M 用 k，否则 M（与 index.ts formatTokens 一致） */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function padToWidth(s: string, targetWidth: number): string {
	return s + " ".repeat(Math.max(0, targetWidth - s.length));
}

/** 生成纯文本统计表格（供 /agents-stats 命令 ctx.ui.notify 输出） */
export function formatStatsTable(items: StatsSummaryItem[], period: StatsPeriod = "all"): string {
	if (items.length === 0) {
		return `暂无统计数据${period === "all" ? "" : `（${period === "today" ? "今日" : "近7天"}无调用）`}`;
	}
	const periodLabel = period === "today" ? "今日" : period === "7d" ? "近7天" : "累计";
	const headers = ["Agent", "调用", "成功", "失败", "今日", "7天", "输入", "输出", "成本"];
	const widths: number[] = [];
	const rows: string[][] = [];

	// 表头与数据行
	const cols = items.map((i) => [
		i.agent,
		String(i.total),
		String(i.success),
		String(i.fail),
		String(i.today),
		String(i.last7d),
		formatTokens(i.input),
		formatTokens(i.output),
		`$${(Number(i.cost) || 0).toFixed(4)}`,
	]);
	const all = [headers, ...cols];
	for (let c = 0; c < headers.length; c++) {
		widths.push(Math.max(...all.map((r) => (r[c] || "").length)));
	}
	const line = (r: string[]) =>
		r.map((cell, c) => padToWidth(cell, widths[c])).join("  ").replace(/\s+$/, "");

	return [
		`子 Agent 调用统计（${periodLabel}，${items.length} 个）:`,
		`  ${line(headers)}`,
		`  ${widths.map((w) => "─".repeat(w)).join("  ")}`,
		...cols.map((r) => `  ${line(r)}`),
	].join("\n");
}
