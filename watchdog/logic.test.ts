import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CONFIG,
	buildTimeoutRedirect,
	isTimeoutError,
	parseTimeoutSec,
	resolveBashTimeout,
	type WatchdogConfig,
} from "./logic.ts";

// ---------------------------------------------------------------------------
// resolveBashTimeout — 兜底 / 放行 / 提醒 三分支
// ---------------------------------------------------------------------------

test("无 timeout → fill-default，补默认值 60s", () => {
	const d = resolveBashTimeout({}, DEFAULT_CONFIG);
	assert.equal(d.action, "fill-default");
	if (d.action === "fill-default") {
		assert.equal(d.timeoutSec, 60);
	}
});

test("显式 timeout 30s → leave，不提醒", () => {
	const d = resolveBashTimeout({ timeout: 30 }, DEFAULT_CONFIG);
	assert.equal(d.action, "leave");
	if (d.action === "leave") {
		assert.equal(d.timeoutSec, 30);
		assert.equal(d.remind, false);
	}
});

test("显式 timeout 恰等于提醒阈值 300s → leave，不提醒（严格大于才提醒）", () => {
	const d = resolveBashTimeout({ timeout: 300 }, DEFAULT_CONFIG);
	assert.equal(d.action, "leave");
	if (d.action === "leave") {
		assert.equal(d.remind, false);
	}
});

test("显式 timeout 301s → leave，触发提醒", () => {
	const d = resolveBashTimeout({ timeout: 301 }, DEFAULT_CONFIG);
	assert.equal(d.action, "leave");
	if (d.action === "leave") {
		assert.equal(d.remind, true);
	}
});

test("无效 timeout（负数/0/NaN）→ 兜底 fill-default", () => {
	for (const bad of [-1, 0, Number.NaN]) {
		const d = resolveBashTimeout({ timeout: bad }, DEFAULT_CONFIG);
		assert.equal(d.action, "fill-default", `timeout=${bad} 应兜底`);
	}
});

test("自定义配置生效", () => {
	const cfg: WatchdogConfig = { defaultTimeoutSec: 30, remindThresholdSec: 120 };
	const d1 = resolveBashTimeout({}, cfg);
	assert.equal(d1.action === "fill-default" && d1.timeoutSec, 30);
	const d2 = resolveBashTimeout({ timeout: 121 }, cfg);
	assert.equal(d2.action, "leave");
	if (d2.action === "leave") {
		assert.equal(d2.remind, true);
	}
});

// ---------------------------------------------------------------------------
// isTimeoutError / parseTimeoutSec — 识别 pi 的超时终止错误文本
// ---------------------------------------------------------------------------

test("识别 pi 超时错误文本", () => {
	assert.equal(isTimeoutError("Command timed out after 60 seconds"), true);
	assert.equal(isTimeoutError("timed out after 60 seconds"), true);
	assert.equal(isTimeoutError("bash: command not found"), false);
});

test("从超时文本提取秒数", () => {
	assert.equal(parseTimeoutSec("Command timed out after 60 seconds"), 60);
	assert.equal(parseTimeoutSec("Command timed out after 2.5 seconds"), 2.5); // pi 可能输出小数秒
	assert.equal(parseTimeoutSec("some other error"), undefined);
});

// ---------------------------------------------------------------------------
// buildTimeoutRedirect — 追加到工具结果末尾的重新聚焦引导文本
// ---------------------------------------------------------------------------

test("引导文本包含重定向指令与超时时长", () => {
	const text = buildTimeoutRedirect(60);
	assert.ok(/不要原样重试|不要.*重试/.test(text), "应明确禁止原样重试");
	assert.ok(/拆|最小验证|更小/.test(text), "应提示拆小步/最小验证");
	assert.ok(text.includes("60"), "应带上超时秒数");
	assert.ok(/timeout/.test(text), "应引导显式传更大 timeout");
});

test("未知超时时长时引导文本不抛错", () => {
	const text = buildTimeoutRedirect(undefined);
	assert.ok(text.length > 0);
});
