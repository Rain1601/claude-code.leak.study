# Phase 1: Agent Loop 骨架

> 研究目标:搞清楚 Claude Code 内部一次用户输入是怎么变成 LLM 调用 → 工具调用 → 结果回填 → 下一轮的,以便我们在自己的 Web/API 后端 agent 服务里抄关键设计。
>
> 关键文件:
> - `src/Tool.ts:362-695` — 工具接口
> - `src/tools.ts` — 工具注册表
> - `src/QueryEngine.ts:184-1177` — 会话外壳(turn 生命周期)
> - `src/query.ts:219-1729` — Agent loop 核心(turn 内多轮迭代)
> - `src/services/tools/toolOrchestration.ts:19-188` — 工具调度(并发/串行)
> - `src/services/tools/StreamingToolExecutor.ts` — 流式工具执行(读未细读,Phase 2 补)
> - `src/hooks/useCanUseTool.tsx` — Permission gating 入口

---

## 0. 一图概览

```
用户输入 (string | ContentBlockParam[])
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  QueryEngine.submitMessage()    [src/QueryEngine.ts:209]     │
│  - 构建 system prompt(default + memory + appendSystemPrompt)│
│  - processUserInput(slash 命令、附件展开、模型覆盖)          │
│  - 发出 system_init 消息                                     │
│  - 累加 usage、检查 maxBudgetUsd、maxTurns、结构化输出重试  │
│  - 包装 canUseTool 统计权限拒绝                              │
└──────────────────────────────────────────────────────────────┘
        │
        ▼  for await of query({...})
┌──────────────────────────────────────────────────────────────┐
│  queryLoop()                    [src/query.ts:241]           │
│  ↺ while (true) 每次迭代 = 一个 turn                         │
│                                                              │
│  ┌─ 1. 预处理 ──────────────────────────────────────────┐    │
│  │  • applyToolResultBudget(超量工具结果换文件引用)    │    │
│  │  • snip / microcompact / contextCollapse / autocompact│   │
│  │  • blocking_limit token 闸门                          │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─ 2. 流式 API 调用 ──────────────────────────────────┐     │
│  │  for await message of deps.callModel({...})         │     │
│  │  • backfillObservableInput 克隆后再 yield           │     │
│  │  • 截留可恢复错误(prompt_too_long/max_output_tokens) │   │
│  │  • 收集 assistantMessages + toolUseBlocks           │     │
│  │  • StreamingToolExecutor 已开始排队工具             │     │
│  │  • FallbackTriggeredError → 切到 fallbackModel 重试 │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌─ 3. 终止判定 / 错误恢复 ────────────────────────────┐     │
│  │  if (!needsFollowUp) {                              │     │
│  │    • 413 → contextCollapse drain → reactiveCompact  │     │
│  │    • max_output_tokens → 升级 max → 重试            │     │
│  │    • handleStopHooks(可阻塞回到下一轮)              │     │
│  │    • checkTokenBudget(diminishing-returns 早停)      │     │
│  │    return Terminal                                   │     │
│  │  }                                                  │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌─ 4. 工具执行 ──────────────────────────────────────┐      │
│  │  runTools(streaming 或 non-streaming)              │      │
│  │  • partitionToolCalls:连续 isConcurrencySafe 一批   │     │
│  │  • 并发 batch 上限 CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY│   │
│  │  • non-safe 串行执行                                │     │
│  │  • generateToolUseSummary (Haiku,异步后台)         │      │
│  └────────────────────────────────────────────────────┘      │
│                                                              │
│  ┌─ 5. 附件注入 + 准备下一轮 ─────────────────────────┐      │
│  │  • 队列里的 prompt/task-notification 转 attachment │      │
│  │  • memory prefetch consume(后台已跑完)            │      │
│  │  • skill discovery prefetch consume               │      │
│  │  • refreshTools()(新连接的 MCP server 工具)       │      │
│  │  • maxTurns 检查                                  │      │
│  │  state = { messages: messages + assistant + tool_results, ...} │
│  │  continue → 回到迭代起点                          │      │
│  └────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────┘
        │
        ▼
   Terminal: { reason: 'completed' | 'max_turns' | 'aborted_*'
              | 'blocking_limit' | 'prompt_too_long' | 'image_error'
              | 'model_error' | 'stop_hook_prevented' | 'hook_stopped' }
        │
        ▼
   QueryEngine 把 Terminal 翻成 SDK 的 result 消息 yield 出去
```

---

## 1. Tool 接口(`src/Tool.ts:362-695`)

**为什么这个接口值得抄**:Claude Code 的 Tool 是一份非常完整的"代理工具"协议,远不止 `{ name, schema, call }`。任何 agent 框架做大都会演化出类似的字段。我把它按用途分组:

### 1.1 必填核心
| 字段 | 用途 |
|---|---|
| `name: string` | 工具名,模型调用时用 |
| `aliases?: string[]` | 重命名兼容 |
| `inputSchema: z.ZodType` | Zod schema,用于校验模型给的 JSON |
| `inputJSONSchema?` | MCP 工具直接给 JSON Schema 时用 |
| `outputSchema?` | 给上游做结构化输出验证 |
| `call(input, ctx, canUseTool, parentMsg, onProgress)` | 真正执行 |
| `description(input, opts)` | 给用户看的人话描述(权限弹窗用) |
| `prompt(opts)` | 写进 system prompt 的工具使用说明 |

### 1.2 权限与校验链
```
模型给出 tool_use
  → validateInput?(input, ctx)        // 工具自检(可同步否决)
  → checkPermissions(input, ctx)      // 工具级权限(可改写 input)
  → canUseTool() = hasPermissionsToUseTool()  // 全局权限层(allow/deny/ask)
  → call(input, ctx, canUseTool, ...) // 执行
```
- `checkPermissions` 默认 `behavior: 'allow'`,由 `buildTool` 注入。
- `preparePermissionMatcher` 让工具支持 `Bash(git *)` 这种 pattern matching,只解析一次给所有 hook 复用。
- `isReadOnly` / `isDestructive` / `isOpenWorld` 是给上层做策略判断用(批量并发判断、UI 警示、自动化分类)。

### 1.3 并发标记 `isConcurrencySafe(input)`
**这是 Claude Code 工具并发调度的关键钥匙**。`toolOrchestration.ts:91-116` 的 `partitionToolCalls` 拿这个字段把一串 tool_use 切分成 batch:连续的 safe 合并成一个并发 batch,non-safe 单独成 batch 串行执行。Read/Grep/Glob 之类 `isConcurrencySafe: true`,Edit/Write/Bash 之类 `false`。

抄进我们的项目要注意:**这个判断是按 input 算的**(不是按工具类型),所以同一工具不同输入可以差异化(例如 Bash 的某些命令是只读的)。

### 1.4 渲染/UI 字段(对后端服务可全部丢)
`renderToolUseMessage` / `renderToolResultMessage` / `renderToolUseProgressMessage` / `renderGroupedToolUse` / `renderToolUseRejectedMessage` / `renderToolUseErrorMessage`:都是 React/Ink 节点,后端服务直接忽略。但 `getActivityDescription` / `getToolUseSummary` 这种**纯文本摘要**对 Web 客户端是有用的(可以传给前端显示"正在执行 X")。

### 1.5 上下文/中断/语义字段(后端要保留)
- `maxResultSizeChars` — 工具结果超过这个值就 spill 到文件,模型只看预览。**长上下文场景下最关键的字段之一**。
- `interruptBehavior()` — `'cancel'` 还是 `'block'`,用户中断时怎么处理。
- `isTransparentWrapper()` — 复合工具(如 REPL 包裹 Bash/Read)透明委托给内部工具的渲染。
- `shouldDefer` / `alwaysLoad` — 工具是否懒加载 schema(配合 `ToolSearchTool`,Phase 2 详)。
- `contextModifier`(在 `ToolResult` 里)— **关键**!工具执行完可以修改 `ToolUseContext` 用于后续工具,但仅当 `isConcurrencySafe: false`(否则并发竞态)。

### 1.6 `buildTool` 工厂(`src/Tool.ts:757-792`)
所有工具走 `buildTool({...})` 拿默认值:
- `isEnabled: true`
- `isConcurrencySafe: false` ← **fail-safe 默认**
- `isReadOnly: false` ← **fail-safe 默认**
- `isDestructive: false`
- `checkPermissions: () => 'allow'`(交给全局层)
- `toAutoClassifierInput: ''`(默认不进入安全分类器)

**值得抄的设计**:把保守默认放在工厂里,工具作者主动 opt-in 才放宽。

---

## 2. 工具注册表(`src/tools.ts`)

### 2.1 关键模式:**注册表是函数,不是常量**
```ts
export function getAllBaseTools(): Tools {
  return [
    AgentTool, TaskOutputTool, BashTool,
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    ExitPlanModeV2Tool, FileReadTool, FileEditTool, ...,
    ...(WebBrowserTool ? [WebBrowserTool] : []),
    ...(isTodoV2Enabled() ? [TaskCreateTool, TaskGetTool, ...] : []),
    ...
  ]
}
```
每次调用都重新构造数组,依据是:
- **Feature flag**:`feature('KAIROS')` / `feature('AGENT_TRIGGERS')`(Bun bundler 静态裁剪)
- **Env var**:`process.env.USER_TYPE === 'ant'`(内部员工)/ `CLAUDE_CODE_SIMPLE` / `ENABLE_LSP_TOOL`
- **运行时设置**:`isTodoV2Enabled()` / `isWorktreeModeEnabled()` / `isReplModeEnabled()`
- **嵌入二进制能力**:`hasEmbeddedSearchTools()` 决定要不要 Glob/Grep

后端服务对照点:**per-request 的工具集应当也走函数构造**,不要做全局常量,这样可以按用户/租户/订阅级别裁剪。

### 2.2 三层过滤
`getTools(permissionContext)`(`tools.ts:271-327`):
1. **Simple 模式**:`CLAUDE_CODE_SIMPLE=true` → 只暴露 Bash/Read/Edit
2. **特殊工具排除**:`ListMcpResourcesTool` / `ReadMcpResourceTool` / `SyntheticOutputTool` 由别的代码路径添加,不进默认池
3. **deny 规则过滤**:`filterToolsByDenyRules` 按 `permissionContext.alwaysDenyRules` 排除——**支持 MCP server 级前缀 deny**(`mcp__server` 屏蔽整个 server)
4. **REPL 模式排除**:若 REPL 启用,原始工具(Bash/Read/Edit 等)从外层池移除,模型只看见 REPL 入口
5. **工具自报**:`tool.isEnabled()` 最后一关

### 2.3 Prompt cache 友好的合并顺序(`assembleToolPool`, `tools.ts:345-367`)
```ts
return uniqBy(
  [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
  'name',
)
```
**这是非常重要的工程细节**。Claude API 服务端的全局 system prompt 缓存按"内置工具序列前缀"做断点。如果把 builtin 和 MCP 一起 sort,MCP 工具插到 builtin 中间,缓存就废掉了。所以这里:
- builtin 自己排序
- MCP 自己排序
- builtin 整段在前,MCP 在后
- uniqBy 保插入顺序 → builtin 名字冲突时胜出

**抄到我们项目里**:任何把"基础工具 + 用户自定义工具"合并成系统提示的地方,都要小心**插入位置 → cache 失效**。

---

## 3. QueryEngine — 会话外壳(`src/QueryEngine.ts`)

### 3.1 类的本质
**一个 QueryEngine = 一个会话(conversation)**。`submitMessage(prompt)` = 一个 turn(对外暴露给 SDK 消费者)。State 跨 turn 持久:
- `mutableMessages: Message[]` — 完整消息历史
- `permissionDenials: SDKPermissionDenial[]` — 跨 turn 累积
- `totalUsage: Usage` — token 累计
- `readFileState: FileStateCache` — 已读文件指纹(防止 Edit 时被改过的脏写)
- `discoveredSkillNames`/`loadedNestedMemoryPaths` — turn 内重置,但跨多个 processUserInputContext 重建保留

### 3.2 `submitMessage()` 异步生成器的产出物
回到调用者(SDK)的是 `SDKMessage` 流,主要类型:
- `system` — `system_init`(turn 开始)/ `compact_boundary` / `api_retry`
- `assistant` — 模型回复(每个 content block 一条)
- `user` — 包括 tool_result 回填和用户原文 replay
- `stream_event` — 原始流事件(透传给前端 SSE 时用)
- `tool_use_summary` — Haiku 生成的工具批次摘要
- `result` — turn 终态(success / error_max_turns / error_max_budget_usd / error_max_structured_output_retries / error_during_execution)

### 3.3 三个"必须正确"的细节
**(a) System prompt 组装顺序**(`QueryEngine.ts:321-325`):
```ts
asSystemPrompt([
  ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
  ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])
```
- `customSystemPrompt` 完全替换默认
- `appendSystemPrompt` 追加(允许 SDK 用户在不丢失默认行为时叠加策略)
- `memoryMechanicsPrompt` 只在自定义 + memory 目录覆盖时注入(教模型怎么读写 `MEMORY.md`)

**(b) 用户消息在 API 响应前就持久化**(`QueryEngine.ts:436-463`):防止"用户点了发送,然后 ctrl-c 杀掉进程,再 --resume 时找不到这条消息"。Bare 模式 fire-and-forget(性能优先);其他模式 `await`。**任何长会话状态系统都该有这个保证**。

**(c) `stop_reason` 从 `message_delta` 取**(`QueryEngine.ts:797-808`):流式响应里 `content_block_stop` 时 `stop_reason: null`,真正值在 `message_delta` 里。如果不抓 delta,result 里的 stop_reason 永远是 null。

### 3.4 三种终止条件(全部在 `submitMessage` 中)
- `maxBudgetUsd` — `getTotalCost() >= maxBudgetUsd` → `error_max_budget_usd`
- `maxTurns` — query.ts 内部触发 `attachment.type === 'max_turns_reached'` → `error_max_turns`
- 结构化输出重试 — `SyntheticOutputTool` 调用次数超 `MAX_STRUCTURED_OUTPUT_RETRIES`(默认 5)→ `error_max_structured_output_retries`

### 3.5 包装 `canUseTool` 收集 denial(`QueryEngine.ts:244-271`)
```ts
const wrappedCanUseTool = async (...args) => {
  const result = await canUseTool(...args)
  if (result.behavior !== 'allow') {
    this.permissionDenials.push({ tool_name, tool_use_id, tool_input })
  }
  return result
}
```
**Web 后端可以照抄**——做权限审计、计费、行为分析时不用改 canUseTool 实现,在外面包一层就行。

### 3.6 `ask()` 便捷函数(`QueryEngine.ts:1186-1295`)
对单 turn 一次性使用的 thin wrapper:`new QueryEngine(cfg) → engine.submitMessage(prompt)`。SDK 模式 / 一次性查询用它。后端服务直接用 `QueryEngine` 类更灵活(可以多 turn,可以 setModel)。

---

## 4. query.ts — Agent loop 核心(最值得抄的部分)

### 4.1 `State` 对象(`query.ts:204-217`)
```ts
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number       // ≤ 3 次重试
  hasAttemptedReactiveCompact: boolean       // 防 compact→still 413→compact 死循环
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<...> | undefined  // 上一轮 Haiku 摘要的 Promise
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined           // 上一次为什么 continue,纯测试/调试用
}
```
**关键模式**:每次 `continue` 都构造全新的 `state` 对象然后 `state = next; continue`。**不在循环内 mutate state**,让所有循环退出原因显式化。

抄进我们项目:**轮次驱动的 loop 用 immutable state-machine 写法**,不要一堆零散的 `let` 在 while 内被改写。一年后维护代价会差很多。

### 4.2 turn 内五个阶段(详见上面流程图)

#### 阶段 1 — 预处理流水线(`query.ts:365-543`)
按代价从低到高叠加:
1. `applyToolResultBudget` — 累积工具结果超量时换成文件引用(`maxResultSizeChars` 字段读这里)
2. **snip**(`HISTORY_SNIP`) — 移除"僵尸"消息(用户已撤销的 tool_use 之类),返回 `tokensFreed` 给下游对账
3. **microcompact** — 局部缓存编辑,删除最老的 tool_use_id 而不重写
4. **contextCollapse**(`CONTEXT_COLLAPSE`) — 把成段历史折叠成摘要,但**保留为读时投影**(REPL 仍然能完整展开看),在 turn 内通过 `state.messages` 推进
5. **autocompact** — 终极兜底,生成完整摘要并产生 `compact_boundary`

设计原则:**每一层都能省 token,顺序排好就只用最便宜的层够用即止**。autocompact 是有代价的(要单独喊 LLM)。

#### 阶段 2 — 流式 API 调用与 withhold-then-recover
```ts
for await (const message of deps.callModel({...})) {
  // 1. 克隆并 backfillObservableInput(给 SDK 观察者看的 input 加 legacy 字段;原始保留给 cache)
  // 2. withhold 可恢复错误(prompt_too_long / max_output_tokens / media_size_error)
  // 3. 收集 assistantMessages / toolUseBlocks
  // 4. StreamingToolExecutor:每个 tool_use 一到达就开始排队执行(并发,在模型还在 stream)
}
```
**Withhold 模式**(`query.ts:799-822`)非常聪明:
> 流里碰到 prompt_too_long → 不立刻 yield 给消费者(会让 SDK 误以为终态)→ 推到 `assistantMessages`,等流结束 → 决定是否恢复 → 恢复成功 continue,失败才 yield 错误。

**FallbackTriggeredError**(`query.ts:893-953`):服务端可以塞一个信号说"这个模型不可用,切到 fallback"。客户端清掉所有 assistant 消息(发 tombstone 让 UI 删掉)+ 给已有 tool_use 补假的 tool_result + 重试整个请求。

#### 阶段 3 — 错误恢复决策树
```
没 needsFollowUp ⟶
├─ lastMessage 是 withheld 413?
│   ├─ 上一轮不是 collapse_drain_retry → contextCollapse.recoverFromOverflow → continue
│   └─ reactiveCompact.tryReactiveCompact → continue
│   └─ 全失败 → yield lastMessage → return { reason: 'prompt_too_long' }
├─ lastMessage 是 withheld max_output_tokens?
│   ├─ 首次 → escalate 到 64k → continue
│   ├─ 重试次数 < 3 → 注入"resume 不要道歉"meta message → continue
│   └─ 耗尽 → yield lastMessage(降级为可见错误)
├─ lastMessage 是其他 isApiErrorMessage → return 'completed'(避免 hook 死循环)
├─ handleStopHooks
│   ├─ preventContinuation → return 'stop_hook_prevented'
│   ├─ blockingErrors → 注入到下一轮 + stopHookActive=true → continue
│   └─ 无事
└─ checkTokenBudget(if TOKEN_BUDGET feature)
    ├─ action=continue → 注入 budget continuation meta → continue
    └─ completionEvent → 记录"diminishing-returns 早停" → return 'completed'
```
注意 `transition.reason !== 'collapse_drain_retry'` 这种"上一轮做了什么"的判断 —— 这就是 `transition` 字段存在的意义。

#### 阶段 4 — 工具执行(`toolOrchestration.ts`)
```
toolUseBlocks (按模型给出的顺序)
  → partitionToolCalls
      → 连续 isConcurrencySafe(input) 合并成一个 concurrent batch
      → non-safe 单独成 serial batch
  → runToolsConcurrently  → `all(...generators, maxConcurrency)`  10 个并发
  → runToolsSerially     → for-of 串行
```
**关键设计**:
- 并发上限 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=10` 默认
- 串行批次里的 `contextModifier` **立即生效**给下一个工具
- 并发批次里的 `contextModifier` **batch 全跑完才应用**(防竞态)
- `markToolUseAsComplete` 维护 `setInProgressToolUseIDs`,UI 用它显示"正在执行 N 个工具"

#### 阶段 5 — 附件注入与下一轮
- **队列命令**:进程级单例队列里有 prompt 类型 / task-notification 类型的命令,主线程或 subagent **按 agentId 分别 drain**,转成 attachment 喂下一轮
- **Memory prefetch**(`startRelevantMemoryPrefetch`):turn 开头就启动 sideQuery,等到这里看 `pendingMemoryPrefetch.settledAt` 是否就绪 → 就绪就 attach,没就绪就跳过(下次迭代再看)
- **Skill discovery prefetch**:同理,把 Haiku 跑的 skill 推荐结果注入
- **refreshTools()**:turn 间新连接的 MCP server 工具在这里加入
- 构造下一轮的 `state.messages = [...messagesForQuery, ...assistantMessages, ...toolResults]`

### 4.3 `Terminal` 枚举(`query/transitions.ts`,未读但从用法推断)
```ts
type Terminal = { reason: 'completed' }
              | { reason: 'max_turns', turnCount }
              | { reason: 'aborted_streaming' | 'aborted_tools' }
              | { reason: 'blocking_limit' }
              | { reason: 'prompt_too_long' }
              | { reason: 'image_error' }
              | { reason: 'model_error', error }
              | { reason: 'stop_hook_prevented' | 'hook_stopped' }
```
每个终态消费者都能区分对待。

---

## 5. Permission Gating(`src/hooks/useCanUseTool.tsx` 浅读)

Tool 调用前的权限链:
```
runToolUse(toolUseBlock, assistantMsg, canUseTool, ctx)
  → canUseTool(tool, input, ctx, asstMsg, toolUseID)
      → hasPermissionsToUseTool() → { behavior, updatedInput?, decisionReason? }
          behavior:
            'allow'  → 直接放行,可能 updatedInput 改写参数
            'deny'   → 直接驳回(记录到 permissionDenials 给 SDK)
            'ask'    → 进入 handler 路由
                ├─ coordinator(coordinator 模式 worker 等待主席决定)
                ├─ swarm worker(swarm 子任务向 swarm 报告)
                └─ interactive(REPL 弹对话框)
```

**对 Web/API 后端的启示**:
- `canUseTool` 是注入式参数,后端可以塞一个完全不同的实现(比如"问 Slack 审核员"、"查租户配额"、"看分类器")
- `forceDecision` 参数让上游可以快进决策(speculation、缓存上一次同样命令的判断)
- `updatedInput` 让权限层可以**改写 input**(例如把相对路径变绝对路径、给 Bash 命令加 sudo 前缀)— 这比"否决+让模型重试"省一轮

---

## 6. 给我们 Web/API 后端 agent 服务的可借鉴清单

我把 Phase 1 看到的设计点按"直接可抄 / 改造可抄 / 不要抄"分类:

### 直接可抄
| 设计点 | 价值 |
|---|---|
| **Tool 接口拆解**(call/inputSchema/checkPermissions/isConcurrencySafe/isReadOnly/maxResultSizeChars) | 字段都有明确职责,不要捏成一个 `execute()` |
| **buildTool 工厂注入保守默认** | 工具作者越懒,系统越安全 |
| **注册表是函数**(per-request 重新构造) | 多租户/feature flag 友好 |
| **State immutable + transition.reason** | 调试和测试都受益 |
| **Withhold-then-recover 模式** | 流式响应里截留可恢复错误,降级才暴露 |
| **包装 canUseTool 做审计**(QueryEngine 模式) | 不改实现就能加观察 |
| **per-iteration sideQuery prefetch + 后台 consume** | memory/skill 预取,turn 内不阻塞主流程 |
| **Tool result spill to file**(maxResultSizeChars) | 长会话不被巨大输出爆掉 |
| **并发分桶执行**(连续 isConcurrencySafe 合并) | 既能并发又不打破语义 |
| **用户消息 API 响应前就持久化** | --resume / 恢复语义的基础 |

### 改造可抄
| 设计点 | 改造方向 |
|---|---|
| **多层 compaction**(snip→microcompact→collapse→autocompact) | Phase 3 详。Web 后端可能只需要 microcompact + autocompact 两层 |
| **Withheld 错误恢复决策树** | 我们可能只关心 prompt_too_long;max_output_tokens 处理可以简化 |
| **Streaming tool execution**(模型还在 stream 就开始执行工具) | 工程复杂度高,先把 non-streaming 跑通,再考虑 |
| **Query chain tracking**(chainId + depth) | subagent 调用链追踪,如果我们有 sub-agent 设计就抄 |
| **结构化输出重试限制** | 跟你后端是不是要做 strict JSON 输出有关 |
| **Fallback model 切换** | 多 provider/多模型时直接复用思路 |

### 不要抄(CLI/Ink 特有)
- 所有 `render*` 字段(React/Ink UI)
- `requireCanUseTool`(speculation 用)
- REPL 透明包裹(`isTransparentWrapper`)
- `sendOSNotification` / `setToolJSX` / `setStreamMode`
- Coordinator/swarm 权限 handler(除非你们做多 agent)

---

## 7. 还没完全搞清楚的点 → 留到 Phase 2/3

- **`StreamingToolExecutor` 内部细节**:它怎么决定什么时候开始执行 tool_use(等 input streaming 完?还是边解析边等?),怎么同步等待 canUseTool。**Phase 2 看**。
- **`runToolUse` / `toolExecution.ts`**:工具实际执行的脚手架(hook 顺序、错误捕获、契约校验)。**Phase 2 看**。
- **`callModel` 内部**:流事件解析、prompt cache 标记位置、`backfillObservableInput` 调用时机。也许 Phase 1.5 单独细看 query.ts 调用的 `deps.callModel`(即 `src/services/api/claude.ts`)。
- **`handleStopHooks`**:哪种 hook 阻塞,哪种 prevent continuation。**Phase 2 看 hooks 系统**。
- **`compact` / `microcompact` / `snip` / `contextCollapse` 细节**:**Phase 3 主菜**。
- **`startRelevantMemoryPrefetch`**:**Phase 3 看**。

---

## 8. 一句话总结 Phase 1

> **Claude Code 的 agent loop = 一个 immutable-state-machine while-true,turn = 迭代,每轮按"预处理 → 流式调用(同时排队工具)→ 错误/终止决策 → 工具执行 → 附件注入 → 准备下一轮"五段执行;工具是有 ~25 个字段的 Tool 接口,通过 isConcurrencySafe 实现安全的批量并发,通过 maxResultSizeChars 防止长上下文炸裂,通过包装 canUseTool 把权限审计外挂化。**

后端服务最值得偷的三个东西:
1. **Tool 接口的字段拆分**(不要捏在一起)
2. **isConcurrencySafe 驱动的连续并发批 + 串行隔离批**调度
3. **Withhold-then-recover** 的流式错误处理模式
