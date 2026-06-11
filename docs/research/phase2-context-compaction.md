# Phase 2: Context Compaction（snip / micro / macro 三档）

> 研究目标：搞清楚 Claude Code 在一轮 LLM 调用前是怎么把会话历史"压扁"以适应上下文窗口的——它不是一个算法，而是**三档串联的级联**，每一档对应不同的 token 区段与不同的成本/损耗权衡。给 uteki 这种"硬截 + recommended_limits"的方案抄思路。
>
> 关键文件：
> - `src/query.ts:365-468` — 每 turn 入口处的压缩流水线（snip → microcompact → contextCollapse → autocompact）
> - `src/services/compact/microCompact.ts:1-531` — 微压缩（time-based 内容清除 + cached MC 缓存编辑）
> - `src/services/compact/autoCompact.ts:1-351` — 阈值判断 + 触发宏压缩 + 失败熔断
> - `src/services/compact/compact.ts:387-749` — 宏压缩主流程（fork 一个 agent 跑 `/compact` 提示，回填 boundary + summary + 附件）
> - `src/services/compact/prompt.ts:1-374` — summarizer 的系统提示（9 段式结构）
> - `src/services/compact/apiMicrocompact.ts:1-153` — API 端 context-editing（让 Anthropic 服务器侧执行 tool_results 清理）
> - `src/services/compact/sessionMemoryCompact.ts:1-100` — 实验性会话记忆替代路径
> - `src/services/compact/timeBasedMCConfig.ts` — time-based microcompact 的 GrowthBook 配置
> - `src/QueryEngine.ts:120-126, 1276-1281` — `feature('HISTORY_SNIP')` 死代码门控 + snip 回放钩子
>
> 关键约定：
> - snip 的源码 (`snipCompact.ts`、`snipProjection.ts`) 在这份 leak 里**被 DCE 消除**了——因为构建时 `feature('HISTORY_SNIP')` 为 false。我们只能从调用点 (`query.ts:401-410`、`autoCompact.ts:164-167, 225, 230, 247-272`、`QueryEngine.ts:898-918, 1276-1281`) 反推它的契约。
> - 整个 compact 模块和 `feature()`、GrowthBook、PROMPT_CACHE_BREAK_DETECTION 深度耦合——压缩动作会破坏服务器侧 prompt cache，要主动通知降级判定，否则误报"cache break"。

---

## 0. 一图概览

```
                        每个 turn 入口（query.ts:365）
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ 0. applyToolResultBudget     [query.ts:379]                           │
│    把单个超大 tool_result 替换成文件引用（per-tool maxResultSizeChars）│
│    —— 这是"工具级"的限流，不算压缩档但同序                            │
└───────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ 1. snip                                              [query.ts:401]    │
│    feature('HISTORY_SNIP') gated                                       │
│    snipCompactIfNeeded(messages) →                                     │
│      { messages, tokensFreed, boundaryMessage? }                       │
│    动作：直接丢老消息（没有 LLM call），保留 protected tail            │
│    成本：~0（纯本地，零 API 开销）                                     │
│    损耗：信息直接丢，不做 summary                                      │
│    yield: SystemMessage（snip boundary）— QueryEngine 接住做 replay    │
└───────────────────────────────────────────────────────────────────────┘
                                │ snipTokensFreed 透传给 autocompact
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ 2. microcompact                              [query.ts:414, micro:253] │
│    两条分支（互斥择一）：                                              │
│                                                                       │
│   2a. time-based MC          [microCompact.ts:446-530]                 │
│       触发：last assistant msg 距今 > gapThresholdMinutes（默认 60）   │
│       动作：把除最近 keepRecent（默认 5）外的可压缩 tool_result        │
│            content 替换为字面量 "[Old tool result content cleared]"   │
│       前提：缓存反正凉了——既然要 rewrite prefix，那就先缩了再 rewrite  │
│                                                                       │
│   2b. cached MC              [microCompact.ts:305-399]                 │
│       feature('CACHED_MICROCOMPACT') + ant 用户 + 模型支持             │
│       动作：本地消息**不改**，构造 cache_edits block 提交给 API,       │
│            服务器侧删除指定 tool_use_id 的内容，缓存前缀**不破**        │
│       延迟：boundary message 推迟到 API 响应后才发，等                 │
│            cache_deleted_input_tokens 真实值                          │
│                                                                       │
│   外部构建/非 ant/非主线程子 agent：legacy MC 已删除，直接 fall-through│
└───────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ 3. contextCollapse           [query.ts:440-447]                       │
│    feature('CONTEXT_COLLAPSE') gated（与 autocompact 互斥）           │
│    动作：runtime-projection 的归档机制（commit log + replay）         │
│    本研究不展开，是另一套独立的 90% commit / 95% blocking-spawn 流程  │
└───────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ 4. autocompact                       [query.ts:453, autoCompact:241]  │
│    shouldAutoCompact(messages, model, querySource, snipTokensFreed)   │
│      ↪ tokenCount = tokenCountWithEstimation - snipTokensFreed        │
│      ↪ threshold = contextWindow - 20K(output reserve) - 13K(buffer)  │
│      ↪ if 超阈值 → autoCompactIfNeeded()                              │
│                                                                       │
│   4a. sessionMemoryCompact（实验，先试）  [autoCompact.ts:288]        │
│       从 SessionMemory 已有的 session-level summary 拼新上下文        │
│       avoid 一次 LLM 调用；条件未满足则 fallthrough                   │
│                                                                       │
│   4b. compactConversation（兜底，真的跑 LLM）[compact.ts:387]         │
│       runForkedAgent({ maxTurns: 1, prompt: COMPACT_PROMPT })         │
│       返回 9 段式 <summary>...</summary>，封进                        │
│       SystemCompactBoundaryMessage + UserMessage(summary)             │
│       + 重新生成 post-compact attachments（文件恢复/计划/技能/MCP 工具）│
│                                                                       │
│   失败熔断：MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3                  │
│   （BQ 2026-03-10 发现 1279 个 session 连续失败 50+ 次浪费 250K req/d）│
└───────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                       发往 callModel(messagesForQuery)
```

---

## 1. snip — 最轻档，直接丢消息

### 1.1 调用契约（DCE 之后只剩这些痕迹）

`query.ts:115-117`：
```typescript
const snipModule = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
  : null
```

`query.ts:401-410` 的调用：
```typescript
if (feature('HISTORY_SNIP')) {
  queryCheckpoint('query_snip_start')
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
  messagesForQuery = snipResult.messages
  snipTokensFreed = snipResult.tokensFreed
  if (snipResult.boundaryMessage) {
    yield snipResult.boundaryMessage
  }
  queryCheckpoint('query_snip_end')
}
```

返回值形状：`{ messages: Message[]; tokensFreed: number; boundaryMessage?: SystemMessage }`。

`QueryEngine.ts:1276-1282` 还有一个**回放（replay）路径**——slash 命令 `/force-snip` 或类似入口会 yield 一条 snip-boundary system message，QueryEngine 接住后调 `snipModule.snipCompactIfNeeded(store, { force: true })` 把效果应用到 REPL 的消息存储上：
```typescript
...(feature('HISTORY_SNIP')
  ? {
      snipReplay: (yielded: Message, store: Message[]) => {
        if (!snipProjection!.isSnipBoundaryMessage(yielded)) return undefined
        return snipModule!.snipCompactIfNeeded(store, { force: true })
      },
    }
  : {}),
```

### 1.2 为什么需要 `snipTokensFreed` 透传

`autoCompact.ts:160-238` 的注释解释得非常清楚：
```typescript
// Snip removes messages but the surviving assistant's usage still reflects
// pre-snip context, so tokenCountWithEstimation can't see the savings.
// Subtract the rough-delta that snip already computed.
snipTokensFreed = 0,
...
const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
```

也就是 token 计数有两条信息来源：
- **API 报的** `usage.input_tokens`（藏在最近一条 assistant message 上）——但 snip 删除的是更早的消息，幸存的那条 assistant **仍带 pre-snip 时刻的 usage**。
- **本地 rough 估算** `tokenCountWithEstimation`——它倾向用 API 数值（更准），只有 fallback 时才走估算。

所以 snip 只能**单独维护一个 `tokensFreed`** 沿管线下传，autocompact 在算"现在还剩多少"时主动减掉，**否则 autocompact 会以 snip 之前的 token 数判定，立刻又触发一次 macro 压缩，把 snip 的劳动直接覆盖**——这是个非常微妙、容易写错的耦合点。

### 1.3 设计要点

- **零 API 成本**：纯本地操作，丢消息不调 LLM。
- **不保留语义**：直接丢，不 summary。所以丢的应该是"已经被新消息事实上覆盖/失效"的旧 turn——具体策略在 DCE 掉的 snipCompact.ts 里，但可以推测是按 API-round 分组从头丢，保留 protected tail。
- **可被 slash 命令强制触发**（`/force-snip` 之类），通过 `snipReplay` 回放——这让用户可以在 micro/macro 都不够省钱时主动出手。
- **同时也响应 time-based trigger**：`microCompact.ts:419-421` 的注释写"Extracted so other pre-request paths (e.g. snip force-apply) can consult the same predicate"——也就是 snip 模块自己可以调 `evaluateTimeBasedTrigger()`，把"时间到了"也作为强制 snip 的依据。

### 1.4 为什么这一档独立存在？

micro 和 macro 都太"贵"——micro 要么改本地内容（破坏缓存）要么发 cache_edits（要服务器配合），macro 直接烧一次 forked-agent 的 LLM 调用（~$0.10+/次，p99.99 输出 17K tokens）。**snip 是当"我就是想白嫖一下，把那批已经没用的旧上下文丢掉"时的最便宜选项**——但代价是没有 summary，所以只能丢真正废弃的内容。

---

## 2. microcompact — 中档，目标是 tool_results

### 2.1 入口与互斥分支

`microCompact.ts:253-293`：

```typescript
export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult> {
  clearCompactWarningSuppression()

  // Time-based trigger runs first and short-circuits.
  const timeBasedResult = maybeTimeBasedMicrocompact(messages, querySource)
  if (timeBasedResult) {
    return timeBasedResult
  }

  if (feature('CACHED_MICROCOMPACT')) {
    const mod = await getCachedMCModule()
    const model = toolUseContext?.options.mainLoopModel ?? getMainLoopModel()
    if (
      mod.isCachedMicrocompactEnabled() &&
      mod.isModelSupportedForCacheEditing(model) &&
      isMainThreadSource(querySource)
    ) {
      return await cachedMicrocompactPath(messages, querySource)
    }
  }

  // Legacy microcompact path removed — tengu_cache_plum_violet is always true.
  return { messages }
}
```

两条分支**择一**，注释清楚：
- time-based 命中 → 用本地内容清除（缓存已凉，没必要保护）。
- cached MC 启用且模型支持 → 用 cache editing（缓存还热，要保护）。
- 都不命中 → 不动，把上下文压力丢给 autocompact。

### 2.2 time-based microcompact

`microCompact.ts:422-444` 的预谓词独立可调用：
```typescript
export function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: QuerySource | undefined,
): { gapMinutes: number; config: TimeBasedMCConfig } | null {
  const config = getTimeBasedMCConfig()
  if (!config.enabled || !querySource || !isMainThreadSource(querySource)) {
    return null
  }
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  if (!lastAssistant) return null
  const gapMinutes =
    (Date.now() - new Date(lastAssistant.timestamp).getTime()) / 60_000
  if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) {
    return null
  }
  return { gapMinutes, config }
}
```

`timeBasedMCConfig.ts:18-34` 的默认配置：
```typescript
export type TimeBasedMCConfig = {
  enabled: boolean              // 默认 false（用 GrowthBook `tengu_slate_heron` 远程开）
  gapThresholdMinutes: number   // 默认 60 —— 服务器侧 cache TTL 1h，过了就一定凉
  keepRecent: number            // 默认 5 —— 保留最近 5 个可压缩工具结果
}
```

执行动作（`microCompact.ts:456-505`）：
1. 收集所有"可压缩"工具的 `tool_use_id`（COMPACTABLE_TOOLS 集合：`FileReadTool / Bash / Grep / Glob / WebSearch / WebFetch / FileEditTool / FileWriteTool`）。
2. 保留最后 `keepRecent` 个的 id，其余 id 进 clearSet。
3. 遍历所有 user message 的 `tool_result` block，把 clearSet 命中的 block 的 `content` 替换为字面量 `"[Old tool result content cleared]"`。
4. 累计 `tokensSaved`，emit `tengu_time_based_microcompact` 事件。
5. **`resetMicrocompactState()`**：把 cached MC 的全局状态清掉——因为内容已改、缓存已破，cached MC 用的全局 `tool_use_id` 注册表也对应失效。
6. **`notifyCacheDeletion(querySource)`**：告诉缓存破裂检测器"这次低 cache_read 是我自己造成的，别误报"。

#### 一个有教学意义的 fence-post

`microCompact.ts:459-461`：
```typescript
// Floor at 1: slice(-0) returns the full array (paradoxically keeps
// everything), and clearing ALL results leaves the model with zero working
// context. Neither degenerate is sensible — always keep at least the last.
const keepRecent = Math.max(1, config.keepRecent)
```

这种细节说明：MC 的退化模式比想得多，需要专门防御。

### 2.3 cached microcompact —— 利用 API cache editing

完全不同的玩法。本地消息**不改**，构造 cache_edits 数组随请求发出去，让 Anthropic 服务器侧"在缓存上做手术"——只删特定 tool_use_id 对应的 content，缓存前缀的 cache_control marker 保留，下一次请求还能 cache hit。

`microCompact.ts:296-303` 的注释：
```
Cached microcompact path - uses cache editing API to remove tool results
without invalidating the cached prefix.

Key differences from regular microcompact:
- Does NOT modify local message content (cache_reference and cache_edits are added at API layer)
- Uses count-based trigger/keep thresholds from GrowthBook config
- Takes precedence over regular microcompact (no disk persistence)
- Tracks tool results and queues cache edits for the API layer
```

执行流（`microCompact.ts:305-399`）：
1. 收集 compactable tool_use_ids，遍历 user message 把它们注册到 `cachedMCState`（module-level 单例，按 user-message 分组以维护 group 边界）。
2. `mod.getToolResultsToDelete(state)` 按 trigger/keepRecent 算出要删的 ids。
3. `mod.createCacheEditsBlock(state, toolsToDelete)` 构造一个 `pendingCacheEdits`，**不**改本地 messages。
4. 记录 baseline：`lastAsst.message.usage.cache_deleted_input_tokens`——这是 API 端返回的**累计**值，下次请求后用差分算本次实际删了多少。
5. 返回 `{ messages: 原样, compactionInfo: { pendingCacheEdits } }`。
6. 调用方（`query.ts:866 等`）在 API 响应后才 yield 真正的 `SystemMessage(boundary)`——这是**deferred boundary**，因为只有等响应回来才知道服务器真的删了多少 token。

#### 为什么 cached MC 只在主线程跑

`microCompact.ts:272-275`：
```typescript
// Only run cached MC for the main thread to prevent forked agents
// (session_memory, prompt_suggestion, etc.) from registering their
// tool_results in the global cachedMCState, which would cause the main
// thread to try deleting tools that don't exist in its own conversation.
```

——`cachedMCState` 是 module-level 全局，跨 agent 共享会污染。

### 2.4 还有一个 server-side 版本：`apiMicrocompact.ts`

这是给 API 协议层用的、和上面 `microCompact.ts` 共存的另一套机制——前者修改的是**单次请求** payload 里加的 `context_management` 配置，告诉 Anthropic 服务器在它那一侧执行 tool_uses/tool_results 清理。

`apiMicrocompact.ts:64-153` 关键产物：
```typescript
export function getAPIContextManagement(options?: {...}): ContextManagementConfig | undefined {
  ...
  if (useClearToolResults) {
    strategies.push({
      type: 'clear_tool_uses_20250919',
      trigger: { type: 'input_tokens', value: 180_000 },
      clear_at_least: { type: 'input_tokens', value: 140_000 },  // = 180K - 40K target
      clear_tool_inputs: TOOLS_CLEARABLE_RESULTS,
    })
  }
  if (useClearToolUses) {
    strategies.push({
      type: 'clear_tool_uses_20250919',
      trigger: { type: 'input_tokens', value: 180_000 },
      clear_at_least: { type: 'input_tokens', value: 140_000 },
      exclude_tools: TOOLS_CLEARABLE_USES,  // 保留 Edit/Write/NotebookEdit
    })
  }
  // 还有 'clear_thinking_20251015' 策略：清理 thinking blocks
  return strategies.length > 0 ? { edits: strategies } : undefined
}
```

两个常量：
- `DEFAULT_MAX_INPUT_TOKENS = 180_000`（触发阈值）
- `DEFAULT_TARGET_INPUT_TOKENS = 40_000`（保留尾部）

注意，"ant-only" + `USE_API_CLEAR_TOOL_RESULTS` / `USE_API_CLEAR_TOOL_USES` 两个环境变量门控——这是个内部实验功能，可能跟 client-side cached MC 是**同一目标的不同实现位置**，看哪个收敛更好。

`clear_thinking_20251015` 是单独的 thinking 块管理策略，超过 1h 闲置时只保留最后一个 thinking turn（`apiMicrocompact.ts:79-87`）。

### 2.5 micro 这一档的设计要点

- 目标**只针对 tool_results 这类高 token / 易失效的内容**——不是整个会话。
- **永远只 clear，不 summarize**——保留 `tool_use` 的入参，只删 `tool_result` 的输出。
- 三种实现按缓存假设分流：
  - time-based MC：缓存凉 → 大胆改本地 content。
  - cached MC：缓存热 → 走 cache editing，本地不改。
  - apiMicrocompact：服务器端配置驱动 → 让 API 在服务器侧自己处理。
- 整套机制非常依赖**缓存破裂检测**的协作（`notifyCacheDeletion` / `notifyCompaction`），否则数据失真。

---

## 3. autocompact — 重档，summarize 整段对话

### 3.1 阈值计算

`autoCompact.ts:32-49`：
```typescript
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
// Based on p99.99 of compact summary output being 17,387 tokens.

export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())
  ...
  return contextWindow - reservedTokensForSummary
}
```

`autoCompact.ts:62-91`：
```typescript
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  return effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS
}
```

举例 Sonnet 4.5 的 200K 窗口：
```
effective_window = 200_000 - 20_000  = 180_000  // 留 20K 给 summary 输出
auto_threshold   = 180_000 - 13_000  = 167_000  // 留 13K buffer 给本轮新内容
warning_at       = 167_000 - 20_000  = 147_000  // warning_threshold = threshold - 20K
blocking_limit   = 180_000 - 3_000   = 177_000  // 硬闸门
```

也就是 167K 提前烧 macro，177K 直接 block。

### 3.2 `shouldAutoCompact` 的递归守卫与互斥

`autoCompact.ts:160-223` 几个 `return false` 的早出，每个都有教训：

```typescript
// Recursion guards. session_memory and compact are forked agents that
// would deadlock.
if (querySource === 'session_memory' || querySource === 'compact') {
  return false
}

// marble_origami is the ctx-agent — if ITS context blows up and
// autocompact fires, runPostCompactCleanup calls resetContextCollapse()
// which destroys the MAIN thread's committed log (module-level state
// shared across forks). Inside feature() so the string DCEs from
// external builds (it's in excluded-strings.txt).
if (feature('CONTEXT_COLLAPSE')) {
  if (querySource === 'marble_origami') {
    return false
  }
}

// Reactive-only mode: suppress proactive autocompact, let reactive compact
// catch the API's prompt-too-long.
if (feature('REACTIVE_COMPACT')) {
  if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
    return false
  }
}

// Context-collapse mode: same suppression. Collapse IS the context
// management system when it's on — the 90% commit / 95% blocking-spawn
// flow owns the headroom problem.
if (feature('CONTEXT_COLLAPSE')) {
  const { isContextCollapseEnabled } =
    require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
  if (isContextCollapseEnabled()) {
    return false
  }
}
```

——核心信息：autocompact 不是孤立机制。它和 sessionMemoryCompact / contextCollapse / reactiveCompact 都在抢同一份"context headroom"问题，彼此互斥/串接，每个分支的开关都伴随血泪 BQ。

### 3.3 触发后的两段式：先试 sessionMemoryCompact，失败再 compactConversation

`autoCompact.ts:286-310`：
```typescript
// EXPERIMENT: Try session memory compaction first
const sessionMemoryResult = await trySessionMemoryCompaction(
  messages,
  toolUseContext.agentId,
  recompactionInfo.autoCompactThreshold,
)
if (sessionMemoryResult) {
  setLastSummarizedMessageId(undefined)
  runPostCompactCleanup(querySource)
  if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
    notifyCompaction(querySource ?? 'compact', toolUseContext.agentId)
  }
  markPostCompaction()
  return { wasCompacted: true, compactionResult: sessionMemoryResult }
}
```

`sessionMemoryCompact.ts:1-3, 47-61`：
```typescript
/**
 * EXPERIMENT: Session memory compaction
 */
export type SessionMemoryCompactConfig = {
  minTokens: number              // 10_000
  minTextBlockMessages: number   // 5
  maxTokens: number              // 40_000 hard cap
}
```

这条路径**不发 LLM 调用**——它从已有的 `SessionMemory`（一个独立子系统在每轮后台 sync 一份 session 级 summary）里拼出一段 summary 直接当 boundary。如果 SessionMemory 还没攒够（empty / 距离太近 / 字数不够），就 fallthrough 到真正的 compactConversation。

省的是什么：一次 forked-agent + ~17K tokens 的 summarizer 调用。代价：依赖一个**异步在后台跑着**的 SessionMemory 进程。

### 3.4 真正的兜底：`compactConversation`

`compact.ts:387-749` 是这整套系统的高潮。流程拆解：

```
1. logPermissionContextForAnts (audit)
2. executePreCompactHooks  ──┐
                              ├─ 用户自定义指令、用户消息
3. mergeHookInstructions    ──┘

4. getCompactPrompt(customInstructions)
   → "Your task is to create a detailed summary..." (prompt.ts:61-)

5. createUserMessage(compactPrompt) = summaryRequest

6. for (;;) {
     summaryResponse = await streamCompactSummary({...})
     summary = getAssistantMessageText(summaryResponse)
     if (!summary?.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)) break

     // CC-1180: 连压缩请求本身都 PTL 了
     ptlAttempts++
     truncated = ptlAttempts <= MAX_PTL_RETRIES
       ? truncateHeadForPTLRetry(messagesToSummarize, summaryResponse)
       : null
     if (!truncated) throw ERROR_MESSAGE_PROMPT_TOO_LONG
     messagesToSummarize = truncated
     retryCacheSafeParams = {...retryCacheSafeParams, forkContextMessages: truncated}
   }

7. context.readFileState.clear()                  // 清掉文件缓存
   context.loadedNestedMemoryPaths?.clear()
   preCompactReadFileState 留作 attachments 用

8. 并行造一堆 attachments:
   - createPostCompactFileAttachments (最多 5 个最近读过的文件,各 5K tokens)
   - createAsyncAgentAttachmentsIfNeeded
   - createPlanAttachmentIfNeeded
   - createPlanModeAttachmentIfNeeded
   - createSkillAttachmentIfNeeded (M5K tokens / 5 个技能 / 25K 总预算)
   - getDeferredToolsDeltaAttachment(callSite: 'compact_full', [])  // 重新公告全套工具
   - getAgentListingDeltaAttachment(context, [])
   - getMcpInstructionsDeltaAttachment(...)

9. executePostCompactHooks (session_start hooks)

10. createCompactBoundaryMessage(
      isAutoCompact ? 'auto' : 'manual',
      preCompactTokenCount,
      messages.at(-1)?.uuid,
    )
    boundaryMarker.compactMetadata.preCompactDiscoveredTools = [...extractDiscoveredToolNames(messages)]
    // 关键: 携带"压缩前已经发现的延迟工具"集合,让 ToolSearch 状态延续

11. summaryMessages = [createUserMessage({
      content: getCompactUserSummaryMessage(summary, suppress, transcriptPath),
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })]

12. logEvent('tengu_compact', {
      preCompactTokenCount,
      truePostCompactTokenCount,          // 新上下文实际大小估计
      willRetriggerNextTurn: truePost >= autoCompactThreshold,
      ...
      tokenStatsToStatsigMetrics(analyzeContext(messages))   // 11ms 单独跑
    })

13. notifyCompaction(...)  // 抑制 cache-break 误报
    markPostCompaction()
    reAppendSessionMetadata()  // 防 --resume 看不到自定义 title

14. return { boundaryMarker, summaryMessages, attachments, hookResults, ... }
```

后面 `buildPostCompactMessages()` 把它们按固定顺序组好替换上下文：
```
boundaryMarker  +  summaryMessages  +  messagesToKeep  +  attachments  +  hookResults
```

### 3.5 Summarizer 的提示

`prompt.ts:19-26`：
```
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
```

注释解释为什么这一段要放最前面（`prompt.ts:13-18`）：fork 出来的 agent 继承父 agent 的全套工具（缓存键一致），Sonnet 4.6+ 的 adaptive-thinking 偶尔会忽视后置约束去调工具，maxTurns=1 + 调失败 → 没有文本输出 → 整个 compact API call 浪费。

`prompt.ts:61-77` 的 9 段式输出结构：
```
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections     (含完整代码片段)
4. Errors and fixes
5. Problem Solving
6. All user messages            (强调列全部用户消息)
7. Pending Tasks
8. Current Work                 (含最后一条 user/assistant 的逐字摘要)
9. Optional Next Step           (含直接引文,防止漂移)
```

——这是一个**强结构化**的人类编辑工程产物。第 6 段"列出所有用户消息"和第 9 段"含直接引文"是反 drift 的重要约束。

### 3.6 失败处理

`autoCompact.ts:62-70, 257-265, 334-350` 的失败熔断：
```typescript
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.

// 在 autoCompactIfNeeded 入口:
if (tracking?.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
  return { wasCompacted: false }
}

// 异常路径:
const nextFailures = (tracking?.consecutiveFailures ?? 0) + 1
if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
  logForDebugging(`autocompact: circuit breaker tripped after ${nextFailures} consecutive failures`)
}
return { wasCompacted: false, consecutiveFailures: nextFailures }
```

——熔断状态 `AutoCompactTrackingState` 通过 query.ts 的递归续传一路带回去，下一轮入口处再检查。

`compact.ts:243-291` 的另一种失败救援：**`truncateHeadForPTLRetry`**——压缩请求本身 PTL 时（连发请求都装不下要被 summarize 的消息）走的兜底：
```typescript
export function truncateHeadForPTLRetry(
  messages: Message[],
  ptlResponse: AssistantMessage,
): Message[] | null {
  // Strip 上一次重试加的合成 marker（避免它形成 group 0 阻碍 20% fallback）
  const input = messages[0]?.type === 'user' && messages[0].isMeta
    && messages[0].message.content === PTL_RETRY_MARKER
    ? messages.slice(1) : messages
  const groups = groupMessagesByApiRound(input)
  if (groups.length < 2) return null
  const tokenGap = getPromptTooLongTokenGap(ptlResponse)
  let dropCount = tokenGap !== undefined
    ? (... 累加 group token,够 tokenGap 就停)
    : Math.max(1, Math.floor(groups.length * 0.2))   // 解析不到 token gap → 丢 20%
  dropCount = Math.min(dropCount, groups.length - 1)  // 至少留一个
  const sliced = groups.slice(dropCount).flat()
  // 头是 assistant 不合法,前置合成 PTL_RETRY_MARKER user message
  if (sliced[0]?.type === 'assistant') {
    return [createUserMessage({ content: PTL_RETRY_MARKER, isMeta: true }), ...sliced]
  }
  return sliced
}
```

最多重试 `MAX_PTL_RETRIES = 3` 次。

### 3.7 autocompact 设计要点

- 阈值是**模型级**计算的（不同模型不同窗口、不同 output 上限）。
- 三层缓冲：output reserve（20K）+ auto buffer（13K）+ blocking buffer（3K）；warning 早于 auto 早于 block。
- 触发后**先白嫖 SessionMemory**，不行才烧 LLM。
- LLM 调用走 **forked agent**（独立上下文，但共享 prompt cache 前缀），单 turn，强约束 text-only。
- summary 是**强结构化的 9 段式**，第 6/9 段专门反漂移。
- 失败有**熔断**（连续 3 次失败本 session 不再尝试），有 **PTL 头部 truncate 重试**。
- 全程要和 **prompt cache break 检测器**、**SessionMemory 记 id**、**transcript metadata**、**post-compact hooks** 协同——任何一处漏掉都是真实的 BQ。

---

## 4. 三档对照表

| 维度 | snip | microcompact | autocompact |
|---|---|---|---|
| **典型触发** | 主动 / 时间 gap / 工具调用预算压力 | tool_result 太多/太老 | 上下文整体逼近窗口 |
| **触发位置** | `query.ts:401` （turn 入口） | `query.ts:414`（turn 入口） | `query.ts:453`（turn 入口） |
| **触发条件** | feature flag + module 内部策略（未泄漏） | time-based 60min gap / cached MC count threshold | tokens ≥ window − 33K |
| **动作粒度** | 整条消息（drop） | 单个 tool_result 的 content（clear） | 整段会话历史（summarize） |
| **API 调用** | 零 | 零（time-based）或随下次请求附带 cache_edits（cached MC） | 一次 forked-agent LLM call |
| **token 成本** | 无 | 无 → 几乎无 | $0.05~0.50（取决于会话长度） |
| **延迟成本** | <1ms | <10ms | 数秒（fork + summarize） |
| **保留语义** | 否（直接丢） | 否（结果丢，工具签名 + 入参留） | 是（9 段式 summary） |
| **缓存影响** | 破坏（改 prefix） | time-based 破坏 / cached MC 保留 | 破坏（必须 `notifyCompaction`） |
| **失败处理** | 未泄漏 | 无（fall-through 给 autocompact） | 熔断 3 次 + PTL head-truncate 重试 3 次 |
| **状态外部化** | `snipTokensFreed` 透传 | `cachedMCState` 全局 + `pendingCacheEdits` 单回合 | `AutoCompactTrackingState` + `RecompactionInfo` |
| **boundary 形式** | `SystemMessage` (yield + replay) | `SystemMessage` (cached MC 推迟到 API 响应后) | `SystemCompactBoundaryMessage` (含 `compactMetadata`) |

---

## 5. 整体设计观察

### 5.1 串联而非选一

四档（含 contextCollapse）严格按 token 节省**便宜→贵**顺序串联，**前一档省下来的让后一档判断阈值时减掉**（snipTokensFreed 是显式参数）。这避免了"一档刚做完，下一档又触发"的双重压缩。

但级联也意味着**调用点必须严格按顺序**——`query.ts:365-468` 的 60 行就是流水线的全部，每一段都有"runs BEFORE / runs AFTER"的注释解释为什么这个顺序不能错。

### 5.2 GrowthBook 远程开关无处不在

- `tengu_slate_heron` ─ time-based MC 配置
- `tengu_cobalt_raccoon` ─ REACTIVE_COMPACT only 模式
- `tengu_compact_cache_prefix` ─ 是否启用 prompt-cache 共享
- `feature('CACHED_MICROCOMPACT')` / `feature('HISTORY_SNIP')` / `feature('REACTIVE_COMPACT')` / `feature('CONTEXT_COLLAPSE')` ─ 编译期 DCE 门控

Cloud 实验/灰度对核心控制流的渗透到了**这是行内 if 的程度**，但同时每个 feature() 块都用 `require()` 而不是 import——这样未启用时整块代码（包括字符串字面量）会被打包器消掉。

### 5.3 设计哲学

- **Cache-first**：每一档都先问"这次操作破坏 prompt cache 吗？"如果会破，就主动通知检测器；如果有更便宜的不破缓存路径（cached MC、SessionMemory），优先走那个。
- **Forked agent 是核心原语**：autocompact 调 LLM 是通过 `runForkedAgent` 跑一个独立的 maxTurns=1 子 agent，sessionMemoryCompact 是异步后台跑的另一个 forked agent——主线和子线共享 prompt cache 前缀但不共享对话状态，这套机制让"agent 调 agent 做元任务"成为标准用法（compact、summary、tool_use_summary、session_memory、autoDream）。
- **悲观熔断**：每个能失败的环节都假设它**会**陷入死循环（autocompact 3 次熔断、PTL 3 次熔断、`marble_origami` 递归保护、`session_memory/compact` querySource 拒绝），全部有线上 BQ 注释佐证。
- **状态外部化**：所有跨 turn / 跨 fork 的状态（snipTokensFreed、cachedMCState、AutoCompactTracking、SessionMemory message-id）都通过参数显式透传，**没有隐式全局**——除了 cachedMCState，那个也专门有"只在主线程跑"的守卫。

---

## 6. 给 uteki 的可借鉴片段

按"实现成本 vs 收益"从低到高排：

### 6.1 立刻能抄：snip 风格的"丢老 tool_results"

uteki 的 `RunArtifacts` 是天然的"持久工具产物"——`messages` 里的 `tool_call`/`tool_result` event 可以在跑到一半时**就地清空 content，保留 metadata + artifact 引用**。tools 的产出本来就落盘了，messages 里只是冗余拷贝。

实现量：~30 行 Python，在 `harness.py:319-322` 的 deltas 累计旁加一个"老 tool_result 内容清空"扫描，按 `(time - last_used) > N min` 或者按数量保留最近 K 个。

### 6.2 中期：autocompact-style 阈值压缩

- 现状：`HarnessLimits` 是**硬截**，超 `max_input_tokens=800k` 直接 error。
- 改造：加一个 `auto_compact_threshold = max_input_tokens * 0.85`，到点就 fork 一个 sub-skill 跑"summarize previous N steps to fit in M tokens"，把 messages 替换成 `[boundary, summary, last_K_messages]`。
- 难点：uteki 没有 prompt cache 复用（每次 run 是新的），所以 cache-break 那一整套都不用关心——比 Claude Code 简单得多。

实现量：~150 行 + 一个新的 summarizer prompt（按 9 段式裁剪，去掉 Files/Errors，加上 SourcesSummary）。

### 6.3 长期：复用 sessionMemory 的"白嫖 summary"机制

uteki 已经有 `Memory((user_id, session_id))` 短期 events——可以在跑完每个 run 后异步派生一个 session-level summary 写回 Memory。下次 run 在同一 session 触发 compact 时优先用它，不行再 fork agent。

但这跟 uteki "run-scoped" 而非 "conversation-scoped" 的核心模型有张力——会话级 summary 在 uteki 里语义不如 Claude Code 自然。可能更适合的是 **artifacts-level 复用**：跨 run 引用之前 run 的 final-report.md 作为 condensed context。

---

## 7. 待补 / 不确定

- **snip 的具体策略未知**——`feature('HISTORY_SNIP')` DCE 掉了 `snipCompact.ts` 和 `snipProjection.ts`，只能从调用点反推契约。如果之后能找到带 `HISTORY_SNIP=true` 的构建版本，应该重读一遍。
- **`contextCollapse` 子系统未细读**——它是 autocompact 的另一种替代（90% commit / 95% blocking-spawn 的"渐进归档"），与本文研究的三档是互斥关系。
- **`cachedMicrocompact.ts` 未读**——cached MC 的 trigger/keepRecent 阈值在 GrowthBook 里，cache_edits block 的协议形状还要看 `mod.createCacheEditsBlock` 的真实结构。
- **`SessionMemory` 子系统未细读**——只读了 sessionMemoryCompact.ts 的入口，后台那个 sync 进程怎么累积 summary 没看。
- **`reactiveCompact`（feature: REACTIVE_COMPACT）未细读**——它是 401/413 反应式触发的，路径在 `compactMessages.ts`，本研究的 autocompact 是 proactive 路径。
