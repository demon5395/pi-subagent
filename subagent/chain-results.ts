/**
 * chain 模式结果列表的「单一写入路径」接缝 —— 纯状态容器
 *
 * 背景：原 `runChainAgents` 的 progress 闭包先 `results[i] = progressResult`，
 * 步骤结束后又 `results.push(r)`；两条写入路径叠加导致：
 *   - `results.length` 随 progress 次数膨胀，大于链步骤数；
 *   - 后续步骤的 progress 按下标覆盖前面步骤的**终值**（终值丢失）；
 *   - `push` 与下标赋值错位，步骤下标与链步骤不再一一对应。
 *
 * 本模块把「进度视图」与「落库结果」彻底分离：
 *   - `progressView(current)`：只给 `onProgress` 展示用，返回「已完成结果 + 当前进行中步骤」
 *     的副本，**不修改** `results`；
 *   - `commit(result)`：**唯一**写入路径，按顺序 push。
 * 因此 `results.length` 恒等于已提交步骤数，`results[i].step === i + 1`。
 *
 * 依赖约定（同 runtime-events.ts）：运行时 import 一律显式带 `.ts` 扩展名；
 * 只用 `import type` 引用 core.ts，保证 `node --test` 原生类型剥离可加载。
 */

import type { SingleResult } from "./core.ts";

export interface ChainResultStore {
	/** 已完成步骤的结果（内部数组，只读语义；最终作为返回值） */
	readonly results: SingleResult[];
	/** 进度视图：已完成结果 + 当前进行中步骤（副本，不写入 results） */
	progressView(current: SingleResult): SingleResult[];
	/** 已完成结果快照（副本） */
	snapshot(): SingleResult[];
	/** 记录一个已完成步骤（唯一写入路径，顺序 push） */
	commit(result: SingleResult): void;
}

/** 创建 chain 结果累加器 */
export function createChainResultStore(): ChainResultStore {
	const results: SingleResult[] = [];
	return {
		results,
		progressView(current) {
			return [...results, current];
		},
		snapshot() {
			return [...results];
		},
		commit(result) {
			results.push(result);
		},
	};
}
