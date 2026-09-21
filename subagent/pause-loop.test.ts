import { test } from "node:test";
import assert from "node:assert/strict";
import {
	decidePauseWait,
	decideResumedRound,
} from "./pause-loop.ts";

// ---------------------------------------------------------------------------
// decideResumedRound —— 「暂停态恢复一轮 prompt」跑完后的编排决策
//
// 这些断言直接对准启发式分支变异体：调换判定优先级、
// 把 usedTools 与 pauseRequested 判反、把纯问答误判为 return 等都会变红。
// ---------------------------------------------------------------------------

test("纯问答（无工具调用）保持暂停：回到暂停态继续等待下一句", () => {
	const decision = decideResumedRound({
		aborted: false,
		finishRequested: false,
		pauseRequested: false,
		usedTools: false,
	});
	assert.equal(decision, "stay-paused");
});

test("本轮有工具调用：视为恢复干活且已跑完，结束并返回父级", () => {
	const decision = decideResumedRound({
		aborted: false,
		finishRequested: false,
		pauseRequested: false,
		usedTools: true,
	});
	assert.equal(decision, "return");
});

test("运行期间用户再次请求暂停：回到暂停等待（不返回）", () => {
	const decision = decideResumedRound({
		aborted: false,
		finishRequested: false,
		pauseRequested: true,
		usedTools: false,
	});
	assert.equal(decision, "pause-again");
});

test("暂停态被中止：退出循环（中止优先，避免永久挂起）", () => {
	const decision = decideResumedRound({
		aborted: true,
		finishRequested: false,
		pauseRequested: false,
		usedTools: false,
	});
	assert.equal(decision, "exit");
});

test("判定优先级：中止 > 再次暂停 > 有工具调用（三者同时成立时 exit）", () => {
	assert.equal(
		decideResumedRound({
			aborted: true,
			finishRequested: false,
			pauseRequested: true,
			usedTools: true,
		}),
		"exit",
	);
});

test("判定优先级：再次暂停 > 有工具调用（本轮调用过工具但仍按了暂停）", () => {
	assert.equal(
		decideResumedRound({
			aborted: false,
			finishRequested: false,
			pauseRequested: true,
			usedTools: true,
		}),
		"pause-again",
	);
});

// ---------------------------------------------------------------------------
// 显式「结束并返回」
// ---------------------------------------------------------------------------

test("显式结束：纯问答轮也返回父级（不依赖工具调用启发式）", () => {
	assert.equal(
		decideResumedRound({
			aborted: false,
			finishRequested: true,
			pauseRequested: false,
			usedTools: false,
		}),
		"return",
	);
});

test("显式结束：与工具调用同时成立时仍返回", () => {
	assert.equal(
		decideResumedRound({
			aborted: false,
			finishRequested: true,
			pauseRequested: false,
			usedTools: true,
		}),
		"return",
	);
});

test("显式结束优先于再次暂停：用户点了结束就交回父级", () => {
	assert.equal(
		decideResumedRound({
			aborted: false,
			finishRequested: true,
			pauseRequested: true,
			usedTools: false,
		}),
		"return",
	);
});

test("中止优先于显式结束：两者同时成立时 exit", () => {
	assert.equal(
		decideResumedRound({
			aborted: true,
			finishRequested: true,
			pauseRequested: false,
			usedTools: false,
		}),
		"exit",
	);
});

// ---------------------------------------------------------------------------
// decidePauseWait —— 「进入暂停态后等待用户消息」的门控决策
// ---------------------------------------------------------------------------

test("等待门控：无待处理消息 → 继续等待", () => {
	assert.equal(
		decidePauseWait({ aborted: false, finishRequested: false, pendingCount: 0 }),
		"wait",
	);
});

test("等待门控：有待处理消息 → 触发 prompt", () => {
	assert.equal(
		decidePauseWait({ aborted: false, finishRequested: false, pendingCount: 1 }),
		"prompt",
	);
});

test("等待门控：已中止 → 退出（即使有待处理消息也优先退出）", () => {
	assert.equal(
		decidePauseWait({ aborted: true, finishRequested: false, pendingCount: 0 }),
		"exit",
	);
	assert.equal(
		decidePauseWait({ aborted: true, finishRequested: false, pendingCount: 2 }),
		"exit",
	);
});

test("等待门控：显式结束 → finish（等待态一键交回父级）", () => {
	assert.equal(
		decidePauseWait({ aborted: false, finishRequested: true, pendingCount: 0 }),
		"finish",
	);
});

test("等待门控：显式结束优先于待处理消息", () => {
	assert.equal(
		decidePauseWait({ aborted: false, finishRequested: true, pendingCount: 3 }),
		"finish",
	);
});

test("等待门控：中止优先于显式结束", () => {
	assert.equal(
		decidePauseWait({ aborted: true, finishRequested: true, pendingCount: 0 }),
		"exit",
	);
});
