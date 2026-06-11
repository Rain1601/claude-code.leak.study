# Phase 2: 工具系统设计

> 研究目标:摸清 Claude Code 工具系统的设计——`Tool` 接口的统一形状、注册表如何按上下文裁剪、MCP 把外部工具拉进来的方式、Skill 怎么动态加载、ToolSearch 这种"按需加载 schema"的协议是怎么工作的、`runToolUse` 执行脚手架做了什么、流式执行 + 并发批分区背后的考量——为我们 Web/API 后端 agent 服务提炼可借鉴设计。
>
> 配套阅读:
> - [phase1-agent-loop.md](./phase1-agent-loop.md) — Phase 1 主笔记(agent loop 骨架)
> - [phase1/qa08.toolInventory.md](./phase1/qa08.toolInventory.md) — 工具盘点(44 个工具入口、12 大功能类、按可见性/角色分层)
> - [phase2/question.md](./phase2/question.md) — Phase 2 Q&A 索引(沉淀更细问题)
>
> 关键文件:
> - `src/Tool.ts:362-700+` — `Tool` 类型契约(25+ 字段)
> - `src/tools.ts:193-389` — 注册表 `getAllBaseTools` / `getTools` / `assembleToolPool` / `getMergedTools`
> - `src/services/tools/toolExecution.ts:337-491` — `runToolUse` 执行入口(权限 → 校验 → call → hook → 包装)
> - `src/services/tools/toolOrchestration.ts:1-189` — `runTools` 并发批分区(按 `isConcurrencySafe`)
> - `src/services/tools/StreamingToolExecutor.ts:40-150` — 流式执行(模型还在 streaming 就开跑)
> - `src/services/tools/toolHooks.ts` — Pre/Post/Permission hook 调度
> - `src/services/mcp/client.ts`、`MCPConnectionManager.tsx`、`channelAllowlist.ts` 等 — MCP 集成
> - `src/skills/bundledSkills.ts`、`src/skills/loadSkillsDir.ts`、`src/tools/SkillTool/SkillTool.ts` — Skill 系统
> - `src/tools/ToolSearchTool/ToolSearchTool.ts`、`src/utils/toolSearch.ts` — 按需加载 schema 协议
>
> 关键约定:工具是 Claude Code 的"动作面"——LLM 只能通过它影响世界。围绕这个面有大量"边界条款":并发安全、只读/破坏性、权限三段检查、schema 按需暴露、cache 友好排序、prompt 拼接、结果上限切档落盘。每一个边界条款都对应一类真实事故。

---

## 0. 一图概览

```
                            QueryEngine (turn shell)
                                    │
                                    ▼
                            query() 主循环
                                    │
                            ┌───────┴──────┐
                            ▼              ▼
                    callModel(...)   tool_use blocks
                                            │
                                            ▼
                            ┌────────────────────────────────┐
                            │ orchestration: partitionToolCalls
                            │  按 isConcurrencySafe(input) 分批  │
                            │  read-only 连续段 → 并发             │
                            │  非 read-only → 独占串行            │
                            └────────────────────────────────┘
                                            │
                                            ▼ 每个 tool block
                            ┌────────────────────────────────┐
                            │ runToolUse (toolExecution.ts)    │
                            │  1. findTool (含 alias 兜底)      │
                            │  2. inputSchema.safeParse         │
                            │  3. validateInput (语义)          │
                            │  4. backfillObservableInput       │
                            │  5. runPreToolUseHooks            │
                            │  6. resolveHookPermissionDecision │
                            │      ↪ canUseTool / checkPerms    │
                            │  7. tool.call(input, ctx, ...)    │
                            │  8. runPostToolUseHooks           │
                            │  9. processToolResultBlock        │
                            │      (超 maxResultSizeChars 落盘) │
                            │ 10. yield UserMessage(tool_result)│
                            └────────────────────────────────┘
                                            ▲
                                            │
                            ┌───────────────┴───────────────┐
                            │            工具池               │
                            │  ┌─────────────┐ ┌───────────┐ │
                            │  │ built-in    │ │ MCP tools │ │
                            │  │ tools.ts    │ │ mcp.tools │ │
                            │  └─────────────┘ └───────────┘ │
                            │         └─assembleToolPool─┘   │
                            │                                │
                            │  Skill = built-in (SkillTool)  │
                            │   ↳ 实际是 forked sub-agent     │
                            │                                │
                            │  ToolSearch = 按需暴露 schema    │
                            │   ↳ shouldDefer ⇒ 协议级延迟     │
                            └────────────────────────────────┘
```

---

## 1. `Tool` 接口规约 — 一个 25+ 字段的契约面

`src/Tool.ts:362-700+` 的 `Tool<Input, Output, Progress>` 是整套系统的核心契约。我把它按"字段角色"切成 7 组:

### 1.1 身份 / 元信息

| 字段 | 说明 |
|---|---|
| `name: string` | 主名称,LLM 看到的、permission 规则匹配的、analytics 上报的都是这个 |
| `aliases?: string[]` | 兼容旧名,例如 `KillShell` 是 `TaskStop` 的 alias。`findToolByName` 同时查主名和 alias |
| `searchHint?: string` | 3-10 个词的"能力短语",**专门给 ToolSearch 关键词匹配用**——不能跟 name 重复词("jupyter" 对 NotebookEdit) |
| `isMcp?: boolean` / `isLsp?: boolean` | 来源标记,用于 telemetry 区分 |
| `mcpInfo?: { serverName, toolName }` | MCP 工具的原始服务器/工具名(未 normalize),即使 `name` 被前缀化也保留原值 |

### 1.2 Schema(三套并行)

| 字段 | 说明 |
|---|---|
| `inputSchema: Input` (Zod) | **本地**校验,`safeParse` 后再做语义检查;给 LLM 的 JSON Schema 也从这里转出 |
| `inputJSONSchema?: ToolInputJSONSchema` | MCP 工具用这个直接给 JSON Schema(不转 Zod),因为它们的 schema 是服务器端的 |
| `outputSchema?: z.ZodType` | 可选;用于 SDK structured output。`TungstenTool` 没定义所以是可选 |
| `inputsEquivalent?(a, b)` | 用于命中"重复调用"判定,例如同样的 file_path 视为等价 |

### 1.3 安全 / 行为标记 ⭐

| 字段 | 说明 |
|---|---|
| `isConcurrencySafe(input): boolean` | **关键**——决定能否进读批量并发段。Bash/Edit/Write 多数为 false,Read/Grep/Glob 为 true |
| `isReadOnly(input): boolean` | 是否只读;Plan Mode 下只允许 readOnly 工具 |
| `isDestructive?(input): boolean` | 不可逆动作的强标记(默认 false);影响 permission 路径上的提示语 |
| `interruptBehavior?(): 'cancel' \| 'block'` | 用户中途发消息时:cancel = 杀掉 + 丢结果;block = 让新消息等。默认 block |
| `isOpenWorld?(input): boolean` | 是否会"开放世界"(网络、调用外部 LLM)——影响沙盒/审计 |
| `requiresUserInteraction?(): boolean` | 是否需要 UI(AskUserQuestion);非交互会话直接拒 |
| `isSearchOrReadCommand?(input)` | 返回 `{ isSearch, isRead, isList? }`,UI 端 collapse 显示用 |
| `shouldDefer?: boolean` | **协议级延迟**——schema 不发给 LLM,要 ToolSearch 找出来才能用 |
| `alwaysLoad?: boolean` | 反义:即使 ToolSearch 启用也必须发 schema(MCP 通过 `_meta['anthropic/alwaysLoad']` 设置) |

### 1.4 三段权限链

| 字段 | 调用时机 |
|---|---|
| `validateInput?(input, ctx)` | **语义合法性**(路径存在、权限范围、参数互斥)。返回 `{ result: false, message, errorCode }` 时直接拒,不会调 `checkPermissions` |
| `checkPermissions(input, ctx): PermissionResult` | **是否需要询问用户**——allow / deny / ask。结合 mode/规则/分类器/hook |
| `backfillObservableInput?(input)` | hooks/canUseTool 看到的副本 mutation。**API 调用看到的原始 input 不变**(保护 prompt cache);只是给观察者补 legacy 字段 |
| `preparePermissionMatcher?(input)` | 给 hook `if` 条件准备的预编译匹配器(`Bash(git *)` 这种)。一次解析多次匹配 |
| `getPath?(input)` | 文件类工具暴露主路径,统一用于 workdir 校验 |

### 1.5 执行入口

| 字段 | 说明 |
|---|---|
| `call(input, ctx, canUseTool, parentMessage, onProgress)` | **核心**;返回 `ToolResult<Output> = { data, newMessages?, contextModifier?, mcpMeta? }` |
| `mapToolResultToToolResultBlockParam(data, toolUseID)` | 把 Output 映射成 API 的 `tool_result` block(`content` 字段、是否分 text/image) |
| `maxResultSizeChars: number` | 结果上限。超过就**落盘 + 回传文件引用**(`processToolResultBlock`)。`Read` 设 `Infinity` 防 Read→file→Read 循环 |

### 1.6 渲染(UI)

| 字段 | 说明 |
|---|---|
| `description(input, opts): Promise<string>` | LLM 看到的工具描述(动态拼)。注意:**接受 tools 列表参数**——可以引用其他工具组合 |
| `prompt(opts): Promise<string>` | 完整 prompt(包括 description + 详细参数说明 + 例子)。`getToolPermissionContext()` 是 lazy 的,避免预渲染时阻塞 |
| `userFacingName(input)` | UI 上显示的友好名 |
| `userFacingNameBackgroundColor?(input)` | UI 颜色(Theme key) |
| `isTransparentWrapper?()` | REPL 这种"包别人"的工具:渲染完全交给内部 progress |
| `getToolUseSummary?(input)` / `getActivityDescription?(input)` | spinner 文案("Reading src/foo.ts") |

### 1.7 状态与生命周期

| 字段 | 说明 |
|---|---|
| `isEnabled(): boolean` | **运行时**门控(feature flag / env / 用户设置)。getTools 末尾用 `.map(t => t.isEnabled())` 过滤 |
| `strict?: boolean` | API strict tool 模式(`tengu_tool_pear` 开启时生效) |

> ✅ 关键观察:这个接口**没有**一个统一的 "tool kind" 枚举。所有差异化都通过**布尔标记 + 可选方法**表达——这让 MCP 工具、Skill 工具、内置工具、deferred 工具用同一份契约,执行脚手架不用 switch。

---

## 2. 注册表:从工具源到 LLM 可见列表

`src/tools.ts:193-389` 是三层管道:

```
getAllBaseTools()         ── feature/env-flag 门控的"完整池"(纯内置)
       │
       ▼
getTools(permCtx)         ── 模式特例(simple/REPL)+ 去掉特殊工具 + 拒规则 + isEnabled
       │
       ▼
assembleToolPool(permCtx, mcpTools)   ── 内置 + MCP 合并,缓存友好排序,name uniqBy
       │
       ▼  →  传给 query() → 通过 system_init 和 LLM tool registry 发出去
```

### 2.1 `getAllBaseTools` — feature 门控的完整池

`src/tools.ts:193-251` 是动态构造的列表,**每行都是一个门**:

```typescript
return [
  AgentTool, TaskOutputTool, BashTool,
  ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),  // bun 内嵌 bfs/ugrep 就免去
  ExitPlanModeV2Tool, FileReadTool, FileEditTool, FileWriteTool, NotebookEditTool,
  WebFetchTool, TodoWriteTool, WebSearchTool, TaskStopTool, AskUserQuestionTool,
  SkillTool, EnterPlanModeTool,
  ...(process.env.USER_TYPE === 'ant' ? [ConfigTool] : []),  // ant 内部
  ...(SuggestBackgroundPRTool ? [...] : []),                  // feature('SUGGEST_BG_PR')
  ...(WebBrowserTool ? [...] : []),                           // feature('WEB_BROWSER_TOOL')
  ...(isTodoV2Enabled() ? [TaskCreate/Get/Update/List] : []), // TaskV2 5-CRUD
  ...(CtxInspectTool ? [...] : []),                           // feature('CONTEXT_COLLAPSE')
  ...(LSPTool 由 ENABLE_LSP_TOOL env 控制),
  ...(isWorktreeModeEnabled() ? [EnterWorktree, ExitWorktree] : []),
  ...,
  ...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),  // ToolSearch 自己也是 conditional
]
```

> **被 DCE 消除的死代码也在这层揭露**:`feature('XXX')` 在生产构建里如果是 false,整个 `require('./tools/XXX/XXX.js')` 都会被打包器静态消掉——`process.env.USER_TYPE` 和 `feature()` 是两种不同的"裁剪剂":前者只在运行时短路求值,后者会编译时消代码。

### 2.2 `getTools(permCtx)` — 上下文裁剪

`src/tools.ts:271-327`:

1. **`CLAUDE_CODE_SIMPLE` 短路**:直接返回 `[BashTool, FileReadTool, FileEditTool]`(再叠加 coordinator/REPL 的特例)
2. **去掉"特殊池"**:`ListMcpResourcesTool` / `ReadMcpResourceTool` / `SyntheticOutputTool` 不通过 getTools 暴露,它们是由专门通道挂载的
3. **`filterToolsByDenyRules`**:用与运行时 permission 相同的 matcher,blanket-deny 的工具(包括 `mcp__server` 这种 server 级 deny)直接抹掉——**让 LLM 根本看不到无权使用的工具**,而不是看到了才被拒
4. **REPL hide**:REPL 模式下,被 REPL 包住的原始工具(Bash/Read/Edit...)对 LLM 隐藏,只暴露 REPL
5. **`isEnabled()`** 末次过滤

### 2.3 `assembleToolPool` — 内置 + MCP 合并,缓存友好排序 ⭐

`src/tools.ts:345-367` 这段注释直接揭示一个真实的服务器约定:

```typescript
// Sort each partition for prompt-cache stability, keeping built-ins as a
// contiguous prefix. The server's claude_code_system_cache_policy places a
// global cache breakpoint after the last prefix-matched built-in tool; a flat
// sort would interleave MCP tools into built-ins and invalidate all downstream
// cache keys whenever an MCP tool sorts between existing built-ins.
return uniqBy(
  [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
  'name',
)
```

——内置工具单独按 name 排序当**连续前缀**,MCP 工具再按 name 排序追加到后面,`uniqBy` 保留先出现的(内置覆盖同名)。**这是为了让服务器侧的 prompt cache breakpoint 永远落在内置工具的末尾**:这样新连一个 MCP server,只会刷新 MCP 段的 cache,不会冲掉内置段。

### 2.4 `getMergedTools` vs `assembleToolPool`

二者都返回"全部工具",但:
- `getMergedTools`:简单 concat,**不排序、不 dedup**——用于 token 预算计算(只要总和,不在乎顺序)
- `assembleToolPool`:排序 + dedup——用于真正发给 LLM 的列表

---

## 3. 工具的四个"来源"

LLM 看到的一个 `tool` 实际可能来自:

| 来源 | 进入路径 | 特点 |
|---|---|---|
| **内置(static)** | 直接在 `tools.ts` import | 进程启动就在,schema 是 Zod |
| **MCP** | `MCPConnectionManager` 拉到 server,把每个 `tools/list` 项包装成 `Tool`,推到 `appState.mcp.tools`,再经 `assembleToolPool` | schema 是远端给的 JSON Schema(走 `inputJSONSchema`);`isMcp=true`;name 形如 `mcp__server__tool` |
| **Skill(本地)** | `SkillTool` 内置,但实际"工具"是命令/skill。在 `getAllCommands(ctx)` 里把 `MCP prompt(loadedFrom='mcp')` 和本地 `getCommands(root)` 合并起来,调用时 `runAgent` fork 一个 sub-agent | 看上去只有一个 `SkillTool`,model 用它 `--name` 指定哪个 skill;**一次 skill = 一次 forked sub-agent** |
| **平台/SDK(动态注入)** | `ToolUseContext.options.refreshTools?` 回调,在 MCP server 中途连上时刷新 | 用于"边连边给"的 SDK 集成 |

### 3.1 Skill 的特殊性 — `SkillTool` 实际是一个分发器

`src/tools/SkillTool/SkillTool.ts:108-150` 注释明确写出:

> Executes a skill in a forked sub-agent context. This runs the skill prompt in an isolated agent with its own token budget.

也就是说,model 调用 `SkillTool({ name: 'foo' })` 时,SkillTool 内部:
1. `getAllCommands(ctx)` 找到 skill `foo`(可能在本地 `.claude/commands/`、bundled、或 MCP server 注册的 prompt)
2. `prepareForkedCommandContext` 准备一个**独立的子 agent 上下文**(独立 token 预算,共享 prompt cache 前缀)
3. `runAgent(...)` 跑起来,等结果回来
4. 把结果包成 `ToolResult` 返回

——所以从 LLM 视角,Skill 是"工具";从执行系统视角,它是"子 agent"。**这层间接性的好处**:可以无限扩展用户自定义的"工具",而 LLM 只需要看见一个稳定的 `SkillTool` schema(name + args)。

### 3.2 MCP 集成的关键模块(留待 qa 展开)

`src/services/mcp/` 目录:

- `client.ts` — Anthropic 官方 SDK 上层包装(`McpAuthError`, `McpToolCallError`)
- `MCPConnectionManager.tsx` — 启动连接、断线重连、状态推到 AppState
- `InProcessTransport.ts` / `SdkControlTransport.ts` — 进程内 transport(SDK 自己挂载 MCP) + SDK 控制平面
- `channelAllowlist.ts` / `channelPermissions.ts` — channel 级权限闸门
- `auth.ts` / `oauthPort.ts` — OAuth 流程(含 IDP login)
- `claudeai.ts` — claude.ai 后端 + `claudeai-proxy` 类型
- `elicitationHandler.ts` — MCP 的 `elicitation/url` 协议(让工具调用过程中向用户要信息)
- `normalization.ts` — 服务器名/工具名归一化(空格/特殊字符)
- `mcpStringUtils.ts` — `mcp__server__tool` 字符串编解码

### 3.3 资源 vs 工具

`ListMcpResourcesTool` / `ReadMcpResourceTool` 是**两个挂在 base list 但不通过 `getTools` 暴露**的特殊工具,专门用于 MCP 的 `resources/list` + `resources/read` 协议——把 MCP server 提供的"文档/数据集"接入。它们的发现/挂载是另一条通道。

---

## 4. 执行脚手架:`runToolUse` 的 10 步流水线

`src/services/tools/toolExecution.ts:337-491`(入口)+ `checkPermissionsAndCallTool:599-...`(主体):

```
runToolUse(toolUse, assistantMessage, canUseTool, ctx) // AsyncGenerator
│
├─ 1. findTool: tools 池找,找不到查 baseAll 的 alias 兜底
│       未找到 → yield is_error: "No such tool available: X"
│
├─ 2. signal 已 abort? → yield CANCEL_MESSAGE
│
└─ streamedCheckPermissionsAndCallTool(...)
       │
       ├─ 3. tool.inputSchema.safeParse(input)        // Zod 类型校验
       │      失败 → buildSchemaNotSentHint 检查是不是 deferred 没加载
       │              如果是,提示模型用 ToolSearch select:<name>
       │              否则 yield InputValidationError
       │
       ├─ 4. tool.validateInput?(input, ctx)            // 语义校验
       │      false → yield <tool_use_error>...</tool_use_error>
       │
       ├─ 5. tool === Bash? → startSpeculativeClassifierCheck
       │      (后台跑 allow classifier,与 hook/dialog 并行)
       │
       ├─ 6. backfillObservableInput(clone)             // 副本 mutate
       │      原 input 不动,clone 进入 hooks/permission/canUseTool 视野
       │      (保护 cache:server 看见的 input 不变)
       │
       ├─ 7. runPreToolUseHooks → 可能改 input、追加 message、stop 流程
       │      返回 hookPermissionResult / stopReason / 等
       │
       ├─ 8. resolveHookPermissionDecision(hookPermResult, tool, input, ctx, canUseTool, ...)
       │       ↪ 内部决定走 canUseTool 还是用 hook 已给的决定
       │       ↪ 最终得到 { decision, input(可能被 hook 改过) }
       │       decision.behavior !== 'allow' → yield reject message + ret
       │
       ├─ 9. tool.call(callInput, ctx{toolUseId, userModified}, canUseTool,
       │              assistantMessage, onProgress)
       │      → ToolResult<Output> = { data, newMessages?, contextModifier?, mcpMeta? }
       │
       ├─10. runPostToolUseHooks(tool, output, ...)
       │      可能 transform output、追加 message、emit warning
       │
       ├─11. tool.mapToolResultToToolResultBlockParam(data, toolUseID)
       │      → tool_result block (text/image array)
       │
       ├─12. processPreMappedToolResultBlock 或 processToolResultBlock
       │      若 content 大小 > maxResultSizeChars → 落盘 + 替换为 "saved to /tmp/.../tool_result_xxx"
       │      用 contentReplacementState 跟踪原位置,后续 read 能 hit
       │
       └─13. yield UserMessage([tool_result(...), 可能的 accept feedback, 可能的 image])
              + 把可能的 contextModifier 透传出去
```

### 关键细节

1. **`backfillObservableInput` 的副本策略**:`processedInput = backfilledClone`,但 `callInput` 在最后会按情况收敛回原 input —— `src/services/tools/toolExecution.ts:1189-1205` 这段代码非常细,核心目的:**`file_path` 这种"被 expandPath 改过"的字段,call() 看到的应该是模型给的原值**,因为工具结果会逐字嵌路径(`"File created successfully at: ${path}"`),改了会破 transcript / VCR 测试的哈希。

2. **`schemaNotSentHint`**:这是 ToolSearch 配套的"自愈提示"——如果 deferred 工具被调但 schema 没发(模型在 messages 里凭印象调),Zod 校验会失败,这时附带提示让模型先 `ToolSearch({query: "select:X"})` 把 schema 拉过来。

3. **MCP 错误识别**:`McpAuthError` / `McpToolCallError_I_VERIFIED_...` 会触发 `-32042` elicitation 流程,跳到 `handleElicitation` 通道。

4. **post-tool hook 可以追加上下文 message**:`hookResults.push(...)` 后被 query() 接住,作为下一轮 LLM 入参的额外块。

5. **`contextModifier` 仅对非并发安全工具生效**(`src/Tool.ts:329` 注释明确):并发批里多个工具同时改 context 会冲突,所以这条路径上 modifier 不会被采纳。

---

## 5. 流水线 vs 流式:两套执行模型并存

Claude Code 有**两条**执行路径,在不同模式下用:

### 5.1 经典:`runTools` + `partitionToolCalls`(batch 模型)

`src/services/tools/toolOrchestration.ts:1-189` — 在**模型这一轮 stream 结束之后**整体执行:

1. `partitionToolCalls(toolUses, ctx)` 把工具调用切成连续批:
   - 连续 `isConcurrencySafe = true` 的 → 一批,**并发跑**
   - 任何 `false` 的 → 单独一批,**串行跑**(独占)
2. `runToolsConcurrently(blocks, ...)` 用 `all(generators, maxConcurrency)`(`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 默认 10)
3. `runToolsSerially(blocks, ...)` 一个一个跑,允许 `contextModifier` 链式传递

### 5.2 流式:`StreamingToolExecutor`(边 stream 边跑)

`src/services/tools/StreamingToolExecutor.ts:40-150` —— 当模型还在产生 `tool_use` block 时就开始执行:

```typescript
class StreamingToolExecutor {
  private tools: TrackedTool[] = []
  private siblingAbortController: AbortController  // 关键:Bash 出错时一并杀同批

  addTool(block, assistantMessage) {
    // safeParse → 决定 isConcurrencySafe → 入队
    this.tools.push({ ..., status: 'queued', isConcurrencySafe })
    void this.processQueue()
  }

  canExecuteTool(isSafe) {
    // 全空,或者全部 executing 中的也都是 safe → 可以加
    return executing.length === 0 ||
           (isSafe && executing.every(t => t.isConcurrencySafe))
  }

  // 结果按"模型发出顺序"yield,跨阶段 buffer
}
```

特点:
- **更细的并发控制**:不是 batch 后 partition,而是逐 tool 入队 + 状态机
- **sibling abort 隔离**:`siblingAbortController = createChildAbortController(parent)`——Bash 出错时,这一批的其它 Bash 一起 abort,但**父 abort 不动**(query.ts 不会因此结束 turn)
- **`discard()` 钩子**:streaming 失败回退时整批丢弃
- **结果按发出顺序 yield**:LLM 看到的 tool_result 顺序与它生成 tool_use 的顺序一致

### 5.3 二者的关系

`runTools` 是默认路径;`StreamingToolExecutor` 在启用 streaming tool execution 的模式下接管(由 query.ts 的 streaming 分支选择)。**契约是一致的**:都靠 `isConcurrencySafe(input)` 决定能否同段跑,都最终走 `runToolUse` → `tool.call`。

---

## 6. 权限链 — 三段+ 决策融合

参考 Phase 1 §6,这里展开 Phase 2 的细节:

```
validateInput?(input, ctx)        // 工具自己定的"语义合法"——失败直接拒
   ↓ pass
runPreToolUseHooks(...)            // 外部 hook 可改 input、给决定、停流程
   ↓ pass / 拿到 hookPermissionResult
resolveHookPermissionDecision(...) // 融合 hook 的决定 + 工具自己的 checkPermissions
   ↓
checkPermissions(input, ctx)       // 工具内 + permissions.ts 全局规则 + classifier
   ↓ allow / deny / ask
canUseTool(...)                    // UI 层钩子:弹对话框、auto-mode、SDK PermissionPromptTool
   ↓
PermissionDecision = { behavior, decisionReason, updatedInput?, contentBlocks?, acceptFeedback? }
   ↓ behavior === 'allow'
tool.call(...)
```

**几个值得点出的设计**:

- `decisionReason` 是结构化的 union(`'rule' | 'hook' | 'mode' | 'classifier' | 'subcommandResults' | 'asyncAgent' | 'sandboxOverride' | 'workingDir' | 'safetyCheck' | 'permissionPromptTool' | 'other'`),OTel 上报时 `decisionReasonToOTelSource` 把它映射到稳定的源词汇(`config / hook / user_permanent / user_temporary / user_reject`)——便于跨版本对比
- `decisionInfo = toolUseContext.toolDecisions?.get(toolUseID)`:UI 早就在 dialog 里记了,headless 模式才需要这里补 OTel——**避免重复上报**
- `permissionDecision.updatedInput`:**允许批准方修改入参**(例如 Bash 中"建议加上 -y" 类),覆盖 `processedInput`
- `acceptFeedback`:用户在 allow 时附加一段文本,作为 tool_result 的 trailing text 一起回 LLM(让模型知道用户为什么放行)
- **`shouldAvoidPermissionPrompts`**(在 `ToolPermissionContext`):后台 agent 不能弹 UI,所有 ask 自动 deny
- **`awaitAutomatedChecksBeforeDialog`**:coordinator worker 模式,等 classifier/hook 跑完再弹 dialog,避免"先弹后判"反复改决定

---

## 7. ToolSearch — schema 按需暴露的协议设计 ⭐

### 7.1 为什么需要

随着 MCP 和 skill 数量增长,工具池可以 ~100+。每个工具的 schema 注入到 system prompt 里,**最贵的部分是它们的 prompt 段** — `Tool.prompt()` 渲染出来动辄几百 tokens。把所有都发给 LLM:

- 占 context(贵)
- 让模型注意力分散(选错工具的概率上升)
- 每多一个工具就破一次 cache(连续部署灾难)

### 7.2 方案:`shouldDefer` + `ToolSearchTool`

1. **工具标记 `shouldDefer = true`**(MCP 默认 defer,内置低频工具也可设),`alwaysLoad = true` 可豁免
2. 给 LLM 的 tool registry 里,这些工具**只发 `name + description + searchHint`**,**不发 `inputSchema`**(对应 API 的 `defer_loading: true`)
3. 模型要用某个 deferred 工具时,先调 `ToolSearchTool({ query: "select:Foo,Bar" })`
4. ToolSearch 返回 matches,**记录在 messages 里**(`extractDiscoveredToolNames(messages)`)
5. 下次请求,claude.ts 的 schema-filter 看到 `discovered` 集合包含 `Foo`,就把 `Foo` 的 schema 加入这次的 request payload
6. 如果模型跳过 ToolSearch 直接调 `Foo`,Zod 会失败 + `buildSchemaNotSentHint` 给"请先 ToolSearch select" 的提示

### 7.3 实现关键

`src/tools/ToolSearchTool/ToolSearchTool.ts`:

```typescript
// memoize on tool name only — toolPrompt 重复触发是热路径
const getToolDescriptionMemoized = memoize(
  async (toolName, tools) => {
    const tool = findToolByName(tools, toolName)
    return tool?.prompt({ getToolPermissionContext: () => default, tools, agents: [] }) ?? ''
  },
  (toolName) => toolName,
)

// 当 deferred 集合变化时整体 invalidate
function maybeInvalidateCache(deferredTools: Tools) {
  const currentKey = deferredTools.map(t => t.name).sort().join(',')
  if (cachedDeferredToolNames !== currentKey) {
    getToolDescriptionMemoized.cache.clear?.()
    cachedDeferredToolNames = currentKey
  }
}
```

`extractDiscoveredToolNames(messages)`:从 message history 扫所有 `ToolSearchTool` 的成功 `tool_result`,union 出 discovered 集合——所以 ToolSearch 的"发现"是**消息持久化的状态**,不靠任何外部存储,断点续传天然支持。

### 7.4 启用条件

`isToolSearchEnabledOptimistic()` / `isToolSearchToolAvailable(tools)` 两道闸:
- 工具总数低于阈值 → 不启用(开销 > 收益)
- Haiku 不支持(模型 capability)
- 测试模式可强制关

---

## 8. 设计要点总结

### 8.1 "一个接口走天下"

`Tool` 接口用**布尔标记 + 可选方法**做差异化,执行脚手架不用为不同来源(built-in / MCP / Skill / LSP / Workflow)分支——这让:
- 同一套 hook 链对所有工具生效
- 同一套权限规则可以匹配 MCP 工具(`mcp__server` blanket-deny)
- 同一套 telemetry 上报字段

### 8.2 "工具池就是 prompt 前缀"

`assembleToolPool` 的注释揭示:服务器端有 `claude_code_system_cache_policy`,**在内置工具尾部插 cache breakpoint**。所有"扩展工具"(MCP / 用户 skill)都在 breakpoint 之后——意味着:
- 新接一个 MCP server 不破内置段 cache(便宜)
- 内置工具数量改变(发版)整池全破(可控)
- **工具排序的稳定性是 cache 命中率的隐藏前提**

### 8.3 "概念上是工具,实现上是子 agent"

`SkillTool` 是这套设计的精髓:LLM 不知道 skill 是 forked sub-agent,只看到一个稳定的"按名调用"的工具接口。这让用户/平台可以**无限扩充工具集而不破 prompt**——schema 仍是 `SkillTool` 那一份。

### 8.4 "schema 是可以按需暴露的"

ToolSearch 把"工具发现"做成消息持久化的状态,而不是某种全局开关——非常聪明。对 100+ MCP 工具的场景,这是 token / 注意力 / cache 三方面同时受益的设计。

### 8.5 "并发安全是工具自报的"

`isConcurrencySafe(input)` 把决定权交给工具自己——`Bash(echo hi)` 可以是 safe,`Bash(rm -rf)` 必须 unsafe。这意味着**同一个工具不同入参可能进不同批**。这种细粒度让 partition 不被"工具级别"粗粒度卡住。

### 8.6 "结果落盘是工具级限流"

`maxResultSizeChars` 单工具自定,超了 `processToolResultBlock` 落盘 + 替换为文件引用。这是**比 microcompact 还早的一档**——压根没进消息历史就先压了。Phase 1 qa07 §5 的 `applyToolResultBudget` 实际上是这个机制的**会话级聚合**。

---

## 9. 给我们后端 agent 服务的可借鉴 / 不必抄

### 9.1 直接可抄

| 设计 | 后端形式 |
|---|---|
| 统一 `Tool` 契约(标记 + 可选方法,而非枚举 + switch) | TypeScript interface 或 Python Protocol + Pydantic schema |
| `isConcurrencySafe(input)` 自报 → orchestrator 按批分区 | 类型层 `is_concurrency_safe: (Input) -> bool`,执行层做 partition |
| `validateInput → checkPermissions → caller-hook` 三段 | 中间件 chain;前两段工具自带,第三段平台注入(类似 Express middleware) |
| `maxResultSizeChars` + 自动落盘 + 文件引用 | 单调用结果超阈值落 S3/对象存储,返回 `s3://...` 引用;工具自定阈值 |
| `assembleToolPool` 的**内置作连续前缀**排序 | 我们若有 prompt cache,排序稳定性比"按字母好看"重要;新加扩展工具应该追加,不应插中间 |
| ToolSearch 的 `shouldDefer` + 消息持久化的 discovered 集合 | 工具数量到 30+ 就值得做。`select:tool1,tool2` 是个清爽的协议 |
| `SkillTool` 模式:暴露给 LLM 的是稳定接口,内部分发 forked agent | 用户自定义工作流/插件这样接,不破核心 prompt |

### 9.2 谨慎/选抄

| 设计 | 建议 |
|---|---|
| `StreamingToolExecutor` 边 stream 边跑 | 收益是延迟,代价是状态机复杂(buffering、abort 隔离、按序 yield)。**先把 batch 路径走稳再考虑** |
| `backfillObservableInput` 副本 mutation | 这是 prompt cache 倒逼的解法。我们如果没有"server 端 cache + 客户端 input 影响 cache key"的耦合,可以更直接地改原 input |
| MCP 全套协议(elicitation、resource、cache_edits) | 抄"思想"(标准化外部工具协议)就够;实际选 MCP 还是自研要看生态 |
| `interruptBehavior: 'cancel' | 'block'` | 对话式产品有用;一次性 API 调用没那么必要 |

### 9.3 我们一般不需要

| 设计 | 原因 |
|---|---|
| `feature()` 编译期 DCE 大量散布 | 那是 Claude Code 多构建变体(internal/external/SDK/REPL)的需求。我们后端单一构建,直接 if 即可 |
| REPL 透明包装 (`isTransparentWrapper`) | 这是 IDE/CLI UI 需要;backend 无 UI |
| OAuth/IDP/`claudeai-proxy` 等 transport | 后端 agent 是 server 端,不是客户端,这套不必抄 |
| `EnterWorktree` / 多 agent swarm coordinator 等"工程模式" | 是 Claude Code 特化场景,不是通用 agent 需求 |

---

## 10. 待沉淀(进 phase2/qaNN.*)

按提问优先级:
1. `Tool` 接口在 44 个工具里的字段分布(谁声明 `isReadOnly` 谁不声明,典型形态)
2. `runToolUse` 内的 hook 顺序细节(Pre / Permission / Post 的成功/失败/cancel 分支)
3. `StreamingToolExecutor` 的"按发出顺序 yield"具体怎么 buffer / 唤醒
4. MCP server 启动 → tools/list → 注入 appState → 经 `assembleToolPool` 出现在 prompt 的端到端时序
5. Skill 在 forked sub-agent 里跑时,**token 预算** / **prompt cache 共享** 怎么和主 agent 协作
6. ToolSearch 的关键词排序算法、`max_results` 默认 5 的取舍、`pending_mcp_servers` 字段的语义
7. `TaskV2`(Create/Get/Update/List/Stop+Output)从 `TodoWrite` 拆分的真实动机(是性能?是 schema 清晰度?是权限粒度?)
8. `canUseTool` / `validateInput` / `checkPermissions` 三段的**语义差**——为什么不合并?
9. `ListMcpResourcesTool` / `ReadMcpResourceTool` 的"特殊池"机制(为什么不走 getTools 但是仍然在 base)
