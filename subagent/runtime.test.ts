import { test } from "node:test";
import assert from "node:assert/strict";
import {
	SubagentRuntimeRegistry,
	createThrottle,
	describeToolCall,
	extractLine,
	resolveRuntimeStatus,
	sanitizeText,
	type RegisterInput,
} from "./runtime.ts";

function mkInput(over: Partial<RegisterInput> = {}): RegisterInput {
	return {
		agent: "implementer",
		agentSource: "global",
		task: "do something",
		mode: "single",
		slot: 0,
		startedAt: 1000,
		handle: { steer: async () => {}, abort: async () => {} },
		...over,
	};
}

test("register 返回唯一 id 并可 get/list", () => {
	const r = new SubagentRuntimeRegistry();
	const input = mkInput();
	const a = r.register(input);
	const b = r.register(input);
	assert.notEqual(a, b);
	assert.equal(r.get(a)?.agent, "implementer");
	assert.equal(r.list().length, 2);
});

test("register 默认值：status=running / lastEventAt=startedAt / 计数为 0", () => {
	const r = new SubagentRuntimeRegistry();
	const e = r.get(r.register(mkInput()))!;
	assert.equal(e.status, "running");
	assert.equal(e.lastEventAt, 1000);
	assert.equal(e.steeringSent, 0);
	assert.equal(e.steeringPending, 0);
});

test("update 对不存在的 id 静默忽略", () => {
	const r = new SubagentRuntimeRegistry();
	assert.doesNotThrow(() => r.update("nope#999", { status: "done" }));
	assert.equal(r.get("nope#999"), undefined);
	assert.equal(r.list().length, 0);
});

test("update 真正写入状态", () => {
	const r = new SubagentRuntimeRegistry();
	const id = r.register(mkInput());
	r.update(id, { status: "done", lastLine: "x", steeringPending: 1 });
	const e = r.get(id)!;
	assert.equal(e.status, "done");
	assert.equal(e.lastLine, "x");
	assert.equal(e.steeringPending, 1);
});

test("unregister 幂等且 id 不可再 get", () => {
	const r = new SubagentRuntimeRegistry();
	let n = 0;
	r.onChange(() => n++);
	const id = r.register(mkInput());
	assert.equal(n, 1);
	r.unregister(id);
	r.unregister(id);
	assert.equal(n, 2); // delete 守卫：仅首次注销触发回调
	assert.equal(r.get(id), undefined);
});

test("reset 清空条目与监听", () => {
	const r = new SubagentRuntimeRegistry();
	let n = 0;
	r.onChange(() => n++);
	const id = r.register(mkInput());
	assert.equal(n, 1);
	r.reset();
	assert.equal(r.list().length, 0);
	r.update(id, { status: "done" });
	r.unregister(id);
	assert.equal(n, 1); // 条目已清空，update/unregister 不再触发回调
	r.register(mkInput()); // 该次 register 会 emit，但监听已被 reset 清空
	assert.equal(n, 1);
});

test("list 按 startedAt 升序", () => {
	const r = new SubagentRuntimeRegistry();
	const late = r.register(mkInput({ agent: "late", startedAt: 2000 }));
	const early = r.register(mkInput({ agent: "early", startedAt: 500 }));
	assert.deepEqual(r.list().map((e) => e.id), [early, late]);
});

test("onChange 触发与退订", () => {
	const r = new SubagentRuntimeRegistry();
	let n = 0;
	const off = r.onChange(() => n++);
	const id = r.register(mkInput());
	assert.equal(n, 1);
	r.update(id, { status: "done" });
	assert.equal(n, 2);
	assert.equal(r.get(id)?.status, "done");
	off();
	r.unregister(id);
	assert.equal(n, 2);
});

test("监听者抛错不影响状态写入", () => {
	const r = new SubagentRuntimeRegistry();
	r.onChange(() => {
		throw new Error("boom");
	});
	const id = r.register(mkInput());
	assert.equal(r.get(id)?.status, "running");
});

test("createThrottle：区间内拦截、边界放行、区间外放行", () => {
	let t = 0;
	const gate = createThrottle(200, () => t);
	assert.equal(gate(), true);
	t = 100;
	assert.equal(gate(), false);
	t = 200;
	assert.equal(gate(), true);
	t = 399;
	assert.equal(gate(), false);
	t = 400;
	assert.equal(gate(), true);
});

test("describeToolCall 各工具与未知工具", () => {
	assert.equal(describeToolCall("bash", { command: "npm test" }), "bash: npm test");
	assert.equal(describeToolCall("read", { file_path: "src/a.ts" }), "read: src/a.ts");
	assert.equal(describeToolCall("read", { path: "src/a.ts" }), "read: src/a.ts");
	assert.equal(describeToolCall("read", {}), "read: ...");
	assert.equal(describeToolCall("write", { path: "src/b.ts" }), "write: src/b.ts");
	assert.equal(describeToolCall("edit", { file_path: "src/c.ts" }), "edit: src/c.ts");
	assert.equal(describeToolCall("ls", { path: "src" }), "ls: src");
	assert.equal(describeToolCall("ls", {}), "ls: .");
	assert.equal(describeToolCall("find", { pattern: "*.ts" }), "find: *.ts");
	assert.equal(describeToolCall("find", {}), "find: *");
	assert.equal(describeToolCall("grep", { pattern: "foo" }), "grep: /foo/");
	assert.equal(describeToolCall("cbm_search_graph", { query: "x" }), "cbm_search_graph");
	assert.equal(describeToolCall("bash", undefined), "bash: ...");
});

test("describeToolCall 长命令截断为总长 48（含单列省略号 …）", () => {
	const long = "x".repeat(60);
	assert.equal(describeToolCall("bash", { command: long }), `bash: ${"x".repeat(47)}…`);
});

test("sanitizeText 剔除 C0/C1 与 ESC 序列，换行制表转空格，保留中文", () => {
	// ANSI（CSI）：整段序列被剔除，可见字符保留
	assert.equal(sanitizeText("a\x1b[31mb\x1b[0mc"), "abc");
	// OSC：BEL 终结的标题序列被整段剔除
	assert.equal(sanitizeText("\x1b]0;title\x07ok"), "ok");
	// 换行/制表 → 空格
	assert.equal(sanitizeText("中文\t命令\n第二行"), "中文 命令 第二行");
	// 残余 C0（NUL/BEL）与 C1/DEL 控制字符
	assert.equal(sanitizeText("a\x00b\x07c\x9fd\x7fe"), "abcde");
	// 普通文本（含中文）不被误删
	assert.equal(sanitizeText("读文件 src/中文.ts"), "读文件 src/中文.ts");
});

test("describeToolCall 参数中的 ANSI/控制字符被剔除，普通文本（含中文）保留", () => {
	const desc = describeToolCall("bash", {
		command: "echo \x1b[31mred\x1b[0m \x1b]0;x\x07中文",
	});
	assert.doesNotMatch(desc, /\u001b/);
	assert.doesNotMatch(desc, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
	assert.match(desc, /echo/);
	assert.match(desc, /red/);
	assert.match(desc, /中文/);
});

test("describeToolCall 中带 ANSI 的参数按可见长度截断（截断后仍无控制字符）", () => {
	const desc = describeToolCall("read", {
		file_path: `${"\x1b[32m"}${"x".repeat(60)}`,
	});
	assert.equal(desc, `read: ${"x".repeat(47)}…`);
	assert.doesNotMatch(desc, /\u001b/);
});

test("extractLine 从字符串 / content 数组取首行", () => {
	assert.equal(extractLine("a\nb"), "a");
	assert.equal(extractLine({ content: [{ type: "text", text: "hello\nworld" }] }), "hello");
	assert.equal(extractLine({ content: [{ type: "image" }] }), undefined);
	assert.equal(
		extractLine({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
		"a b",
	);
	assert.equal(extractLine({ content: [{ type: "text", text: "" }] }), undefined);
	assert.equal(extractLine({ content: [] }), undefined);
	assert.equal(extractLine(undefined), undefined);
	assert.equal(extractLine(123), undefined);
});

// ---------------------------------------------------------------------------
// resolveRuntimeStatus：finally 终态判定（设计：● running / ⊘ aborted / ✓ done / ✗ failed）
// ---------------------------------------------------------------------------

test("resolveRuntimeStatus：用户中止优先，即便 exitCode=1 也判 aborted", () => {
	// 回归：浮层 x/a 中止时 abort 路径不写 stopReason=aborted，
	// 若只看 isFailedResult 会被误判为 failed（终态应显示 ⊘）。
	assert.equal(
		resolveRuntimeStatus(true, { exitCode: 1, stopReason: undefined }),
		"aborted",
	);
	assert.equal(
		resolveRuntimeStatus(true, { exitCode: 1, stopReason: "error" }),
		"aborted",
	);
});

test("resolveRuntimeStatus：用户中止、会话自然结束也判 aborted（用户意图优先）", () => {
	assert.equal(resolveRuntimeStatus(true, { exitCode: 0 }), "aborted");
});

test("resolveRuntimeStatus：stopReason=aborted 判 aborted（既有语义保留）", () => {
	assert.equal(
		resolveRuntimeStatus(false, { exitCode: 0, stopReason: "aborted" }),
		"aborted",
	);
	assert.equal(
		resolveRuntimeStatus(false, { exitCode: 1, stopReason: "aborted" }),
		"aborted",
	);
});

test("resolveRuntimeStatus：失败判 failed", () => {
	assert.equal(resolveRuntimeStatus(false, { exitCode: 1 }), "failed");
	assert.equal(
		resolveRuntimeStatus(false, { exitCode: 0, stopReason: "error" }),
		"failed",
	);
});

test("resolveRuntimeStatus：正常结束判 done", () => {
	assert.equal(resolveRuntimeStatus(false, { exitCode: 0 }), "done");
	assert.equal(
		resolveRuntimeStatus(false, { exitCode: 0, stopReason: "endTurn" }),
		"done",
	);
});
