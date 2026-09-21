/**
 * 核心引擎 — SDK 单 agent 执行（含 provider 支持）
 *
 * 使用 createAgentSession() + SessionManager.inMemory() 替代子进程 spawn，
 * 在同一个进程内创建隔离的子会话。
 */

import type { Message } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	SessionManager,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents";
import { createConfiguredSettingsManager, resolveProviderConfig } from "./auth.ts";
import { formatAgentError } from "./agent-list.ts";
import type { BudgetAccumulator } from "./budget";
import {
	runtimeRegistry,
	createThrottle,
	resolveRuntimeStatus,
	type RegisterInput,
	type RunningSubagent,
	type RuntimeMode,
	type RuntimeStatus,
} from "./runtime.ts";
import { clipLastLine, reduceSessionEvent } from "./runtime-events.ts";
import { decidePauseWait, decideResumedRound } from "./pause-loop.ts";
import { createChainResultStore } from "./chain-results.ts";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "global" | "project" | "unknown";
	task: string;
	messages: Message[];
	usage: UsageStats;
	model?: string;
	provider?: string;
	endedAt?: number;
	stopReason?: string;
	errorMessage?: string;
	exitCode: number; // 0=成功, 1=失败
	step?: number;
	/**
	 * 子代理实际运行 cwd（`cwd ?? defaultCwd`）。
	 *
	 * 跨包契约：父会话 cost-radar 解析 `details.results[].cwd`，
	 * 按 `cwd !== 父会话 cwd` 计「N 次子代理未纳入共享闸门」并在面板提示。
	 * 该字段恒有值（所有结果构造路径均填充）；老版本无该字段 → 不计数（保守）。
	 */
	cwd: string;
}

/**
 * 进度回调载荷：SingleResult 的可选子集 + 当前动作。
 * currentAction 供内嵌卡片同步展示（修好「黑盒干等」），不改变既有字段语义。
 */
export type SingleProgress = Partial<SingleResult> & { currentAction?: string };

/**
 * 并行/链式模式的进度回调：结果视图 + 最近触发的 currentAction。
 * currentAction 供内嵌卡片在并/链模式下同步展示当前动作。
 */
export type MultiProgress = (
	results: SingleResult[],
	currentAction?: string,
) => void;

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted"
	);
}

// 运行时 lastLine 截断 / currentAction 生命周期映射统一在 runtime-events.ts
// （纯函数、可被 node --test 加载）。

export function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= 50 * 1024) return output;

	let truncated = output.slice(0, 50 * 1024);
	while (Buffer.byteLength(truncated, "utf8") > 50 * 1024) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted]`;
}

// ---------------------------------------------------------------------------
// 单 agent 执行
// ---------------------------------------------------------------------------

// ---- 纵深防御：UI/注册表异常绝不反噬子代理执行 ----
// 运行时注册表只服务于面板展示。注册/写入/注销失败最多导致「可见性降级」，
// 但绝不能中断子会话、覆盖返回值或在 finally 中抛出异常。

/** 安全注册：注册失败或返回假值时返回 undefined（跳过后续运行时写入） */
function safeRuntimeRegister(input: RegisterInput): string | undefined {
	try {
		return runtimeRegistry.register(input) || undefined;
	} catch {
		// UI/注册表异常绝不反噬子代理执行
		return undefined;
	}
}

/** 安全写入：id 缺失或写入抛错时静默忽略 */
function safeRuntimeUpdate(
	id: string | undefined,
	patch: Partial<Omit<RunningSubagent, "id">>,
): void {
	if (!id) return;
	try {
		runtimeRegistry.update(id, patch);
	} catch {
		// UI/注册表异常绝不反噬子代理执行
	}
}

/** 安全注销：注销抛错时静默忽略 */
function safeRuntimeUnregister(id: string | undefined): void {
	if (!id) return;
	try {
		runtimeRegistry.unregister(id);
	} catch {
		// UI/注册表异常绝不反噬子代理执行
	}
}

/**
 * 在隔离的 SDK 会话中运行单个 agent。
 *
 * 通过 createAgentSession() + SessionManager.inMemory() 创建子会话，
 * 使用 session.subscribe() 收集消息和用量统计。
 *
 * @param defaultCwd   默认工作目录
 * @param agent        agent 配置
 * @param task         任务描述
 * @param cwd          可选的自定义工作目录
 * @param signal       可选的取消信号
 * @param onProgress   可选的进度回调
 * @param defaultProvider 父会话的 provider（用于情况 2/3）
 * @param defaultModel    父会话的 model（用于情况 3）
 */
export async function runSingleAgent(
	defaultCwd: string,
	agent: AgentConfig,
	task: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	onProgress?: (result: SingleProgress) => void,
	defaultProvider?: string,
	defaultModel?: string,
	runtime: { mode: RuntimeMode; slot: number } = { mode: "single", slot: 0 },
	budget?: BudgetAccumulator,
): Promise<SingleResult> {
	const runCwd = cwd ?? defaultCwd;
	const result: SingleResult = {
		agent: agent.name,
		agentSource: agent.source,
		task,
		messages: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		exitCode: 0,
		cwd: runCwd,
	};

	if (budget?.exhausted(runCwd)) {
		result.exitCode = 1;
		result.errorMessage = "子代理预算已耗尽，已跳过";
		return result;
	}

	// 解析 provider 配置：若 agent 指定了 provider/model，
	// 通过 SettingsManager 告知 createAgentSession 要用的模型。
	// "inherit" 时交给 SDK 按默认/继承行为自行发现。
	let sessionSettingsManager: ReturnType<typeof createConfiguredSettingsManager> | undefined;
	try {
		const resolution = resolveProviderConfig(
			agent.provider,
			agent.model,
			defaultProvider,
			defaultModel,
		);
		if (resolution !== "inherit") {
			sessionSettingsManager = createConfiguredSettingsManager(
				cwd ?? defaultCwd,
				getAgentDir(),
				resolution.provider,
				resolution.model,
			);
		}
	} catch (err: any) {
		result.exitCode = 1;
		result.errorMessage = err.message;
		return result;
	}

	const tools = agent.tools ?? [
		"read",
		"bash",
		"write",
		"edit",
		"grep",
		"find",
		"ls",
	];

	let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let runtimeId: string | undefined;
	// 用户是否经浮层 handle.abort() 主动中止：abort 路径下 session.prompt
	// 可能以非 aborted 的错误结束，需用本地标记兜底，否则终态被误判为 failed。
	let abortedByUser = false;
	// 是否因预算耗尽被中止（与用户中止区分，供面板/终态渲染）
	let abortedByBudget = false;
	// ---- 暂停/恢复状态（不销毁会话，结果持续累加到 result）----
	let pauseRequested = false; // 用户要求暂停
	let isPaused = false; // 当前处于暂停等待态
	let finishRequested = false; // 用户显式要求结束并返回父级
	let toolCallsInRun = 0; // 本轮 prompt 内工具调用次数（区分「恢复干活」与「纯问答」）
	const pendingMessages: string[] = []; // 暂停期间用户发来的消息
	let wake: (() => void) | undefined; // 唤醒暂停等待循环
	const notifyWake = (): void => {
		const w = wake;
		wake = undefined;
		w?.();
	};
	try {
		const created = await createAgentSession({
			cwd: cwd ?? defaultCwd,
			tools,
			sessionManager: SessionManager.inMemory(cwd ?? defaultCwd),
			...(sessionSettingsManager
				? { settingsManager: sessionSettingsManager }
				: {}),
		});
		session = created.session;

		// 共用中止实现：记录中止原因（user/budget）后 abort。即使 session.abort()
		// 抛错（session 已 dispose / abort 竞态），中止意图仍应体现为 ⊘ aborted，
		// 且错误照常向浮层传播（浮层负责 notify + 失败回写）。
		const abortRun = async (
			reason: "user" | "budget" = "user",
		): Promise<void> => {
			if (reason === "user") abortedByUser = true;
			else abortedByBudget = true;
			notifyWake();
			if (isPaused) {
				// 暂停态会话空闲，abort 可能抛错但无实际影响，直接忽略
				try {
					await session!.abort();
				} catch {
					// 忽略
				}
				return;
			}
			await session!.abort();
		};

		// ---- 运行时注册（供面板/干预浮层读取；id 用 ref 规避闭包先有鸡后有蛋）----
		const idRef = { current: "" };
		const rid = safeRuntimeRegister({
			agent: agent.name,
			agentSource: agent.source,
			task,
			mode: runtime.mode,
			slot: runtime.slot,
			startedAt: Date.now(),
			currentAction: "启动中…",
			handle: {
				steer: async (text: string) => {
					// 已暂停：会话空闲，消息入队由暂停循环立即 prompt（无需 steer）
					if (isPaused) {
						pendingMessages.push(text);
						safeRuntimeUpdate(idRef.current, { lastEventAt: Date.now() });
						notifyWake();
						return;
					}
					await session!.steer(text);
					let cur: RunningSubagent | undefined;
					try {
						cur = runtimeRegistry.get(idRef.current);
					} catch {
						// UI/注册表异常绝不反噬子代理执行
					}
					safeRuntimeUpdate(idRef.current, {
						steeringSent: (cur?.steeringSent ?? 0) + 1,
						lastEventAt: Date.now(),
					});
				},
				pause: async () => {
					// 暂停 = 中止当前活动，但保留会话（后续 steer 作为新 prompt 续跑）
					pauseRequested = true;
					safeRuntimeUpdate(idRef.current, { lastEventAt: Date.now() });
					try {
						await session!.abort();
					} catch {
						// 空闲态 abort 可能抛错：仍以 pauseRequested 生效
					}
					notifyWake();
				},
				finish: async () => {
					// 显式结束并返回父级：置位标记并唤醒暂停循环，
					// 由 decidePauseWait / decideResumedRound 优先判定而交回父级。
					// 不 abort、不触发终态 aborted，结果照常 return。
					finishRequested = true;
					safeRuntimeUpdate(idRef.current, { lastEventAt: Date.now() });
					notifyWake();
				},
				abort: (reason: "user" | "budget" = "user") => abortRun(reason),
			},
		});
		idRef.current = rid ?? "";
		runtimeId = rid;
		const shouldProgress = createThrottle(200);
		// 本地跟踪当前动作：首个工具开始前保持 undefined，使内嵌卡片回退到原有
		// 文本输出展示（「未提供时行为不变」）；一旦有工具执行则与注册表同源展示。
		let currentAction: string | undefined;

		// 订阅事件：收集消息、使用统计、运行时状态。
		// 运行期映射（currentAction 生命周期 / registry 补丁 / 进度请求）统一走
		// runtime-events.ts 纯函数，此处只执行副作用。
		unsubscribe = session.subscribe((event) => {
			const red = reduceSessionEvent(event, currentAction);
			currentAction = red.currentAction;
			if (red.toolCallStarted) toolCallsInRun++;
			if (red.patch) {
				safeRuntimeUpdate(rid, { ...red.patch, lastEventAt: Date.now() });
			}
			if (event.type === "tool_execution_start") {
				if (onProgress && red.progress && shouldProgress()) {
					onProgress({
						messages: [...result.messages],
						usage: { ...result.usage },
						currentAction,
					});
				}
			} else if (event.type === "message_end" && event.message) {
				const msg = event.message as Message & { errorMessage?: string }; // AgentMessage → Message（安全：message_end 始终是标准 assistant Message）
				result.messages.push(msg);

				if (msg.role === "assistant") {
					result.usage.turns++;
					const u = msg.usage;
					if (u) {
						result.usage.input += u.input || 0;
						result.usage.output += u.output || 0;
						result.usage.cacheRead += u.cacheRead || 0;
						result.usage.cacheWrite += u.cacheWrite || 0;
						result.usage.cost += u.cost?.total || 0;
						result.usage.contextTokens = u.totalTokens || 0;
					}
					if (msg.stopReason) result.stopReason = msg.stopReason;
					if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					if (msg.model && !result.model) result.model = msg.model;
					if (msg.provider) result.provider = msg.provider;
				}
				// 预算自查：每轮助手消息后累加并用本 run 的 cwd 判定（设计 §6.1）
				if (budget && msg.role === "assistant" && msg.usage) {
					budget.addTurn(msg.provider, msg.model, msg.usage, msg.timestamp);
					if (budget.exhausted(runCwd)) {
						// 预算中止无浮层消费方：吞掉 abort 拒绝，避免 unhandledRejection
						// （abortedByBudget 已置位，终态仍体现为 ⊘ aborted）
						abortRun("budget").catch(() => {});
					}
				}

				const firstText = (() => {
					if (msg.role !== "assistant") return undefined;
					for (const part of msg.content) {
						if (part.type === "text" && part.text) {
							return part.text.split("\n")[0];
						}
					}
					return undefined;
				})();
				safeRuntimeUpdate(rid, {
					lastEventAt: Date.now(),
					...(firstText ? { lastLine: clipLastLine(firstText) } : {}),
				});

				if (onProgress && result.messages.length > 0 && shouldProgress()) {
					onProgress({
						messages: [...result.messages],
						usage: { ...result.usage },
						currentAction,
					});
				}
			}
		});

		// 等待扩展工具（cbm_*）就绪：codebase-memory 扩展的 register() 是异步的
		// （MCP 握手，实测 ~250ms），注册完成后 pi 会刷新工具注册表。若 prompt
		// 发起过早，白名单中的 cbm 工具尚未注册，agent 将无法使用它们。
		const pendingExtTools = tools.filter((t) => t.startsWith("cbm_"));
		if (pendingExtTools.length > 0) {
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				const active = session.getActiveToolNames();
				if (pendingExtTools.every((t) => active.includes(t))) break;
				await new Promise((r) => setTimeout(r, 100));
			}
		}

		// 发送 prompt（通过 before_agent_start 注入 agent 系统提示）
		const fullPrompt = agent.systemPrompt
			? `## 系统指令\n\n${agent.systemPrompt}\n\n## 任务\n\n${task}`
			: task;

		// 单次 prompt；返回本轮是否调用过工具（用于区分「恢复干活」与「纯问答」）
		const runOnce = async (text: string): Promise<boolean> => {
			toolCallsInRun = 0;
			await session!.prompt(text, { signal });
			return toolCallsInRun > 0;
		};

		await runOnce(fullPrompt);

		// ---- 暂停/恢复编排循环 ----
		// 暂停不销毁会话：用户消息作为新 prompt 在同一会话上下文续跑，消息与用量
		// 持续累加到 result，最终统一 return（保证执行结果能交回父级）。
		// 退出条件：用户中止或预算中止 / 恢复后本轮产生了工具调用（视为继续并跑完）
		// / 自然结束。注意：预算中止发生在暂停态（如恢复后的纯问答轮）时也必须
		// 退出循环，否则会重新进入暂停等待且无人 notifyWake → 永久挂起。
		const isAborted = (): boolean => abortedByUser || abortedByBudget;
		while (!isAborted() && pauseRequested) {
			pauseRequested = false;
			isPaused = true;
			safeRuntimeUpdate(rid, {
				status: "paused",
				currentAction: undefined,
				lastEventAt: Date.now(),
			});

			// 等待用户发来一条消息（或中止/显式结束）——门控决策走纯函数
			let waitDecision = decidePauseWait({
				aborted: isAborted(),
				finishRequested,
				pendingCount: pendingMessages.length,
			});
			while (waitDecision === "wait") {
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				waitDecision = decidePauseWait({
					aborted: isAborted(),
					finishRequested,
					pendingCount: pendingMessages.length,
				});
			}
			// exit（中止）与 finish（显式结束）均退出暂停循环并把结果交回父级
			if (waitDecision === "exit" || waitDecision === "finish") break;

			const msg = pendingMessages.shift();
			if (msg === undefined) continue;

			isPaused = false;
			safeRuntimeUpdate(rid, { status: "running", lastEventAt: Date.now() });
			const usedTools = await runOnce(msg);
			// 本轮跑完后的编排决策走纯函数：
			// 中止/继续干活 → 退出并返回；再次暂停/纯问答 → 回到暂停等待。
			const roundDecision = decideResumedRound({
				aborted: isAborted(),
				finishRequested,
				pauseRequested,
				usedTools,
			});
			if (roundDecision === "exit" || roundDecision === "return") break;
			// pause-again / stay-paused：回到暂停态等待下一句
			pauseRequested = true;
		}
	} catch (err: any) {
		result.exitCode = 1;
		result.errorMessage = err.message ?? String(err);
	} finally {
		result.endedAt = Date.now();
		unsubscribe?.();
		session?.dispose();
		// 注册表收尾必须完全隔离：异常不得覆盖/吞掉本次 return result
		try {
			if (runtimeId) {
				const status: RuntimeStatus = resolveRuntimeStatus(
					abortedByUser || abortedByBudget,
					result,
				);
				safeRuntimeUpdate(runtimeId, {
					status,
					abortReason: abortedByUser
						? "user"
						: abortedByBudget
							? "budget"
							: undefined,
					currentAction: undefined,
				});
				const timer = setTimeout(
					() => safeRuntimeUnregister(runtimeId),
					3000,
				);
				(timer as unknown as { unref?: () => void }).unref?.();
			}
		} catch {
			// UI/注册表异常绝不反噬子代理执行
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// 并行模式
// ---------------------------------------------------------------------------

// 最大并行任务数（与 index.ts 中的 MAX_PARALLEL_TASKS 同步）
const MAX_CONCURRENCY = 4;

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

export async function runParallelAgents(
	defaultCwd: string,
	agents: AgentConfig[],
	tasks: { agent: string; task: string; cwd?: string }[],
	signal: AbortSignal | undefined,
	defaultProvider?: string,
	defaultModel?: string,
	onProgress?: MultiProgress,
	budget?: BudgetAccumulator,
	runOne: typeof runSingleAgent = runSingleAgent,
): Promise<SingleResult[]> {
	const allResults: SingleResult[] = new Array(tasks.length);

	// 初始化占位
	for (let i = 0; i < tasks.length; i++) {
		allResults[i] = {
			agent: tasks[i].agent,
			agentSource: "unknown",
			task: tasks[i].task,
			messages: [],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			exitCode: -1, // 运行中
			cwd: tasks[i].cwd ?? defaultCwd,
		};
	}

	return await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
		const agent = agents.find((a) => a.name === t.agent);
		if (!agent) {
			allResults[index].exitCode = 1;
			allResults[index].errorMessage = `Unknown agent: "${t.agent}"`;
			return allResults[index];
		}
		const result = await runOne(
			defaultCwd,
			agent,
			t.task,
			t.cwd,
			signal,
			(partial) => {
				if (partial.messages) allResults[index].messages = partial.messages;
				if (partial.usage) allResults[index].usage = partial.usage;
				onProgress?.([...allResults], partial.currentAction);
			},
			defaultProvider,
			defaultModel,
			{ mode: "parallel", slot: index },
			budget,
		);
		allResults[index] = result;
		onProgress?.([...allResults]);
		return result;
	});
}

// ---------------------------------------------------------------------------
// 链式模式
// ---------------------------------------------------------------------------

export async function runChainAgents(
	defaultCwd: string,
	agents: AgentConfig[],
	chain: { agent: string; task: string; cwd?: string }[],
	signal: AbortSignal | undefined,
	defaultProvider?: string,
	defaultModel?: string,
	onProgress?: MultiProgress,
	budget?: BudgetAccumulator,
	runOne: typeof runSingleAgent = runSingleAgent,
): Promise<SingleResult[]> {
	// 结果列表经单一写入路径累积（progress 只产出视图，不写 results）
	const store = createChainResultStore();
	let previousOutput = "";

	for (let i = 0; i < chain.length; i++) {
		const step = chain[i];
		const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
		const agent = agents.find((a) => a.name === step.agent);

		if (!agent) {
			store.commit({
				agent: step.agent,
				agentSource: "unknown",
				task: step.task,
				messages: [],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					contextTokens: 0,
					turns: 0,
				},
				exitCode: 1,
				errorMessage: formatAgentError(step.agent, agents),
				step: i + 1,
				cwd: step.cwd ?? defaultCwd,
			});
			onProgress?.(store.snapshot());
			return store.results;
		}

		const r = await runOne(
			defaultCwd,
			agent,
			taskWithContext,
			step.cwd,
			signal,
			(partial) => {
				if (partial.messages) {
					const progressResult: SingleResult = {
						agent: agent.name,
						agentSource: agent.source,
						task: step.task,
						messages: partial.messages,
						usage: partial.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						exitCode: -1,
						step: i + 1,
						cwd: step.cwd ?? defaultCwd,
					};
					// 仅展示进度视图，不写 results（写入只发生在 commit）；同时透传当前动作
					onProgress?.(store.progressView(progressResult), partial.currentAction);
				}
			},
			defaultProvider,
			defaultModel,
			{ mode: "chain", slot: i + 1 },
			budget,
		);
		r.step = i + 1;
		store.commit(r);
		onProgress?.(store.snapshot());

		if (isFailedResult(r)) return store.results; // 失败提前终止
		previousOutput = getFinalOutput(r.messages);
	}

	return store.results;
}
