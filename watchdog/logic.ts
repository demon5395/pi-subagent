// ---------------------------------------------------------------------------
// Watchdog — bash 长命令治理 · 纯逻辑层（可单测，无 pi 依赖）
// ---------------------------------------------------------------------------
//
// 语义（方案 ii：不硬掐模型显式传的 timeout）：
//   1. bash 调用无 timeout        → 兜底补 defaultTimeoutSec（默认 60s）
//   2. 显式 timeout ≤ 提醒阈值    → 放行
//   3. 显式 timeout > 提醒阈值    → 放行但标记 remind（由 index.ts notify 用户）
//   4. 命令实际超时被 pi 终止     → 工具结果追加"重新聚焦引导文本"
//
// 超时引导不替换原始输出：模型既保留命令输出/错误细节，又收到重定向指令。

export interface WatchdogConfig {
	/** 兜底超时（秒）：模型未传 timeout 时补上的值。默认 60 */
	defaultTimeoutSec: number;
	/** 提醒阈值（秒）：显式 timeout 超过该值才 notify 用户。默认 300 */
	remindThresholdSec: number;
}

export const DEFAULT_CONFIG: WatchdogConfig = {
	defaultTimeoutSec: 60,
	remindThresholdSec: 300,
};

export type TimeoutAction =
	| { action: "fill-default"; timeoutSec: number }
	| { action: "leave"; timeoutSec: number | undefined; remind: boolean };

/**
 * 决定 bash 调用的超时处理方式。
 * 仅读 input.timeout（可以是任意值），由调用方决定是否就地 mutate input。
 */
export function resolveBashTimeout(
	input: { timeout?: unknown },
	cfg: WatchdogConfig = DEFAULT_CONFIG,
): TimeoutAction {
	const raw = input.timeout;
	// 未传、或传了无效值（负数/0/NaN/非数）→ 兜底
	if (raw === undefined || typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
		return { action: "fill-default", timeoutSec: cfg.defaultTimeoutSec };
	}
	const remind = raw > cfg.remindThresholdSec;
	return { action: "leave", timeoutSec: raw, remind };
}

const TIMED_OUT_RE = /timed\s+out\s+after\s+(\d+(?:\.\d+)?)/i;

/** 判断工具结果错误文本是否为 pi 的 bash 超时终止。 */
export function isTimeoutError(text: string): boolean {
	return /timed\s*out/i.test(text);
}

/** 从超时文本提取整秒数；找不到返回 undefined。 */
export function parseTimeoutSec(text: string): number | undefined {
	const m = TIMED_OUT_RE.exec(text);
	if (!m) return undefined;
	const n = Number(m[1]);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 生成追加到工具结果末尾的重新聚焦引导文本。
 * 追加而非替换：模型仍能看到命令的原始输出与错误。
 */
export function buildTimeoutRedirect(timeoutSec: number | undefined): string {
	const sec = timeoutSec !== undefined ? `（超过 ${timeoutSec} 秒）` : "";
	return [
		``,
		`---`,
		`⚠️ watchdog：该命令因超时已被终止${sec}。不要原样重试这条命令。`,
		`请重新评估执行策略，选一种更快的方式：`,
		`1. 拆成更小的步骤，先跑最小验证（单文件/子集/局部改动）；`,
		`2. 收窄范围：例如测试子集、增量构建、只处理当前目标；`,
		`3. 若任务确实需要长时间运行，请显式传入更大的 timeout（如 timeout: 600）`,
		`   并在执行前用一句话说明理由。`,
		`---`,
	].join("\n");
}
