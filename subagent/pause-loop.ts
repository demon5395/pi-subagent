/**
 * 暂停/恢复编排循环的纯决策层
 *
 * `core.ts` 的暂停循环只负责副作用（改注册表、abort、session.prompt），
 * 「进入暂停后何时触发 prompt / 本轮跑完后该退出、返回还是继续暂停」这些
 * 控制流决策集中在本模块，从而可被 `node --test` 直接加载并杀死接线分支变异。
 *
 * 依赖约定：本模块的运行时 import 一律显式带 `.ts` 扩展名；不得 value import
 * core.ts / index.ts（否则 Node 原生类型剥离无法解析无扩展名相对导入）。
 * 本模块只做纯映射，不触碰 registry、不读写时间戳、不调用 SDK。
 */

// ---------------------------------------------------------------------------
// 暂停态等待门控
// ---------------------------------------------------------------------------

/** 进入暂停态后「等待用户消息」的门控决策 */
export type PauseWaitDecision =
	| "exit" // 已中止 → 退出整个暂停循环
	| "finish" // 用户显式请求结束 → 退出循环并把结果交回父级
	| "prompt" // 有待处理消息 → 取一条执行 prompt
	| "wait"; // 无消息且未中止/未结束 → 继续挂起等待

export interface PauseWaitState {
	/** 是否已被用户/预算中止 */
	aborted: boolean;
	/** 用户是否显式请求结束并返回父级 */
	finishRequested: boolean;
	/** 暂停期间累积的待处理用户消息数 */
	pendingCount: number;
}

/**
 * 判定暂停等待环节应执行的动作。
 *
 * 判定优先级（与历史行为一致，勿调换）：中止 > 显式结束 > 有待处理消息 > 等待。
 * 中止优先保证预算在暂停态耗尽时也能退出循环（否则会重新进入等待且
 * 无人 notifyWake → 永久挂起）；显式结束次优先保证用户一键交回父级不被
 * 排队中的消息掩盖。
 */
export function decidePauseWait(state: PauseWaitState): PauseWaitDecision {
	if (state.aborted) return "exit";
	if (state.finishRequested) return "finish";
	if (state.pendingCount > 0) return "prompt";
	return "wait";
}

// ---------------------------------------------------------------------------
// 恢复一轮后的编排决策
// ---------------------------------------------------------------------------

/**
 * 「暂停态恢复一轮 prompt」跑完后的编排决策。
 *
 * - `exit`        用户/预算中止 → 退出循环
 * - `return`      本轮有工具调用或用户显式结束 → 结束返回父级
 * - `pause-again` 运行期间用户又按了暂停 → 回到暂停等待
 * - `stay-paused` 纯问答（无工具调用）→ 保持暂停等下一句
 */
export type ResumedRoundDecision =
	| "exit"
	| "return"
	| "pause-again"
	| "stay-paused";

export interface ResumedRoundState {
	/** 是否已被用户/预算中止 */
	aborted: boolean;
	/** 用户是否显式请求结束并返回父级 */
	finishRequested: boolean;
	/** 本轮运行期间用户是否再次请求暂停 */
	pauseRequested: boolean;
	/** 本轮 prompt 内是否发生过工具调用 */
	usedTools: boolean;
}

/**
 * 判定「暂停态恢复一轮 prompt」结束后应执行的动作。
 *
 * 判定优先级（与历史行为一致，勿调换）：
 * 1. `aborted` → `exit`（中止优先，避免在暂停态重新进入等待而永久挂起）
 * 2. `finishRequested` → `return`（用户显式结束，优先于启发式与再次暂停）
 * 3. `pauseRequested` → `pause-again`（用户在本轮内又按了暂停）
 * 4. `usedTools` → `return`（有工具调用 = 恢复干活，跑完即返回）
 * 5. 否则 → `stay-paused`（纯文本 = 问答，保持暂停）
 *
 * 启发式限制：第 4 条按「本轮是否发生 tool_execution_start」区分干活与问答，
 * 对「需要子代理读文件/执行命令才能回答的问题」可能误判为 `return` 而提前
 * 结束；增加第 2 条显式结束作为可靠逃生口，但**不改变**默认
 * 启发式行为。详见 README「暂停 / 提问 / 继续」。
 */
export function decideResumedRound(
	state: ResumedRoundState,
): ResumedRoundDecision {
	if (state.aborted) return "exit";
	if (state.finishRequested) return "return";
	if (state.pauseRequested) return "pause-again";
	if (state.usedTools) return "return";
	return "stay-paused";
}
