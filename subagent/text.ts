/**
 * 展示层文本裁剪 —— 单一实现
 *
 * 历史上三处各自实现裁剪：`runtime.ts` 的 `clip`（48，`...`）、
 * `runtime-events.ts` 的 `clipLastLine`（80，`...`）、`panel.ts` 的
 * `truncatePlain`（可变宽度，`…`）。省略号约定与长度语义不一致，现收敛于此。
 *
 * 语义：结果总长度（含省略号）不超过 `max`；超出时取前 `max-1` 字符 + `…`。
 * 选用单列宽的 `…`（而非三列宽的 `...`），保证面板列宽对齐。
 *
 * 依赖约定：本模块保持零依赖，供 runtime / runtime-events / panel 共同复用。
 */

export const ELLIPSIS = "…";

/** 裁剪到总长不超过 max（含省略号）；max<=0 返回空串 */
export function clipText(s: string, max: number): string {
	if (max <= 0) return "";
	return s.length > max ? `${s.slice(0, max - 1)}${ELLIPSIS}` : s;
}
