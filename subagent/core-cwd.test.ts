import { test } from "node:test";
import assert from "node:assert/strict";
import {
	runChainAgents,
	runParallelAgents,
	runSingleAgent,
	type SingleResult,
	type UsageStats,
} from "./core.ts";
import type { AgentConfig } from "./agents.ts";
import type { BudgetAccumulator } from "./budget.ts";

function makeAgent(): AgentConfig {
	return {
		name: "a",
		description: "d",
		systemPrompt: "",
		source: "project",
		filePath: "/tmp/a.md",
	};
}

/** 始终耗尽的假累加器：让 runSingleAgent 在创建会话前提前返回（无需真 SDK 会话） */
function exhaustedAcc(): BudgetAccumulator {
	return {
		addTurn() {},
		exhausted() {
			return true;
		},
		spent() {
			return 1;
		},
	};
}

test("runSingleAgent：跨 cwd 运行的结果携带实际 cwd（契约）", async () => {
	const r = await runSingleAgent(
		"/parent",
		makeAgent(),
		"t",
		"/child",
		undefined,
		undefined,
		undefined,
		undefined,
		{ mode: "single", slot: 0 },
		exhaustedAcc(),
	);
	assert.equal(r.cwd, "/child");
	assert.equal(r.exitCode, 1);
});

test("runSingleAgent：未指定 cwd 时回退 defaultCwd", async () => {
	const r = await runSingleAgent(
		"/parent",
		makeAgent(),
		"t",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ mode: "single", slot: 0 },
		exhaustedAcc(),
	);
	assert.equal(r.cwd, "/parent");
});

test("runChainAgents：未知 agent 的结果也带 cwd（step.cwd 优先）", async () => {
	const rs = await runChainAgents(
		"/parent",
		[],
		[{ agent: "missing", task: "t", cwd: "/child" }],
		undefined,
	);
	assert.equal(rs[0].cwd, "/child");
});

// ---------------------------------------------------------------------------
// 并/链模式 onProgress 透传 currentAction
// 用注入的假 runner 触发进度回调，无需真实 SDK 会话。
// ---------------------------------------------------------------------------

function zeroUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function fakeResult(agent: string, task: string, step?: number): SingleResult {
	return {
		agent,
		agentSource: "project",
		task,
		messages: [],
		usage: zeroUsage(),
		exitCode: 0,
		step,
		cwd: "/w",
	};
}

/** 假 runner：触发一次带 currentAction 的进度回调后立即返回终值 */
function fakeRunner(action: string) {
	return async (
		_defaultCwd: string,
		agent: AgentConfig,
		task: string,
		_cwd: string | undefined,
		_signal: AbortSignal | undefined,
		onProgress?: (p: { messages?: unknown[]; usage?: UsageStats; currentAction?: string }) => void,
	): Promise<SingleResult> => {
		onProgress?.({ messages: [], usage: zeroUsage(), currentAction: action });
		return fakeResult(agent.name, task);
	};
}

test("runParallelAgents：进度回调透传 currentAction", async () => {
	const seen: Array<string | undefined> = [];
	const results = await runParallelAgents(
		"/w",
		[makeAgent()],
		[{ agent: "a", task: "t" }],
		undefined,
		undefined,
		undefined,
		(_rs, action) => seen.push(action),
		undefined,
		fakeRunner("bash: npm test") as never,
	);
	assert.equal(seen[0], "bash: npm test");
	assert.equal(results.length, 1);
});

test("runChainAgents：进度回调透传 currentAction", async () => {
	const seen: Array<string | undefined> = [];
	await runChainAgents(
		"/w",
		[makeAgent()],
		[{ agent: "a", task: "t" }],
		undefined,
		undefined,
		undefined,
		(_rs, action) => seen.push(action),
		undefined,
		fakeRunner("read: x") as never,
	);
	assert.equal(seen[0], "read: x");
});
