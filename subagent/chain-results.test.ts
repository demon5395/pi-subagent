import { test } from "node:test";
import assert from "node:assert/strict";
import { createChainResultStore } from "./chain-results.ts";
import type { SingleResult } from "./core.ts";

// ---------------------------------------------------------------------------
// chain 结果累加器
//
// 原实现把 progress 结果直接 `results[i] = ...` 写入 results，步骤结束又 `results.push(r)`，
// 使 results 出现重复/下标错位。这里以「每步中途触发 progress」的最小复现驱动累加器，
// 固化「单一写入路径」的行为契约：
//   - progress 不污染 results；
//   - 最终 results.length === steps；
//   - results[i].step === i + 1，且每项都是该步终值而非 progress 中间值。
// ---------------------------------------------------------------------------

function makeResult(step: number, kind: "final" | "progress"): SingleResult {
	return {
		agent: `agent-${step}`,
		agentSource: "project",
		task: `task-${step}`,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		exitCode: kind === "final" ? 0 : -1,
		step,
		cwd: "/w",
		// 以 task 区分终值/中间值，便于断言下标未被 progress 覆盖
		stopReason: kind,
	};
}

test("progress 中途触发不写入 results；最终 length===steps 且下标一一对应", () => {
	const store = createChainResultStore();
	const steps = 3;
	const progressViews: SingleResult[][] = [];

	for (let i = 0; i < steps; i++) {
		// 该步运行中：多次 progress（覆盖 progress 闭包被触发多次的场景）
		for (let p = 0; p < 2; p++) {
			const view = store.progressView(makeResult(i + 1, "progress"));
			progressViews.push(view);
			// progress 期间不得有已完成结果落库
			assert.equal(store.results.length, i, `step ${i + 1} progress 不应写入 results`);
			// 进度视图 = 已完成结果 + 当前进行中步骤
			assert.equal(view.length, i + 1);
			assert.equal(view[i].step, i + 1);
			assert.equal(view[i].stopReason, "progress");
		}
		// 该步结束：唯一写入路径
		store.commit(makeResult(i + 1, "final"));
		assert.equal(store.results.length, i + 1);
	}

	assert.equal(store.results.length, steps);
	for (let i = 0; i < steps; i++) {
		assert.equal(store.results[i].step, i + 1, `results[${i}] 下标应一一对应`);
		assert.equal(store.results[i].agent, `agent-${i + 1}`);
		assert.equal(store.results[i].stopReason, "final", "终值不得被 progress 中间值覆盖");
	}
});

test("snapshot 返回副本，外部改动不影响内部 results", () => {
	const store = createChainResultStore();
	store.commit(makeResult(1, "final"));
	const snap = store.snapshot();
	snap[0] = makeResult(99, "progress");
	snap.push(makeResult(2, "progress"));
	assert.equal(store.results.length, 1);
	assert.equal(store.results[0].step, 1);
});

test("progressView 在无已完成步骤时仅含当前步骤", () => {
	const store = createChainResultStore();
	const view = store.progressView(makeResult(1, "progress"));
	assert.equal(view.length, 1);
	assert.equal(store.results.length, 0);
});
