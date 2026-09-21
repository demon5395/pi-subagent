/**
 * 子代理预算消费端（纯逻辑 + 薄适配）
 *
 * 只读消费 cost-radar 经 globalThis.__piCostRadarBudget 发布的只读闸门
 * （version 2：check/price）。无总线 / 版本不符 / 任一次调用抛错 → 全部 no-op，
 * 子代理行为与未接入前逐字节一致。
 *
 * 本模块不得 import core.ts / index.ts / panel.ts，以保证 node --test 可加载。
 */

export interface Usage4 {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** cost-radar 侧 CostRadarBudget 的结构型（跨包，不 import pi-zh） */
export interface BudgetBus {
	readonly version: 2;
	readonly ownerSessionId: string;
	readonly cwd: string;
	check(cwd: string): { limit: number | null; parentSpend: number };
	price(
		provider: string,
		model: string,
		usage: Usage4,
		tsMs: number,
	): { yuan: number | null; covered: boolean };
}

export const BUDGET_BUS_KEY = "__piCostRadarBudget";

/** 发现总线；不存在 / 结构不符 / version !== 2 → undefined（降级 no-op） */
export function resolveBudget(
	g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): BudgetBus | undefined {
	const raw = g[BUDGET_BUS_KEY];
	if (!raw || typeof raw !== "object") return undefined;
	const b = raw as Partial<BudgetBus>;
	if (b.version !== 2) return undefined;
	if (typeof b.check !== "function" || typeof b.price !== "function") return undefined;
	return b as BudgetBus;
}

export interface BudgetAccumulator {
	/** 上报一轮用量并按父配置计价累加；无总线 / 未收录 → 不累加（绝不抛出） */
	addTurn(provider: string, model: string, usage: Usage4, tsMs: number): void;
	/** 当前工具调用是否已使总额（parentSpend + 本工具调用已耗）触达额度；无总线 → false */
	exhausted(cwd: string): boolean;
	/** 仅供测试/诊断 */
	spent(): number;
}

/** 每次工具调用建一个累加器；整组 run 共享同一实例（见设计 §6.1） */
export function createAccumulator(bus: BudgetBus | undefined): BudgetAccumulator {
	let acc = 0;
	return {
		addTurn(provider, model, usage, tsMs) {
			if (!bus) return;
			try {
				const { yuan } = bus.price(provider, model, usage, tsMs);
				if (yuan !== null && Number.isFinite(yuan)) acc += yuan;
			} catch {
				// 总线异常绝不反噬子代理执行
			}
		},
		exhausted(cwd) {
			if (!bus) return false;
			try {
				const { limit, parentSpend } = bus.check(cwd);
				return limit !== null && parentSpend + acc >= limit;
			} catch {
				return false;
			}
		},
		spent() {
			return acc;
		},
	};
}
