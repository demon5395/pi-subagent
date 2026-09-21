/**
 * Watchdog — bash 长命令治理（扩展入口）
 *
 * 语义（方案 ii：不硬掐模型显式传的 timeout）：
 *   1. tool_call（bash）：无 timeout → 就地补默认值（60s）；显式 timeout > 提醒阈值
 *      （300s）→ 放行但 notify 用户，让"跑很久"透明可见。
 *   2. tool_result（bash）：命令实际超时被 pi 终止 → 保留原始输出，末尾追加
 *      "重新聚焦引导文本"（不原样重试 / 拆小步 / 先最小验证 / 确需长任务显式传大
 *      timeout 并说明理由）。模型下一步自动按引导重新规划。
 *   3. /watchdog：on|off|status / timeout <秒> / remind <秒>（会话级，默认开启）。
 *   4. 命中事件 appendEntry 留痕（不进 LLM 上下文）。
 *
 * 备注：ctx.abort() 与 pi.sendUserMessage(steer) 可用于未来的"超时+无产出 → abort +
 * 注入 steer"完整闭环（方案 2），本期未启用。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONFIG,
	buildTimeoutRedirect,
	isTimeoutError,
	parseTimeoutSec,
	resolveBashTimeout,
	type WatchdogConfig,
} from "./logic.ts";

const APPENTRY_TYPE = "watchdog";

interface WatchdogState {
	enabled: boolean;
	config: WatchdogConfig;
}

function summarizeCommand(cmd: unknown): string {
	if (typeof cmd !== "string") return "(no command)";
	const c = cmd.trim();
	return c.length > 60 ? `${c.slice(0, 57)}...` : c;
}

export default function (pi: ExtensionAPI) {
	const state: WatchdogState = {
		enabled: true,
		config: { ...DEFAULT_CONFIG },
	};

	const trace = (msg: string) => {
		pi.appendEntry(APPENTRY_TYPE, { ts: Date.now(), msg });
	};

	// ---------------------------------------------------------------------
	// tool_call：兜底超时 / 长超时提醒
	// ---------------------------------------------------------------------
	pi.on("tool_call", (event, ctx) => {
		if (!state.enabled) return;
		if (event.toolName !== "bash") return;

		const decision = resolveBashTimeout(event.input, state.config);
		if (decision.action === "fill-default") {
			// 静默兜底：bash 无 timeout 时强制补默认值（事件 input 可就地修改）
			event.input.timeout = decision.timeoutSec;
			return;
		}
		if (decision.remind && decision.timeoutSec !== undefined) {
			const cmd = summarizeCommand(event.input.command);
			ctx.ui.notify(
				`watchdog: bash 请求 timeout=${decision.timeoutSec}s（> ${state.config.remindThresholdSec}s）: ${cmd}`,
				"info",
			);
			trace(`bash remind timeout=${decision.timeoutSec}s cmd=${cmd}`);
		}
	});

	// ---------------------------------------------------------------------
	// tool_result：超时终止 → 追加重新聚焦引导文本
	// ---------------------------------------------------------------------
	pi.on("tool_result", (event, ctx) => {
		if (!state.enabled) return;
		if (event.toolName !== "bash") return;
		if (!event.isError) return;

		const text = event.content
			.map((c) => (c.type === "text" ? c.text : ""))
			.join("\n");
		if (!isTimeoutError(text)) return;

		const sec =
			parseTimeoutSec(text) ??
			(typeof event.input.timeout === "number" ? event.input.timeout : undefined);
		const guide = buildTimeoutRedirect(sec);
		const cmd = summarizeCommand(event.input.command);

		ctx.ui.notify(`watchdog: bash 超时已终止，已附加重新聚焦引导（${cmd}）`, "warning");
		trace(`bash timed out cmd=${cmd} sec=${sec ?? "?"}`);

		// 保留原始输出 + 末尾追加引导（不替换，避免丢失命令输出细节）
		return { content: [...event.content, { type: "text", text: guide }] };
	});

	// ---------------------------------------------------------------------
	// /watchdog 命令：会话级开关与阈值调整
	// ---------------------------------------------------------------------
	pi.registerCommand("watchdog", {
		description: "bash 长命令治理：on/off/status / timeout <秒> / remind <秒>",
		getArgumentCompletions: (prefix: string) => {
			const words = ["on", "off", "status", "timeout", "remind"];
			return words
				.filter((w) => w.startsWith(prefix.toLowerCase()))
				.map((w) => ({ value: w, label: w }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [cmd, raw] = args.trim().split(/\s+/);

			const fmt = () =>
				`watchdog ${state.enabled ? "on" : "off"} · 兜底 timeout=${state.config.defaultTimeoutSec}s · 提醒阈值 remind=${state.config.remindThresholdSec}s`;

			switch (cmd) {
				case "on":
					state.enabled = true;
					ctx.ui.notify(`watchdog 已开启（${fmt()}）`, "info");
					break;
				case "off":
					state.enabled = false;
					ctx.ui.notify("watchdog 已关闭", "info");
					break;
				case "timeout": {
					const n = Number(raw);
					if (!Number.isInteger(n) || n < 1 || n > 3600) {
						ctx.ui.notify("用法：/watchdog timeout <1-3600 秒>", "error");
						break;
					}
					state.config.defaultTimeoutSec = n;
					ctx.ui.notify(`兜底 timeout 已设为 ${n}s`, "info");
					break;
				}
				case "remind": {
					const n = Number(raw);
					if (!Number.isInteger(n) || n < 1 || n > 86400) {
						ctx.ui.notify("用法：/watchdog remind <1-86400 秒>", "error");
						break;
					}
					state.config.remindThresholdSec = n;
					ctx.ui.notify(`提醒阈值已设为 ${n}s`, "info");
					break;
				}
				case "status":
				case "":
					ctx.ui.notify(fmt(), "info");
					break;
				default:
					ctx.ui.notify(
						"用法：/watchdog on|off|status / timeout <秒> / remind <秒>",
						"error",
					);
			}
		},
	});
}

// 类型来自 pi 扩展上下文；避免引入额外 import 链的类型擦除问题
type ExtensionCommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];
