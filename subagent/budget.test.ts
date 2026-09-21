import { test } from "node:test";
import assert from "node:assert/strict";
import {
	BUDGET_BUS_KEY,
	createAccumulator,
	resolveBudget,
	type BudgetBus,
	type Usage4,
} from "./budget.ts";

const U = (over: Partial<Usage4> = {}): Usage4 => ({
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...over,
});

/** 假总线：input 每 token ¥1，output 每 token ¥2；limit 可注入 */
function fakeBus(limit: number | null, parentSpend = 0, cwd = "/w"): BudgetBus {
	return {
		version: 2,
		ownerSessionId: "s1",
		cwd,
		check(c: string) {
			return c === cwd ? { limit, parentSpend } : { limit: null, parentSpend: 0 };
		},
		price(_p, _m, u) {
			return { yuan: u.input * 1 + u.output * 2, covered: true };
		},
	};
}

test("resolveBudget：无键返回 undefined", () => {
	assert.equal(resolveBudget({}), undefined);
});

test("resolveBudget：version 不符/结构缺失返回 undefined", () => {
	assert.equal(resolveBudget({ [BUDGET_BUS_KEY]: { version: 1 } }), undefined);
	assert.equal(resolveBudget({ [BUDGET_BUS_KEY]: { version: 2 } }), undefined);
});

test("resolveBudget：合法对象原样返回", () => {
	const bus = fakeBus(10);
	assert.equal(resolveBudget({ [BUDGET_BUS_KEY]: bus }), bus);
});

test("无总线：addTurn 不累加、exhausted 恒 false", () => {
	const a = createAccumulator(undefined);
	a.addTurn("x", "y", U({ input: 999 }), 1);
	assert.equal(a.spent(), 0);
	assert.equal(a.exhausted("/w"), false);
});

test("累加：按 price 计价，未收录(null)不累加", () => {
	const bus = fakeBus(100);
	bus.price = (_p, _m, u) => ({
		yuan: u.input > 0 ? u.input : null,
		covered: u.input > 0,
	});
	const a = createAccumulator(bus);
	a.addTurn("x", "y", U({ input: 3 }), 1);   // +3
	a.addTurn("x", "y", U({ output: 5 }), 2);  // 未收录 → 不计
	assert.equal(a.spent(), 3);
});

test("exhausted：parentSpend + acc 触达 limit", () => {
	const bus = fakeBus(10, 7);
	const a = createAccumulator(bus);
	assert.equal(a.exhausted("/w"), false);      // 7 < 10
	a.addTurn("x", "y", U({ input: 3 }), 1);     // 7+3 >= 10
	assert.equal(a.exhausted("/w"), true);
});

test("exhausted：limit===null 恒 false；cwd 不匹配恒 false", () => {
	const a1 = createAccumulator(fakeBus(null, 999));
	a1.addTurn("x", "y", U({ input: 1000 }), 1);
	assert.equal(a1.exhausted("/w"), false);

	const a2 = createAccumulator(fakeBus(1, 0, "/other"));
	a2.addTurn("x", "y", U({ input: 1000 }), 1);
	assert.equal(a2.exhausted("/w"), false);     // cwd 不匹配 → check 返回 limit:null
});

test("非有限数价格：NaN/Infinity 不累加（防污染 acc 致 exhausted 失效）", () => {
	const bus = fakeBus(10);
	const a = createAccumulator(bus);
	bus.price = () => ({ yuan: Number.NaN, covered: true });
	a.addTurn("x", "y", U({ input: 1 }), 1);
	assert.equal(a.spent(), 0);
	bus.price = () => ({ yuan: Infinity, covered: true });
	a.addTurn("x", "y", U({ input: 1 }), 2);
	assert.equal(a.spent(), 0);
});

test("异常隔离：price/check 抛错不逸出、按未计价/未超支处理", () => {
	const bus = fakeBus(1);
	bus.price = () => { throw new Error("boom"); };
	bus.check = () => { throw new Error("boom"); };
	const a = createAccumulator(bus);
	assert.doesNotThrow(() => a.addTurn("x", "y", U({ input: 1 }), 1));
	assert.equal(a.spent(), 0);
	assert.equal(a.exhausted("/w"), false);
});
