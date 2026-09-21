/**
 * 会话事件 → 运行期状态/进度 的纯映射层
 *
 * `core.ts` 的 session 订阅回调只负责「副作用」（写 registry、发进度、累计用量），
 * 其中「事件字段如何映射到 RunningSubagent 补丁 / currentAction 生命周期 / 是否请求
 * 进度」集中在本模块，从而可被 `node --test` 直接加载并杀死接线分支变异。
 *
 * 依赖约定：本模块的运行时 import 一律显式带 `.ts` 扩展名；不得 value import
 * core.ts / index.ts（否则 Node 原生类型剥离无法解析无扩展名相对导入）。
 * 本模块只做纯映射，不触碰 registry、不读写时间戳。
 */

import { clipText } from "./text.ts";
import {
	describeToolCall,
	extractLine,
	sanitizeText,
	type RunningSubagent,
} from "./runtime.ts";

/** session 事件的最小子集（避免 value import SDK，保持可测） */
export interface SessionEventLike {
	type: string;
	toolName?: string;
	args?: Record<string, unknown>;
	partialResult?: unknown;
	steering?: ReadonlyArray<unknown>;
	message?: unknown;
}

/** 单事件对运行期状态的纯映射结果 */
export interface SessionEventReduction {
	/** registry 补丁；undefined = 本事件不改注册表 */
	patch?: Partial<Omit<RunningSubagent, "id">>;
	/** 事件后应保留的 currentAction（权威值；undefined = 清空） */
	currentAction?: string;
	/** 本事件是否完成了「一次工具调用开始」（core 用于本轮计数） */
	toolCallStarted?: boolean;
	/** 是否应触发 onProgress 进度回调 */
	progress?: boolean;
}

/** 运行时 lastLine 最大可见长度（超出截断加省略号，避免面板行溢出） */
export const LAST_LINE_MAX = 80;

/**
 * lastLine 进入展示链路的唯一入口：先 sanitizeText 剔除控制字节，
 * 再按统一约定截断。工具 partial 输出与助手文本首行都经此函数。
 */
export function clipLastLine(s: string): string {
	return clipText(sanitizeText(s), LAST_LINE_MAX);
}

/**
 * 把一个 session 事件归约为运行期补丁 + currentAction 生命周期 + 进度请求。
 *
 * `currentAction` 始终是「事件后的权威值」：`core.ts` 可直接 `currentAction = red.currentAction`。
 *
 * @param event              session 事件（字段最小子集）
 * @param prevCurrentAction  事件前 core 持有的 currentAction
 */
export function reduceSessionEvent(
	event: SessionEventLike,
	prevCurrentAction: string | undefined,
): SessionEventReduction {
	switch (event.type) {
		case "tool_execution_start": {
			const currentAction = describeToolCall(event.toolName ?? "", event.args);
			return {
				patch: { currentAction },
				currentAction,
				toolCallStarted: true,
				progress: true,
			};
		}
		case "tool_execution_update": {
			const line = extractLine(event.partialResult);
			return line
				? { currentAction: prevCurrentAction, patch: { lastLine: clipLastLine(line) } }
				: { currentAction: prevCurrentAction };
		}
		case "tool_execution_end":
			// 工具结束后清空当前动作：否则工具跑完的最终 assistant message_end
			// 仍会带上旧动作，内嵌卡片显示陈旧状态（回归修复）。仅清 currentAction，
			// 不动 lastLine 等字段；面板按 currentAction ?? lastLine ?? (thinking…) 回退。
			return { patch: { currentAction: undefined }, currentAction: undefined };
		case "queue_update":
			return {
				currentAction: prevCurrentAction,
				patch: { steeringPending: event.steering?.length ?? 0 },
			};
		case "message_end":
			// 进度回调必须带上「当前动作」：工具执行期间该值由 start/end 维护；
			// 工具跑完后的最终消息则保持 undefined（避免陈旧动作）。
			return event.message
				? { currentAction: prevCurrentAction, progress: true }
				: { currentAction: prevCurrentAction };
		default:
			return { currentAction: prevCurrentAction };
	}
}

/**
 * 内嵌卡片进度文案：优先展示当前动作，其次最终输出，最后占位符。
 * （index.ts 的 onUpdate 用它组装 content.text。）
 */
export function resolveProgressText(
	currentAction: string | undefined,
	finalOutput: string,
	fallback = "(running...)",
): string {
	return currentAction ?? (finalOutput || fallback);
}
