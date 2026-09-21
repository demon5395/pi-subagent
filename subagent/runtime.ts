/**
 * 子代理运行时注册表 — 执行期状态层（纯状态，无 UI、无 session 依赖）
 *
 * core.ts 在子会话创建/结束时写入；panel.ts / index.ts 读取并渲染。
 * 本模块不得 runtime import core.ts / index.ts / panel.ts，
 * 以保证 node --test 能直接加载。
 */

import { clipText } from "./text.ts";

export type RuntimeStatus = "running" | "paused" | "aborted" | "done" | "failed";
export type RuntimeMode = "single" | "parallel" | "chain";

/** core.ts 注入的闭包，UI 层只通过它操作子会话 */
export interface RuntimeHandle {
	/** 运行中：排队注入指令；已暂停：作为用户消息在空闲会话上立即执行 */
	steer(text: string): Promise<void>;
	/** 中止当前活动（保留会话）；暂停后可用 steer 继续对话/恢复 */
	pause(): Promise<void>;
	/**
	 * 显式请求「结束并返回父级」：置位 finishRequested 并唤醒
	 * 暂停循环。仅对已暂停条目有意义（运行中置位会在下次进入暂停等待时生效）；
	 * 与 abort 不同，不改 abortReason、终态仍为 done。
	 */
	finish(): Promise<void>;
	abort(): Promise<void>;
}

export interface RunningSubagent {
	id: string;
	agent: string;
	agentSource: "global" | "project" | "unknown";
	task: string;
	mode: RuntimeMode;
	slot: number;
	startedAt: number;
	lastEventAt: number;
	currentAction?: string;
	lastLine?: string;
	status: RuntimeStatus;
	/** 中止原因：budget=预算用尽（cost-radar 闸门）；user=用户经浮层中止 */
	abortReason?: "user" | "budget";
	steeringSent: number;
	steeringPending: number;
	handle: RuntimeHandle;
}

export type RegisterInput = Omit<
	RunningSubagent,
	"id" | "lastEventAt" | "status" | "steeringSent" | "steeringPending"
> &
	Partial<
		Pick<
			RunningSubagent,
			"lastEventAt" | "status" | "steeringSent" | "steeringPending"
		>
	>;

/** 模块内单调计数器：防同名同槽位复用（重复工具调用） */
let seq = 0;

export class SubagentRuntimeRegistry {
	private entries = new Map<string, RunningSubagent>();
	private listeners = new Set<() => void>();

	register(input: RegisterInput): string {
		const id = `${input.agent}#${++seq}`;
		this.entries.set(id, {
			...input,
			id,
			lastEventAt: input.lastEventAt ?? input.startedAt,
			status: input.status ?? "running",
			steeringSent: input.steeringSent ?? 0,
			steeringPending: input.steeringPending ?? 0,
		});
		this.emit();
		return id;
	}

	/** 幂等：id 已注销则静默忽略，不抛错 */
	update(id: string, patch: Partial<Omit<RunningSubagent, "id">>): void {
		const cur = this.entries.get(id);
		if (!cur) return;
		this.entries.set(id, { ...cur, ...patch, id });
		this.emit();
	}

	unregister(id: string): void {
		if (this.entries.delete(id)) this.emit();
	}

	get(id: string): RunningSubagent | undefined {
		return this.entries.get(id);
	}

	list(): RunningSubagent[] {
		return [...this.entries.values()].sort((a, b) => a.startedAt - b.startedAt);
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}

	/** 仅供测试 */
	reset(): void {
		this.entries.clear();
		this.listeners.clear();
	}

	private emit(): void {
		for (const cb of [...this.listeners]) {
			try {
				cb();
			} catch {
				// 监听者异常不得影响状态写入
			}
		}
	}
}

export const runtimeRegistry = new SubagentRuntimeRegistry();

/** 节流判定器：返回 true 表示本次放行（注入 now 便于单测） */
export function createThrottle(
	intervalMs: number,
	now: () => number = Date.now,
): () => boolean {
	let last = Number.NEGATIVE_INFINITY;
	return () => {
		const t = now();
		if (t - last < intervalMs) return false;
		last = t;
		return true;
	};
}

/**
 * 剔除终端控制字符：C0（\x00-\x1f）、DEL（\x7f）、C1（\x80-\x9f）
 * 以及 ESC 序列（CSI/OSC 等）。换行/制表替换为空格（面板按行渲染）。
 * 模型生成的工具参数会被拼进 TUI 行，必须防止 ANSI/OSC 序列驱动终端
 * （控制字节不得进入展示/回传链路）。
 * 纯函数：保留普通可见字符（含中文）。
 */
export function sanitizeText(s: string): string {
	return s
		// 换行/制表 → 空格（不引入换行，保持单行展示）
		.replace(/[\r\n\t]+/g, " ")
		// OSC：ESC ] ... BEL 或 ST(ESC \)
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
		// CSI：ESC [ 参数字节 中间字节 终止字节
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		// 其余 ESC 序列（含落单 ESC）
		.replace(/\x1b[\s\S]?/g, "")
		// 残余 C0 / DEL / C1
		.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/** 把子会话的工具调用渲染成一行可读动作，例如 "bash: npm test" */
export function describeToolCall(
	name: string,
	args: Record<string, unknown> | undefined,
): string {
	const a = (args ?? {}) as Record<string, unknown>;
	// 参数来自模型，拼入 TUI 前先剔除控制字符/ESC 序列（防终端注入）
	const str = (v: unknown): string =>
		typeof v === "string" ? sanitizeText(v) : "";
	switch (name) {
		case "bash":
			return `bash: ${clipText(str(a.command) || "...", 48)}`;
		case "read":
			return `read: ${clipText(str(a.file_path) || str(a.path) || "...", 48)}`;
		case "write":
			return `write: ${clipText(str(a.file_path) || str(a.path) || "...", 48)}`;
		case "edit":
			return `edit: ${clipText(str(a.file_path) || str(a.path) || "...", 48)}`;
		case "ls":
			return `ls: ${clipText(str(a.path) || ".", 48)}`;
		case "find":
			return `find: ${clipText(str(a.pattern) || "*", 48)}`;
		case "grep":
			return `grep: /${clipText(str(a.pattern), 32)}/`;
		default:
			return name;
	}
}

/**
 * finally 终态判定（设计文档状态图标表：● running / ⊘ aborted / ✓ done / ✗ failed）。
 *
 * 判定顺序（重要）：
 *   1. abortedByUser —— 用户在浮层 `x`/`a` 主动中止。abort 路径下 session.prompt
 *      可能以非 aborted 的错误结束（exitCode=1 / stopReason=error），若只看
 *      stopReason / isFailedResult 会把用户中止误判为 failed（终态应显示 ⊘）。
 *   2. stopReason === "aborted" —— 兼容既有语义（会话自身因 abort 结束）。
 *   3. 失败语义 —— 与 core.ts 的 isFailedResult 保持一致（exitCode !== 0 或 error）。
 *   4. 否则 done。
 *
 * 纯函数、无副作用：不改变 result 的 stopReason/exitCode，也不影响并行/链式逻辑。
 */
export function resolveRuntimeStatus(
	abortedByUser: boolean,
	result: { exitCode: number; stopReason?: string },
): RuntimeStatus {
	if (abortedByUser) return "aborted";
	if (result.stopReason === "aborted") return "aborted";
	if (result.exitCode !== 0 || result.stopReason === "error") return "failed";
	return "done";
}

/** 从 tool_execution_update 的 partialResult 中提取首行文本（防御式，输入是 any） */
export function extractLine(partial: unknown): string | undefined {
	const firstLine = (s: string): string | undefined => {
		const line = s.split("\n")[0].trim();
		return line.length > 0 ? line : undefined;
	};
	if (typeof partial === "string") return firstLine(partial);
	const content = (partial as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((c): c is { type: string; text: string } => {
			const o = c as { type?: unknown; text?: unknown };
			return o?.type === "text" && typeof o.text === "string";
		})
		.map((c) => c.text)
		.join(" ");
	return text ? firstLine(text) : undefined;
}
