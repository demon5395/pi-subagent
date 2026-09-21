/**
 * Provider/Auth 支持模块
 *
 * 三级优先策略：
 *   1. agent .md 中指定了 provider + model → 使用 agent 自己的 provider/model
 *   2. agent .md 只指定了 model → 使用父会话的 provider，切换 model
 *   3. agent .md 未指定 → 完全继承父会话的 provider/model
 *
 * 通过 SettingsManager.setDefaultModelAndProvider() 将模型选择传递给
 * createAgentSession，由 SDK 内部完成 Model/AuthStorage/ModelRegistry 的构建。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// auth.json 读取
// ---------------------------------------------------------------------------

interface AuthEntry {
	type: "api_key" | "oauth";
	key?: string;
	token?: string;
}

interface AuthStore {
	[provider: string]: AuthEntry;
}

/** 读取 ~/.pi/agent/auth.json */
export function readAuthStore(): AuthStore {
	const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
	try {
		return JSON.parse(fs.readFileSync(authPath, "utf-8"));
	} catch {
		return {};
	}
}

/** 获取指定 provider 的 API Key */
export function getApiKey(provider: string): string | undefined {
	const store = readAuthStore();
	const entry = store[provider];
	return entry?.key;
}

// ---------------------------------------------------------------------------
// Provider 配置解析
// ---------------------------------------------------------------------------

/**
 * 三级优先策略的结果。
 */
export type ProviderResolution =
	| { provider: string; model: string }
	| "inherit";

/**
 * 根据 agent 配置计算使用的 provider 和 model。
 *
 * 三种返回：
 *   1. { provider, model } — 指定了 provider+model 或仅指定 model（有父 provider）
 *   2. "inherit" — 继承父会话（情况 3：都未指定）
 *   3. throw — 指定了 provider 但 auth.json 中无 API Key
 */
export function resolveProviderConfig(
	agentProvider?: string,
	agentModel?: string,
	defaultProvider?: string,
	defaultModel?: string,
): "inherit" | ProviderResolution {
	// 情况 1：指定了 provider + model → 完整自定义
	if (agentProvider && agentModel) {
		const apiKey = getApiKey(agentProvider);
		if (!apiKey) {
			throw new Error(
				`Provider "${agentProvider}" 在 auth.json 中未找到 API Key`,
			);
		}
		return { provider: agentProvider, model: agentModel };
	}

	// 情况 2：只指定了 model → 用父会话 provider，切换 model
	if (agentModel) {
		if (!defaultProvider) {
			throw new Error(
				`Agent 指定了 model "${agentModel}"，但父会话无 provider 可继承。`,
			);
		}
		return { provider: defaultProvider, model: agentModel };
	}

	// 情况 3：都未指定 → 继承父会话
	return "inherit";
}

// ---------------------------------------------------------------------------
// SettingsManager 辅助：构造带预设 provider/model 的 SettingsManager
// ---------------------------------------------------------------------------

/**
 * 创建预设了 provider/model 的 SettingsManager。
 * 传给 createAgentSession({ settingsManager }) 后 SDK 内部会通过
 * findInitialModel → settingsManager.getDefaultProvider/Model 找到我们指定的模型。
 */
export function createConfiguredSettingsManager(
	cwd: string,
	agentDir: string,
	provider: string,
	modelId: string,
): SettingsManager {
	const sm = SettingsManager.create(cwd, agentDir);
	sm.setDefaultModelAndProvider(provider, modelId);
	return sm;
}
