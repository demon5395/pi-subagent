import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	attachPanelIfUI,
	clampSelection,
	formatElapsed,
	formatRuntimeLines,
	normalizeKey,
	reduceControlKey,
	renderOverlayBox,
	type ControlState,
} from "./panel.ts";
import type { RunningSubagent } from "./runtime.ts";

function entry(over: Partial<RunningSubagent> = {}): RunningSubagent {
	return {
		id: "implementer#1",
		agent: "implementer",
		agentSource: "global",
		task: "do something",
		mode: "single",
		slot: 0,
		startedAt: 0,
		lastEventAt: 0,
		status: "running",
		steeringSent: 0,
		steeringPending: 0,
		handle: { steer: async () => {}, pause: async () => {}, abort: async () => {}, finish: async () => {} },
		...over,
	};
}

const LIST: ControlState = { selected: 0, mode: "list", draft: "" };

test("formatElapsed 各量级", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(59_999), "59s");
	assert.equal(formatElapsed(60_000), "1m00s");
	assert.equal(formatElapsed(72_000), "1m12s");
	assert.equal(formatElapsed(3_720_000), "1h02m");
	assert.equal(formatElapsed(3_600_000), "1h00m");
});

test("formatRuntimeLines 空列表返回 []", () => {
	assert.deepEqual(formatRuntimeLines([], { now: 0 }), []);
});

test("formatRuntimeLines 单项 running（thinking 兜底）", () => {
	assert.deepEqual(formatRuntimeLines([entry()], { now: 12_000 }), [
		"● implementer · 12s · (thinking…)",
		"⊙ 1 active · /agents-ps 干预",
	]);
});

test("formatRuntimeLines 优先显示 currentAction", () => {
	const lines = formatRuntimeLines([entry({ currentAction: "bash: npm test" })], {
		now: 0,
	});
	assert.equal(lines[0], "● implementer · 0s · bash: npm test");
});

test("formatRuntimeLines 无 currentAction 时回退 lastLine", () => {
	const lines = formatRuntimeLines([entry({ lastLine: "输出中" })], { now: 0 });
	assert.ok(lines[0].includes("输出中"), lines[0]);
});

test("formatRuntimeLines 终态图标与动作", () => {
	assert.equal(
		formatRuntimeLines([entry({ status: "aborted" })], { now: 0 })[0],
		"⊘ implementer · 0s · 已中止",
	);
});

test("formatRuntimeLines done/failed 终态图标", () => {
	const done = formatRuntimeLines([entry({ status: "done" })], { now: 0 })[0];
	assert.ok(done.includes("✓"), done);
	const failed = formatRuntimeLines([entry({ status: "failed" })], { now: 0 })[0];
	assert.ok(failed.includes("✗"), failed);
});

test("formatRuntimeLines 注入计数与待投递", () => {
	const lines = formatRuntimeLines(
		[entry({ steeringSent: 2, steeringPending: 1 })],
		{ now: 0 },
	);
	assert.equal(lines[0], "● implementer · 0s · (thinking…) · ↩2(1 待投递)");
});

test("formatRuntimeLines 仅已投递时无待投递标记", () => {
	const lines = formatRuntimeLines(
		[entry({ steeringSent: 1, steeringPending: 0 })],
		{ now: 0 },
	);
	assert.ok(lines[0].includes("↩1"), lines[0]);
	assert.ok(!lines[0].includes("待投递"), lines[0]);
});

test("formatRuntimeLines 超过 maxRows 折叠并统计 running", () => {
	const entries = [
		entry({ id: "a#1", agent: "a", startedAt: 0 }),
		entry({ id: "b#2", agent: "b", startedAt: 1 }),
		entry({ id: "c#3", agent: "c", startedAt: 2 }),
		entry({ id: "d#4", agent: "d", startedAt: 3 }),
		entry({ id: "e#5", agent: "e", startedAt: 4 }),
		entry({ id: "f#6", agent: "f", startedAt: 5, status: "done" }),
	];
	const lines = formatRuntimeLines(entries, { now: 0 });
	assert.equal(lines.length, 6);
	assert.equal(lines[4], "… +2 more");
	assert.equal(lines[5], "⊙ 5 active · /agents-ps 干预");
});

test("formatRuntimeLines 恰好 maxRows 不折叠", () => {
	const entries = [
		entry({ id: "a#1", agent: "a" }),
		entry({ id: "b#2", agent: "b" }),
		entry({ id: "c#3", agent: "c" }),
		entry({ id: "d#4", agent: "d" }),
	];
	const lines = formatRuntimeLines(entries, { now: 0 });
	assert.equal(lines.length, 5);
	assert.ok(
		lines.every((l) => !l.includes("more")),
		lines.join("\n"),
	);
	assert.equal(lines[4], "⊙ 4 active · /agents-ps 干预");
});

test("formatRuntimeLines 长 agent 名截断（默认 16 列）", () => {
	const lines = formatRuntimeLines([entry({ agent: "a".repeat(20) })], { now: 0 });
	assert.ok(lines[0].startsWith(`● ${"a".repeat(15)}… · `), lines[0]);
});

test("formatRuntimeLines agent 名恰好 16 列不截断", () => {
	const name = "a".repeat(16);
	const lines = formatRuntimeLines(
		[entry({ agent: name, currentAction: "run" })],
		{ now: 0 },
	);
	assert.ok(lines[0].includes(name), lines[0]);
	assert.ok(!lines[0].includes("…"), lines[0]);
});

test("clampSelection 边界", () => {
	assert.equal(clampSelection(3, 0), 0);
	assert.equal(clampSelection(3, 2), 1);
	assert.equal(clampSelection(-1, 2), 0);
	assert.equal(clampSelection(1, 5), 1);
});

test("normalizeKey 解析方向键与功能键", () => {
	assert.deepEqual(normalizeKey("\x1b[A"), { key: "up" });
	assert.deepEqual(normalizeKey("\x1b[B"), { key: "down" });
	assert.deepEqual(normalizeKey("\r"), { key: "enter" });
	assert.deepEqual(normalizeKey("\x1b"), { key: "escape" });
	assert.deepEqual(normalizeKey("\x7f"), { key: "backspace" });
	assert.deepEqual(normalizeKey("s"), { key: "char", char: "s" });
	assert.deepEqual(normalizeKey("\x1b[99~"), { key: "other" });
});

test("reduceControlKey：↓ 到底不回绕、↑ 到顶不回绕", () => {
	const entries = [entry({ id: "a#1" }), entry({ id: "b#2" })];
	const down = reduceControlKey({ ...LIST, selected: 1 }, { key: "down" }, entries);
	assert.equal(down.state.selected, 1);
	const up = reduceControlKey({ ...LIST, selected: 0 }, { key: "up" }, entries);
	assert.equal(up.state.selected, 0);
});

test("reduceControlKey：空列表时 s/x/a 均无动作", () => {
	assert.deepEqual(reduceControlKey(LIST, { key: "char", char: "s" }, []).effect, {
		type: "none",
	});
	assert.deepEqual(reduceControlKey(LIST, { key: "char", char: "x" }, []).effect, {
		type: "none",
	});
	assert.deepEqual(reduceControlKey(LIST, { key: "char", char: "a" }, []).effect, {
		type: "none",
	});
	assert.equal(
		reduceControlKey(LIST, { key: "char", char: "s" }, []).state.mode,
		"list",
	);
});

test("reduceControlKey：s 进入输入态，enter 产出 steer effect", () => {
	const entries = [entry({ id: "implementer#7" })];
	const s = reduceControlKey(LIST, { key: "char", char: "s" }, entries);
	assert.equal(s.state.mode, "input");
	const typed = reduceControlKey(s.state, { key: "char", char: "改" }, entries);
	const done = reduceControlKey(typed.state, { key: "enter" }, entries);
	assert.deepEqual(done.effect, {
		type: "steer",
		id: "implementer#7",
		text: "改",
	});
	assert.equal(done.state.mode, "list");
	assert.equal(done.state.draft, "");
});

test("reduceControlKey：输入态空/纯空白草稿回车无动作", () => {
	const entries = [entry({ id: "implementer#7" })];
	const empty = { selected: 0, mode: "input" as const, draft: "" };
	assert.deepEqual(
		reduceControlKey(empty, { key: "enter" }, entries).effect,
		{ type: "none" },
	);
	const blank = { selected: 0, mode: "input" as const, draft: "   " };
	const r = reduceControlKey(blank, { key: "enter" }, entries);
	assert.deepEqual(r.effect, { type: "none" });
	assert.equal(r.state.mode, "list");
	assert.equal(r.state.draft, "");
});

test("reduceControlKey：steer 目标为选中项", () => {
	const entries = [entry({ id: "a#1" }), entry({ id: "b#2" })];
	const s = { selected: 1, mode: "input" as const, draft: "hi" };
	const r = reduceControlKey(s, { key: "enter" }, entries);
	assert.equal(r.effect.type, "steer");
	assert.equal((r.effect as { id: string }).id, entries[1].id);
});

test("reduceControlKey：输入态多字符累积", () => {
	const entries = [entry()];
	const s = { selected: 0, mode: "input" as const, draft: "" };
	const a = reduceControlKey(s, { key: "char", char: "a" }, entries);
	const b = reduceControlKey(a.state, { key: "char", char: "b" }, entries);
	assert.equal(b.state.draft, "ab");
});

test("reduceControlKey：输入态 esc 回列表且清空草稿", () => {
	const entries = [entry()];
	const s = reduceControlKey(LIST, { key: "char", char: "s" }, entries);
	const typed = reduceControlKey(s.state, { key: "char", char: "x" }, entries);
	const esc = reduceControlKey(typed.state, { key: "escape" }, entries);
	assert.equal(esc.state.mode, "list");
	assert.equal(esc.state.draft, "");
	assert.deepEqual(esc.effect, { type: "none" });
});

test("reduceControlKey：输入态 backspace 删一个字符", () => {
	const entries = [entry()];
	const s = { selected: 0, mode: "input" as const, draft: "abc" };
	assert.equal(
		reduceControlKey(s, { key: "backspace" }, entries).state.draft,
		"ab",
	);
});

test("reduceControlKey：列表态 x 中止选中、a 全部中止、esc 关闭", () => {
	const entries = [entry({ id: "a#1" }), entry({ id: "b#2" })];
	assert.deepEqual(
		reduceControlKey({ ...LIST, selected: 1 }, { key: "char", char: "x" }, entries)
			.effect,
		{ type: "abort", id: "b#2" },
	);
	assert.deepEqual(
		reduceControlKey(LIST, { key: "char", char: "a" }, entries).effect,
		{ type: "abort-all" },
	);
	assert.deepEqual(reduceControlKey(LIST, { key: "escape" }, entries).effect, {
		type: "close",
	});
});

test("reduceControlKey：r 对已暂停条目产出 finish effect", () => {
	const entries = [entry({ id: "p#1", status: "paused" })];
	assert.deepEqual(
		reduceControlKey({ ...LIST, selected: 0 }, { key: "char", char: "r" }, entries)
			.effect,
		{ type: "finish", id: "p#1" },
	);
});

test("reduceControlKey：r 只对已暂停条目生效（running 无动作）", () => {
	const entries = [entry({ id: "run#1", status: "running" })];
	assert.deepEqual(
		reduceControlKey(LIST, { key: "char", char: "r" }, entries).effect,
		{ type: "none" },
	);
});

test("reduceControlKey：空列表时 r 无动作", () => {
	assert.deepEqual(reduceControlKey(LIST, { key: "char", char: "r" }, []).effect, {
		type: "none",
	});
});

import {
	ControlOverlayComponent,
	RuntimePanelController,
	openControlOverlay,
	type OverlayUIContext,
	type PanelRegistry,
	type PanelUIContext,
} from "./panel.ts";
import { SubagentRuntimeRegistry, type RegisterInput } from "./runtime.ts";

function fakeUI() {
	const calls: Array<{ key: string; mounted: boolean; placement?: string }> = [];
	const ui: PanelUIContext = {
		setWidget(key, content, opts) {
			calls.push({
				key,
				mounted: content !== undefined,
				placement: opts?.placement,
			});
		},
	};
	return { ui, calls };
}

function regInput(over: Partial<RegisterInput> = {}): RegisterInput {
	// handle 按字段合并，保证任何用例都自带完整的三个闭包（steer/pause/abort），
	// 不会因局部 override 缺失 pause 而崩溃。
	const { handle, ...rest } = over;
	return {
		agent: "implementer",
		agentSource: "global",
		task: "t",
		mode: "single",
		slot: 0,
		startedAt: 0,
		...rest,
		handle: {
			steer: async () => {},
			pause: async () => {},
			abort: async () => {},
			finish: async () => {},
			...(handle ?? {}),
		},
	};
}

test("面板控制器：空注册表 attach 不挂 widget", () => {
	const reg = new SubagentRuntimeRegistry();
	const { ui, calls } = fakeUI();
	const panel = new RuntimePanelController(reg);
	panel.attach(ui);
	assert.equal(calls.length, 0);
	panel.detach();
});

test("面板控制器：有子代理时挂 widget（belowEditor），清空时卸载", () => {
	const reg = new SubagentRuntimeRegistry();
	const { ui, calls } = fakeUI();
	const panel = new RuntimePanelController(reg);
	panel.attach(ui);
	const id = reg.register(regInput());
	assert.equal(calls.at(-1)?.mounted, true);
	assert.equal(calls.at(-1)?.placement, "belowEditor");
	assert.equal(calls.at(-1)?.key, "subagent-runtime");
	reg.unregister(id);
	assert.equal(calls.at(-1)?.mounted, false);
	panel.detach();
});

// ---------------------------------------------------------------------------
// 生命周期与渲染链路：用「包装 registry 计 active 订阅」+「monkeypatch
// setInterval/clearInterval 计 live timer / unref」替代 setWidget 调用次数断言，
// 保证变异体无法存活（订阅/定时器泄漏、误卸载、重挂回归、渲染异常逸出）。
// ---------------------------------------------------------------------------

interface CountingRegistry {
	wrapper: PanelRegistry;
	inner: SubagentRuntimeRegistry;
	readonly active: number;
	readonly subscribeCount: number;
}

/** list 透传 + onChange 计 active 订阅（退订递减） */
function countingRegistry(): CountingRegistry {
	let active = 0;
	let subscribeCount = 0;
	const inner = new SubagentRuntimeRegistry();
	const wrapper: PanelRegistry = {
		list: () => inner.list(),
		onChange: (cb) => {
			subscribeCount += 1;
			active += 1;
			const off = inner.onChange(cb);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				active -= 1;
				off();
			};
		},
	};
	return {
		wrapper,
		inner,
		get active() {
			return active;
		},
		get subscribeCount() {
			return subscribeCount;
		},
	};
}

interface FakeTimerHandle {
	unref(): void;
}

/** monkeypatch 全局定时器：记录 live timer、unref 调用，并可手动触发回调 */
function fakeTimers() {
	const realSet = globalThis.setInterval;
	const realClear = globalThis.clearInterval;
	const live = new Set<FakeTimerHandle>();
	const created: FakeTimerHandle[] = [];
	const unrefed = new Set<FakeTimerHandle>();
	const callbacks = new Map<FakeTimerHandle, () => void>();
	// 记录每次 setInterval 的间隔，用于钉住刷新增速（规格：每秒一次）
	const delays: number[] = [];

	globalThis.setInterval = ((cb: () => void, ms?: number) => {
		delays.push(ms ?? Number.NaN);
		const handle: FakeTimerHandle = {
			unref() {
				unrefed.add(handle);
			},
		};
		created.push(handle);
		live.add(handle);
		callbacks.set(handle, cb);
		return handle;
	}) as unknown as typeof globalThis.setInterval;
	globalThis.clearInterval = ((h: unknown) => {
		live.delete(h as FakeTimerHandle);
	}) as unknown as typeof globalThis.clearInterval;

	return {
		get liveCount() {
			return live.size;
		},
		created,
		unrefed,
		delays,
		fireAll() {
			for (const cb of [...callbacks.values()]) cb();
		},
		restore() {
			globalThis.setInterval = realSet;
			globalThis.clearInterval = realClear;
		},
	};
}

type WidgetFactory = (
	tui: { requestRender(): void },
	theme: unknown,
) => { render(width: number): string[]; invalidate(): void };

/** 捕获 widget 工厂、提供可计数的假 tui，并记录每次 setWidget */
function fakeRenderingUI() {
	const calls: Array<{ key: string; content: unknown; mounted: boolean }> = [];
	let totalCount = 0;
	let factory: WidgetFactory | undefined;
	// requestRender 必须依赖 this（而非纯闭包计数）：一旦调用方丢失 this 绑定
	// （如 setInterval(this.tui.requestRender, …) / 解构后裸调用），计数不会增长，
	// 这类回归才能被断言捕获。totalCount 仅由 this 方法内递增，getter 读它。
	const tui = {
		count: 0,
		requestRender() {
			this.count += 1;
			totalCount += 1;
		},
	};
	const ui: PanelUIContext = {
		setWidget(key, content) {
			calls.push({ key, content, mounted: content !== undefined });
			if (typeof content === "function") factory = content as WidgetFactory;
		},
	};
	return {
		ui,
		calls,
		tui,
		get factory() {
			return factory;
		},
		get requestRenderCount() {
			return totalCount;
		},
	};
}

test("面板控制器：attach 三次只保留一个 active 订阅", () => {
	const reg = countingRegistry();
	const { ui } = fakeUI();
	const panel = new RuntimePanelController(reg.wrapper);
	panel.attach(ui);
	panel.attach(ui);
	panel.attach(ui);
	assert.equal(reg.active, 1);
	assert.equal(reg.subscribeCount, 1);
	panel.detach();
	assert.equal(reg.active, 0);
});

test("面板控制器：attach 两次仅一个 ticker，detach 清停且 unref 已调用", () => {
	const reg = countingRegistry();
	const { ui } = fakeUI();
	const panel = new RuntimePanelController(reg.wrapper);
	const timers = fakeTimers();
	try {
		panel.attach(ui);
		panel.attach(ui);
		assert.equal(timers.liveCount, 1);
		assert.equal(timers.created.length, 1);
		assert.ok(
			timers.created.every((h) => timers.unrefed.has(h)),
			"每个创建的 timer 都必须调用 unref（否则阻塞进程退出）",
		);
		panel.detach();
		assert.equal(timers.liveCount, 0);
	} finally {
		timers.restore();
	}
});

test("面板控制器：detach 在挂载态卸载 widget、退订，之后注册无任何 setWidget", () => {
	const reg = countingRegistry();
	const { ui, calls } = fakeUI();
	const panel = new RuntimePanelController(reg.wrapper);
	panel.attach(ui);
	reg.inner.register(regInput());
	assert.equal(calls.at(-1)?.mounted, true);
	const beforeDetach = calls.length;

	panel.detach();
	assert.equal(calls.length, beforeDetach + 1);
	assert.equal(calls.at(-1)?.mounted, false);
	assert.equal(calls.at(-1)?.key, "subagent-runtime");
	assert.equal(reg.active, 0);

	reg.inner.register(regInput());
	assert.equal(calls.length, beforeDetach + 1);
});

test("面板控制器：detach 后重新 attach 仍能挂载", () => {
	const reg = countingRegistry();
	const { ui, calls } = fakeUI();
	const panel = new RuntimePanelController(reg.wrapper);
	panel.attach(ui);
	reg.inner.register(regInput());
	panel.detach();
	assert.equal(calls.at(-1)?.mounted, false);

	panel.attach(ui);
	assert.equal(reg.active, 1);
	assert.equal(calls.at(-1)?.mounted, true);
	assert.equal(calls.at(-1)?.key, "subagent-runtime");
	panel.detach();
});

test("面板控制器：detach 卸载 setWidget 抛错时吞异常、字段复位，后续 attach 仍可用", () => {
	const reg = new SubagentRuntimeRegistry();
	const { ui, calls } = fakeUI();
	const throwingUI: PanelUIContext = {
		setWidget(key, content, opts) {
			if (content === undefined) throw new Error("unmount boom");
			ui.setWidget(key, content, opts);
		},
	};
	const panel = new RuntimePanelController(reg);
	panel.attach(throwingUI);
	reg.register(regInput());
	assert.equal(calls.at(-1)?.mounted, true);

	assert.doesNotThrow(() => panel.detach(), "detach 不得向调用方抛错");
	// 字段已复位：后续 attach 能重新挂载
	assert.doesNotThrow(() => panel.attach(ui));
	assert.equal(calls.at(-1)?.mounted, true);
	panel.detach();
});

test("面板控制器：detach 退订抛错时吞异常、字段复位（对齐 attach 的不反噬约定）", () => {
	const base = new SubagentRuntimeRegistry();
	let active = 0;
	const wrapper: PanelRegistry = {
		list: () => base.list(),
		onChange: () => {
			active += 1;
			return () => {
				active -= 1;
				throw new Error("off boom");
			};
		},
	};
	const { ui } = fakeUI();
	const panel = new RuntimePanelController(wrapper);
	panel.attach(ui);
	assert.equal(active, 1);
	assert.doesNotThrow(() => panel.detach(), "退订异常不得逸出");
	assert.equal(active, 0, "计数已在抛错前递减");
});

test("面板控制器：attach 遇 setWidget 抛错时回滚，后续 attach 仍能成功挂载", () => {
	const reg = countingRegistry();
	const badUI: PanelUIContext = {
		setWidget() {
			throw new Error("setWidget boom");
		},
	};
	const { ui, calls } = fakeUI();
	const panel = new RuntimePanelController(reg.wrapper);
	const timers = fakeTimers();
	try {
		reg.inner.register(regInput());

		// 首次 attach：setWidget 抛错 → 内部吞掉 + 完整回滚，绝不向调用方抛
		assert.doesNotThrow(() => panel.attach(badUI));
		assert.equal(reg.active, 0, "回滚必须退订");
		assert.equal(timers.liveCount, 0, "回滚必须清停 ticker");
		assert.equal(calls.length, 0, "坏 UI 不得挂载");

		// this.ui 已回滚清空：后续 attach 正常 UI 仍能重新订阅并挂载
		panel.attach(ui);
		assert.equal(reg.active, 1, "后续 attach 必须重新订阅");
		assert.equal(timers.liveCount, 1, "后续 attach 必须重建 ticker");
		assert.equal(calls.at(-1)?.mounted, true, "setWidget 必须以挂载态被调用");
		assert.equal(calls.at(-1)?.key, "subagent-runtime");
		assert.equal(calls.at(-1)?.placement, "belowEditor");
		panel.detach();
	} finally {
		timers.restore();
	}
});

test("面板控制器：清空后再次非空自动重挂（订阅未丢）", () => {
	const reg = countingRegistry();
	const { ui, calls } = fakeUI();
	const panel = new RuntimePanelController(reg.wrapper);
	panel.attach(ui);
	const id = reg.inner.register(regInput());
	assert.equal(calls.at(-1)?.mounted, true);

	reg.inner.unregister(id);
	assert.equal(calls.at(-1)?.mounted, false);
	const afterUnmount = calls.length;

	reg.inner.register(regInput());
	assert.equal(calls.length, afterUnmount + 1);
	assert.equal(calls.at(-1)?.mounted, true);
	assert.equal(calls.at(-1)?.key, "subagent-runtime");
	assert.equal(reg.active, 1);
	panel.detach();
});

test("面板控制器：已挂载态下 update 不重复 setWidget", () => {
	const reg = countingRegistry();
	const { ui, calls } = fakeUI();
	const panel = new RuntimePanelController(reg.wrapper);
	panel.attach(ui);
	const id = reg.inner.register(regInput());
	const mountedCalls = calls.length;

	reg.inner.update(id, { currentAction: "bash: x" });
	assert.equal(calls.length, mountedCalls);
	panel.detach();
});

test("面板控制器：渲染链路内容、宽度截断与 list 异常兜底", () => {
	const reg = countingRegistry();
	const f = fakeRenderingUI();
	const panel = new RuntimePanelController(reg.wrapper);
	panel.attach(f.ui);
	reg.inner.register(regInput({ agent: "implementer" }));
	assert.ok(f.factory, "widget 工厂应已挂载");
	const widget = f.factory!(f.tui, {});

	// ① 行内容包含 agent 名
	const wide = widget.render(120);
	assert.ok(
		wide.some((l) => l.includes("implementer")),
		wide.join("\n"),
	);

	// ② 宽度截断：每行长度不超过给定 width
	const narrow = widget.render(20);
	assert.ok(narrow.length > 0);
	assert.ok(
		narrow.every((l) => l.length <= 20),
		narrow.map((l) => `${l.length}:${l}`).join(" | "),
	);

	// ③ list() 抛错 → 返回设计原文兜底行且不抛（异常时 running 计数按 0）
	const originalList = reg.wrapper.list;
	(reg.wrapper as { list: () => RunningSubagent[] }).list = () => {
		throw new Error("list boom");
	};
	let fallback: string[] = [];
	assert.doesNotThrow(() => {
		fallback = widget.render(80);
	});
	assert.deepEqual(fallback, ["子代理运行时：0 running"]);
	(reg.wrapper as { list: () => RunningSubagent[] }).list = originalList;
	panel.detach();
});

test("面板控制器：已挂载态下 onChange 触发 requestRender", () => {
	const reg = countingRegistry();
	const f = fakeRenderingUI();
	const panel = new RuntimePanelController(reg.wrapper);
	panel.attach(f.ui);
	const id = reg.inner.register(regInput());
	assert.ok(f.factory, "widget 工厂应已挂载");
	f.factory!(f.tui, {}); // 模拟 TUI 拉取工厂并回传 tui

	const before = f.requestRenderCount;
	reg.inner.update(id, { currentAction: "bash: x" });
	assert.equal(f.requestRenderCount, before + 1);
	panel.detach();
});

test("面板控制器：ticker 每次 tick 驱动一次 requestRender", () => {
	const reg = countingRegistry();
	const f = fakeRenderingUI();
	const panel = new RuntimePanelController(reg.wrapper);
	const timers = fakeTimers();
	try {
		panel.attach(f.ui);
		reg.inner.register(regInput());
		assert.ok(f.factory, "widget 工厂应已挂载");
		f.factory!(f.tui, {}); // 模拟 TUI 拉取工厂并回传 tui

		const before = f.requestRenderCount;
		timers.fireAll();
		assert.equal(
			f.requestRenderCount,
			before + 1,
			"ticker 回调必须真实驱动 tui.requestRender（空回调即回归）",
		);
		panel.detach();
	} finally {
		timers.restore();
	}
});

test("面板控制器：卸载 widget 后 ticker 不再驱动旧 tui", () => {
	const reg = countingRegistry();
	const f = fakeRenderingUI();
	const panel = new RuntimePanelController(reg.wrapper);
	const timers = fakeTimers();
	try {
		panel.attach(f.ui);
		const id = reg.inner.register(regInput());
		assert.ok(f.factory, "widget 工厂应已挂载");
		f.factory!(f.tui, {});

		reg.inner.unregister(id);
		const afterUnmount = f.requestRenderCount;
		timers.fireAll();
		assert.equal(
			f.requestRenderCount,
			afterUnmount,
			"unmountWidget 必须清掉 this.tui，否则 ticker 会继续驱动已卸载的旧 tui",
		);
		panel.detach();
	} finally {
		timers.restore();
	}
});

test("面板控制器：ticker 间隔为 1000ms（每秒刷新）", () => {
	const reg = countingRegistry();
	const { ui } = fakeUI();
	const panel = new RuntimePanelController(reg.wrapper);
	const timers = fakeTimers();
	try {
		panel.attach(ui);
		assert.equal(timers.delays.length, 1);
		assert.equal(timers.delays[0], 1000, "规格要求每秒刷新一次");
		panel.detach();
	} finally {
		timers.restore();
	}
});

test("面板控制器：ticker 回调异常不逸出", () => {
	const reg = countingRegistry();
	const f = fakeRenderingUI();
	const panel = new RuntimePanelController(reg.wrapper);
	const timers = fakeTimers();
	try {
		panel.attach(f.ui);
		reg.inner.register(regInput());
		assert.ok(f.factory, "widget 工厂应已挂载");
		f.factory!(f.tui, {});
		let tickCalls = 0;
		f.tui.requestRender = () => {
			tickCalls += 1;
			throw new Error("render boom");
		};
		let escaped: unknown;
		try {
			timers.fireAll();
		} catch (e) {
			escaped = e;
		}
		// 先证明 ticker 真的驱动了 requestRender（否则本用例是真空断言），再证明异常未逸出
		assert.ok(tickCalls >= 1, "ticker 必须调用到 requestRender");
		assert.equal(escaped, undefined, "render 异常不得逸出 ticker 回调");
		panel.detach();
	} finally {
		timers.restore();
	}
});

// ---------------------------------------------------------------------------
// 干预浮层：用 /agents-ps 唤出，临时抢焦点；操作对象为 running 与 paused 条目
// （终态条目的 handle 指向已 dispose 的 session，steer/abort 必报错）。
// ---------------------------------------------------------------------------

test("浮层：渲染标题、agent 名与按键提示", () => {
	const reg = new SubagentRuntimeRegistry();
	reg.register(regInput());
	const c = new ControlOverlayComponent(reg, () => {});
	const out = c.render(80).join("\n");
	assert.match(out, /子代理运行时/);
	assert.match(out, /implementer/);
	assert.match(out, /s 注入\/提问/);
});

test("浮层：s → 输入 → enter 调用 handle.steer 并回到列表态", async () => {
	const reg = new SubagentRuntimeRegistry();
	const steered: string[] = [];
	reg.register(
		regInput({
			handle: {
				steer: async (t) => {
					steered.push(t);
				},
				abort: async () => {},
			},
		}),
	);
	const c = new ControlOverlayComponent(reg, () => {});
	c.handleInput("s");
	assert.equal(c.state.mode, "input");
	c.handleInput("h");
	c.handleInput("i");
	assert.equal(c.state.draft, "hi");
	c.handleInput("\r");
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(steered, ["hi"]);
	assert.equal(c.state.mode, "list");
});

test("浮层：x 中止选中，a 全部中止", async () => {
	const reg = new SubagentRuntimeRegistry();
	const aborted: string[] = [];
	const mk = (name: string) =>
		reg.register(
			regInput({
				agent: name,
				handle: {
					steer: async () => {},
					abort: async () => {
						aborted.push(name);
					},
				},
			}),
		);
	mk("a");
	mk("b");
	const c = new ControlOverlayComponent(reg, () => {});
	c.handleInput("x");
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(aborted, ["a"]);
	c.handleInput("a");
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(aborted, ["a", "a", "b"]);
});

test("浮层：esc 关闭", () => {
	const reg = new SubagentRuntimeRegistry();
	let closed = false;
	const c = new ControlOverlayComponent(reg, () => {
		closed = true;
	});
	c.handleInput("\x1b");
	assert.equal(closed, true);
});

test("浮层：steer 抛错时记录 notice 并渲染出来", async () => {
	const reg = new SubagentRuntimeRegistry();
	reg.register(
		regInput({
			handle: {
				steer: async () => {
					throw new Error("不能注入以 / 开头的扩展命令文本");
				},
				abort: async () => {},
			},
		}),
	);
	const c = new ControlOverlayComponent(reg, () => {});
	c.handleInput("s");
	c.handleInput("!");
	c.handleInput("\r");
	await new Promise((r) => setTimeout(r, 0));
	assert.match(c.render(80).join("\n"), /不能注入以 \/ 开头/);
});

test("浮层：终态条目不计入列表、不可选中、不参与全部中止", async () => {
	const reg = new SubagentRuntimeRegistry();
	const aborted: string[] = [];
	const mkAbort = (name: string) => async () => {
		aborted.push(name);
	};
	reg.register(
		regInput({
			agent: "done-one",
			status: "done",
			handle: { steer: async () => {}, abort: mkAbort("done-one") },
		}),
	);
	reg.register(
		regInput({
			agent: "running-one",
			handle: { steer: async () => {}, abort: mkAbort("running-one") },
		}),
	);
	const c = new ControlOverlayComponent(reg, () => {});
	const out = c.render(80).join("\n");
	assert.ok(!out.includes("done-one"), `终态条目不应出现在浮层列表：\n${out}`);
	assert.match(out, /running-one/);
	assert.match(out, /子代理运行时 \(1\)/);
	assert.equal(c.state.selected, 0);

	// a（全部中止）只作用于 running 条目，绝不触碰已 dispose 的终态 session
	c.handleInput("a");
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(aborted, ["running-one"]);
});

// ---------------------------------------------------------------------------
// 审查反馈补强：目标解析、中止汇总、生命周期与渲染细节
// ---------------------------------------------------------------------------

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test("浮层：x / s 的目标为选中项而非首项", async () => {
	const reg = new SubagentRuntimeRegistry();
	const steered: string[] = [];
	const aborted: string[] = [];
	let i = 0;
	const mk = (name: string) =>
		reg.register(
			regInput({
				agent: name,
				startedAt: i++,
				handle: {
					steer: async (t) => {
						steered.push(`${name}:${t}`);
					},
					abort: async () => {
						aborted.push(name);
					},
				},
			}),
		);
	mk("a");
	mk("b");
	const c = new ControlOverlayComponent(reg, () => {});

	// ↓ 选中第二条（b）
	c.handleInput("\x1b[B");
	assert.equal(c.state.selected, 1);

	// s + 文本 + enter 只作用于 b
	c.handleInput("s");
	c.handleInput("h");
	c.handleInput("i");
	c.handleInput("\r");
	await tick();
	assert.deepEqual(steered, ["b:hi"]);

	// x 仍只作用于 b
	c.handleInput("x");
	await tick();
	assert.deepEqual(aborted, ["b"]);
});

test("浮层：abort-all 部分失败时 notify error、失败条目回写 failed、正常条目不被误写", async () => {
	const reg = new SubagentRuntimeRegistry();
	const aborted: string[] = [];
	const okId = reg.register(
		regInput({
			agent: "ok",
			startedAt: 0,
			handle: {
				steer: async () => {},
				abort: async () => {
					aborted.push("ok");
				},
			},
		}),
	);
	const boomId = reg.register(
		regInput({
			agent: "boom",
			startedAt: 1,
			handle: {
				steer: async () => {},
				abort: async () => {
					throw new Error("abort boom");
				},
			},
		}),
	);
	const notified: Array<{ msg: string; type?: string }> = [];
	const rejections: unknown[] = [];
	const onRejection = (r: unknown) => rejections.push(r);
	process.on("unhandledRejection", onRejection);
	try {
		const c = new ControlOverlayComponent(reg, () => {}, (msg, type) =>
			notified.push({ msg, type }),
		);
		c.handleInput("a");
		await tick();
		await tick();
		assert.deepEqual(aborted, ["ok"], "正常条目的 abort 必须被调用");
		assert.ok(c.notice, "notice 必须非空");
		assert.match(c.notice!, /1 个失败/, c.notice);
		// 部分失败必须 notify error，不得静默
		assert.equal(notified.length, 1, "notify 必须恰好收到一次失败通知");
		assert.equal(notified[0].type, "error");
		assert.match(notified[0].msg, /1 个失败/);
		// 失败条目回写 failed；正常条目绝不误写
		assert.equal(reg.get(boomId)?.status, "failed", "失败条目必须回写 failed");
		assert.equal(
			reg.get(okId)?.status,
			"running",
			"正常条目不得被误写为 failed",
		);
		assert.deepEqual(rejections, [], "不得产生 unhandled rejection");
	} finally {
		process.off("unhandledRejection", onRejection);
	}
});

test("浮层：list 抛错时 render 不逸出并返回与常驻面板一致的兜底行", () => {
	const reg = countingRegistry();
	const running = [entry({ status: "running" })];
	let calls = 0;
	// 第一次 list（render 主路径）抛错 → 进入兜底；兜底内的计数 list 正常返回
	(reg.wrapper as { list: () => RunningSubagent[] }).list = () => {
		calls += 1;
		if (calls === 1) throw new Error("list boom");
		return running;
	};
	const c = new ControlOverlayComponent(reg.wrapper, () => {});
	let out: string[] = [];
	assert.doesNotThrow(() => {
		out = c.render(80);
	});
	assert.equal(calls, 2, "兜底必须重新按 running 计数而非硬编码 0");
	assert.deepEqual(out, ["子代理运行时：1 running"]);
	c.dispose();
});

test("浮层：bindTui 订阅 + 1000ms ticker，dispose 后清停", () => {
	const reg = countingRegistry();
	const timers = fakeTimers();
	const tui = {
		count: 0,
		requestRender() {
			this.count += 1;
		},
	};
	try {
		const c = new ControlOverlayComponent(reg.wrapper, () => {});
		c.bindTui(tui);
		assert.equal(timers.delays.length, 1);
		assert.equal(timers.delays[0], 1000, "浮层每秒刷新");
		assert.equal(timers.liveCount, 1);

		const beforeTick = tui.count;
		timers.fireAll();
		assert.equal(tui.count, beforeTick + 1, "tick 必须驱动 requestRender");

		const beforeRegister = tui.count;
		reg.inner.register(regInput());
		assert.equal(tui.count, beforeRegister + 1, "订阅必须触发 requestRender");
		assert.equal(reg.active, 1);

		c.dispose();
		assert.equal(timers.liveCount, 0, "dispose 必须 clearInterval");
		assert.equal(reg.active, 0, "dispose 必须退订");

		const afterDispose = tui.count;
		reg.inner.register(regInput());
		assert.equal(tui.count, afterDispose, "dispose 后注册表变化不得再重绘");
	} finally {
		timers.restore();
	}
});

test("浮层：render 宽度截断（每行 <= width）", () => {
	const reg = new SubagentRuntimeRegistry();
	reg.register(
		regInput({
			agent: "implementer-with-long-name",
			startedAt: 0,
			currentAction: "bash: a very long command line",
		}),
	);
	reg.register(
		regInput({
			agent: "reviewer",
			startedAt: 1,
			currentAction: "read: 很长的文件路径/还有一个长文件名.ts",
		}),
	);
	const c = new ControlOverlayComponent(reg, () => {});
	const lines = c.render(10);
	assert.ok(lines.length > 0);
	assert.ok(
		// 用可见宽度而非 .length：边框对齐与 ANSI 重置序列都要求如此
		lines.every((l) => visibleWidth(l) <= 10),
		lines.map((l) => `${visibleWidth(l)}:${l}`).join(" | "),
	);
});

test("浮层：abort 抛错时 notify error、status 回写 failed，不逸出也不误报成功", async () => {
	const reg = new SubagentRuntimeRegistry();
	const id = reg.register(
		regInput({
			agent: "boom",
			handle: {
				steer: async () => {},
				abort: async () => {
					throw new Error("abort boom");
				},
			},
		}),
	);
	const notified: Array<{ msg: string; type?: string }> = [];
	const rejections: unknown[] = [];
	const onRejection = (r: unknown) => rejections.push(r);
	process.on("unhandledRejection", onRejection);
	try {
		const c = new ControlOverlayComponent(reg, () => {}, (msg, type) =>
			notified.push({ msg, type }),
		);
		c.handleInput("x");
		await tick();
		await tick();
		assert.ok(c.notice, "notice 必须非空");
		assert.match(c.notice!, /操作失败/);
		assert.match(c.notice!, /abort boom/);
		assert.ok(!c.notice!.includes("已中止"), `不得误报成功：${c.notice}`);
		assert.ok(!c.render(200).join("\n").includes("已中止"));
		assert.equal(reg.get(id)?.status, "failed", "handle 失败必须回写 failed");
		assert.equal(notified.length, 1, "notify 必须恰好收到一次通知");
		assert.equal(notified[0].type, "error", "失败通知类型必须为 error");
		assert.match(notified[0].msg, /abort boom/);
		assert.deepEqual(rejections, [], "await 缺失会变成 unhandled rejection");
	} finally {
		process.off("unhandledRejection", onRejection);
	}
});

test("浮层：steer 抛错时 notify error 且 status 回写 failed", async () => {
	const reg = new SubagentRuntimeRegistry();
	const id = reg.register(
		regInput({
			agent: "boom",
			handle: {
				steer: async () => {
					throw new Error("steer boom");
				},
				abort: async () => {},
			},
		}),
	);
	const notified: Array<{ msg: string; type?: string }> = [];
	const c = new ControlOverlayComponent(reg, () => {}, (msg, type) =>
		notified.push({ msg, type }),
	);
	c.handleInput("s");
	c.handleInput("h");
	c.handleInput("i");
	c.handleInput("\r");
	await tick();
	assert.match(c.notice ?? "", /操作失败/);
	assert.match(c.notice ?? "", /steer boom/);
	assert.equal(reg.get(id)?.status, "failed", "steer 失败必须回写 failed");
	assert.equal(notified.length, 1);
	assert.equal(notified[0].type, "error");
	assert.match(notified[0].msg, /steer boom/);
});

test("浮层：以 / 开头的注入用设计原文提示、notify error，且不调用 handle、不增加 steeringSent", async () => {
	const reg = new SubagentRuntimeRegistry();
	let steerCalls = 0;
	const id = reg.register(
		regInput({
			agent: "worker",
			handle: {
				steer: async () => {
					steerCalls += 1;
				},
				abort: async () => {},
			},
		}),
	);
	const notified: Array<{ msg: string; type?: string }> = [];
	const c = new ControlOverlayComponent(reg, () => {}, (msg, type) =>
		notified.push({ msg, type }),
	);
	c.handleInput("s");
	for (const ch of "/help") c.handleInput(ch);
	c.handleInput("\r");
	await tick();
	assert.match(c.notice ?? "", /不能注入以 \/ 开头的扩展命令文本/);
	assert.deepEqual(notified, [
		{ msg: "不能注入以 / 开头的扩展命令文本", type: "error" },
	]);
	assert.equal(steerCalls, 0, "以 / 开头的文本不得送入 handle.steer");
	assert.equal(reg.get(id)?.steeringSent, 0, "steeringSent 不得增加");
});

test("浮层：steer 成功 notice 非空且出现在 render 输出", async () => {
	const reg = new SubagentRuntimeRegistry();
	reg.register(regInput({ agent: "worker" }));
	const c = new ControlOverlayComponent(reg, () => {});

	c.handleInput("s");
	c.handleInput("h");
	c.handleInput("\r");
	await tick();
	assert.ok(c.notice && c.notice.length > 0);
	assert.ok(c.render(200).join("\n").includes(c.notice!));
});

test("浮层：先 steer 后 x，abort 成功文案不被残留 notice 掩盖（M27）", async () => {
	const reg = new SubagentRuntimeRegistry();
	reg.register(regInput({ agent: "worker" }));
	const c = new ControlOverlayComponent(reg, () => {});

	// 先走一次 steer 制造 notice 残留：若 abort 分支不重写 notice，弱断言会误判通过
	c.handleInput("s");
	c.handleInput("h");
	c.handleInput("\r");
	await tick();
	assert.ok(c.notice && c.notice.length > 0);

	c.notice = undefined;
	c.handleInput("x");
	await tick();
	assert.match(c.notice ?? "", /已中止 worker/);
	assert.ok(
		c.render(200).join("\n").includes("已中止 worker"),
		"render 输出必须包含 abort 成功文案",
	);
});

test("浮层：r 对已暂停条目调用 handle.finish 并渲染 notice", async () => {
	const reg = new SubagentRuntimeRegistry();
	let finishCalls = 0;
	reg.register(
		regInput({
			agent: "worker",
			status: "paused",
			handle: {
				finish: async () => {
					finishCalls += 1;
				},
			},
		}),
	);
	const c = new ControlOverlayComponent(reg, () => {});

	c.handleInput("r");
	await tick();
	assert.equal(finishCalls, 1, "r 必须且只能调用一次 handle.finish");
	assert.match(c.notice ?? "", /结束/);
	assert.ok(c.render(200).join("\n").includes("结束"));
});

test("浮层：r 不作用于运行中的条目（不调用 handle.finish）", async () => {
	const reg = new SubagentRuntimeRegistry();
	let finishCalls = 0;
	reg.register(
		regInput({
			agent: "worker",
			status: "running",
			handle: {
				finish: async () => {
					finishCalls += 1;
				},
			},
		}),
	);
	const c = new ControlOverlayComponent(reg, () => {});

	c.handleInput("r");
	await tick();
	assert.equal(finishCalls, 0, "运行中条目不得被 r 结束");
	assert.equal(c.notice, undefined);
});

test("浮层：finish 抛错时 notify error、status 回写 failed，不逸出", async () => {
	const reg = new SubagentRuntimeRegistry();
	const id = reg.register(
		regInput({
			agent: "boom",
			status: "paused",
			handle: {
				finish: async () => {
					throw new Error("finish boom");
				},
			},
		}),
	);
	const notified: Array<{ msg: string; type?: string }> = [];
	const c = new ControlOverlayComponent(reg, () => {}, (msg, type) =>
		notified.push({ msg, type }),
	);
	c.handleInput("r");
	await tick();
	assert.match(c.notice ?? "", /操作失败/);
	assert.match(c.notice ?? "", /finish boom/);
	assert.equal(reg.get(id)?.status, "failed", "finish 失败必须回写 failed");
	assert.equal(notified.length, 1);
	assert.equal(notified[0].type, "error");
	assert.match(notified[0].msg, /finish boom/);
});

test("浮层：首次动作即 x 中止成功并渲染 notice", async () => {
	const reg = new SubagentRuntimeRegistry();
	reg.register(regInput({ agent: "worker" }));
	const c = new ControlOverlayComponent(reg, () => {});

	c.handleInput("x");
	await tick();
	assert.match(c.notice ?? "", /已中止 worker/);
	assert.ok(c.render(200).join("\n").includes("已中止 worker"));
});

test("浮层：abort-all 全成功路径 notice 为「已中止全部」并渲染", async () => {
	const reg = new SubagentRuntimeRegistry();
	reg.register(regInput({ agent: "a", startedAt: 0 }));
	reg.register(regInput({ agent: "b", startedAt: 1 }));
	const c = new ControlOverlayComponent(reg, () => {});

	c.handleInput("a");
	await tick();
	assert.match(c.notice ?? "", /已中止全部/);
	assert.ok(c.render(200).join("\n").includes("已中止全部"));
});

test("浮层：openControlOverlay 接线 overlay 选项、bindTui 接管与 done 透传", async () => {
	const reg = new SubagentRuntimeRegistry();
	const tui = {
		count: 0,
		requestRender() {
			this.count += 1;
		},
	};
	const timers = fakeTimers();
	let seenOptions:
		| { overlay?: boolean; overlayOptions?: Record<string, unknown> }
		| undefined;
	let seenComponent:
		| { handleInput(data: string): void; dispose(): void }
		| undefined;
	const doneCalls: unknown[] = [];
	const ui = {
		custom(
			factory: (
				tui: { requestRender(): void },
				theme: unknown,
				keybindings: unknown,
				done: (result: unknown) => void,
			) => unknown,
			options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> },
		): Promise<unknown> {
			seenOptions = options;
			return new Promise((resolve) => {
				seenComponent = factory(tui, {}, {}, (result) => {
					doneCalls.push(result);
					resolve(result);
				}) as { handleInput(data: string): void; dispose(): void };
			});
		},
	} as unknown as OverlayUIContext;
	try {
		const pending = openControlOverlay(ui, reg);
		assert.ok(seenComponent, "工厂必须被调用");
		assert.equal(timers.delays.at(-1), 1000);

		// 工厂返回值已由 bindTui 接管：订阅生效
		const before = tui.count;
		reg.register(regInput());
		assert.equal(tui.count, before + 1, "bindTui 未接管订阅");

		// done 透传：esc → done(undefined) → custom resolve
		seenComponent!.handleInput("\x1b");
		const result = await pending;
		assert.equal(result, undefined);
		assert.deepEqual(doneCalls, [undefined]);
		assert.deepEqual(seenOptions, {
			overlay: true,
			overlayOptions: { anchor: "center", width: "70%", maxHeight: "60%" },
		});
		seenComponent!.dispose();
	} finally {
		timers.restore();
	}
});

test("浮层：列表缩短后 selected 夹取，后续按键作用于正确条目", async () => {
	const reg = new SubagentRuntimeRegistry();
	const steered: string[] = [];
	let i = 0;
	const mk = (name: string) =>
		reg.register(
			regInput({
				agent: name,
				startedAt: i++,
				handle: {
					steer: async (t) => {
						steered.push(`${name}:${t}`);
					},
					abort: async () => {},
				},
			}),
		);
	const aId = mk("a");
	mk("b");
	const c = new ControlOverlayComponent(reg, () => {});

	// 先选中第 2 条
	c.handleInput("\x1b[B");
	assert.equal(c.state.selected, 1);

	// 列表缩短（首条注销）后，下一次按键经 reducer 后 clamp 回合法范围
	reg.unregister(aId);
	c.handleInput("s");
	assert.equal(c.state.selected, 0);

	// 注入只作用于夹取后的正确条目（b）
	c.handleInput("h");
	c.handleInput("i");
	c.handleInput("\r");
	await tick();
	assert.deepEqual(steered, ["b:hi"]);
});

test("浮层：▸ 仅出现在选中行，3 条 running 全部渲染", () => {
	const reg = new SubagentRuntimeRegistry();
	["a", "b", "c"].forEach((name, i) => {
		reg.register(regInput({ agent: name, startedAt: i }));
	});
	const c = new ControlOverlayComponent(reg, () => {});

	let lines = c.render(200);
	let marked = lines.filter((l) => l.includes("▸"));
	assert.equal(marked.length, 1, "选中标记必须唯一");
	assert.ok(marked[0].includes("● a ·"), marked[0]);

	c.handleInput("\x1b[B");
	lines = c.render(200);
	marked = lines.filter((l) => l.includes("▸"));
	assert.equal(marked.length, 1, "选中标记必须唯一");
	assert.ok(marked[0].includes("● b ·"), marked[0]);

	const out = lines.join("\n");
	for (const name of ["a", "b", "c"]) {
		assert.ok(lines.some((l) => l.includes(`● ${name} ·`)), `缺少 ${name} 行：\n${out}`);
	}
});

// ---------------------------------------------------------------------------
// 规格落差补齐：浮层注入计数/排队状态、notify 接线、渲染兜底文案
// ---------------------------------------------------------------------------

test("浮层：列表行显示 ↩n 与 (排队中)，pending 归零后不再显示排队中", () => {
	const reg = new SubagentRuntimeRegistry();
	const id = reg.register(
		regInput({
			agent: "implementer",
			startedAt: 0,
			currentAction: "bash: npm test",
			steeringSent: 1,
			steeringPending: 1,
		}),
	);
	const c = new ControlOverlayComponent(reg, () => {});

	const withPending = c.render(200).join("\n");
	assert.match(withPending, /↩1\(排队中\)/, withPending);

	// queue_update → registry.onChange 驱动：pending 归零即视为已送达
	reg.update(id, { steeringPending: 0 });
	const delivered = c.render(200).join("\n");
	assert.ok(delivered.includes("↩1"), delivered);
	assert.ok(!delivered.includes("排队中"), `pending 归零不得再显示排队中：\n${delivered}`);
});

test("浮层：无注入时不显示 ↩", () => {
	const reg = new SubagentRuntimeRegistry();
	reg.register(regInput({ steeringSent: 0, steeringPending: 0 }));
	const c = new ControlOverlayComponent(reg, () => {});
	assert.ok(!c.render(200).join("\n").includes("↩"));
});

test("浮层：openControlOverlay 把 ui.notify 注入组件（失败时收到 error）", async () => {
	const reg = new SubagentRuntimeRegistry();
	reg.register(
		regInput({
			agent: "boom",
			handle: {
				steer: async () => {},
				abort: async () => {
					throw new Error("abort boom");
				},
			},
		}),
	);
	const notified: Array<{ msg: string; type?: string }> = [];
	let seenComponent:
		| { handleInput(data: string): void; dispose(): void }
		| undefined;
	const ui = {
		notify(msg: string, type?: string) {
			notified.push({ msg, type });
		},
		custom(
			factory: (
				tui: { requestRender(): void },
				theme: unknown,
				keybindings: unknown,
				done: (result: unknown) => void,
			) => unknown,
		): Promise<unknown> {
			return new Promise((resolve) => {
				seenComponent = factory(
					{ requestRender() {} },
					{},
					{},
					(result) => resolve(result),
				) as { handleInput(data: string): void; dispose(): void };
			});
		},
	} as unknown as OverlayUIContext;

	const pending = openControlOverlay(ui, reg);
	assert.ok(seenComponent, "工厂必须被调用");
	seenComponent!.handleInput("x");
	await tick();
	assert.equal(notified.length, 1, "ui.notify 必须被注入并调用");
	assert.equal(notified[0].type, "error");
	assert.match(notified[0].msg, /abort boom/);

	seenComponent!.handleInput("\x1b");
	await pending;
	seenComponent!.dispose();
});

test("面板控制器：渲染异常兜底为「子代理运行时：N running」（异常时 0）", () => {
	const reg = countingRegistry();
	const f = fakeRenderingUI();
	const panel = new RuntimePanelController(reg.wrapper);
	panel.attach(f.ui);
	reg.inner.register(regInput({ status: "running" }));
	assert.ok(f.factory, "widget 工厂应已挂载");
	const widget = f.factory!(f.tui, {});
	const originalList = reg.wrapper.list;

	// ① list 本身抛错 → 兜底行且 running 计数按 0 计
	(reg.wrapper as { list: () => RunningSubagent[] }).list = () => {
		throw new Error("list boom");
	};
	assert.deepEqual(widget.render(80), ["子代理运行时：0 running"]);

	// ② list 正常但渲染抛错 → N 为当前 running 计数
	const badStartedAt = {
		valueOf() {
			throw new Error("elapsed boom");
		},
	} as unknown as number;
	(reg.wrapper as { list: () => RunningSubagent[] }).list = () => [
		entry({ status: "running", startedAt: badStartedAt }),
	];
	assert.deepEqual(widget.render(80), ["子代理运行时：1 running"]);

	(reg.wrapper as { list: () => RunningSubagent[] }).list = originalList;
	panel.detach();
});

// ---------------------------------------------------------------------------
// 浮层边框：无边框时与正文难以区分，用制表符方框让其「立」起来。
// 关键不变量：每行可见宽度相等（右边框对齐），中文/emoji 不错位。
// ---------------------------------------------------------------------------

test("浮层边框：上下边框闭合、标题入框、每行可见宽度一致", () => {
	const out = renderOverlayBox("子代理运行时 (2)", ["▸ ● a · 3s", "  ● b · 1m02s"], 60);
	assert.equal(out.length, 4); // 顶 + 2 行 + 底
	assert.ok(out[0].startsWith("┌") && out[0].endsWith("┐"));
	assert.ok(out[out.length - 1].startsWith("└") && out[out.length - 1].endsWith("┘"));
	assert.match(out[0], /子代理运行时 \(2\)/);
	for (const line of out) {
		assert.equal(visibleWidth(line), 60, `行宽应为 60: ${JSON.stringify(line)}`);
	}
});

test("浮层边框：中文宽字符内容仍不错位（每行等宽）", () => {
	const out = renderOverlayBox("运行时", ["注入给 子代理：改一下", "↑↓ 选择 · s 注入"], 40);
	for (const line of out) assert.equal(visibleWidth(line), 40, JSON.stringify(line));
});

test("浮层边框：超宽行被截断，不破坏右边框", () => {
	const out = renderOverlayBox("t", ["x".repeat(200)], 30);
	for (const line of out) assert.equal(visibleWidth(line), 30);
});

test("浮层边框：标题过长时截断，边框仍闭合", () => {
	const out = renderOverlayBox("标题".repeat(50), ["a"], 24);
	assert.ok(out[0].startsWith("┌") && out[0].endsWith("┐"));
	for (const line of out) assert.equal(visibleWidth(line), 24);
});

test("浮层：render 输出带边框", () => {
	const reg = new SubagentRuntimeRegistry();
	reg.register(regInput());
	const c = new ControlOverlayComponent(reg, () => {});
	const lines = c.render(70);
	assert.ok(lines[0].startsWith("┌"));
	assert.ok(lines[lines.length - 1].startsWith("└"));
	for (const line of lines) assert.equal(visibleWidth(line), 70, JSON.stringify(line));
});

// ---------------------------------------------------------------------------
// 暂停 / 恢复：p 暂停选中项；暂停条目仍可在浮层显示与操作；
// 常驻面板把 paused 计入 active 并显示 ⏸。
// ---------------------------------------------------------------------------

test("浮层：p 暂停选中项并提示", async () => {
	const reg = new SubagentRuntimeRegistry();
	const paused: string[] = [];
	reg.register(
		regInput({
			agent: "a",
			handle: {
				pause: async () => {
					paused.push("a");
				},
				steer: async () => {},
				abort: async () => {},
			},
		}),
	);
	const c = new ControlOverlayComponent(reg, () => {});
	c.handleInput("p");
	await tick();
	assert.deepEqual(paused, ["a"]);
	assert.match(c.render(70).join("\n"), /已暂停 a/);
});

test("浮层：已暂停条目仍显示、可选中、可继续对话", async () => {
	const reg = new SubagentRuntimeRegistry();
	const steered: string[] = [];
	reg.register(
		regInput({
			agent: "paused-one",
			status: "paused",
			handle: {
				steer: async (t) => {
					steered.push(t);
				},
				pause: async () => {},
				abort: async () => {},
			},
		}),
	);
	const c = new ControlOverlayComponent(reg, () => {});
	assert.match(c.render(70).join("\n"), /paused-one/);
	// s + 文本 + enter → 走 steer（core 在暂停态会转成 prompt）
	c.handleInput("s");
	c.handleInput("继");
	c.handleInput("续");
	c.handleInput("\r");
	await tick();
	assert.deepEqual(steered, ["继续"]);
	// 暂停态提示应为「立即处理」而非「排队投递」
	assert.match(c.notice ?? "", /已发送给 paused-one（暂停中，立即处理）/);
});

test("浮层：对已暂停条目按 p 不重复触发 pause", async () => {
	const reg = new SubagentRuntimeRegistry();
	let called = 0;
	reg.register(
		regInput({
			status: "paused",
			handle: {
				pause: async () => {
					called++;
				},
				steer: async () => {},
				abort: async () => {},
			},
		}),
	);
	const c = new ControlOverlayComponent(reg, () => {});
	c.handleInput("p");
	await tick();
	assert.equal(called, 0);
});

test("常驻面板：paused 计入 active 并显示 ⏸", () => {
	const lines = formatRuntimeLines([entry({ status: "paused" })], { now: 0 });
	assert.match(lines[0], /⏸/);
	assert.match(lines[lines.length - 1], /⊙ 1 active/);
});

test("浮层：暂停态条目可被 x 中止", async () => {
	const reg = new SubagentRuntimeRegistry();
	const aborted: string[] = [];
	reg.register(
		regInput({
			status: "paused",
			handle: {
				abort: async () => {
					aborted.push("p");
				},
				pause: async () => {},
				steer: async () => {},
			},
		}),
	);
	const c = new ControlOverlayComponent(reg, () => {});
	c.handleInput("x");
	await tick();
	assert.deepEqual(aborted, ["p"]);
});

test("浮层：暂停态发送后保持输入态，可连续对话（无需重按 s）", async () => {
	const reg = new SubagentRuntimeRegistry();
	const steered: string[] = [];
	reg.register(
		regInput({
			status: "paused",
			handle: {
				steer: async (t) => {
					steered.push(t);
				},
				pause: async () => {},
				abort: async () => {},
			},
		}),
	);
	const c = new ControlOverlayComponent(reg, () => {});
	c.handleInput("s"); // 进入输入态
	c.handleInput("a");
	c.handleInput("\r");
	await tick();
	assert.equal(c.state.mode, "input", "暂停态发送后应仍在输入态");
	// 直接继续输入下一句，无需再按 s
	c.handleInput("b");
	c.handleInput("\r");
	await tick();
	assert.deepEqual(steered, ["a", "b"]);
	// esc 可退出输入态
	c.handleInput("\x1b");
	assert.equal(c.state.mode, "list");
});

test("formatRuntimeLines：aborted 条目按 abortReason 区分预算用尽与用户取消", () => {
	const budget = formatRuntimeLines(
		[entry({ status: "aborted", abortReason: "budget" })],
		{ now: 0 },
	).join("\n");
	assert.ok(budget.includes("预算用尽"), `实际: ${budget}`);

	const user = formatRuntimeLines(
		[entry({ status: "aborted", abortReason: "user" })],
		{ now: 0 },
	).join("\n");
	assert.ok(user.includes("已中止"), `实际: ${user}`);
});

// ---------------------------------------------------------------------------
// attachPanelIfUI —— 面板挂载的 UI 守卫与异常隔离（接线分支）
// ---------------------------------------------------------------------------

test("attachPanelIfUI：无可视 UI 时不挂载、返回 false", () => {
	let attached = 0;
	const ok = attachPanelIfUI(
		{ hasUI: false, ui: {} },
		{ attach: () => { attached++; } },
	);
	assert.equal(ok, false);
	assert.equal(attached, 0);
});

test("attachPanelIfUI：有 UI 时调用 attach 且返回 true", () => {
	let attachedWith: unknown;
	const ui = { marker: 1 };
	const ok = attachPanelIfUI(
		{ hasUI: true, ui },
		{ attach: (u) => { attachedWith = u; } },
	);
	assert.equal(ok, true);
	assert.equal(attachedWith, ui);
});

test("attachPanelIfUI：attach 抛错时静默降级、不向外抛", () => {
	assert.doesNotThrow(() => {
		const ok = attachPanelIfUI(
			{ hasUI: true, ui: {} },
			{ attach: () => { throw new Error("widget boom"); } },
		);
		assert.equal(ok, false);
	});
});

test("浮层：render 使用注入时钟（确定性耗时断言，不用 Date.now）", () => {
	const reg = new SubagentRuntimeRegistry();
	reg.register(regInput({ agent: "a", startedAt: 1000 }));
	// 真实时钟下 Date.now()-1000 会随时间漂移；注入 now 后耗时应恒为 4s。
	const c = new ControlOverlayComponent(reg, () => {}, undefined, () => 5000);
	const out = c.render(200).join("\n");
	assert.match(out, /4s/);
	assert.doesNotMatch(out, /5s/);
});
