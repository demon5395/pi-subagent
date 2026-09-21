/**
 * 子代理运行时表现层 — 面板格式化 + 键盘 reducer +（后续）widget 控制器与干预浮层
 *
 * 约束：本模块不得 runtime import ./runtime（只能 import type），
 * 否则 node --test 会因无扩展名解析失败。
 */

import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RunningSubagent, RuntimeStatus } from "./runtime";
import { clipText } from "./text.ts";

export const WIDGET_KEY = "subagent-runtime";

const STATUS_ICON: Record<RuntimeStatus, string> = {
	running: "●",
	paused: "⏸",
	aborted: "⊘",
	done: "✓",
	failed: "✗",
};

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** 毫秒 → 0s / 59s / 1m00s / 1h02m */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	if (total < 60) return `${total}s`;
	if (total < 3600) {
		return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
	}
	const m = Math.floor((total % 3600) / 60);
	return `${Math.floor(total / 3600)}h${String(m).padStart(2, "0")}m`;
}

/** aborted 条目文案：预算用尽 vs 用户取消（其余状态原样） */
function statusAction(e: RunningSubagent): string {
	if (e.status === "aborted") return e.abortReason === "budget" ? "预算用尽" : "已中止";
	return e.status;
}

export function formatRuntimeLines(
	entries: RunningSubagent[],
	opts: { now: number; maxRows?: number; nameWidth?: number },
): string[] {
	if (entries.length === 0) return [];
	const maxRows = opts.maxRows ?? 4;
	const nameWidth = opts.nameWidth ?? 16;

	const lines = entries.slice(0, maxRows).map((e) => {
		const name = clipText(e.agent, nameWidth);
		const action =
			e.status === "running"
				? (e.currentAction ?? e.lastLine ?? "(thinking…)")
				: statusAction(e);
		const parts = [
			`${STATUS_ICON[e.status]} ${name}`,
			formatElapsed(opts.now - e.startedAt),
			action,
		];
		if (e.steeringSent > 0) {
			parts.push(
				`↩${e.steeringSent}${e.steeringPending > 0 ? `(${e.steeringPending} 待投递)` : ""}`,
			);
		}
		return parts.join(" · ");
	});

	if (entries.length > maxRows) {
		lines.push(`… +${entries.length - maxRows} more`);
	}
	const active = entries.filter(
		(e) => e.status === "running" || e.status === "paused",
	).length;
	lines.push(`⊙ ${active} active · /agents-ps 干预`);
	return lines;
}

export function clampSelection(selected: number, count: number): number {
	if (count <= 0) return 0;
	return Math.min(Math.max(0, selected), count - 1);
}

export type ControlKey =
	| "up"
	| "down"
	| "enter"
	| "escape"
	| "backspace"
	| "char"
	| "other";

export interface ControlKeyEvent {
	key: ControlKey;
	char?: string;
}

export interface ControlState {
	selected: number;
	mode: "list" | "input";
	draft: string;
}

export type ControlEffect =
	| { type: "none" }
	| { type: "steer"; id: string; text: string }
	| { type: "pause"; id: string }
	| { type: "finish"; id: string }
	| { type: "abort"; id: string }
	| { type: "abort-all" }
	| { type: "close" };

/** 原始按键序列 → 归一化按键（方向键优先于 escape 匹配） */
export function normalizeKey(data: string): ControlKeyEvent {
	if (matchesKey(data, Key.up)) return { key: "up" };
	if (matchesKey(data, Key.down)) return { key: "down" };
	if (matchesKey(data, Key.enter)) return { key: "enter" };
	if (matchesKey(data, Key.escape)) return { key: "escape" };
	if (matchesKey(data, Key.backspace)) return { key: "backspace" };
	if (data.length === 1 && data >= " " && data !== "\x7f") {
		return { key: "char", char: data };
	}
	return { key: "other" };
}

/** 纯键盘状态机：列表导航 / 输入态 / 动作产出 */
export function reduceControlKey(
	state: ControlState,
	ev: ControlKeyEvent,
	entries: RunningSubagent[],
): { state: ControlState; effect: ControlEffect } {
	if (state.mode === "input") {
		switch (ev.key) {
			case "escape":
				return {
					state: { ...state, mode: "list", draft: "" },
					effect: { type: "none" },
				};
			case "enter": {
				const target = entries[state.selected];
				const text = state.draft.trim();
				if (!target) {
					return {
						state: { ...state, mode: "list" as const, draft: "" },
						effect: { type: "none" },
					};
				}
				// 暂停态：发送后保持输入态，方便连续对话（无需每轮重按 s）；
				// 运行态：回列表（排队注入通常是一次性指令）。esc 可随时退出输入态。
				const stayInput = target.status === "paused";
				const next = {
					...state,
					mode: (stayInput ? "input" : "list") as "input" | "list",
					draft: "",
				};
				if (!text) return { state: next, effect: { type: "none" } };
				return {
					state: next,
					effect: { type: "steer", id: target.id, text },
				};
			}
			case "backspace":
				return {
					state: { ...state, draft: state.draft.slice(0, -1) },
					effect: { type: "none" },
				};
			case "char":
				return {
					state: { ...state, draft: state.draft + (ev.char ?? "") },
					effect: { type: "none" },
				};
			default:
				return { state, effect: { type: "none" } };
		}
	}

	switch (ev.key) {
		case "up":
			return {
				state: { ...state, selected: Math.max(0, state.selected - 1) },
				effect: { type: "none" },
			};
		case "down":
			return {
				state: {
					...state,
					selected: clampSelection(state.selected + 1, entries.length),
				},
				effect: { type: "none" },
			};
		case "escape":
			return { state, effect: { type: "close" } };
		case "char": {
			if (ev.char === "s" && entries.length > 0) {
				return {
					state: { ...state, mode: "input", draft: "" },
					effect: { type: "none" },
				};
			}
			const target = entries[state.selected];
			if (ev.char === "p" && target && target.status === "running") {
				return { state, effect: { type: "pause", id: target.id } };
			}
			// r：显式结束并返回父级，仅对已暂停条目可用
			if (ev.char === "r" && target && target.status === "paused") {
				return { state, effect: { type: "finish", id: target.id } };
			}
			if (ev.char === "x" && target) {
				return { state, effect: { type: "abort", id: target.id } };
			}
			if (ev.char === "a" && entries.length > 0) {
				return { state, effect: { type: "abort-all" } };
			}
			return { state, effect: { type: "none" } };
		}
		default:
			return { state, effect: { type: "none" } };
	}
}

// ---------------------------------------------------------------------------
// 常驻面板控制器（不抢焦点；仅列表非空时挂 widget）
// ---------------------------------------------------------------------------

export type WidgetTui = { requestRender(): void };

export interface PanelUIContext {
	setWidget(
		key: string,
		content:
			| ((
					tui: WidgetTui,
					theme: unknown,
			  ) => { render(width: number): string[]; invalidate(): void })
			| undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
}

export interface PanelRegistry {
	list(): RunningSubagent[];
	onChange(cb: () => void): () => void;
	/**
	 * 可选：失败回写（真实注册表 SubagentRuntimeRegistry 实现；不存在的 id 静默忽略）。
	 * 声明为可选，使只读 fake（list + onChange）也能作为 PanelRegistry 注入。
	 */
	update?(id: string, patch: Partial<Omit<RunningSubagent, "id">>): void;
}

/** running 计数（防御式）：list 异常时按 0 计，供常驻面板/浮层共用的渲染兜底文案 */
function safeRunningCount(registry: PanelRegistry): number {
	try {
		return registry.list().filter((e) => e.status === "running").length;
	} catch {
		return 0;
	}
}

/** 面板挂载的最小接口（RuntimePanelController 满足；便于测试注入 fake） */
export interface PanelAttachable {
	attach(ui: unknown): void;
}

/**
 * 面板挂载的 UI 守卫：无可视 UI 不挂；挂载异常静默降级、返回 false。
 * 抽成纯接线函数以便单测覆盖（hasUI 守卫 / attach 分支）。
 */
export function attachPanelIfUI(
	ctx: { hasUI: boolean; ui: unknown },
	panel: PanelAttachable,
): boolean {
	if (!ctx.hasUI) return false;
	try {
		panel.attach(ctx.ui);
		return true;
	} catch {
		// UI 异常绝不反噬子代理执行：挂载失败最多导致可见性降级
		return false;
	}
}

export class RuntimePanelController {
	private ui?: PanelUIContext;
	private tui?: WidgetTui;
	private mounted = false;
	private unsubscribe?: () => void;
	private timer?: ReturnType<typeof setInterval>;
	// 注意：Node 22 原生类型剥离（node --test）不支持「构造函数参数属性」
	// （ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX），故显式声明字段并在构造函数内赋值。
	private readonly registry: PanelRegistry;
	private readonly now: () => number;

	constructor(registry: PanelRegistry, now: () => number = Date.now) {
		this.registry = registry;
		this.now = now;
	}

	/** 幂等：重复调用只生效一次；失败时完全回滚且不向调用方抛错 */
	attach(ui: PanelUIContext): void {
		if (this.ui) return;
		this.ui = ui;
		try {
			this.unsubscribe = this.registry.onChange(() => this.sync());
			// ticker 回调同样不得让异常逸出：requestRender 失败绝不能反噬子代理执行
			// （设计文档「错误处理」：widget 渲染、ticker 回调全部包裹 try/catch）。
			this.timer = setInterval(() => {
				try {
					this.tui?.requestRender();
				} catch {
					// 静默：UI 异常绝不反噬执行
				}
			}, 1000);
			(this.timer as unknown as { unref?: () => void }).unref?.();
			this.sync();
		} catch {
			// 瞬时 UI/注册表异常必须回滚：否则 this.ui 残留会让后续 attach 直接 return，
			// 控制器整个会话永久失联。回滚后 this.ui=undefined，下一次 attach 仍能成功。
			this.rollbackAttach();
		}
	}

	/** attach 失败回滚：清 timer、退订、尽力卸载已挂 widget，并复位字段 */
	private rollbackAttach(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		const off = this.unsubscribe;
		this.unsubscribe = undefined;
		if (off) {
			try {
				off();
			} catch {
				// 退订异常不得逸出
			}
		}
		if (this.mounted) {
			this.mounted = false;
			this.tui = undefined;
			try {
				this.ui?.setWidget(WIDGET_KEY, undefined);
			} catch {
				// 卸载异常不得逸出
			}
		}
		this.ui = undefined;
	}

	/** 彻底退订、停 ticker，并清除 widget（异常一律吞掉，对齐 attach 的不反噬约定） */
	detach(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		const off = this.unsubscribe;
		this.unsubscribe = undefined;
		if (off) {
			try {
				off();
			} catch {
				// 退订异常不得逸出
			}
		}
		try {
			this.unmountWidget();
		} catch {
			// 卸载异常不得逸出（unmountWidget 内部字段已复位）
		}
		this.ui = undefined;
	}

	/** 仅卸载 widget，保留订阅与 ticker：列表再次非空时能自动重挂 */
	private unmountWidget(): void {
		if (!this.mounted) return;
		this.mounted = false;
		this.tui = undefined;
		this.ui?.setWidget(WIDGET_KEY, undefined);
	}

	/** running 计数（防御式）：list 异常时按 0 计，供渲染兜底文案使用 */
	private runningCountSafely(): number {
		return safeRunningCount(this.registry);
	}

	private sync(): void {
		const has = this.registry.list().length > 0;
		if (has && !this.mounted) {
			this.mounted = true;
			this.ui?.setWidget(
				WIDGET_KEY,
				(tui) => {
					this.tui = tui;
					return {
						render: (width: number) => {
							try {
								return formatRuntimeLines(this.registry.list(), {
									now: this.now(),
								}).map((l) => (l.length > width ? l.slice(0, width) : l));
							} catch {
								// 设计原文兜底（UI 异常绝不反噬执行）：N 为 running 计数，异常时 0
								return [`子代理运行时：${this.runningCountSafely()} running`];
							}
						},
						invalidate: () => {},
					};
				},
				{ placement: "belowEditor" },
			);
			return;
		}
		if (!has) {
			// 清空即卸载 widget，但**不**在此处彻底 detach（不退订、不停 ticker）：
			// 同一次 execute 内 attach 与 register 之间存在窗口，上一次执行的 3s 延迟
			// 注销可能恰好在此期间触发。若此处 detach，随后 register 将无人监听，
			// 面板在该次执行中永久失联，与「attach 幂等可重入」相悖。
			this.unmountWidget();
			return;
		}
		this.tui?.requestRender();
	}
}

// ---------------------------------------------------------------------------
// 干预浮层（用户按键唤出，临时抢焦点）
// ---------------------------------------------------------------------------

/**
 * 浮层只展示、只操作 **running** 条目。
 *
 * 依据：终态条目（aborted/done/failed）在常驻面板的 3 秒终态保留期内仍留在
 * 注册表中，但其 handle 指向的 session 已 dispose，对其 steer/abort 必然报错
 * （设计文档「错误处理」：session 已 dispose → notify error）。设计文档交互章节
 * 的浮层样例也只列 running（`●`）条目，且写明「选中项结束后（列表缩短）自动把
 * selected 夹取到合法范围」——终态条目应当**从浮层列表消失**，终态展示由常驻
 * 面板负责（常驻面板明确「含刚结束、处于 3 秒终态保留期的条目」）。
 * 因此这里的列表、序号、选中夹取全部以 running 条目为基准。
 */
/** 浮层可操作条目：运行中与已暂停（暂停条目仍可对话/继续/中止）*/
function runningOnly(entries: RunningSubagent[]): RunningSubagent[] {
	return entries.filter((e) => e.status === "running" || e.status === "paused");
}

type WidgetComponent = {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
	dispose?(): void;
};

/** 按可见宽度右侧补空格（CJK 宽字符按 2 列计） */
function padToVisible(s: string, w: number): string {
	const vis = visibleWidth(s);
	return vis >= w ? s : s + " ".repeat(w - vis);
}

/**
 * 用制表符边框包裹内容，让浮层从背景中「立」起来（无边框时与正文难以区分）。
 * 宽度按 visibleWidth 计算，中文/emoji 不会错位；超宽行用 truncateToWidth 截断。
 * 返回的每一行可见宽度都等于 W，保证右边框对齐。
 */
export function renderOverlayBox(
	title: string,
	body: string[],
	width: number,
): string[] {
	const W = Math.max(4, width);
	const inner = Math.max(0, W - 4); // │␠ content ␠│

	const head = (() => {
		const full = `┌─ ${title} `;
		if (visibleWidth(full) + 1 <= W) return full;
		const t = truncateToWidth(title, Math.max(0, W - 5));
		return `┌─ ${t} `;
	})();
	const top = `${head}${ "─".repeat(Math.max(0, W - visibleWidth(head) - 1)) }┐`;
	const bottom = `└${"─".repeat(W - 2)}┘`;

	const rows = body.map((line) => {
		const clipped = truncateToWidth(line, inner);
		return `│ ${padToVisible(clipped, inner)} │`;
	});

	return [top, ...rows, bottom];
}

export type OverlayNotify = (
	message: string,
	type?: "info" | "warning" | "error",
) => void;

export class ControlOverlayComponent implements WidgetComponent {
	state: ControlState = { selected: 0, mode: "list", draft: "" };
	notice?: string;
	private tui?: WidgetTui;
	private unsubscribe?: () => void;
	private timer?: ReturnType<typeof setInterval>;
	// 注意：Node 22 原生类型剥离（node --test）不支持「构造函数参数属性」
	// （ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX），故显式声明字段并在构造函数内赋值。
	private readonly registry: PanelRegistry;
	private readonly done: (result?: unknown) => void;
	private readonly notify?: OverlayNotify;
	private readonly now: () => number;

	constructor(
		registry: PanelRegistry,
		done: (result?: unknown) => void,
		notify?: OverlayNotify,
		now: () => number = Date.now,
	) {
		this.registry = registry;
		this.done = done;
		this.notify = notify;
		this.now = now;
	}

	/** 由 ctx.ui.custom 的工厂调用，接管重绘 */
	bindTui(tui: WidgetTui): void {
		this.tui = tui;
		// onChange 与 ticker 回调均不得让 UI 异常逸出（设计文档「错误处理」：
		// widget 渲染、ticker 回调全部包裹 try/catch）。
		this.unsubscribe = this.registry.onChange(() => {
			try {
				this.tui?.requestRender();
			} catch {
				// 静默：UI 异常绝不反噬执行
			}
		});
		this.timer = setInterval(() => {
			try {
				this.tui?.requestRender();
			} catch {
				// 静默：UI 异常绝不反噬执行
			}
		}, 1000);
		(this.timer as unknown as { unref?: () => void }).unref?.();
	}

	handleInput(data: string): void {
		const entries = runningOnly(this.registry.list());
		const { state, effect } = reduceControlKey(
			this.state,
			normalizeKey(data),
			entries,
		);
		this.state = {
			...state,
			selected: clampSelection(state.selected, entries.length),
		};
		void this.applyEffect(effect, entries);
	}

	invalidate(): void {}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	/** 失败提示：写 notice 并 notify(error)；不触碰注册表 */
	private reportError(message: string): void {
		this.notice = message;
		try {
			this.notify?.(message, "error");
		} catch {
			// 静默：UI 异常绝不反噬执行
		}
	}

	/** 状态回写：handle 失败路径把条目标为 failed（注册表不支持/异常时静默忽略） */
	private markFailed(id: string): void {
		try {
			this.registry.update?.(id, { status: "failed" });
		} catch {
			// 静默：注册表异常绝不反噬执行
		}
	}

	/** 失败回写：提示 + 标记 failed */
	private reportFailure(id: string, message: string): void {
		this.reportError(message);
		this.markFailed(id);
	}

	private async applyEffect(
		effect: ControlEffect,
		entries: RunningSubagent[],
	): Promise<void> {
		try {
			switch (effect.type) {
				case "steer": {
					const target = entries.find((e) => e.id === effect.id);
					if (!target) return;
					// 设计「语义」：以 / 开头的文本是扩展命令，session.steer 会抛错。
					// 在此提前拒绝，保证不触碰 handle、steeringSent 绝不增加。
					if (effect.text.startsWith("/")) {
						this.reportError("不能注入以 / 开头的扩展命令文本");
						break;
					}
					try {
						await target.handle.steer(effect.text);
						// 暂停态会话空闲，消息会被立即执行；运行态才是排队投递
						this.notice =
							target.status === "paused"
								? `已发送给 ${target.agent}（暂停中，立即处理）`
								: `已注入指令（排队投递，子代理跑完当前工具后生效）`;
					} catch (err) {
						this.reportFailure(target.id, `操作失败：${errMessage(err)}`);
					}
					break;
				}
				case "pause": {
					const target = entries.find((e) => e.id === effect.id);
					if (!target) return;
					try {
						await target.handle.pause();
						this.notice = `已暂停 ${target.agent}（可输入消息提问，或让它继续）`;
					} catch (err) {
						this.reportFailure(target.id, `操作失败：${errMessage(err)}`);
					}
					break;
				}
				case "finish": {
					const target = entries.find((e) => e.id === effect.id);
					if (!target) return;
					try {
						await target.handle.finish();
						this.notice = `已请求结束 ${target.agent}，将返回父会话`;
					} catch (err) {
						this.reportFailure(target.id, `操作失败：${errMessage(err)}`);
					}
					break;
				}
				case "abort": {
					const target = entries.find((e) => e.id === effect.id);
					if (!target) return;
					try {
						await target.handle.abort();
						this.notice = `已中止 ${target.agent}`;
					} catch (err) {
						this.reportFailure(target.id, `操作失败：${errMessage(err)}`);
					}
					break;
				}
				case "abort-all": {
					const results = await Promise.allSettled(
						entries.map((e) => e.handle.abort()),
					);
					let failed = 0;
					entries.forEach((e, i) => {
						if (results[i].status !== "rejected") return;
						failed += 1;
						this.markFailed(e.id);
					});
					this.notice =
						failed > 0
							? `已中止 ${entries.length - failed} 个，${failed} 个失败`
							: "已中止全部子代理";
					if (failed > 0) {
						try {
							this.notify?.(this.notice, "error");
						} catch {
							// 静默：UI 异常绝不反噬执行
						}
					}
					break;
				}
				case "close":
					this.done(undefined);
					return;
				default:
					return;
			}
		} catch (err) {
			this.reportError(`操作失败：${errMessage(err)}`);
		}
		try {
			this.tui?.requestRender();
		} catch {
			// 静默：UI 异常绝不反噬执行
		}
	}

	render(width: number): string[] {
		try {
			const entries = runningOnly(this.registry.list());
			const lines: string[] = [];
			entries.slice(0, 8).forEach((e, i) => {
				const marker = i === this.state.selected ? "▸" : " ";
				const action = e.currentAction ?? e.lastLine ?? "(thinking…)";
				// 设计 mock：`↩1(排队中)`；pending 归零即视为已送达（queue_update 驱动）
				const steering =
					e.steeringSent > 0
						? `↩${e.steeringSent}${e.steeringPending > 0 ? "(排队中)" : ""}`
						: "";
				const row = `${marker} ${STATUS_ICON[e.status]} ${e.agent} · ${formatElapsed(this.now() - e.startedAt)} · ${action}`;
				lines.push(steering ? `${row} · ${steering}` : row);
			});
			if (this.state.mode === "input") {
				lines.push(
					`> 注入给 ${entries[this.state.selected]?.agent ?? "?"}: ${this.state.draft}`,
				);
				lines.push("enter 发送 · esc 退出输入");
			} else {
				lines.push("↑↓ 选择 · s 注入/提问 · p 暂停 · r 结束返回 · x 中止 · a 全部中止 · esc 关闭");
			}
			if (this.notice) lines.push(this.notice);
			return renderOverlayBox(
				`子代理运行时 (${entries.length})`,
				lines,
				width,
			);
		} catch {
			// 与常驻面板统一兜底：UI 异常绝不反噬执行，running 计数按 0 计
			return [`子代理运行时：${safeRunningCount(this.registry)} running`];
		}
	}
}

export interface OverlayUIContext {
	/** 可选：失败通知（ExtensionUIContext.notify） */
	notify?(message: string, type?: "info" | "warning" | "error"): void;
	custom<T>(
		factory: (
			tui: WidgetTui,
			theme: unknown,
			keybindings: unknown,
			done: (result: T) => void,
		) => WidgetComponent,
		options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> },
	): Promise<T>;
}

/** 打开干预浮层；无运行条目时由调用方先行拦截 */
export async function openControlOverlay(
	ui: OverlayUIContext,
	registry: PanelRegistry,
	now: () => number = Date.now,
): Promise<void> {
	await ui.custom<undefined>(
		(tui, _theme, _keybindings, done) => {
			const component = new ControlOverlayComponent(registry, done, (msg, type) => {
				try {
					ui.notify?.(msg, type);
				} catch {
					// 静默：UI 异常绝不反噬执行
				}
			}, now);
			component.bindTui(tui);
			return component;
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "70%", maxHeight: "60%" },
		},
	);
}
