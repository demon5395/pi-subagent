import { test } from "node:test";
import assert from "node:assert/strict";
import {
	clipLastLine,
	reduceSessionEvent,
	resolveProgressText,
} from "./runtime-events.ts";

// ---------------------------------------------------------------------------
// reduceSessionEvent —— session 事件 → 运行期状态 的纯映射
//
// 这些断言直接对准接线分支变异体：删掉「开始带 currentAction」、
// 删掉「结束清 currentAction」、删掉「进度请求」等都会让对应用例变红。
// ---------------------------------------------------------------------------

test("tool_execution_start：产出 currentAction 补丁、标记工具开始、请求进度", () => {
	const red = reduceSessionEvent(
		{
			type: "tool_execution_start",
			toolName: "bash",
			args: { command: "npm test" },
		},
		undefined,
	);
	assert.equal(red.toolCallStarted, true);
	assert.equal(red.progress, true);
	assert.equal(red.currentAction, "bash: npm test");
	assert.equal(red.patch?.currentAction, "bash: npm test");
});

test("tool_execution_start：动作经 describeToolCall 消毒/裁剪", () => {
	const red = reduceSessionEvent(
		{
			type: "tool_execution_start",
			toolName: "bash",
			args: { command: "echo \u001b[31mhi\u001b[0m" },
		},
		undefined,
	);
	assert.equal(red.currentAction, "bash: echo hi");
	assert.doesNotMatch(red.currentAction ?? "", /\u001b/);
});

test("tool_execution_update：有文本输出时写 lastLine 补丁", () => {
	const red = reduceSessionEvent(
		{
			type: "tool_execution_update",
			partialResult: { content: [{ type: "text", text: "line one\nline two" }] },
		},
		"bash: sleep",
	);
	assert.equal(red.patch?.lastLine, "line one");
	// 仅更新输出，currentAction 保持不变
	assert.equal(red.currentAction, "bash: sleep");
});

test("tool_execution_update：空输出不产生补丁", () => {
	const red = reduceSessionEvent(
		{ type: "tool_execution_update", partialResult: { content: [] } },
		"bash: sleep",
	);
	assert.equal(red.patch, undefined);
});

test("tool_execution_end：清空 currentAction（回归：工具跑完后不得显示陈旧动作）", () => {
	const red = reduceSessionEvent(
		{ type: "tool_execution_end", toolName: "bash" },
		"bash: npm test",
	);
	assert.equal(red.currentAction, undefined);
	assert.ok(red.patch && "currentAction" in red.patch);
	assert.equal(red.patch?.currentAction, undefined);
});

test("queue_update：写入 steeringPending 数量", () => {
	const red = reduceSessionEvent(
		{ type: "queue_update", steering: ["a", "b", "c"] },
		"bash: ls",
	);
	assert.equal(red.patch?.steeringPending, 3);
	assert.equal(red.currentAction, "bash: ls");
});

test("queue_update：缺省 steering 视为 0", () => {
	const red = reduceSessionEvent({ type: "queue_update" }, undefined);
	assert.equal(red.patch?.steeringPending, 0);
});

test("message_end：保留当前动作并请求进度（内嵌卡片需带上 currentAction）", () => {
	const red = reduceSessionEvent(
		{
			type: "message_end",
			message: { role: "assistant", content: [] },
		},
		"bash: npm test",
	);
	assert.equal(red.progress, true);
	assert.equal(red.currentAction, "bash: npm test");
	// message_end 不应产生运行期补丁（lastLine 由 core 依消息内容单独处理）
	assert.equal(red.patch, undefined);
});

test("message_end：无 message 时不请求进度", () => {
	const red = reduceSessionEvent({ type: "message_end" }, "bash: ls");
	assert.equal(red.progress, undefined);
	assert.equal(red.currentAction, "bash: ls");
});

test("未知事件：空补丁，currentAction 保持不变", () => {
	const red = reduceSessionEvent({ type: "agent_start" }, "bash: ls");
	assert.equal(red.patch, undefined);
	assert.equal(red.currentAction, "bash: ls");
	assert.equal(red.progress, undefined);
});

// ---------------------------------------------------------------------------
// clipLastLine —— 从 core.ts 迁移
// ---------------------------------------------------------------------------

test("clipLastLine：短文本原样返回", () => {
	assert.equal(clipLastLine("hello"), "hello");
});

test("clipLastLine：超长文本截断并加省略号（总长不超过 80）", () => {
	const long = "x".repeat(120);
	const clipped = clipLastLine(long);
	assert.equal(clipped.length, 80);
	assert.equal(clipped, "x".repeat(79) + "…");
});

test("clipLastLine：先 sanitizeText 剔除控制字节再截断", () => {
	assert.equal(clipLastLine("a\u001b[31mb\u001b[0mc"), "abc");
	assert.equal(clipLastLine("第一行\n第二行"), "第一行 第二行");
	assert.doesNotMatch(clipLastLine("\u001b]0;x\u0007ok"), /[\x00-\x1f\x7f-\x9f]/);
});

// ---------------------------------------------------------------------------
// resolveProgressText —— index.ts 内嵌卡片文案（优先展示当前动作）
// ---------------------------------------------------------------------------

test("resolveProgressText：优先展示 currentAction", () => {
	assert.equal(resolveProgressText("bash: npm test", "最终答复"), "bash: npm test");
});

test("resolveProgressText：无动作时回退最终输出", () => {
	assert.equal(resolveProgressText(undefined, "最终答复"), "最终答复");
});

test("resolveProgressText：两者皆无时回退占位符", () => {
	assert.equal(resolveProgressText(undefined, ""), "(running...)");
});
