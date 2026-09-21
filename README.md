# Subagent SDK

> `createAgentSession` + `SessionManager.inMemory()` — 同一进程内隔离上下文，无需启动子进程。

Single / Parallel / Chain 三种模式 · 自定义 Provider（三级优先策略）· 流式 TUI 渲染 · **8 个预装 Agent** · **内置 task-orchestrator Skill** · **Agent 调用统计**

---

## 快速开始

### 安装

```bash
# 方式一：本地路径（在本仓库根目录执行）
pi install ./

# 方式二：临时加载
pi -e ./

# 方式三：Git 远程（生产）
pi install https://github.com/demon5395/pi-subagent
```

加载成功后看到 `Extensions (1): pi-subagent` 即完成。

首次启动时，插件会自动将 8 个预装 agent 复制到 `~/.pi/agent/agents/`，**不会覆盖已有同名文件**。

### 验证

```
/agents                 # 列出所有可用 agent
/task-orchestrator      # 查看 skill 是否可用（无参数会提示输入需求）
subagent: 使用 scout-overview 列出当前项目结构
```

### 升级

当前版本 **0.5.0**。

```bash
# 未固定 ref 的安装（本 README 方式三）：拉取最新提交并重建
pi update --extensions

# 固定在某个 tag/commit 的安装：先迁移到新 ref 再更新
pi install https://github.com/demon5395/pi-subagent@v0.5.0

# 临时加载方式无需升级，重新拉取仓库即可
```

> 说明：`pi update --extensions`（与 `--all`）会重建包依赖、但**不会移动**已固定的 tag/commit ref——
> 固定过 ref 的安装必须用 `pi install <源>@<新 ref>` 迁移。升级仅替换插件文件；`~/.pi/agent/agents/`
> 下已存在的 agent 不会被覆盖，需要新版定义时用 Web Studio（`/agents-web`）管理面板的「恢复预装」
> （从包内 `agents/` 重新写入，带差异预览）。

---

## 预装 Agent 一览

首次加载时插件自动将包内 `agents/` 下的 8 个 agent 文件复制到 `~/.pi/agent/agents/`，**不会覆盖已有同名文件**（用户自定义优先）。

> cbm 查询 6 件套 = `cbm_get_architecture, cbm_search_code, cbm_search_graph, cbm_trace_path, cbm_get_code_snippet, cbm_query_graph`（只读知识图谱查询，索引由主会话负责）

### 核心角色（4 个）

| Agent | 角色 | 做什么 | 工具 |
|-------|------|--------|------|
| **scout-overview** 🕵️‍♂️ | 全面侦察 | 侦察项目结构，输出整体布局和关键文件摘要 | read, bash, ls, find, grep + cbm 查询 6 件套 |
| **implementer** 🛠️ | 实现者 | 按计划实现代码，遵循 TDD，带状态报告协议 | read, bash, write, edit, grep, find, ls |
| **expert** 🔬 | 专家（手动派发专用） | 代码分析与调试，诊断 Bug 和性能问题 | read, bash, write, edit, grep, find, ls + cbm 查询 6 件套 |
| **writer** 📝 | 文档撰写（手动派发专用） | 编写技术文档和 README，遵循中文排版规范 | read, write, edit, bash, grep, ls |

### 审查角色（4 个）

| Agent | 角色 | 做什么 | 工具 |
|-------|------|--------|------|
| **reviewer** 👁️ | 设计审查 | 审查架构设计、模块划分和技术方案 | read, grep, find, ls + cbm 查询 6 件套 |
| **spec-reviewer** ✅ | 规格审查 | 对比实现与规格，检查缺失和多余功能 | read, grep, find, ls |
| **code-reviewer** 🔍 | 代码审查 | 审查代码质量、安全性、可维护性和项目模式遵从 | read, grep, find, ls, bash + cbm 查询 6 件套 |
| **final-reviewer** 🏁 | 最终审查 | 所有任务完成后整体审查，检查可合并性 | read, bash, grep, find, ls + cbm 查询 6 件套 |

### 分工原理

四个审查 Agent 关注点完全不同，按流水线顺序执行：

```
reviewer        → "这么设计行不行？"     （规划阶段）
spec-reviewer   → "功能做对了没？"       （每个任务后）
code-reviewer   → "代码写得好不好？"     （每个任务后，先于 spec-reviewer）
final-reviewer  → "整体能不能合并？"     （所有任务完成后）
```

> 所有预装 agent 均使用当前会话的 provider/model（三级优先策略的「情况 3」）。
> 每个 agent 的 `suggested-model` 字段提供模型建议（仅供展示参考，不参与模型选择）。
> 你可以在 frontmatter 中追加 `provider` / `model` 字段来切换为自定义配置。

---

## 使用模式

| 模式 | 用法 | 说明 |
|------|------|------|
| **Single** | `subagent: 使用 scout-overview 列出项目结构` | 单 agent 执行 |
| **Parallel** | `subagent: tasks: [{agent: "scout-overview", task: "..."}, ...]` | 并行执行，最多 8 个任务，并发 4 |
| **Chain** | `subagent: chain: [{agent: "scout-overview", task: "..."}, ...]` | 链式执行，`{previous}` 传递上下文，失败即终止 |

### Single 模式（单 agent）

```
subagent: 使用 scout-overview 列出项目结构
subagent: 使用 expert 分析 src/core.ts 的性能瓶颈
```

### Parallel 模式（并行）

```
subagent: tasks: [
  {agent: "scout-overview", task: "列出 src/ 下的 .ts 文件"},
  {agent: "scout-overview", task: "列出 tests/ 下的测试文件"}
]
```

### Chain 模式（链式）

```
subagent: chain: [
  {agent: "scout-overview", task: "列出项目文件结构"},
  {agent: "implementer", task: "实现：\n{previous}"}
]
```

`{previous}` 占位符引用上一步的最终输出。任一步骤失败则提前终止。

---

## 任务编排入口

插件内置 **task-orchestrator** skill，通过 `resources_discover` 事件注册包内 `skills/` 目录，**不复制到用户目录**。安装时 Pi 直接从包路径加载，卸载即消失，零残留。

```
/task-orchestrator 为用户登录模块添加二因素认证
```

一条命令完成从需求澄清到代码合并的全流程：

```
/task-orchestrator [需求描述]
     │
     ├─ 前置条件：僵尸进程检测（≥1 则警告，用户确认后继续）
     ├─ 前置条件：依赖检查（superpowers-zh + pi-subagent）
     ├─ 无需求描述？ → 提示并等待输入
     │
步骤 1：头脑风暴 → 产出设计文档 → commit
     │
步骤 2：侦察 + writing-plans → 产出实现计划 → commit
     │
步骤 3：任务循环（三阶段审查 + 自动重试）
     │  每个任务 chain: [implementer, spec-reviewer, code-reviewer]
     │  失败 → 自动重试（最多 3 次）→ 仍失败 → R(重试)/S(跳过)/P(重新规划)
     │
步骤 4：final-reviewer → 汇总 → 询问合并/PR/继续修改
```

依赖 `superpowers-zh`（brainstorming + writing-plans 技能）；首次使用时自动检测，缺失时给出安装提示。技能与 `subagent` 工具同属 pi-subagent 包，技能可用即表示工具可用，无外部依赖。

---

## 运行时控制与预算闸门要点

### 运行时控制面（看得见 + 插得上手）

- **看得见**：有子代理运行时，编辑器下方出现常驻状态面板（状态图标 `●` running / `⏸` paused / `⊘` aborted / `✓` done / `✗` failed），每秒刷新，全部结束（含 3 秒终态保留期）后自动消失；single 模式的内嵌卡片同步显示当前动作。
- **插得上手**：子代理运行（或暂停）期间输入 `/agents-ps` 唤出干预浮层——`↑↓` 选择、`s` 注入/提问（运行中排队投递，暂停态立即处理且可连续对话）、`p` 暂停、`r` 结束并返回父级、`x` 中止选中项、`a` 全部中止、`esc` 关闭。中止只作用于子会话，**不牵连父回合**。
- **语义**：运行中 steer 是排队投递而非抢占；用户主动中止与模型失败在终态上可区分；无 UI 模式（`pi -p` / RPC）全链路静默跳过。

### 预算闸门（与 cost-radar 协作）

- pi-subagent 是**消费端**：只读 cost-radar 在父会话发布的额度闸门（`globalThis.__piCostRadarBudget`，`version: 2`，仅 `check` / `price` 两个无副作用方法），**不写总线、不改动 cost-radar 状态**。
- 判定公式：`exhausted = limit !== null && parentSpend + acc >= limit`。启动 run 前触达 → **拒启**（不建会话）；每轮助手消息后触达 → `abort("budget")` **自中止**。
- 预算中止的 `abortReason: "budget"` 与用户取消的 `"user"` 区分；`SingleResult` 记录 `provider` / `endedAt` 且 `details.costContract = 1`，父会话 cost-radar 仅在该契约标记下归账。
- **降级恒等**：未装 / 未升级 cost-radar、缺 `check`·`price`、或任一调用抛错 → 全程 no-op，子代理行为与接入前一致；总线异常绝不反噬执行。
