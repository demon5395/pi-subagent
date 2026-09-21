import { test } from "node:test";
import assert from "node:assert/strict";
import { ELLIPSIS, clipText } from "./text.ts";

// 三处截断实现收敛后的唯一契约：
//   结果总长（含省略号）不超过 max；省略号统一为单列宽 `…`。

test("clipText：未超长原样返回", () => {
	assert.equal(clipText("hello", 5), "hello");
	assert.equal(clipText("hello", 10), "hello");
});

test("clipText：恰好在边界不截断", () => {
	assert.equal(clipText("x".repeat(5), 5), "x".repeat(5));
});

test("clipText：超长截断为 max-1 字符 + 单列省略号", () => {
	const out = clipText("x".repeat(10), 5);
	assert.equal(out, `xxxx${ELLIPSIS}`);
	assert.equal(out.length, 5);
	assert.equal(ELLIPSIS, "…", "省略号必须是单列宽 `…`，不是 `...`");
});

test("clipText：max=1 只留省略号，max<=0 返回空串", () => {
	assert.equal(clipText("abc", 1), ELLIPSIS);
	assert.equal(clipText("abc", 0), "");
	assert.equal(clipText("abc", -3), "");
});
