# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/) 规范。

> 0.1.0 及更早的变更未归档，历史见 `git log`。

---

## [Unreleased]

## [0.5.0] - 2026-09-13

### 新增

- **暂停浮层 `r` 键「结束并返回」**：干预浮层对暂停态条目新增 `r` 操作——用户显式结束暂停并把当前结果交回父级，不再只能依赖「本轮是否发生 `tool_execution_start`」的启发式。优先级 `abort > finish > 暂停/工具`，`RuntimeHandle` 新增 `finish()`。
- **`SingleResult` / `details.results[]` 增加 `cwd` 契约字段**：记录子代理实际运行目录，供 cost-radar 判定跨 cwd 子代理是否纳入共享闸门（跨项目契约拓展，向后兼容）。
- **并行 / 链式进度透传 `currentAction`**：`parallel` / `chain` 内嵌卡片与常驻面板同源展示当前工具动作（`MultiProgress`），不再只有粗粒度文案。

### 变更

- **运行期接线可测化**：新增纯映射模块 `subagent/runtime-events.ts`，把「session 事件 → 运行期状态」的映射（`currentAction` 生命周期、registry 补丁、进度请求）从 `core.ts` 订阅回调抽出；`core.ts` / `index.ts` 改为单向调用，使此前因无扩展名相对导入而零单测覆盖的接线分支可被 `node --test` 覆盖。`panel.ts` 新增 `attachPanelIfUI`（`hasUI` 守卫 + 挂载异常隔离）。
- **暂停 / 恢复决策抽为纯函数**：新增 `subagent/pause-loop.ts`（`decidePauseWait()` / `decideResumedRound()`），`core.ts` 只执行副作用，行为不变。
- **文本处理收敛**：三处截断实现统一为 `subagent/text.ts` 的 `clipText`（省略号统一为单列 `…`）；`lastLine` 进入展示链路前统一 `sanitizeText`；`panel.ts` `detach()` 容错对齐 `attach()`；浮层 `render` 改用注入时钟；设计文档澄清 `handle` 失败由调用方 `notify` + 回写 `failed`。

### 修复

- **chain 模式 `results` 重复 / 错位**：`runChainAgents` 的进度回调原双向写入（`results[i] = progressResult` + 末尾 `results.push`）导致数组随进度膨胀、下标错位。抽出 `subagent/chain-results.ts` 纯状态容器，`commit()` 为唯一写入路径、`progressView()` 只读视图不写 `results`。

### 测试

- 新增 `runtime-events.test.ts`（15）、`chain-results.test.ts`、`pause-loop.test.ts`（7）、`text.test.ts`（4）、`core-cwd.test.ts` 等，`panel.test.ts` 补多例；累计 `node --test subagent/*.test.ts` **187/187**。6 个运行期接线分支变异、5 个暂停决策变异全部被单测杀死。

### 文档

- 显式「结束/返回」已实现；README「暂停 / 提问 / 继续」章节标注启发式限制。

## [0.4.0] - 2026-09-13

### 新增

- **子代理预算闸门（消费端，与 cost-radar 协作）**：pi-subagent 只读消费 cost-radar 发布的额度闸门（`globalThis.__piCostRadarBudget`，`version: 2`），新增纯逻辑模块 `subagent/budget.ts`（只读总线发现 + 按工具调用累加的累加器，无 pi 依赖、`node --test` 可加载）。
  - **拒启**：每次 `subagent` 工具调用建一个累加器（single / parallel / chain 内所有 run 共享）；启动 run 前若已触达额度则不建会话、直接返回失败结果。
  - **每轮自查 + 自中止**：每轮助手消息后按 `price` 累加本轮用量并 `check`，触达额度则 `abort("budget")` 中止该 run；`chain` 因中止停止后续步骤，`parallel` 排队任务启动前被拒启。
  - **中止原因可区分**：新增 `abortReason: "budget"`，运行时面板终态文案显示「预算用尽」以区别于用户经 `/agents-ps` 取消的「已中止」。
  - **归账契约**：`SingleResult` 补 `provider` / `endedAt`，`details.costContract = 1`（父会话 cost-radar 仅在该契约标记下解析 `details.results[].usage`）。
  - **降级恒等**：无总线 / `version !== 2` / 缺 `check`·`price` / 任一调用抛错 → 全部 no-op，子代理行为与未接入前逐字节一致；总线异常绝不反噬执行。未装或未升级 cost-radar 时全程 no-op。
  - **测试**：新增 `subagent/budget.test.ts`（降级、异常隔离、累加器正确性），`subagent/panel.test.ts` 补中止原因渲染用例。
  - **设计规格**：判定公式、消费端改动、降级与边界矩阵均已定稿。

## [0.3.0] - 2026-09-13

### 新增

- **暂停 / 提问 / 继续（人机协同）**：干预浮层新增 `p` 暂停选中子代理——中断其当前活动但**保留会话**；随后 `s` 输入的消息在同一会话上下文作为新 prompt **立即执行**，因此可以停下来向子代理提问，也可以输入「继续」让它接着干原任务。SDK 无原生 `pause`，实现为「中断当前 turn + 保留会话 + 再用同一会话 prompt」的近似。
  - **结果必回父级**：暂停期间不销毁会话、不提前返回，每次 prompt 的消息与用量持续累加到同一 result，最终统一 `return`——无论中间问答多少轮，子代理的最终执行结果都能交回父会话。
  - **「继续」与「纯问答」的区分**：暂停后的一轮若子代理调用了工具（=在干活/继续），该轮跑完即结束并返回结果；若只回了纯文本（=纯问答），则继续停在暂停态等待下一句。
  - **注意**：这是「中断」而非「冻结进程」，`p` 会打断正在跑的工具（`sleep` 之类会被杀）。
- **`/agents-ps` 斜杠命令作为唯一干预入口**：不依赖任何特殊按键，可绕开 macOS 等无法上报 Meta/增强按键序列的终端；斜杠命令在子代理运行中会被立即执行、不被排队。**原有 `alt+x` / `ctrl+shift+x` / `f2` 三个快捷键全部取消。**
- **干预浮层制表符边框**（`┌─┐│└┘`）：宽度按 `visibleWidth` 计算，中文/emoji 不错位；超宽行 `truncateToWidth` 截断，每行可见宽度严格等于给定宽度以保证右边框对齐。
- **暂停态连续对话**：暂停态按回车发送后**保持输入态**，可直接输入下一句（无需每轮重按 `s`）；`esc` 退出输入态。

### 变更

- 常驻面板汇总由 `⊙ N running` 改为 `⊙ N active`（`paused` 计入），暂停条目显示 `⏸`。
- 干预浮层操作对象由仅 `running` 扩展为 `running` 与 `paused`（暂停条目仍可对话 / 继续 / 中止）。
- 暂停态发送浮层提示为「已发送给 …（暂停中，立即处理）」，区别于运行态的「已注入指令（排队投递，子代理跑完当前工具后生效）」。
- README「运行时控制面」章节、E2E 脚本（`M-x` → `/agents-ps`）同步更新；「哪些不做」移除「暂停/恢复」。

### 测试

- 新增暂停交互单测（`p` 暂停、暂停条目显示/可操作、暂停态连续对话保持输入态、暂停态提示文案、`p` 对已暂停条目不重复触发、`⏸`+`active` 渲染）。全量 `131 pass / 0 fail`。
- 集成实测（tmux 真实 TUI）：`sleep` 运行 → `p` 暂停（aborted）→ 提问（回答并仍暂停）→「继续」→ 重新执行并报告 → 结果返回父会话。

## [0.2.1] - 2026-09-13

### 文档

- README「快速开始」新增「升级」小节：`pi update --extensions`（与 `--all`）会重建包依赖但**不会移动**已固定的 tag/commit ref，固定过 ref 的安装需用 `pi install <源>@<新 ref>` 迁移（引用 pi 文档 `docs/packages.md` 的 Git 源一节）；`pi -e` 临时加载无需升级；升级不会覆盖 `~/.pi/agent/agents/` 下已存在的 agent，需要新版定义时用 Web Studio（`/agents-web`）的「恢复预装」（从包内 `agents/` 重新写入，带差异预览）。目录同步补「升级」子条目。

## [0.2.0] - 2026-09-13

### 新增

- **子代理运行时控制面**（`subagent/runtime.ts` + `subagent/panel.ts`）：解决「子代理跑起来后父会话只能干等」。
  - **看得见**：有子代理运行时，编辑器下方出现常驻状态面板（`● implementer · 12s · bash: npm test · ↩1`，最多 4 行、超出折叠），状态图标 `●` running / `⊘` aborted / `✓` done / `✗` failed，每秒刷新；全部结束（终态保留 3 秒）后自动消失。single 模式下内嵌进度卡片同步显示当前动作，不再只在消息结束时刷新。
  - **插得上手**：`alt+x` 唤出干预浮层——`↑↓` 选择、`s` 输入并注入指令（**排队投递**，子代理跑完当前工具批次才生效）、`x` 中止选中项（parallel 其余继续、chain 自然停止）、`a` 全部中止、`esc` 关闭。中止只作用于子会话，**不牵连父回合**，父工具照常返回部分结果供模型重规划。
  - 语义与边界：steer 文本以 `/` 开头会被拒并提示（不计入 `↩n`）；用户主动中止优先于成功/失败判定（终态 `⊘`）；无 UI 模式（`pi -p` / RPC）全链路静默跳过，行为与改动前一致。YAGNI 明确不做：危险动作审批拦截、Web Studio 改造、暂停/恢复、RPC 远程干预、热键可配置化、子代理输出全文查看。
- **单测**：`subagent/runtime.test.ts`、`subagent/panel.test.ts`（注册表语义、面板纯函数、键盘 reducer、面板控制器生命周期、干预浮层，注入 fake handle / fake UI，零依赖）。
- **端到端验证**：`subagent/e2e/runtime-control.sh`（tmux 驱动真实 TUI，9 条断言：面板出现、耗时递增、当前动作可见、浮层、steer 排队投递、`x` 中止 → `⊘`、父卡片含 aborted、终态 3 秒后面板消失、无 running 时提示），自带隔离环境（临时 `HOME` + `PI_CODING_AGENT_DIR`，含 mock agent `runtime-e2e`）。
- **文档**：README 新增「运行时控制面」章节（含热键、steer 排队语义、中止语义、手动验收清单、YAGNI 清单）。

### 修复

- **内嵌卡片/面板残留陈旧动作**：工具结束后仍显示上一次的工具动作（`currentAction` 直到子代理结束才清空），新增 `tool_execution_end` 清位，回退到最近输出行。
- **用户主动中止的终态错误**：浮层 `x`/`a` 中止后显示 `✗ failed`（被 `isFailedResult` 吞掉），修正为设计要求的 `⊘ aborted`；模型自身失败仍为 `✗ failed`。
- **面板 `attach()` 失败后永久失联**：一次瞬时 UI 异常会让控制器整会话拒绝再挂载，改为失败回滚（清定时器、退订、复位状态）且不向调用方抛异常。
- **工具参数可注入 ANSI 控制序列**：模型生成的命令/路径原样进入 TUI 行，`describeToolCall` 增加控制字符清洗（保留可见字符与中文）。
- **运行时注册表异常可能反噬子代理执行**：注册/写入/注销全部安全包裹，UI 侧异常最多导致「可见性降级」，绝不中断子会话、不覆盖返回值。
- **干预浮层三处行为缺陷**：`x`/`s` 曾作用于首个条目而非选中项；abort-all 部分失败无汇总提示（改用 `Promise.allSettled` 并提示失败数）；steer/abort 失败时只有浮层 notice、缺少 `notify(..., "error")` 与失败状态回写。
- **E2E 脚本加固**：消除 4 类可静默通过（真失败也 PASS）的弱断言、断言耗时严格递增、环境隔离不再污染真实 `~/.pi/agent/agents-stats.json`、`trap` 覆盖 INT/TERM、明确禁止父模型重试以免污染终态观察。
