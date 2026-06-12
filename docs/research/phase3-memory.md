# Phase 3: 记忆系统(Memory)

> 研究目标:把 Claude Code 跨会话/跨子 agent 的记忆系统拆清楚——MEMORY.md 怎么加载,`auto memory` / 个人 / 团队 / agent-级别这几层怎么分层,后台 `autoDream` 怎么把多 session 信号巩固成持久记忆,以及子 agent 的 memory snapshot 怎么在团队之间传播。为我们的 Web/API agent 服务提炼"长会话记忆怎么落地"的设计参考。
>
> 关键文件:
> - `src/memdir/memdir.ts:1-507` — memory 核心加载、`loadMemoryPrompt` 入口、4-type 提示词构造
> - `src/memdir/paths.ts:1-278` — 路径解析链 + `isAutoMemoryEnabled` 5 步链 + 安全校验
> - `src/memdir/findRelevantMemories.ts:1-141` — sideQuery → Sonnet 选 top-5 相关记忆
> - `src/memdir/memoryTypes.ts:14-256` — `user / feedback / project / reference` 4 类记忆 + 提示词块
> - `src/memdir/memoryScan.ts:1-94` — 扫描 .md frontmatter 构造 manifest
> - `src/memdir/teamMemPaths.ts:1-292` — Team memory 路径 + 防 symlink-escape
> - `src/memdir/teamMemPrompts.ts:1-100` — 双目录(私人 + 团队)合并 prompt
> - `src/services/autoDream/autoDream.ts:1-324` — 后台巩固:时间/会话/锁三道门 + forked agent
> - `src/services/autoDream/consolidationLock.ts:1-140` — **锁文件 mtime IS lastConsolidatedAt** 的精妙设计
> - `src/services/autoDream/consolidationPrompt.ts:1-65` — 4-phase 巩固 prompt
> - `src/tasks/DreamTask/DreamTask.ts:1-157` — autoDream 的 UI 暴露层 + kill 路径
> - `src/tools/AgentTool/agentMemory.ts:1-177` — 子 agent 的 user/project/local 三 scope
> - `src/tools/AgentTool/agentMemorySnapshot.ts:1-197` — snapshot 传播机制(checkAgentMemorySnapshot)
> - `src/utils/memoryFileDetection.ts:1-289` — 文件分类层(memory 还是 CLAUDE.md?)
> - `src/utils/attachments.ts:2346-2424` — `startRelevantMemoryPrefetch` + `MemoryPrefetch` Disposable
> - `src/QueryEngine.ts:316-325` — system_prompt 注入路径
> - `src/query.ts:301-304` — turn 起手的 prefetch + `using` 自动 dispose
> - `src/services/extractMemories/extractMemories.ts:1-560` — turn-end 抽取(与 autoDream 并列的第二条写入路径)

---

## 0. 一图概览

```
                              ┌──── 三种"读出"消费点 (Read paths) ────┐
                              │                                       │
  写入路径 (Write paths)       │   ① system_prompt 注入                │
  ━━━━━━━━━━━━━━━━━━━━━━━     │      QueryEngine.ts:316-325           │
                              │      memdir.loadMemoryPrompt()        │
  A. 用户手写                  │      → "instruction manual" + MEMORY.md
     /memory 命令              │                                       │
     commands/memory/memory.tsx│   ② nested_memory attachment          │
        │                     │      attachments.ts:1727+1878         │
        ▼                     │      模型 Read 一个文件 → 注入该路径   │
     <autoMemPath>/<file>.md  │      下的 CLAUDE.md/MEMORY.md         │
        │                     │      (跨 turn dedup via readFileState)│
  B. extractMemories (turn 末) │                                       │
     turn 结束 + 无 tool_call  │   ③ relevant_memories attachment      │
     fork agent 抽取本会话     │      attachments.ts:2346-2424         │
        │                     │      turn 起手 sideQuery → top-5      │
  C. autoDream (24h+/5+sess)  │      using pendingMemoryPrefetch      │
     跨会话巩固 fork agent     │      Symbol.dispose 自动清理          │
     consolidationLock 互斥    │                                       │
        │                     │   ┌── 子 agent 专用 ──┐                │
  D. /dream (KAIROS) 手动     │   │ loadAgentMemory   │                │
     append to logs/YYYY/MM/  │   │ Prompt(per type)  │                │
                              │   │ + Snapshot 传播   │                │
                              │   └───────────────────┘                │
                              └───────────────────────────────────────┘

                            ┌─── memdir 物理布局 ───┐
                            │ <autoMemPath>/        │
                            │   MEMORY.md           │  ← entrypoint, 200 lines / 25KB 硬截
                            │   <slug>.md ...       │  ← topic files, frontmatter (name/desc/type)
                            │   team/               │  ← TEAMMEM feature
                            │     MEMORY.md         │
                            │     <slug>.md ...     │
                            │   logs/YYYY/MM/       │  ← KAIROS append-only daily logs
                            │     YYYY-MM-DD.md     │
                            │   .consolidate-lock   │  ← mtime IS lastConsolidatedAt
                            │                       │
                            │ <cwd>/.claude/        │
                            │   agent-memory/<T>/   │  ← project scope (VCS-tracked)
                            │   agent-memory-local/ │  ← local scope (not VCS)
                            │   agent-memory-snapshots/<T>/ │ ← propagation source
                            │                              │ │   .snapshot-synced.json
                            └──────────────────────────────┘
```

**核心命题**:Claude Code 的 memory 系统不是"一个 KV store",而是 **5 类写入路径 × 3 类读出消费点 × 3 层 scope(user/project/local)** 的笛卡尔积。看懂分层、看懂"写入 vs 消费分离"、看懂"sync vs async 注入分离",才能不把它和我们熟悉的 session 缓存搞混。

---

## 1. memdir 核心加载链路

### 1.1 入口函数 `loadMemoryPrompt()`(`memdir.ts:419-507`)

整个 memory 系统进入 system_prompt 的**唯一函数**,返回 `string | null`。三档 dispatch:

```ts
export async function loadMemoryPrompt(): Promise<string | null> {
  const autoEnabled = isAutoMemoryEnabled()
  const skipIndex = getFeatureValue_CACHED_MAY_BE_STALE('tengu_moth_copse', false)

  // 档 1: KAIROS 助理模式 + autoEnabled → 日志附加模式
  if (feature('KAIROS') && autoEnabled && getKairosActive()) {
    return buildAssistantDailyLogPrompt(skipIndex)
  }

  // 档 2: TEAMMEM 已开 + 已启用 → 双目录组合 prompt
  if (feature('TEAMMEM')) {
    if (teamMemPaths!.isTeamMemoryEnabled()) {
      await ensureMemoryDirExists(teamDir)
      return teamMemPrompts!.buildCombinedMemoryPrompt(extraGuidelines, skipIndex)
    }
  }

  // 档 3: autoEnabled → 个人单目录
  if (autoEnabled) {
    await ensureMemoryDirExists(autoDir)
    return buildMemoryLines('auto memory', autoDir, extraGuidelines, skipIndex).join('\n')
  }

  // 档 4: 都关 → null (上游不注入 memory 段)
  return null
}
```

**几个隐藏细节值得标记**:

- **`getKairosActive()` 排在 TEAMMEM 之前**——`memdir.ts:432` 注释解释:append-only 日志范式 vs team sync 是不兼容的(team sync 期望共享的 MEMORY.md 双向读写),所以 KAIROS 拿走优先级,TEAMMEM 在 KAIROS 模式下被吃掉。
- **`extraGuidelines` 从 env var 注入**——`CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES` 是 Cowork 平台自定义 memory policy 的注入口(`memdir.ts:442-446`)。普通 CLI 用户用不上,但 SDK 嵌入场景关键。
- **`tengu_moth_copse` 控制 `skipIndex`**——开了就跳过 MEMORY.md 两步保存规范,提示词体积更小;这是个**在跑评测的 A/B 开关**。

### 1.2 4-type 提示词构造 `buildMemoryLines()`(`memdir.ts:199-266`)

输出是一个 `string[]`,11 个段落拼出"how to use memory" instruction manual。结构(`memoryTypes.ts` 提供主体):

```
# auto memory                              ← displayName 替换("Persistent Agent Memory" 等)
You have a persistent, file-based memory system at `<memoryDir>`.
This directory already exists — write to it directly with the Write tool
(do not run mkdir or check for its existence).                          ← DIR_EXISTS_GUIDANCE

You should build up this memory system over time...
If the user explicitly asks you to remember something, save it immediately.

## Types of memory                          ← TYPES_SECTION_INDIVIDUAL (264 行)
<types>
  <type><name>user</name>...</type>         ← 用户角色/偏好/知识
  <type><name>feedback</name>...</type>     ← 用户给的工作方式指引
  <type><name>project</name>...</type>      ← 项目状态(谁/做什么/到什么时候)
  <type><name>reference</name>...</type>    ← 外部系统指针
</types>

## What NOT to save in memory               ← WHAT_NOT_TO_SAVE_SECTION
- Code patterns, conventions, architecture — derivable
- Git history, recent changes — `git log` 是权威
- Debugging solutions or fix recipes — 修复在代码里
- Anything already documented in CLAUDE.md files
- Ephemeral task details
These exclusions apply even when the user explicitly asks you to save.

## How to save memories                     ← 两步走或单步(skipIndex)
Step 1: write to its own file with frontmatter (name/description/type)
Step 2: add pointer to MEMORY.md (one-line index, <150 chars)

## When to access memories                  ← WHEN_TO_ACCESS_SECTION
- 相关时或用户引用过往工作时
- 用户显式 ask/check/recall/remember → MUST 访问
- 用户说 ignore → 完全当 MEMORY.md 为空
- (drift caveat: memory 是时间快照,引用前先 verify 当下状态)

## Before recommending from memory          ← TRUSTING_RECALL_SECTION
- 内含文件路径 → 先 check 存在
- 内含函数/flag → 先 grep
- 用户要 act 而不只是问历史 → 先 verify

## Memory and other forms of persistence
区分 memory vs plan vs task

## Searching past context                   ← 可选,feature('tengu_coral_fern')
1. memSearch grep <autoMemPath>
2. transcriptSearch grep <projectDir>/<sessId>.jsonl
```

**4 种 type 不是随便起的**——`memoryTypes.ts:14-19` 是一个**封闭的 const tuple**:

```ts
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
```

`parseMemoryType()` 用 `MEMORY_TYPES.find(t => t === raw)` 严格匹配,未识别的 type 返回 `undefined`。这个封闭设计是**故意的**——不允许用户起新 type,因为 prompt 里 4 种 type 各有独立的 `when_to_save / how_to_use / body_structure / examples` 块,加新 type 不只是改一行 enum,要重写整段 prompt。

**type 块的 examples 块是 eval 调出来的**(从 `memoryTypes.ts:228-238` 注释能看到):

```
* Eval-validated (memory-prompt-iteration.eval.ts, 2026-03-17):
*   H1 (verify function/file claims): 0/2 → 3/3 via appendSystemPrompt.
*   When buried as a bullet under "When to access", dropped to 0/3 — position
*   matters. The H1 cue is about what to DO with a memory, not when to
*   look, so it needs its own section-level trigger context.
```

也就是说 `## Before recommending from memory` 这一节是被 eval 反复 grader 出来的——同一段文字放在不同段落标题下面,Sonnet 的行为完全不同。

### 1.3 双模式:个人 vs 组合

| 模式 | 函数 | scope | 用途 |
|---|---|---|---|
| Individual | `buildMemoryLines` → `TYPES_SECTION_INDIVIDUAL` | 无 `<scope>` 标签 | 普通用户、agent memory |
| Combined | `buildCombinedMemoryPrompt` → `TYPES_SECTION_COMBINED` | 每个 type 带 `<scope>private/team</scope>` 指引 | TEAMMEM 启用时 |

Combined 多出一段顶层 `## Memory scope`(`teamMemPrompts.ts:69-75`)解释 private/team 双目录,以及每个 type 在 `<scope>` 里告诉模型:
- `user` → **always private**
- `feedback` → default private,clearly project-wide convention 才存 team
- `project` → 倾向 team
- `reference` → usually team

外加一条**敏感数据红线**:`teamMemPrompts.ts:78` "**You MUST avoid saving sensitive data within shared team memories. For example, never save API keys or user credentials.**"

### 1.4 `truncateEntrypointContent()` — MEMORY.md 入口截断(`memdir.ts:57-103`)

200 行 / 25KB 双 cap,两阶段:

```ts
// 阶段 1: 行截
let truncated = wasLineTruncated
  ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')  // 200 行
  : trimmed

// 阶段 2: 字节截(在最后一个换行处)
if (truncated.length > MAX_ENTRYPOINT_BYTES) {                // 25_000 字节
  const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES)
  truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES)
}
```

注释 `memdir.ts:36-38` 说明 byte cap 的存在:

> `~125 chars/line at 200 lines. At p97 today; catches long-line indexes that slip past the line cap (p100 observed: 197KB under 200 lines).`

也就是说 P100 用户写了 200 行但每行 1000 字符,光行 cap 拦不住。两 cap 联防。

警告文本被精心设计(`memdir.ts:96-97`):

```
\n\n> WARNING: MEMORY.md is N lines and S KB. Only part of it was loaded.
Keep index entries to one line under ~200 chars; move detail into topic files.
```

**这条警告会被模型读到**,而且警告本身就是"教模型怎么自己 fix MEMORY.md"。

### 1.5 `isAutoMemoryEnabled()` — 5 步优先级链(`paths.ts:30-55`)

```
1. CLAUDE_CODE_DISABLE_AUTO_MEMORY env (1/true → OFF, 0/false → ON, 短路)
2. CLAUDE_CODE_SIMPLE env (--bare → OFF)
3. CLAUDE_CODE_REMOTE 但没 CLAUDE_CODE_REMOTE_MEMORY_DIR → OFF (CCR 但没持久存储)
4. settings.json.autoMemoryEnabled (项目级 opt-out)
5. 默认: 启用
```

每一档优先级都有它的**部署场景**:
- env(1)给 SDK 调用方完全关掉
- SIMPLE(2)是 `--bare` 模式,这个模式的 system prompt 本来也不带 memory 段
- REMOTE(3)是 cloud 跑的远程 agent,默认关 memory 除非显式给路径
- settings(4)允许仓库级 .claude/settings.json 关掉
- 默认 ON,鼓励用

**对照 `paths.ts:38-42` 注释**:

```
// --bare / SIMPLE: prompts.ts already drops the memory section from the
// system prompt via its SIMPLE early-return; this gate stops the other half
// (extractMemories turn-end fork, autoDream, /remember, /dream, team sync).
```

也就是说 prompt 里的 memory 段是一条门(在 prompts.ts),memory 写入 + 后台 dream 又是一条门(在这里)——**两条门一致才能整体禁用**,缺一就半残。

### 1.6 路径解析:`getAutoMemPath()` 三档(`paths.ts:223-235`)

```
优先级 1: CLAUDE_COWORK_MEMORY_PATH_OVERRIDE env (验证后直接用)
优先级 2: settings.json.autoMemoryDirectory (仅 trusted sources: policy/local/user)
         注意: projectSettings (.claude/settings.json) 被故意排除!
优先级 3: <memoryBase>/projects/<sanitized-git-root>/memory/
         memoryBase = CLAUDE_CODE_REMOTE_MEMORY_DIR ?? ~/.claude
         git-root = findCanonicalGitRoot ?? projectRoot (worktree 共享)
```

`paths.ts:170-186` 那段安全注释:

```
SECURITY: projectSettings (.claude/settings.json committed to the repo) is
intentionally excluded — a malicious repo could otherwise set
autoMemoryDirectory: "~/.ssh" and gain silent write access to sensitive
directories via the filesystem.ts write carve-out (which fires when
isAutoMemPath() matches and hasAutoMemPathOverride() is false).
```

**威胁模型清晰**:`isAutoMemPath()` 返回 true 的目录享有 `filesystem.ts` 的"绕过 DANGEROUS_DIRECTORIES" 特权,如果让 `.claude/settings.json`(仓库 commit 的)可以指定这个路径,clone 一个恶意仓库就能让 Claude Code 静默写 `~/.ssh`。所以项目级 settings.json 不允许配 `autoMemoryDirectory`,只允许 user/local/policy 三个 trusted source。

**`validateMemoryPath()`(`paths.ts:109-150`)安全清单**:

| 拒绝条件 | 原因 |
|---|---|
| 非绝对路径 | "../foo" 会被解释为 CWD-relative |
| 长度 <3 | "/" 截后变 "",或 "/a" 太短 |
| `^[A-Za-z]:$` | Windows 驱动盘根 "C:\" 截后变 "C:" |
| `\\` 前缀 | UNC 路径(网络),信任边界不透明 |
| `//` 前缀 | 同 UNC |
| null byte `\0` | 能穿过 normalize(),syscall 截断 |
| `~/` 仅扩展非空尾部 | `~/`, `~/..` 等会扩展到 $HOME 或祖先 |

**worktree 共享**(`paths.ts:198-205`):用 `findCanonicalGitRoot()` 取真正的 repo root,这样同一仓库的多个 worktree 共享一份 auto memory。issue `anthropics/claude-code#24382`,显式记录。

### 1.7 `memoize(getAutoMemPath, keyed on projectRoot)`(`paths.ts:223-235`)

**render-path 优化**:`collapseReadSearchGroups → isAutoManagedMemoryFile → getAutoMemPath` 这条链路在 Messages 每次 re-render 时每个 tool_use message 都跑一次。`getSettingsForSource × 4 → parseSettingsFile (realpathSync + readFileSync)` 是每次重算的代价。memoize 把它压到 0。

key 选 `projectRoot` 而不是无参 cache:测试会 mid-block mock projectRoot,key 化让 mock 切换时自动重算。生产里 env / settings.json / CLAUDE_CONFIG_DIR 都是 session-stable,所以一会话一份 cache 够用。

### 1.8 写入侧的"目录自创"哲学

`memdir.ts:111-119` 那一段 `DIR_EXISTS_GUIDANCE`:

```ts
export const DIR_EXISTS_GUIDANCE =
  'This directory already exists — write to it directly with the Write tool ' +
  '(do not run mkdir or check for its existence).'
```

注释:`Shipped because Claude was burning turns on `ls`/`mkdir -p` before writing.`

**这是一条来自生产观察的提示词修正**——模型默认会先 `ls` 看目录在不在、`mkdir -p` 一下、再写。这浪费 2-3 个 turn。直接告诉它"目录已存在"+ harness 那边 `ensureMemoryDirExists()` 提前 mkdir,模型就会一步 Write 完事。

`ensureMemoryDirExists()`(`memdir.ts:129-147`)调用 `fs.mkdir` 一次,内部已经 swallows EEXIST,**调用方不需要 try/catch**。EACCES/EPERM 之类真错误进 logForDebugging,**继续往下走**——模型的 Write 真的执行不下去时会自己看到底层报错。

## 2. 跨边界注入:三条独立的 read path

Memory 进入模型上下文有**三条互相独立的路径**,它们的生命周期、缓存友好度、消费时机都不一样。

### 2.1 路径 ①:`system_prompt` 注入(static,session 级)

两个进入点,**互斥**:

**(a) 默认路径** — `prompts.ts:495` 通过 `systemPromptSection('memory', ...)` 缓存:

```ts
const dynamicSections = [
  systemPromptSection('session_guidance', ...),
  systemPromptSection('memory', () => loadMemoryPrompt()),   // ← 这里
  systemPromptSection('ant_model_override', ...),
  ...
]
```

`systemPromptSection` 是一个 keyed cache,key="memory" 全 session 复用同一份字符串。`loadMemoryPrompt()` 内部读 MEMORY.md 文件 + 拼 instruction manual,只跑一次。

**(b) Cowork 路径** — `QueryEngine.ts:316-325`,SDK 调用方自定义 system prompt 时的碰头:

```ts
// When an SDK caller provides a custom system prompt AND has set
// CLAUDE_COWORK_MEMORY_PATH_OVERRIDE, inject the memory-mechanics prompt.
const memoryMechanicsPrompt =
  customPrompt !== undefined && hasAutoMemPathOverride()
    ? await loadMemoryPrompt()
    : null

const systemPrompt = asSystemPrompt([
  ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
  ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])
```

**这条路只有 SDK 调用方 + 设置了 `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 时才走**。注释解释:env var 是显式的 opt-in 信号——调用方接好了 memory 目录,需要 Claude 知道怎么用(MEMORY.md 文件名、loading 语义、调哪个 Write/Edit)。普通 customPrompt(SDK 用户替换 system prompt 但不挂 memory)不要这一段。

**两条路里 prompt 内容是同一个**(都是 `loadMemoryPrompt()` 返回),区别在**插入位置**:默认走 `systemPromptSection('memory')` 让它和其他 section 一起排在 system prompt 标准位置;Cowork 走 `QueryEngine` 插在 customPrompt 之后、appendSystemPrompt 之前。

### 2.2 路径 ②:`nested_memory` attachment(reactive,触发式)

**触发条件**:模型 Read 一个文件,这个文件所在的目录及其祖先里有 CLAUDE.md / MEMORY.md / .claude/rules/ 之类的"nested instructions"。

**入口**:`attachments.ts:872`,在 `getAttachmentMessages` 那条同步通道里:

```ts
maybe('nested_memory', () => getNestedMemoryAttachments(context)),
// relevant_memories moved to async prefetch (startRelevantMemoryPrefetch)
```

**机制**(`attachments.ts:2167-2194` + `1710-1790`):
- 工具(主要是 FileReadTool)在执行时把读到的路径加进 `toolUseContext.nestedMemoryAttachmentTriggers: Set<string>`
- `getNestedMemoryAttachments` 检查这个 Set,**空就立刻返回**(快路径)
- 非空逐个调 `getNestedMemoryAttachmentsForFile(filePath, ...)`,找该路径祖先里的 nested instructions,产出 `nested_memory` attachment
- 处理完 `triggers.clear()`——下一轮重新累积

**Dedup 双层**(`attachments.ts:1722-1750`):

```ts
// 第 1 层: loadedNestedMemoryPaths (非淘汰 Set,跨 turn 永久)
if (toolUseContext.loadedNestedMemoryPaths?.has(memoryFile.path)) continue

// 第 2 层: readFileState (100-entry LRU)
if (!toolUseContext.readFileState.has(memoryFile.path)) {
  // 注入 nested_memory attachment
  toolUseContext.loadedNestedMemoryPaths?.add(memoryFile.path)
  toolUseContext.readFileState.set(memoryFile.path, { ... })
}
```

**注释 `attachments.ts:1719-1721` 解释为什么要两层**:

```
// loadedNestedMemoryPaths is a non-evicting Set; readFileState is a 100-entry
// LRU that drops entries in busy sessions, so relying on it alone re-injects
// the same CLAUDE.md on every eviction cycle.
```

也就是说**只用 LRU 不够**——长会话里 LRU 把老条目淘汰,下次又注入同一 CLAUDE.md。non-evicting Set 是补丁。

**partial-view 标记**(`attachments.ts:1738-1750`)是另一处微妙细节:

```ts
toolUseContext.readFileState.set(memoryFile.path, {
  content: memoryFile.contentDiffersFromDisk
    ? (memoryFile.rawContent ?? memoryFile.content)
    : memoryFile.content,
  timestamp: Date.now(),
  offset: undefined,
  limit: undefined,
  isPartialView: memoryFile.contentDiffersFromDisk,  // ← 关键
})
```

注入的 content 经过 strip HTML comments / strip frontmatter / 截断 MEMORY.md 处理,**和磁盘真实字节不同**。如果直接缓存这个修改版,后续 Edit 会以为它就是磁盘内容,改坏。所以缓存**真实 raw bytes**,但置 `isPartialView: true`。Edit/Write 看到这个 flag 会强制要求先做一次真正的 Read。

### 2.3 路径 ③:`relevant_memories` attachment(proactive prefetch)

**最有趣的一条**——turn 起手就 fire 一个 sideQuery,turn 内某个 attachment-collection 点 consume。完全异步、可中断、`using` Symbol.dispose 自动清理。

#### 2.3.1 Prefetch 启动(`query.ts:301-304`)

```ts
// Fired once per user turn — the prompt is invariant across loop iterations,
// so per-iteration firing would ask sideQuery the same question N times.
// Consume point polls settledAt (never blocks). `using` disposes on all
// generator exit paths — see MemoryPrefetch for dispose/telemetry semantics.
using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
  state.messages,
  state.toolUseContext,
)
```

注意三点:

1. **`using` 关键字**——TS 5.2+ 的 Explicit Resource Management。生成器退出(return/throw/abort)时 `[Symbol.dispose]()` 必跑,把 13 个 return 点的清理代码集中到一处。
2. **一个 turn 一次**——不在 `while(true)` 里面,**在外面**。每 turn 的 query 就是用户的最新 prompt,iter 之间没变,不需要重选 5 次。
3. **Consume 不阻塞**——下游用 `settledAt` 看好没好,没好就跳过这轮,下次 iter 再看。

#### 2.3.2 Disposable handle(`attachments.ts:2346-2424`)

```ts
export type MemoryPrefetch = {
  promise: Promise<Attachment[]>
  /** Set by promise.finally(). null until the promise settles. */
  settledAt: number | null
  /** Set by the collect point in query.ts. -1 until consumed. */
  consumedOnIteration: number
  [Symbol.dispose](): void
}

export function startRelevantMemoryPrefetch(messages, ctx): MemoryPrefetch | undefined {
  // Gate 1: feature flag tengu_moth_copse
  if (!isAutoMemoryEnabled() ||
      !getFeatureValue_CACHED_MAY_BE_STALE('tengu_moth_copse', false)) {
    return undefined
  }

  // Gate 2: 必须有真实用户 prompt(过滤掉 isMeta)
  const lastUserMessage = messages.findLast(m => m.type === 'user' && !m.isMeta)
  if (!lastUserMessage) return undefined

  // Gate 3: 单词 prompt(无空白)拒收 —— 上下文太少
  const input = getUserMessageText(lastUserMessage)
  if (!input || !/\s/.test(input.trim())) return undefined

  // Gate 4: 整个 session 累计 surfaced bytes 已经到 60KB → 停
  const surfaced = collectSurfacedMemories(messages)
  if (surfaced.totalBytes >= RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES) {
    return undefined
  }

  // 子 abort: 用户 Escape 立即砍,不用等 [Symbol.dispose]
  const controller = createChildAbortController(toolUseContext.abortController)
  const firedAt = Date.now()
  const promise = getRelevantMemoryAttachments(input, ..., surfaced.paths)
    .catch(e => { if (!isAbortError(e)) logError(e); return [] })

  const handle: MemoryPrefetch = {
    promise,
    settledAt: null,
    consumedOnIteration: -1,
    [Symbol.dispose]() {
      controller.abort()
      logEvent('tengu_memdir_prefetch_collected', {
        hidden_by_first_iteration:
          handle.settledAt !== null && handle.consumedOnIteration === 0,
        consumed_on_iteration: handle.consumedOnIteration,
        latency_ms: (handle.settledAt ?? Date.now()) - firedAt,
      })
    },
  }
  void promise.finally(() => { handle.settledAt = Date.now() })
  return handle
}
```

**4 道前置门**:feature flag、必须有真实用户消息、prompt 至少有空白(多于一个词)、session 累计 surfaced 没爆 60KB。

**telemetry 在 dispose 里**:`hidden_by_first_iteration` 这个字段——如果第一轮 iter 就 consume 但 prefetch 在那之前就完了,说明用户根本看不到 prefetch 价值(latency 都被 model streaming 吃掉了)。

#### 2.3.3 选择算法 `findRelevantMemories()`(`findRelevantMemories.ts:39-141`)

```
1. scanMemoryFiles(memoryDir) —— readdir + frontmatter parse, 排除 MEMORY.md
   按 mtime 降序,top-MAX_MEMORY_FILES=200
2. 过滤 alreadySurfaced —— 之前 turn surfaced 过的不再选
3. selectRelevantMemories —— sideQuery 到 Sonnet
   - 输入:用户 query + 200 个 (filename, description, type, ts) manifest
   - 可选:recentTools = 最近用过的工具,告诉 selector "这些工具的 reference docs 是噪音,但 warnings/gotchas 仍然有用"
   - max_tokens=256, json_schema 强结构化输出
   - 选最多 5 个 filename
4. 用合法 filename 集合二次过滤(防 hallucination)
5. 返回 [{ path, mtimeMs }]
```

**关键工程刻痕**:`SELECT_MEMORIES_SYSTEM_PROMPT` 显式告诉 selector(`findRelevantMemories.ts:18-24`):

```
- If you are unsure if a memory will be useful, do not include it. Be selective.
- If a list of recently-used tools is provided, do not select memories that are
  usage reference or API documentation for those tools (Claude Code is already
  exercising them). DO still select memories containing warnings, gotchas, or
  known issues about those tools — active use is exactly when those matter.
```

**这一段太有意思**——不是简单"过滤掉同名 memory",而是教 selector 区分 reference docs vs warnings/gotchas。Sonnet 能理解这个区分。

#### 2.3.4 多 agent 隔离(`attachments.ts:2196-2213`)

```ts
async function getRelevantMemoryAttachments(input, agents, ...) {
  // If an agent is @-mentioned, search only its memory dir (isolation).
  // Otherwise search the auto-memory dir.
  const memoryDirs = extractAgentMentions(input).flatMap(mention => {
    const agentType = mention.replace('agent-', '')
    const agentDef = agents.find(def => def.agentType === agentType)
    return agentDef?.memory ? [getAgentMemoryDir(agentType, agentDef.memory)] : []
  })
  const dirs = memoryDirs.length > 0 ? memoryDirs : [getAutoMemPath()]
  ...
}
```

**很有意思的隔离**:用户 prompt 里 @-mention 了一个 agent,prefetch 就只搜那个 agent 的 memory,**完全不碰 auto memory**。这是为了 agent-专精的场景——@-mention `code-reviewer` 时,不希望它把 user 的 personal preferences 拿来当 review 标准。

#### 2.3.5 三层 dedup(`attachments.ts:2226-2234`)

```ts
// alreadySurfaced 在 selector 里也过一遍 → Sonnet 5 slot 都给新候选
// readFileState catches files the model read via FileReadTool
// 这里的 alreadySurfaced 再过一次是 belt-and-suspenders(多 dir 可能 reintroduce)
const selected = allResults
  .flat()
  .filter(m => !readFileState.has(m.path) && !alreadySurfaced.has(m.path))
  .slice(0, 5)
```

三个 dedup 来源:
1. **selector 输入侧 alreadySurfaced**——Sonnet 不浪费 budget 重选
2. **selector 输出侧 alreadySurfaced 再过**——多 agent dir 可能各自选了同一文件,合并后去重
3. **readFileState**——模型主动 Read 过的文件也不再注入

#### 2.3.6 注入大小 cap(`attachments.ts:269-289`)

```ts
const MAX_MEMORY_LINES = 200
// 注意: 4KB,不是 25KB
const MAX_MEMORY_BYTES = 4096

export const RELEVANT_MEMORIES_CONFIG = {
  MAX_SESSION_BYTES: 60 * 1024,  // 60KB session 累计
}
```

注释 `attachments.ts:270-276` 解释:

```
// Line cap alone doesn't bound size (200 × 500-char lines = 100KB). The
// surfacer injects up to 5 files per turn via <system-reminder>, bypassing
// the per-message tool-result budget, so a tight per-file byte cap keeps
// aggregate injection bounded (5 × 4KB = 20KB/turn).
```

注意三个不同的 cap:
- **MEMORY.md entrypoint**: 25KB(严的索引)
- **relevant_memories per-file**: 4KB(每个被选中的 topic file)
- **relevant_memories per-session**: 60KB(session 累计,约 3 次满载)

**为什么 per-file 只有 4KB?**——relevant_memories 走 `<system-reminder>` 通道,**绕过 per-message tool-result budget**(Phase 2 笔记里讲过的 budget gate),所以这里必须自己卡死。frontmatter + 开头几段最有价值,后面被截了也不是大问题,模型可以用 FileRead 拉完整版。

#### 2.3.7 consume 时的 filter-then-mark 顺序(`attachments.ts:2520-2541`)

```ts
export function filterDuplicateMemoryAttachments(
  attachments: Attachment[],
  readFileState: FileStateCache,
): Attachment[] {
  return attachments
    .map(attachment => {
      if (attachment.type !== 'relevant_memories') return attachment
      const filtered = attachment.memories.filter(m => !readFileState.has(m.path))
      for (const m of filtered) {
        readFileState.set(m.path, { content: ..., timestamp: ..., ... })  // ← 标记在 filter 之后!
      }
      return filtered.length > 0 ? { ...attachment, memories: filtered } : null
    })
    .filter((a): a is Attachment => a !== null)
}
```

注释 `attachments.ts:2513-2518` 讲了这个 ordering 是 load-bearing 的:

```
The mark-after-filter ordering is load-bearing: readMemoriesForSurfacing
used to write to readFileState during the prefetch, which meant the filter
saw every prefetch-selected path as "already in context" and dropped them
all (self-referential filter). Deferring the write to here, after the
filter runs, breaks that cycle while still deduping against tool calls
from any iteration.
```

也就是说**曾经踩过的坑**:prefetch 时就标记 → filter 时所有路径都"已读过" → 全 drop。Bug 修法是把标记延后到 filter 之后。

### 2.4 三条路径对照

| 维度 | ① system_prompt | ② nested_memory | ③ relevant_memories |
|---|---|---|---|
| 触发 | session 启动 | FileRead 文件触发 | turn 起手 sideQuery |
| 内容来源 | MEMORY.md 入口 + instruction manual | 读到的文件所在路径的 nested CLAUDE.md/MEMORY.md | Sonnet 选的 top-5 topic files |
| 调用方式 | sync (`loadMemoryPrompt`) | sync 但用 trigger set | async prefetch + `using` dispose |
| Cache 友好度 | 极好,system_prompt 前缀 | 中等,attachment 在 turn 内位置稳定 | 中等,pre-computed header 避免 daily age 变化导致 cache bust |
| Dedup | 无(session 内只读一次) | 双层(non-evicting Set + LRU) | 三层(selector 输入 + 输出 + readFileState) |
| 上限 | MEMORY.md 25KB | 每文件用 `readFileInRange` | per-file 4KB / per-turn 20KB / per-session 60KB |
| 中断 | 不可中断 | 不可中断(快路径已跑完) | 用户 Escape 立即 abort(child controller) |
| 失败处理 | 文件不存在 → 空入口段 | trigger.clear + 继续 | catch → 空数组,不影响主流程 |

**对后端最值得抄的设计**:**异步 prefetch + Disposable 句柄 + 三层 dedup**。`using` + Symbol.dispose 的写法让 13 个 return 点不用各自 cleanup;`hidden_by_first_iteration` telemetry 让你知道 prefetch latency 是否被 stream 吃掉(决定要不要继续做)。

## 3. autoDream — 后台跨会话巩固

> `src/services/autoDream/autoDream.ts:1-324` + `consolidationLock.ts:1-140` + `consolidationPrompt.ts:1-65`

**核心命题**:让一个后台 forked agent 周期性地读多个 session transcripts,把分散信号巩固成持久 memory 文件。

### 3.1 触发点:turn 末 stopHook

`stopHooks.ts:155`:

```ts
void executeAutoDream(stopHookContext, toolUseContext.appendSystemMessage)
```

入口在 query loop 的"无 tool_use,准备终止"路径里——也就是说**每次 agent 答完一轮且没继续调工具时**,autoDream 都被询问"该跑吗"。它在 1 次 stat + 1 次 GB cache read 之内决定 "no"——所以"每次问"成本不是问题。

### 3.2 4 道门(`autoDream.ts:95-189`)

```
门 1: isGateOpen() — 全局条件
  - !getKairosActive()       (KAIROS 用的是 disk-skill dream,不是这个)
  - !getIsRemoteMode()       (CCR 远程模式不跑)
  - isAutoMemoryEnabled()    (memory 全局开关)
  - isAutoDreamEnabled()     (setting → GB tengu_onyx_plover)
  └ 任何一个 false → return

门 2: 时间门(最便宜,1 次 stat)
  hoursSince = (Date.now() - lastConsolidatedAt) / 3_600_000
  if hoursSince < minHours (默认 24h) → return

门 3: 扫描节流
  if (sinceLastScan < 10 * 60 * 1000) → return
  - 关键: 时间门过但 session 门没过时,lock mtime 不前进,时间门每 turn 都过
  - 没这道节流的话,每 turn 都会去 readdir transcripts 目录,白做功
  - 节流时长 10 分钟,够便宜

门 4: 会话门(scan transcripts 目录)
  sessionIds = listSessionsTouchedSince(lastConsolidatedAt)
                .filter(id => id !== currentSession)
  if sessionIds.length < minSessions (默认 5) → return

门 5: 文件锁(实际操作前互斥)
  priorMtime = tryAcquireConsolidationLock()
  if (priorMtime === null) → return  // 别的进程拿着
```

注释 `autoDream.ts:5-8`:

> Gate order (cheapest first):
>   1. Time: hours since lastConsolidatedAt >= minHours (one stat)
>   2. Sessions: transcript count with mtime > lastConsolidatedAt >= minSessions
>   3. Lock: no other process mid-consolidation

**4 道门的代价递增**:时间门 1 stat 就出结果;会话门要 readdir + 多个 stat;锁还要写文件 + 读回。所以排队从便宜到贵——一上来就 reject 95% 的 turn,只 1-2% 的 turn 进得了锁那一步。

### 3.3 锁文件 = lastConsolidatedAt:精妙的一物多用(`consolidationLock.ts:1-140`)

**`.consolidate-lock`(`<autoMemPath>/.consolidate-lock`)同时承担两个角色**:

| 角色 | 实现 |
|---|---|
| 互斥锁 | 文件存在 + body=PID + mtime <60min ago + isProcessRunning(PID) → 别人持有 |
| 上次巩固时间戳 | mtime = lastConsolidatedAt(`readLastConsolidatedAt()` 一次 stat 就够) |

```ts
export async function tryAcquireConsolidationLock(): Promise<number | null> {
  // 1. 读现状
  const [s, raw] = await Promise.all([stat(path), readFile(path, 'utf8')])
  mtimeMs = s.mtimeMs
  holderPid = parseInt(raw.trim(), 10)

  // 2. 还在 60min 内 + PID 活着 → 别人拿着,失败
  if (Date.now() - mtimeMs < HOLDER_STALE_MS && isProcessRunning(holderPid)) {
    return null
  }
  // dead PID 或 unparseable body → 可以抢

  // 3. 写自己 PID + 更新 mtime(写动作本身就更新 mtime)
  await writeFile(path, String(process.pid))

  // 4. 二次读验证(两个 reclaimer 都写时 last-writer wins)
  const verify = await readFile(path, 'utf8')
  if (parseInt(verify.trim(), 10) !== process.pid) return null

  return mtimeMs ?? 0  // 返回原 mtime 用于 rollback
}
```

**几条精妙的设计**:

1. **mtime 即 lastConsolidatedAt**——巩固成功了不用额外写时间戳,write 动作本身就更新了 mtime。
2. **HOLDER_STALE_MS = 60min**——超过 60min 即使 PID 活着也认为 stale(防 PID 复用 + 防 hang 死的 fork)。
3. **PID-based liveness 检测**(`isProcessRunning`)——和 mtime 一起判定,防 PID 复用穿透。
4. **二次读验证**——两个进程都过了第 2 步要 reclaim 时,都写,然后都读;`verify === process.pid` 才认为自己拿到。Last-writer wins。
5. **失败 rollback 一定要做**(`rollbackConsolidationLock`):

```ts
export async function rollbackConsolidationLock(priorMtime: number): Promise<void> {
  if (priorMtime === 0) {
    await unlink(path)  // 之前没文件就删
    return
  }
  await writeFile(path, '')   // 清空 PID body,防"我自己"被认为还在跑
  const t = priorMtime / 1000
  await utimes(path, t, t)    // mtime rewind
}
```

**为什么要清空 body?**——注释 `consolidationLock.ts:87-88`:`Clears the PID body — otherwise our still-running process would look like it's holding.` 你 fork 失败但主进程还在跑,如果 body 还是你的 PID,后面的 turn 一查"PID 活着 + mtime 半小时前",会判定你还在持有锁,而你其实早就放弃了。所以失败时一定要把 body 清干净,只留 mtime 当时间戳。

### 3.4 fork agent 跑巩固(`autoDream.ts:210-271`)

```ts
const result = await runForkedAgent({
  promptMessages: [createUserMessage({ content: prompt })],
  cacheSafeParams: createCacheSafeParams(context),    // 复用父 prompt cache
  canUseTool: createAutoMemCanUseTool(memoryRoot),    // 权限:read-only Bash + memory dir write
  querySource: 'auto_dream',
  forkLabel: 'auto_dream',
  skipTranscript: true,                                // 不污染主 session transcript
  overrides: { abortController },
  onMessage: makeDreamProgressWatcher(taskId, setAppState),
})
```

**4 个关键配置**:

| 字段 | 作用 |
|---|---|
| `cacheSafeParams` | 让 fork 继承父的 prompt cache prefix——同一 system_prompt + memory section + tool defs,免 cache 重建 |
| `canUseTool: createAutoMemCanUseTool(memoryRoot)` | 自定义权限层:Bash 只允许 read-only 命令、Edit/Write 只允许写 memoryRoot 下 |
| `skipTranscript: true` | 后台 agent 自己的 turn-by-turn 不写进用户 session 的 `.jsonl` |
| `onMessage: makeDreamProgressWatcher` | 拦截每个 assistant turn,提取 text + tool_use 计数,推到 DreamTask 让 UI 显示 |

**额外约束写在 prompt 里而不是 shared body**(`autoDream.ts:216-221`):

```ts
const extra = `

**Tool constraints for this run:** Bash is restricted to read-only commands
(\`ls\`, \`find\`, \`grep\`, \`cat\`, \`stat\`, \`wc\`, \`head\`, \`tail\`, and similar).
Anything that writes, redirects to a file, or modifies state will be denied.
Plan your exploration with this in mind — no need to probe.

Sessions since last consolidation (${sessionIds.length}):
${sessionIds.map(id => '- ' + id).join('\n')}`
```

注释 `autoDream.ts:213-214`:

> Tool constraints note goes in `extra`, not the shared prompt body —
> manual /dream runs in the main loop with normal permissions and this
> would be misleading there.

**这就是为什么 prompt 拆成 `buildConsolidationPrompt(memoryRoot, transcriptDir, extra)` 三参数**——`autoDream` 把"Bash 只读"塞进 extra,但**手动 `/dream`** 跑同一 prompt body,extra 是空的,模型在主 loop 里有完整 Bash 权限。Prompt 复用,instance 化差异。

### 3.5 4-phase 巩固 prompt(`consolidationPrompt.ts:10-65`)

```
# Dream: Memory Consolidation

## Phase 1 — Orient
- ls 看现有内容
- 读 MEMORY.md 知道现有索引
- 略读现有 topic files(避免造重复)
- 看 logs/ 或 sessions/ 如有(KAIROS layout)

## Phase 2 — Gather recent signal
按优先级:
1. Daily logs(logs/YYYY/MM/YYYY-MM-DD.md)如有,append-only stream
2. Drifted memories(和当前代码冲突的旧 memory)
3. Transcript search(narrow grep,不通读)

## Phase 3 — Consolidate
- 优先 merge 进现有 topic file,不 reproduce
- 相对日期 → 绝对日期("yesterday" → "2026-03-05")
- 删除被驳倒的事实

## Phase 4 — Prune and index
- MEMORY.md 维持 <200 行 / <25KB
- 单行 > ~200 字符 → 内容在错位置,移到 topic file
- 删除指向已删/已超 memory 的 pointer
- 添加新重要 memory 的 pointer
- 解决两个 file 矛盾时修错那个

最后 return brief summary
```

**4-phase 是给模型的工作流模板**,不是 hard checkpoint。`DreamTask.ts:20-23` 注释明确:

> No phase detection — the dream prompt has a 4-stage structure
> (orient/gather/consolidate/prune) but we don't parse it. Just flip from
> 'starting' to 'updating' when the first Edit/Write tool_use lands.

也就是说 UI 端只检测"第一次 Edit/Write" 这个粗粒度信号,不解析模型当下在第几阶段——把信任交给模型自己的执行。

### 3.6 失败 / 中断 / 完成 三条路径

```
完成:
  - completeDreamTask(taskId)  → status: completed, notified: true
  - appendSystemMessage({ ...createMemorySavedMessage(filesTouched), verb: 'Improved' })
    ← 同 extractMemories "Saved N memories" 的复用接口,只是 verb 不同
  - logEvent('tengu_auto_dream_completed', { cache_read, cache_created, ... })

失败(fork 抛错且不是 abort):
  - failDreamTask(taskId)  → status: failed
  - await rollbackConsolidationLock(priorMtime)  ← rewind mtime
  - logEvent('tengu_auto_dream_failed', {})

被用户 kill(从 bg-tasks 对话框点 kill):
  - DreamTask.kill 已经做了 abort + 改 status: killed + rollback
  - 这里 catch 看到 abortController.signal.aborted → return,不重复操作
```

**注释 `autoDream.ts:260-264` 解释 kill 的去重**:

> If the user killed from the bg-tasks dialog, DreamTask.kill already
> aborted, rolled back the lock, and set status=killed. Don't overwrite
> or double-rollback.

也就是说**kill 路径和 fail 路径有部分重叠**——kill 已经在 DreamTask 里 rollback 了,这里再 rollback 是 double rollback(rewinds to original mtime + lock body),会把锁状态搞乱。所以这里特意 `if (signal.aborted) return` 跳过。

## 4. DreamTask — autoDream 的 UI 暴露层

> `src/tasks/DreamTask/DreamTask.ts:1-157`

文件开头注释说得很直白(`DreamTask.ts:1-4`):

> Background task entry for auto-dream (memory consolidation subagent).
> Makes the otherwise-invisible forked agent visible in the footer pill and
> Shift+Down dialog. The dream agent itself is unchanged — this is pure UI
> surfacing via the existing task registry.

也就是 DreamTask 不是另一条"主动巩固"路径——**它就是 autoDream 在 Task 注册表里的代理**。autoDream 启动时 `registerDreamTask(...)` 把自己挂上去,UI 在底栏小药丸和 Shift+Down 后台任务对话框里能看到它。

### 4.1 状态结构(`DreamTask.ts:25-41`)

```ts
export type DreamTaskState = TaskStateBase & {
  type: 'dream'
  phase: 'starting' | 'updating'         // 二态,详见下面
  sessionsReviewing: number              // 触发时计的 session 数
  filesTouched: string[]                 // Edit/Write 触过的路径
  turns: DreamTurn[]                      // 最近 30 个 assistant turn(text + toolUseCount)
  abortController?: AbortController       // kill 时 abort()
  priorMtime: number                      // 给 kill 时 rollback 用
}
```

**两个不完美但合理的妥协**(`DreamTask.ts:31-35` 注释):

> Paths observed in Edit/Write tool_use blocks via onMessage. This is an
> INCOMPLETE reflection of what the dream agent actually changed — it misses
> any bash-mediated writes and only captures the tool calls we pattern-match.
> Treat as "at least these were touched", not "only these were touched".

也就是说 `filesTouched` 是个**下界**——`bash > memfile.md` 这种 redirect 写不被记录,因为 Bash 没产生 Edit/Write 工具调用。但这条是给用户看的 UI 信息,**不需要完美**;dream prompt 已经禁止 Bash write,所以漏报概率不高。

### 4.2 phase 二态 + flip 规则

```ts
phase: newTouched.length > 0 ? 'updating' : task.phase,
filesTouched:
  newTouched.length > 0
    ? [...task.filesTouched, ...newTouched]
    : task.filesTouched,
```

启动后 phase='starting',**第一个产生 Edit/Write 的 turn 之后**永久变 'updating'。注释 `DreamTask.ts:21-23`:

> No phase detection — the dream prompt has a 4-stage structure
> (orient/gather/consolidate/prune) but we don't parse it. Just flip from
> 'starting' to 'updating' when the first Edit/Write tool_use lands.

**Resist 用文本 grep**——不解析"Phase 1 — Orient"这种 marker,只看模型的实际行为信号(有没有真改文件)。这是个"信任模型自身,不监控它的工作流"的设计。

### 4.3 `MAX_TURNS = 30` 滑窗

```ts
turns: task.turns.slice(-(MAX_TURNS - 1)).concat(turn),
```

只保留最后 29 + 当前 = 30 个 turn 的 text + toolUseCount 给 UI 显示。dream agent 通常 10-30 turn 完事,所以这个窗对大部分 case 不截断;长 case(>30 turn)只丢历史 turn 的展示,不影响 dream 本身。

### 4.4 `notified: true` 立刻置(`DreamTask.ts:109-113`)

```ts
completeDreamTask(taskId, setAppState): {
  status: 'completed',
  endTime: Date.now(),
  notified: true,           // ← 立刻 true
  abortController: undefined,
}
```

注释:

> notified: true immediately — dream has no model-facing notification path
> (it's UI-only), and eviction requires terminal + notified. The inline
> appendSystemMessage completion note IS the user surface.

也就是说**Task 框架的标准生命周期**是:terminal → 等用户 ack(notified=true)→ eviction。但 DreamTask 不发"通知模型"那种事件,所以一终态就直接置 notified,让它能被 evict。`appendSystemMessage` 那条"Improved files A B C" 才是给用户看的 surface。

### 4.5 `kill()` 的特殊路径(`DreamTask.ts:136-156`)

```ts
async kill(taskId, setAppState) {
  let priorMtime: number | undefined
  updateTaskState<DreamTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task   // 已终态,no-op
    task.abortController?.abort()                 // 砍 fork 的 stream
    priorMtime = task.priorMtime                  // 抓 mtime 给 rollback
    return { ...task, status: 'killed', notified: true, abortController: undefined }
  })
  // updateTaskState 是 React state 更新,可能 noop(并发竞争)。
  // 只在真的改了 status 时才 rollback。
  if (priorMtime !== undefined) {
    await rollbackConsolidationLock(priorMtime)
  }
}
```

**两件事在 kill 里同时做**:
1. abort fork agent 的 stream
2. rollback consolidationLock 的 mtime(让下次 turn 还能再触发)

注意 `if (priorMtime !== undefined)`——如果 `updateTaskState` 因为 task 已经在终态而 no-op,`priorMtime` 不会被赋值,这里就不 rollback,避免 double-rollback 把别人(后续的 fail 路径)的状态搞乱。

### 4.6 总结:**Task 系统的"渲染层"角色**

DreamTask 这个文件相当于一个 adapter——把"后台 fork agent + lock 文件 + abortController" 这些底层概念翻译成 Task 框架能理解的 status/notified/turns/filesTouched 字段。**autoDream 不需要关心 React state**——它只调 `registerDreamTask` / `addDreamTurn` / `completeDreamTask` 三个函数,DreamTask 内部做 setAppState。

**对后端的可借鉴模式**:把"后台子任务暴露给前端"做成一个独立的 adapter 模块(注册 + 状态更新 + kill 路径),不要让业务模块直接操心 UI state shape。

## 5. AgentTool 子 agent memory + snapshot 传播

> `src/tools/AgentTool/agentMemory.ts:1-177` + `agentMemorySnapshot.ts:1-197`

**关键事实**:**每个 agent type 有独立的 MEMORY.md**,不和 project auto-memory 混。fork 出去的 `code-reviewer` agent 不会带走父的 user/feedback 记忆,带走的是它自己 type 的累积学习。

### 5.1 三 scope 物理布局(`agentMemory.ts:52-65`)

```
'user'    → <memoryBase>/agent-memory/<agentType>/MEMORY.md
            (~/.claude/agent-memory/<agentType>/, 跨所有项目)
'project' → <cwd>/.claude/agent-memory/<agentType>/MEMORY.md
            (VCS-tracked, 团队共享)
'local'   → <cwd>/.claude/agent-memory-local/<agentType>/MEMORY.md
            (NOT VCS-tracked, 本机+本项目)
```

**`agentType` 路径化要 sanitize**(`agentMemory.ts:20-22`):

```ts
function sanitizeAgentTypeForPath(agentType: string): string {
  return agentType.replace(/:/g, '-')
}
```

注释解释:**插件命名的 agent type(`my-plugin:my-agent`)用了冒号,Windows 上是非法路径字符**,转成 `-`。Phase 2 工具系统里 `mcp__server__tool` 类似的命名也有这种 namespace 编码——值得抄到我们后端的"工具/agent 命名规约"里。

### 5.2 远程 mode 下的 local scope 重定向(`agentMemory.ts:29-44`)

```ts
function getLocalAgentMemoryDir(dirName: string): string {
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    return join(
      CLAUDE_CODE_REMOTE_MEMORY_DIR,
      'projects',
      sanitizePath(findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot()),
      'agent-memory-local',
      dirName,
    ) + sep
  }
  return join(getCwd(), '.claude', 'agent-memory-local', dirName) + sep
}
```

**这是给 Cowork / 远程 sandbox 的兼容**——sandbox 容器的 cwd 通常是临时挂载,不持久;`CLAUDE_CODE_REMOTE_MEMORY_DIR` 指向一个跨 session 持久的 mount,所有 sandbox 里的 local scope 实际写到那里。**用 project root 做 namespace 防 namespace 冲突**(否则多个项目的 sandbox 会互相覆盖 local memory)。

### 5.3 `loadAgentMemoryPrompt()` — 复用 `buildMemoryPrompt`(`agentMemory.ts:138-177`)

```ts
export function loadAgentMemoryPrompt(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  let scopeNote: string
  switch (scope) {
    case 'user':    scopeNote = '- ...keep learnings general since they apply across all projects'
    case 'project': scopeNote = '- ...shared with your team via version control, tailor to this project'
    case 'local':   scopeNote = '- ...not checked into version control, tailor to this project and machine'
  }

  const memoryDir = getAgentMemoryDir(agentType, scope)
  void ensureMemoryDirExists(memoryDir)   // fire-and-forget

  return buildMemoryPrompt({              // ← 复用 memdir.ts 的标准构造
    displayName: 'Persistent Agent Memory',
    memoryDir,
    extraGuidelines: [scopeNote, ...(cowork ? [coworkExtra] : [])],
  })
}
```

**两个细节**:

1. **prompt body 完全复用 memdir 的 `buildMemoryPrompt`**——同样的 4 type / what NOT to save / when to access / before recommending。只 displayName 和 extraGuidelines 不同。这意味着 agent memory 用一套一模一样的"how to think about memory" instruction manual。
2. **fire-and-forget mkdir**——`agentMemory.ts:159-163` 注释:

> this runs at agent-spawn time inside a sync getSystemPrompt() callback
> (called from React render in AgentDetail.tsx, so it cannot be async).
> The spawned agent won't try to Write until after a full API round-trip,
> by which time mkdir will have completed.

React render 里调 getSystemPrompt 是同步的,但 mkdir 必须 async。所以**fire-and-forget**:启动 mkdir 不等结果,反正模型第一次想 Write 已经过去 1 个 API 来回(~1s+),目录早建好了。**真没建好的兜底是** FileWriteTool 自己也会 mkdir parent dir。

### 5.4 Snapshot 传播机制(`agentMemorySnapshot.ts:1-197`)

**这是 phase 3 最值得抄的 idea 之一**——团队怎么把 agent memory 的"权威版本"通过 git 分发。

#### 5.4.1 物理结构

```
<cwd>/.claude/
  agent-memory-snapshots/
    code-reviewer/
      snapshot.json              ← { updatedAt: "2026-06-10T14:23:00Z" }
      MEMORY.md                  ← 权威版本的 MEMORY.md
      patterns.md                ← topic files
      style.md
      ...

  agent-memory/                  ← project scope local 文件
    code-reviewer/
      MEMORY.md                  ← 我本地的 MEMORY.md(可能领先 / 落后 snapshot)
      patterns.md
      ...
      .snapshot-synced.json      ← { syncedFrom: "2026-06-08T09:11:00Z" }
```

**注意 snapshot 目录是和 agent-memory 平级的另一个目录**,**不是** agent-memory 的子目录。这样:
- 用户的本地 agent-memory 写不进 snapshot(它在另一棵子树)
- snapshot 可以被 git track,本地 agent-memory 可以不 track(也可以 track,看 scope)
- 切到另一个分支时 snapshot 跟着切,但本地 agent-memory 不动

#### 5.4.2 3-action 决策表(`agentMemorySnapshot.ts:98-144`)

```ts
export async function checkAgentMemorySnapshot(agentType, scope): Promise<{
  action: 'none' | 'initialize' | 'prompt-update'
  snapshotTimestamp?: string
}> {
  const snapshotMeta = await readJsonFile(getSnapshotJsonPath(agentType), snapshotMetaSchema())
  if (!snapshotMeta) return { action: 'none' }                       // 没 snapshot

  const hasLocalMemory = /* readdir local dir, 看有没有 .md */
  if (!hasLocalMemory) return { action: 'initialize', snapshotTimestamp }  // 第一次,直接复制

  const syncedMeta = await readJsonFile(getSyncedJsonPath(agentType, scope), syncedMetaSchema())
  if (!syncedMeta || new Date(snapshotMeta.updatedAt) > new Date(syncedMeta.syncedFrom)) {
    return { action: 'prompt-update', snapshotTimestamp }  // snapshot 比本地新,问用户
  }

  return { action: 'none' }   // 本地已 sync 到这版
}
```

**三种 action 的语义边界**:

| action | 触发条件 | 行为 |
|---|---|---|
| `none` | 没 snapshot,或 local 已和 snapshot 同步 | 啥都不做 |
| `initialize` | 有 snapshot,本地一个 .md 都没有 | 自动复制 snapshot → local + 写 `.snapshot-synced.json` |
| `prompt-update` | snapshot.updatedAt > syncedFrom | **弹对话框问用户**:要不要用 snapshot 覆盖本地 |

`initialize` 不问用户因为没什么可丢的;`prompt-update` 必须问因为本地可能有用户自己加的内容,直接覆盖会丢工作。

#### 5.4.3 三种应用方式

```ts
// 第一次拉取
export async function initializeFromSnapshot(agentType, scope, snapshotTimestamp) {
  await copySnapshotToLocal(...)
  await saveSyncedMeta(agentType, scope, snapshotTimestamp)
}

// 用户同意用 snapshot 覆盖
export async function replaceFromSnapshot(agentType, scope, snapshotTimestamp) {
  // 先删本地所有 .md(防 orphan)
  for (dirent of existing) if (dirent.name.endsWith('.md')) await unlink(...)
  await copySnapshotToLocal(...)
  await saveSyncedMeta(...)
}

// 用户拒绝更新 / 选"我自己管"
export async function markSnapshotSynced(agentType, scope, snapshotTimestamp) {
  // 不改 local 内容,只更新 syncedFrom = snapshotTimestamp
  // 效果:下次 check 时 snapshot.updatedAt <= syncedFrom 不再提示
  await saveSyncedMeta(agentType, scope, snapshotTimestamp)
}
```

**`markSnapshotSynced` 是"静音此版"**——用户选了"不更新但别再问",`.snapshot-synced.json` 里把 syncedFrom 顶到当前 snapshot 时间戳,后续不再触发 prompt-update 直到 snapshot 再次更新。

### 5.5 子 agent 命名隔离 in `relevant_memories`(`attachments.ts:2206-2213`)

回顾路径 ③ 的 agent 隔离:

```ts
const memoryDirs = extractAgentMentions(input).flatMap(mention => {
  const agentType = mention.replace('agent-', '')
  const agentDef = agents.find(def => def.agentType === agentType)
  return agentDef?.memory ? [getAgentMemoryDir(agentType, agentDef.memory)] : []
})
const dirs = memoryDirs.length > 0 ? memoryDirs : [getAutoMemPath()]
```

**`@-mention agent → 只搜该 agent 的 memory dir,不碰 auto memory**。这是给"agent 是个 personality"语义服务的:`@code-reviewer 帮我看看这个 PR` 的时候,不希望从 user 的 personal feedback memory("我不喜欢 trailing whitespace warning")里 surface 内容混淆 review 标准。

### 5.6 用 isAgentMemoryPath 做权限保护

`memoryFileDetection.ts:68-104` 的 `isAgentMemoryPath` 给三 scope 各做一次 prefix 检查,允许 FileWriteTool 的"memory 目录碰过的写,走 carve-out"。**Local scope 在远程 mode 下走 `CLAUDE_CODE_REMOTE_MEMORY_DIR/projects/<git>/agent-memory-local/`** 这条路径也要识别——所以这里有 env-var 分支判断。

## 6. Team memory 分层

> `src/memdir/teamMemPaths.ts:1-292` + `teamMemPrompts.ts:1-100`

**TEAMMEM 是 feature-flag 加 GrowthBook 双重门后才上的功能,但它对架构的渗透很深**——`memdir.ts` 第 6 行就 `feature('TEAMMEM') ? require('./teamMemPaths') : null`,说明这是一等公民,不是边角。

### 6.1 启用链(`teamMemPaths.ts:73-78`)

```ts
export function isTeamMemoryEnabled(): boolean {
  if (!isAutoMemoryEnabled()) return false                                   // 必须 auto 开
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_herring_clock', false)  // GB cohort
}
```

**双门**:
- auto memory 必须开(team mem 是 auto 的子目录,语义上无 auto 就无 team)
- `tengu_herring_clock` GB flag 控制 cohort(灰度 / 内部员工 / 实验组)

注释 `teamMemPaths.ts:67-72`:

> Team memory is a subdirectory of auto memory, so it requires auto memory
> to be enabled. This keeps all team-memory consumers (prompt, content
> injection, sync watcher, file detection) consistent when auto memory is
> disabled via env var or settings.

**用 subdirectory 而不是独立目录**的好处是**关 auto 就同时关 team**,不会出现"auto 关了但 team 还在写"的状态不一致。

### 6.2 物理布局

```
<autoMemPath>/                        ← 个人 memory
  MEMORY.md
  user_role.md
  feedback_tests.md
  ...
  team/                               ← team memory(子目录)
    MEMORY.md                          ← team 自己的入口索引
    feedback_test_policy.md
    project_release_cycle.md
    ...
```

**team 是 auto 的子目录**,所以 isAutoMemFile(teamFile) 也是 true。`memoryFileDetection.ts:106-114` 显式提示:

> Team dir is a subdirectory of memdir, so a team path matches both
> isTeamMemFile and isAutoMemFile. Check team first.

`memoryScopeForPath` 这种 scope 分类函数**先看 team 再看 personal**,否则所有 team 文件都归 personal。

### 6.3 Combined prompt:`<scope>` 标签 + 4-type 各自给指引

`teamMemPrompts.buildCombinedMemoryPrompt`(`teamMemPrompts.ts:22-100`)做几件 Individual 模式没做的事:

**(a) 顶层 `## Memory scope` 段解释两个目录**:

```
- private: ...persist across conversations with only this specific user,
           stored at `<autoDir>`
- team: ...shared with and contributed by all of the users who work
        within this project directory, synced at the beginning of every session,
        stored at `<teamDir>`
```

**(b) 4 type 的 `<scope>` 子标签**(`memoryTypes.ts:37-104` 的 COMBINED 版本):

| type | scope |
|---|---|
| `user` | **always private**(用户偏好不该 leak 给团队) |
| `feedback` | default private; team only if 项目范围的 convention(testing policy / build invariant) |
| `project` | 倾向 team(项目状态、deadline、incident 都是团队共享) |
| `reference` | usually team(Linear/Grafana 这种外部指针团队都用) |

**特别有意思的 `feedback` 类型**:既不全 private 也不全 team。它告诉模型**判断标准**:

> Before saving a private feedback memory, check that it doesn't contradict
> a team feedback memory — if it does, either don't save it or note the
> override explicitly.

(`memoryTypes.ts:60`)

也就是**两个 scope 都有同主题 memory 时存在覆盖语义**——private feedback 默认 override team feedback,但必须显式标。**这是 prompt-level 的 conflict resolution**。

**(c) 多一条**敏感数据红线(`teamMemPrompts.ts:78`):

```
You MUST avoid saving sensitive data within shared team memories.
For example, never save API keys or user credentials.
```

private memory 没这一行,因为 private memory 也不会泄漏给团队。

### 6.4 两段式路径校验防 symlink escape(`teamMemPaths.ts:222-256`)

**问题**:`path.resolve()` 不 resolve symlink。如果团队 memory 目录里被植入一个 symlink 指向 `~/.ssh/authorized_keys`,resolve-only 的 containment 检查会通过(字符串前缀 OK),但实际 writeFile 会跟着 symlink 写到外面。

**两段校验**(`validateTeamMemWritePath`):

```ts
// 第 1 段: 字符串 prefix 检查(快路径,防明显的 ../../)
const resolvedPath = resolve(filePath)
if (!resolvedPath.startsWith(teamDir)) throw PathTraversalError
// teamDir 已经带 trailing sep, "team-evil/" 不会匹配 "team/"

// 第 2 段: realpath 到最深存在的 ancestor + 再验 containment
const realPath = await realpathDeepestExisting(resolvedPath)
if (!(await isRealPathWithinTeamDir(realPath))) {
  throw PathTraversalError('Path escapes ... via symlink')
}
```

**`realpathDeepestExisting`**(`teamMemPaths.ts:109-171`)的逻辑:

```
walk up from target path:
  try realpath(current):
    success → 返回 realpath + 之前 pop 出来的 tail(rebuilt)
  fail ENOENT:
    lstat(current):
      isSymbolicLink → THROW (dangling symlink 是攻击向量!)
      其他 → 真不存在,pop current 进 tail,继续往上
  fail ELOOP:
    THROW (symlink loop)
  fail 其他(EACCES/EIO):
    THROW (cannot verify → fail closed)
```

**关键设计**:
- **目标文件可能还不存在**(我们正要创建它),所以不能直接 realpath。必须 walk up 找到最深存在的 ancestor → realpath 它 → 然后 rejoin 不存在的尾部。
- **dangling symlink 是攻击**——文件本身不存在但 symlink 存在,代表有人提前埋好链子等你写。lstat 看符号链接本身的元数据(不跟着走),发现是 symlink 就 throw。
- **ENOENT 又不是 dangling 的情况**——可能是中间某个 ancestor 是 dangling symlink,继续 walk up 暴露它。
- **fail closed**——EACCES/EIO 这种"看不清"的错误也 throw,**不允许 silent skip**。注释:`fail closed by wrapping as PathTraversalError so the caller can skip this entry gracefully instead of aborting the entire batch`。

### 6.5 sanitizePathKey 防多种 traversal 向量(`teamMemPaths.ts:22-64`)

```ts
function sanitizePathKey(key: string): string {
  if (key.includes('\0')) throw      // null byte → C syscall 截断
  decoded = decodeURIComponent(key) catch (key)
  if (decoded !== key && (decoded.includes('..') || decoded.includes('/'))) {
    throw  // URL-encoded traversal: %2e%2e%2f
  }
  // PSR M22187 vector 4: NFKC normalization attack
  // fullwidth ．． ／ (U+FF0E U+FF0F) → NFKC → ascii ../
  const normalized = key.normalize('NFKC')
  if (normalized !== key && (normalized.includes('..') || ...)) {
    throw  // Unicode 化 traversal
  }
  if (key.includes('\\')) throw      // Windows path sep
  if (key.startsWith('/')) throw     // 绝对路径
  return key
}
```

**6 种攻击向量**:
1. null byte (`\0`) — C 层 syscall 截断
2. URL 编码 `%2e%2e%2f` = `../`
3. Unicode NFKC 化的 `．．／` 看着不是斜杠但 normalize 后是
4. Windows backslash `\`
5. 绝对路径前缀 `/`
6. 普通的 `..` 是后续 resolve-then-prefix-check 拦的,这里不重复

每一条都标了 PSR(可能是 Anthropic 内部的 Project Security Report)编号——`teamMemPaths.ts:39-43` 的 NFKC 那条特意注:`PSR M22187 vector 4`,是真的被红队挖出来过的向量。

### 6.6 team memory 的 sync(本笔记不详细展开)

**team memory 在 session 开头会从某个远程 store sync 到本地**(`teamMemPrompts.ts:74`:`Team memories are synced at the beginning of every session`)。本笔记没读 sync 实现(应该在 `services/teamMemory/` 或类似目录,本仓库没暴露),但**注入流程上 team 文件和个人文件对模型是同一界面**——同样的 `## Types of memory` 提示,同样的 4 types,只是写入时模型自己决定路径(team 还是 private)。

**对后端的启示**:**写入分层(personal/team)做成模型 prompt 里的"scope guidance"**,不要在写入 API 里强分。模型懂语义,而硬路径分流会让"用户偏好"和"团队约定"硬绑死目录,反而不灵活。

## 7. 写入路径的语义边界

实际是**5 条写入路径**(原计划写"三种"——读完发现是 5 条,如实记录)。每条的触发时机、写者、协调机制都不同。

### 7.1 路径全景表

| # | 路径 | 写者 | 触发 | 目标 | 协调 |
|---|---|---|---|---|---|
| A | 主对话直接写 | Main agent | 模型用 Edit/Write 在主 loop 内调 | `<autoMemPath>/<file>.md` 或 `team/<file>.md` | extractMemories 通过 `hasMemoryWritesSince` 检测,跳过这段 |
| B | extractMemories | Turn-end forked agent | turn 末 + 无 tool_use + feature flag + 5+ new messages | `<autoMemPath>/<file>.md` 或 `team/<file>.md` | 跳过已被 main agent 写过的 message range |
| C | autoDream | 跨 session forked agent | turn 末 + 24h+/5sess+ + lock | 所有 4 类 memory 文件,包括 MEMORY.md prune | `consolidationLock` 互斥;跑前 `recordConsolidation` 占坑 |
| D | KAIROS daily logs | Main agent(append-only) | 助理模式 + autoEnabled + 模型自觉 append | `<autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md` | 不和 MEMORY.md 双向同步,夜间 /dream skill 单向蒸馏 |
| E | `/memory` 命令 | 用户(打开 $EDITOR) | 用户手动 invoke | 任意 memory 文件 | 不参与任何协调,直接绕过 agent |

### 7.2 路径 A:主对话直接写

最直观的一条。模型在主 loop 里读 user prompt → 决定"这是个 feedback,该存"→ 调 FileWriteTool 写一个新 .md → 调 FileEditTool 在 MEMORY.md 里加 pointer。

**没什么协调机制需要解释**——和模型写任何其他文件没区别。FileWriteTool 的 carve-out 让它绕过 DANGEROUS_DIRECTORIES 检查写 `<autoMemPath>`(通过 `isAutoMemPath` 匹配)。

这条路径的**主要风险**是模型**写**得不够频繁——它的 system_prompt 里有详细 instruction manual,但**真实生产里仍有 95% turn 该存的没存**。这就是为什么需要路径 B/C。

### 7.3 路径 B:extractMemories — turn-end 抽取

**入口**:`stopHooks.ts` 在每个 turn 终止时(同 autoDream 一起)调 `extractMemories` 模块。

**关键协调**(`extractMemories.ts:1-15` 文件头注释):

> Extracts durable memories from the current session transcript and writes
> them to the auto-memory directory.
>
> It runs once at the end of each complete query loop (when the model produces
> a final response with no tool calls) via handleStopHooks in stopHooks.ts.
>
> Uses the forked agent pattern (runForkedAgent) — a perfect fork of the main
> conversation that shares the parent's prompt cache.

**和 autoDream 的区别**:
- extractMemories **per-session**——只看当前会话的消息
- autoDream **cross-session**——读多个 transcript jsonl 文件
- extractMemories 是 turn 末 1-2 turn 跑完的轻量 fork
- autoDream 是 30+ turn 深度巩固的重量 fork

**协调机制**:`hasMemoryWritesSince` 检测主 agent 已经写过的 message 范围,extractMemories 跳过那段。注释:

> The main agent's prompt always has full save instructions regardless of
> this gate — when the main agent writes memories, the background agent
> skips that range; when it doesn't, the background agent catches anything
> missed.

(`paths.ts:60-67`)

**核心思想**:**主 agent 是优先写入者,background 是 fallback**。主 agent 写了就别再 extract;没写,extract 兜底。两个层都有同一份"how to save memory" instruction(via `loadMemoryPrompt`),所以**两者的"该存什么"判断标准是一致的**。

### 7.4 路径 C:autoDream

**已在 §3 详述**。和 extractMemories 关键区别是**时间尺度**和**操作目标**:

| 维度 | extractMemories | autoDream |
|---|---|---|
| 触发频率 | 每 turn 末 | 24h+ 5sess+ |
| 看数据范围 | 当前 session 后 N 条 message | 多 session transcripts |
| 操作 | 新增 topic file | 新增 + 合并 + prune + rebuild MEMORY.md |
| Fork agent prompt | 抽取专用 | 4-phase consolidation |
| 互斥 | 无(per-session) | consolidationLock(全局) |

**两者都在 stopHooks 里 trigger**,但 extractMemories 几乎每 turn 都跑(轻),autoDream 95% turn 直接 return(重)。

### 7.5 路径 D:KAIROS 日志附加(`memdir.ts:319-370`)

**Assistant 模式**——`getKairosActive()` 返回 true 时启用。和普通 CLI 不同:

```
普通 CLI:
  - 一个对话 = 一个 turn-by-turn 互动
  - MEMORY.md 是活索引,模型直接编辑

Assistant 模式(KAIROS):
  - session 是 perpetual 的(可能跑几天)
  - MEMORY.md 仍然是索引但模型不直接编辑
  - 新信息写到 <autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md (append-only)
  - 夜间 disk-skill /dream(不是 autoDream)蒸馏 logs → topic files → MEMORY.md
```

`buildAssistantDailyLogPrompt`(`memdir.ts:327-370`)给的 prompt 教模型:

```
This session is long-lived. As you work, record anything worth remembering by
**appending** to today's daily log file:
  `<autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md`

Write each entry as a short timestamped bullet. Create the file (and parent
directories) on first write if it does not exist. Do not rewrite or
reorganize the log — it is append-only. A separate nightly process distills
these logs into `MEMORY.md` and topic files.
```

**精妙细节 - prompt cache 友好**(`memdir.ts:329-334` 注释):

> Describe the path as a pattern rather than inlining today's literal path:
> this prompt is cached by systemPromptSection('memory', ...) and NOT
> invalidated on date change. The model derives the current date from the
> date_change attachment (appended at the tail on midnight rollover) rather
> than the user-context message — the latter is intentionally left stale to
> preserve the prompt cache prefix across midnight.

**prompt 里写的是 `YYYY/MM/YYYY-MM-DD.md` 模板**,不是 `2026/06/2026-06-12.md`。如果写实际日期,午夜过后 prompt 字面值就变了 → cache miss。所以 prompt 静态化,日期通过另一条 `date_change` attachment 注入到消息末尾。**user-context 消息(包含 currentDate)故意 stale 保 prefix**——这是 prompt cache 友好设计的极致。

**KAIROS 和 TEAMMEM 不兼容**(`memdir.ts:427-431` 注释):

> KAIROS daily-log mode takes precedence over TEAMMEM: the append-only
> log paradigm does not compose with team sync (which expects a shared
> MEMORY.md that both sides read + write). Gating on `autoEnabled` here
> means the !autoEnabled case falls through to the tengu_memdir_disabled
> telemetry block below, matching the non-KAIROS path.

**Append-only vs bidirectional-sync 语义冲突**——如果两边都 append-only,合并冲突没法自动解决;如果 team 那侧编辑 MEMORY.md,我这侧 KAIROS 日志风格的索引整理就被打乱。所以**KAIROS 干脆覆盖 TEAMMEM**,选定后只跑 KAIROS。

### 7.6 路径 E:`/memory` slash 命令(`commands/memory/memory.tsx`)

**最简单的一条**——用户在 REPL 输 `/memory`,弹一个 `MemoryFileSelector` 选 memory 文件,选完后 `editFileInEditor` 在 `$EDITOR` 里打开。

```tsx
const handleSelectMemoryFile = async (memoryPath: string) => {
  // 1. 必要时创建配置目录
  if (memoryPath.includes(getClaudeConfigHomeDir())) {
    await mkdir(getClaudeConfigHomeDir(), { recursive: true })
  }
  // 2. wx flag 创建空文件(如果不存在),EEXIST 静默
  try { await writeFile(memoryPath, '', { encoding: 'utf8', flag: 'wx' }) }
  catch (e) { if (getErrnoCode(e) !== 'EEXIST') throw e }
  // 3. 调 $EDITOR / $VISUAL
  await editFileInEditor(memoryPath)
  // 4. 提示用户 editor 名字
  const editorInfo = ... `Using ${editorSource}=...`
  onDone(`Opened memory file at ${getRelativeMemoryPath(memoryPath)}\n\n${editorHint}`)
}
```

**唯一让我注意的细节**:`writeFile(..., flag: 'wx')`——wx 是"exclusive create" flag,文件不存在才创建,存在就 EEXIST,这样**不会把已有内容清掉**。这条防的是"重复点 /memory 选同一文件"踩坏自己。

### 7.7 协调机制总览

```
                  ┌─────────────────────────────────────┐
                  │ 写者                                │
                  ├─────────────────────────────────────┤
[A] main agent ── │ 第一优先级。在 prompt 里有 instruction │
                  │ 主动写。turn-by-turn 写到 memory dir.│
                  └────────────────┬────────────────────┘
                                   ▼
                          hasMemoryWritesSince
                          (extractMemories 检测)
                                   │
                                   ▼
                  ┌──────────────────────────────────────┐
                  │ 写者                                 │
                  ├──────────────────────────────────────┤
[B] extractMem ── │ 兜底。每 turn 末扫 main 漏的 message  │
                  │ 范围,fork 出去抽取。                 │
                  └──────────────┬───────────────────────┘
                                 │ 一段时间后……
                                 ▼
                  ┌──────────────────────────────────────┐
                  │ 写者                                 │
                  ├──────────────────────────────────────┤
[C] autoDream ─── │ 深度整理。24h+ 5+sess. consolidate  │
                  │ 多 session 信号,prune MEMORY.md,    │
                  │ 解决文件间矛盾。                     │
                  └──────────────────────────────────────┘

旁路:
  [D] KAIROS log — append-only, 夜间 /dream skill 蒸馏(不在 autoDream 里)
  [E] /memory  — 用户绕过 agent, $EDITOR 直接改
```

**每一层接管前一层的遗漏**——这是设计的精髓。A 漏了 B 兜,B 攒了 C 整理。**整个系统是分层的,每层只解决一种 granularity 的问题**:
- A 解决"模型当下决策要存"
- B 解决"模型该存但没存"
- C 解决"多次累积的 redundancy / drift / contradiction"
- D 给 perpetual session 一个不阻塞主流程的快速写入路径
- E 给用户一个"绕过自动化"的 escape hatch

## 8. 工程刻痕(每一行都有故事)

每一条都是"看代码这一处会想'为什么写成这样'" → 翻到注释发现是被某个具体问题/事故/eval 打出来的。

### 8.1 `.consolidate-lock` mtime IS lastConsolidatedAt

`consolidationLock.ts:1-2`:

> Lock file whose mtime IS lastConsolidatedAt. Body is the holder's PID.

**两件事用一个文件做**:
- mutex(body=PID + 60min stale + isProcessRunning 检测)
- 上次成功巩固的时间戳(mtime)

成功巩固 = lock 成功获得 + fork 跑完 + 不 rollback。所有这些都通过"写文件 → mtime 自动更新"实现,不需要单独的 `last_run.txt`。**rollback 是"显式 utimes 回退"**(`consolidationLock.ts:91-108`)。

**对后端启示**:用文件系统的 mtime 当时间戳省一个字段。但要小心**utimes 需要 root 或 owner 权限**——容器化部署里可能踩到。

### 8.2 KAIROS daily-log prompt 用 pattern 而非 literal date(`memdir.ts:329-334`)

**问题**:KAIROS 模式 system_prompt 里要告诉模型"今天的 log 在 `2026/06/2026-06-12.md`"。但 prompt 走 `systemPromptSection('memory', ...)` cache,一旦字面值变了 → cache miss。

**修法**:**prompt 里写模板 `YYYY/MM/YYYY-MM-DD.md`**,告诉模型"从 currentDate 提取日期替换"。日期通过另一条 `date_change` attachment 注入消息末尾——**消息末尾的变化不破坏 prompt cache prefix**。

**对后端启示**:**system_prompt 静态化是 prompt cache 的命脉**。任何"今天日期 / current PR 编号 / latest version"这种 daily-mutable 信息,**绝不要 inline 到 system_prompt**,只放在消息尾。

### 8.3 `relevant_memories.header` pre-compute(`attachments.ts:504-514`)

**问题**:每条 `relevant_memories` 显示"`<file.md>` (saved 3 days ago):"。`memoryAge(mtimeMs)` 调 Date.now()——同一文件**今天显示 "3 days ago",明天 "4 days ago"**。字面值不同 → prompt cache 失效。

**修法**:**attachment 创建时就把 header 字符串算好存进 attachment 字段**,渲染只读不算。后续 turn 看到的是同一字符串。

```ts
type RelevantMemories = {
  type: 'relevant_memories'
  memories: {
    path: string
    content: string
    mtimeMs: number
    /** Pre-computed header. Computed once at creation so the rendered bytes
     * are stable across turns — recomputing memoryAge(mtimeMs) at render
     * time calls Date.now(), so "3 days ago" becomes "4 days ago" → cache bust. */
    header?: string
    limit?: number
  }[]
}
```

**对后端启示**:prompt cache 友好性是**在数据结构里 freeze 时间相关字段**,不是 render layer 自己处理。

### 8.4 `filterDuplicateMemoryAttachments` mark-after-filter 顺序(`attachments.ts:2513-2540`)

**Bug history**:

```
v1: readMemoriesForSurfacing 在 prefetch 时就 readFileState.set(...)
    → consume 时 filterDuplicateMemoryAttachments 看见所有 path "已读过"
    → 全 drop
    → relevant_memories 永远是空

v2: 把 readFileState.set 延后到 consume 时,在 filter 之后
    → filter 看到 path 不在 readFileState
    → 保留
    → 然后 set 进去防止下一轮再注
```

注释:`The mark-after-filter ordering is load-bearing`。

**对后端启示**:**"防重复" 的标记时机和"判断重复"的检查时机要彻底分开**。一个 helper 同时做两件,容易写出自指 bug。

### 8.5 nested_memory 的 `isPartialView: true`(`attachments.ts:1738-1750`)

**问题**:nested_memory 注入的内容是经过处理的(stripped HTML comments / stripped frontmatter / truncated MEMORY.md),**和磁盘真实字节不同**。如果直接缓存进 readFileState,后续 Edit/Write 会以为这是磁盘内容,改坏。

**修法**:**缓存 raw bytes** + 置 `isPartialView: true`。Edit/Write 看 flag → "你只看了 partial view,要先做 Read 拿全量"。

**对后端启示**:**"模型看到的字符串" 和"磁盘真实字节"不同时**,缓存层必须区分两者,任何修改前要求重新对齐。

### 8.6 MEMORY.md 200 lines + 25KB 双 cap(`memdir.ts:35-38`)

注释:

> ~125 chars/line at 200 lines. At p97 today; catches long-line indexes that
> slip past the line cap (p100 observed: 197KB under 200 lines).

也就是有人写了 200 行但每行 1000 字符,行 cap 不够。**两 cap 联防**,分别盖 P97 和 P100。

**对后端启示**:**任何 size 限制都用两个维度 cap**——逻辑维度(行/项)+ 物理维度(字节)。

### 8.7 `DIR_EXISTS_GUIDANCE`(`memdir.ts:116-117`)

注释:

> Shipped because Claude was burning turns on `ls`/`mkdir -p` before writing.

模型默认行为:写文件前 `ls` 看看、`mkdir -p` 一下、再写。三个 turn 干一件事的活。**修法**:harness 提前 mkdir + prompt 里告诉模型"目录已存在,直接 Write"。

`DIRS_EXIST_GUIDANCE`(team+private 双目录)是 plural 版本。

**对后端启示**:**prompt 里说"基础设施已经准备好"**,让模型省探索动作。每省一个 turn 都是省 latency + 钱。

### 8.8 NFKC normalization attack(`teamMemPaths.ts:39-43`)

```ts
const normalized = key.normalize('NFKC')
if (normalized !== key && (normalized.includes('..') || normalized.includes('/') ||
    normalized.includes('\\') || normalized.includes('\0'))) {
  throw new PathTraversalError(`Unicode-normalized traversal: "${key}"`)
}
```

注释:

> Unicode normalization attacks: fullwidth ．．／ (U+FF0E U+FF0F) normalize
> to ASCII ../ under NFKC. While path.resolve/fs.writeFile treat these as
> literal bytes (not separators), downstream layers or filesystems may
> normalize — reject for defense-in-depth (PSR M22187 vector 4).

**这是真红队挖出来的攻击向量**——fullwidth 句号和斜杠在视觉上是中日韩文字符,Node.js 不当 path 分隔符,但**底层文件系统 / 数据库 / 同步层可能 normalize**,变成 `../`。Defense-in-depth 把这种"上游不识别但下游识别"的字符提前拒掉。

**对后端启示**:**用户输入做 path 时不只 sanitize ASCII**——Unicode 等价类必须考虑。

### 8.9 `memoize(getAutoMemPath, keyed on projectRoot)`(`paths.ts:223-235`)

**慢路径成本**:`getAutoMemPath` → 三档 fallback → `getSettingsForSource × 4` → `parseSettingsFile(realpathSync + readFileSync)`。**单次 ~1-3ms**。

**调用频率**:`collapseReadSearchGroups → isAutoManagedMemoryFile → getAutoMemPath` 这条链在 Messages 每次 re-render 每个 tool_use 都跑。React render 一次几十次,memory 多了一秒钟跑 100+ 次。

**修法**:memoize keyed on `getProjectRoot()`。生产里 projectRoot 是 session-stable,所以一次 cache 整个 session。测试里 projectRoot mock 切换,key 化让重算。

**对后端启示**:**memoize 不要无参 cache**——key 化让 cache 可控,测试和生产都好。

### 8.10 eval 决定的段标题:"Before recommending" vs "Trusting what you recall"(`memoryTypes.ts:240-244`)

注释:

> Header wording matters: "Before recommending" (action cue at the decision
> point) tested better than "Trusting what you recall" (abstract). The
> appendSystemPrompt variant with this header went 3/3; the abstract header
> went 0/3 in-place. Same body text — only the header differed.

**完全相同的文字内容,只改段落标题,行为从 0/3 变 3/3**。原因:标题给模型一个 trigger context。"Before recommending" 是 action cue(在决策时刻提醒),"Trusting what you recall" 是 abstract concept(没有触发时刻)。

**对后端启示**:**section header 不是装饰,是 trigger**——决定模型在什么时候想起这段 instruction。

### 8.11 `memoryAge` 用"3 days ago"而非 ISO timestamp(`memoryAge.ts:11-20`)

```ts
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d === 0) return 'today'
  if (d === 1) return 'yesterday'
  return `${d} days ago`
}
```

注释:

> Models are poor at date arithmetic — a raw ISO timestamp doesn't trigger
> staleness reasoning the way "47 days ago" does.

**模型对日期算术很烂**。"2026-04-26T08:11:00Z" 看上去就一个标识符,不触发 staleness reasoning;"47 days ago" 直接是 staleness 提示词。

**对后端启示**:**给模型的时间不要用 ISO**——用相对人话。涉及"过去多久"的判断,人话表达 >> 精确 timestamp。

### 8.12 staleness caveat 1 天以上才显示(`memoryAge.ts:33-42`)

```ts
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d <= 1) return ''       // ← 今天/昨天的不带 caveat
  return `This memory is ${d} days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.`
}
```

注释:

> Returns '' for fresh (today/yesterday) memories — warning there is noise.
> Motivated by user reports of stale code-state memories (file:line citations
> to code that has since changed) being asserted as fact — the citation
> makes the stale claim sound more authoritative, not less.

**今天/昨天的 memory 不带 staleness 警告**——加了反而噪声。**超 1 天才提醒**,因为这才是有真实 drift 风险的时刻。

**对后端启示**:**警告不要无脑刷**——只在真正有风险的窗口里出。

### 8.13 selector 区分"reference docs"和"warnings/gotchas"(`findRelevantMemories.ts:21-24`)

```
- If a list of recently-used tools is provided, do not select memories that
  are usage reference or API documentation for those tools (Claude Code is
  already exercising them). DO still select memories containing warnings,
  gotchas, or known issues about those tools — active use is exactly when
  those matter.
```

**关键洞察**:模型在用某个工具,**该工具的 usage docs** 是噪音(行为已在 transcript 里展开了);**该工具的 warnings/gotchas** 是高价值(就是这个时刻要小心)。

**对后端启示**:**ranking / filtering 给 LLM 做** 比 hard-coded heuristic 强。Sonnet 能区分这种语义。

### 8.14 `tengu_*` 大量 GrowthBook flag

我数到的(可能不全):

| flag | 控制 |
|---|---|
| `tengu_moth_copse` | `relevant_memories` prefetch + skipIndex 提示词 |
| `tengu_onyx_plover` | autoDream enabled + minHours/minSessions 配置 |
| `tengu_herring_clock` | TEAMMEM cohort |
| `tengu_coral_fern` | "Searching past context" prompt 段 |
| `tengu_passport_quail` | extractMemories enabled |
| `tengu_slate_thimble` | extractMemories noninteractive override |

**整个 memory 系统是 cohort-gated 的实验场**。生产里不是所有用户走同一代码路径——这意味着任何"我观察到 Claude Code 行为 X" 的描述,**在不同 cohort 下可能完全不同**。

**对后端启示**:**memory 这种 user-facing 行为系统,灰度部署是必须的**。一次 prompt 改动可能 50% 用户觉得好,50% 觉得变差——直上线就死定了。

## 9. extractMemories — 与 autoDream 并列的第二条写入路径

> `src/services/extractMemories/extractMemories.ts:1-560`

§7 已经讲过它和 autoDream 的语义差。这里补几个值得抄的工程设计。

### 9.1 closure-scoped state(`extractMemories.ts:10-13`)

```
State is closure-scoped inside initExtractMemories() rather than module-level,
following the same pattern as confidenceRating.ts. Tests call
initExtractMemories() in beforeEach to get a fresh closure.
```

**autoDream 也走这模式**(`autoDream.ts:10-11`)。

**好处**:
- 测试不用 mock 全局变量 / 不用 `jest.resetModules()` / 不用 `vi.clearAllMocks()`
- 每个 `beforeEach()` 重新 init,closure 完全独立,**自动隔离**
- 模块 import 是 cheap 的,init 是 expensive 的,这种模式让 import 不带 side effect

**对后端启示**:**任何"有可变状态且需要测试"的模块**——用 `init...` 工厂函数返回一个 closure 而不是直接 `let state = ...`。

### 9.2 `hasMemoryWritesSince` 协调主 agent(`extractMemories.ts:348-351`)

```ts
if (hasMemoryWritesSince(messages, lastExtractedAtMessageIndex)) {
  logForDebugging('[extractMemories] skipping — conversation already wrote to memory files')
  return
}
```

**简单但关键**:扫消息看自上次 extract 以来主 agent 有没有写过 memory 文件;有就跳过。

**为什么不用锁?**——extractMemories 是 per-session 的,在主 loop 里跑(stopHook),没有跨进程并发问题。**用消息扫描代替显式状态字段**,因为消息历史本来就是 state-of-truth。

**对后端启示**:**协调机制能用现有数据推导就不要加新字段**——messages 已经记录了所有信息,加一个 `lastExtractWrites` 字段是冗余。

### 9.3 完成消息复用 `createMemorySavedMessage`(`extractMemories.ts:457`)

```ts
appendSystemMessage(createMemorySavedMessage(writtenPaths))
```

`autoDream` 也调同一函数,只是 `verb` 不同(`autoDream.ts:244-247`):

```ts
appendSystemMessage({
  ...createMemorySavedMessage(dreamState.filesTouched),
  verb: 'Improved',     // ← 默认 'Saved',Dream 改成 'Improved'
})
```

**用户看到**:
- extractMemories 后: `Saved 3 memories: feedback_x.md, user_y.md, project_z.md`
- autoDream 后: `Improved 7 memories: ...`

**对后端启示**:**用户面 surface 复用 component,只参数化语义动词**——一致的视觉,清晰的语义差。

### 9.4 trailing extraction 给"stashed context"(`extractMemories.ts:511-519`)

```ts
if (lastExtractStashed) {
  logForDebugging('[extractMemories] running trailing extraction for stashed context')
  // 跑一次额外的 extraction
}
```

**场景**:用户在 extractMemories 正跑时又发了新 prompt。当前 extraction 不能跑两次,但新 prompt 后续的对话可能也有该存的信息。所以**stash 这次的 message range,等下次结束时合并跑一次 trailing extraction**。

**对后端启示**:**长跑后台任务遇到 reentry 时,不要 drop 也不要 queue 跑两次**——stash 中间增量,下一次合并跑。

### 9.5 fork agent 的 `createCacheSafeParams`(`autoDream.ts:227` + `extractMemories.ts` 同上)

**共享设计**:fork agent 用 `createCacheSafeParams(context)` 拷贝**主 agent 的 prompt cache prefix**(system_prompt + memory section + tool defs)。

**意义**:
- fork 的第一个 turn 几乎是 cache hit(只新增 dream/extract prompt 那一段 user message)
- 省 tokens / 省 latency / 省钱

**没这设计的话**:每次 fork 重建 prompt cache,~30K tokens 的 system_prompt 每次都重新交。 

**对后端启示**:**fork 出去的子 agent 默认应该继承父的 cache**——只在需要"完全不同 system_prompt"时才不继承。

## 10. 对我们 Web/API agent 后端的启示

按"直接可抄 / 改造可抄 / 不要抄" 三档分类。

### 10.1 直接可抄

| 设计点 | 价值 |
|---|---|
| **`loadMemoryPrompt` 是唯一入口函数,返回 string \| null** | system_prompt 注入只通过一个函数,关掉就 null,不需要"memory disabled" 特殊路径写在调用方 |
| **5 步优先级链 isAutoMemoryEnabled** | env → simple-flag → remote-without-dir → settings.json → 默认。每档优先级对应一个部署场景 |
| **4 type 封闭 taxonomy(user/feedback/project/reference)** | 不要让用户起新 type。每个 type 在 prompt 里有独立的 when_to_save/how_to_use/body_structure/examples,新增是 prompt rewrite 不是 enum 加行 |
| **MEMORY.md 200 行 + 25KB 双 cap + 截断警告** | 任何 size 限制都用两维度 cap。截断警告本身教模型怎么自己 fix(挪 detail 到 topic file) |
| **prefetch + Disposable handle + `using`** | 长会话里 sideQuery 这种 promise-returning 资源用 `using` 自动清理,13 个 generator return 点不用各自 cleanup |
| **三层 dedup(selector 输入 / 输出 / readFileState)** | 防"同一 memory 重复 surface",每层针对不同语义(LLM budget / multi-dir merge / model already read) |
| **mark-after-filter 顺序在 dedup 里 load-bearing** | 不能在 prefetch 时就 mark(self-referential bug)——必须 consume 时 filter 完再 mark |
| **per-file 4KB cap(不是 25KB)给 surfacer** | 走 `<system-reminder>` 通道绕过 tool-result budget,这里必须自己卡死。truncate 加 FileRead 指引,模型自取全文 |
| **Lock 文件 mtime IS lastTriggerAt** | mutex + 时间戳一物多用。rollback 是 utimes 回退 |
| **PID-based liveness + 60min stale guard + 二次读验证** | 锁文件防 PID 复用 / hang fork / 并发 reclaim 三类问题 |
| **Forked agent + cacheSafeParams** | 子 agent 继承父 prompt cache 省 30K tokens / fork。skipTranscript 不污染用户 session |
| **Closure-scoped state in `init...()` 工厂** | 测试隔离的最佳模式,beforeEach 调一次 init 就完全独立 closure |
| **`hasMemoryWritesSince` 用消息扫描代替显式状态字段** | 协调机制能从现有数据推导就别加新字段 |
| **stash + trailing run 处理 reentry** | 后台任务遇到第二次 trigger,不 drop 不并发,stash 增量等当前结束 |
| **Pre-compute time-relative header in attachment** | "3 days ago" 算好存进 attachment,渲染只读不算,**保 prompt cache**。daily mutable 数据不要进 system_prompt 字面值 |
| **KAIROS 模板路径而非 literal date** | 用 `YYYY/MM/YYYY-MM-DD.md` 模板 + `date_change` attachment,模型自己代入。**消息尾部变化不破 cache prefix** |
| **agent type 命名 sanitize(`:` → `-`)** | 跨平台路径化的最小 escape,namespace 编码兼容 Windows |
| **snapshot 传播机制(`snapshot.json.updatedAt` + `.snapshot-synced.json.syncedFrom`)** | 团队通过 git 传"权威 memory 版本",3-action 决策表(none/initialize/prompt-update)+ markSnapshotSynced 静音此版 |
| **eval-driven section header wording** | 段落标题是 trigger context,不只是装饰。同一文字内容不同标题行为天差 |
| **`memoryAge` 用"3 days ago"而非 ISO timestamp** | 模型对日期算术烂,人话相对时间触发 staleness reasoning |
| **`isPartialView: true` 标记差异性内容** | 模型看到的内容 vs 磁盘真实字节不同时,缓存层必须区分,后续 Edit 强制重新 Read |
| **fail-closed on EACCES/EIO in containment 检查** | 看不清就拒,不让 silent succeed |

### 10.2 改造可抄

| 设计点 | 改造方向 |
|---|---|
| **5 类写入路径分层(A 主写 → B 兜底抽取 → C 跨 session 巩固 + D KAIROS log + E 用户编辑)** | Web 后端可能只需要 A + C 两层:主 agent 写,跨 session 跑 cron 巩固。B(per-turn 抽取)在 RPS 高的场景代价大,可省 |
| **Team memory 分层(personal vs team scope guidance via prompt)** | 写入分层不要 hard route by API,让模型自己根据 `<scope>` 提示判断走哪条。**写入界面统一,scope 由 prompt 引导** |
| **autoDream 4-phase consolidation prompt** | 蒸馏 prompt 是 universal pattern:orient → gather → consolidate → prune。具体内容随业务调,结构通用 |
| **三 scope(user/project/local)agent memory** | 后端可能只需要 user/project,local 是 CLI 场景特有。但 snapshot 传播机制 user-scope 也用得上 |
| **per-session vs cross-session 双轨写入** | autoDream 24h 巩固对短 session 后端不适用;但"批处理 + lock 互斥"的 pattern 可以做成 cron job |
| **PathTraversalError 多向量防御** | 我们的 web 后端用户输入路径少,但**SDK 嵌入场景**用户可能传任意 key,这套 sanitization 直接抄 |

### 10.3 不要抄(CLI/Ink 特有)

- DreamTask 在 footer pill 显示——CLI UI 特有,后端通过事件流上报就行
- `editFileInEditor` 调 $EDITOR——CLI 用户特有,web 直接给编辑器组件
- `setAppState` setter pattern — React state propagation,后端用 event bus
- KAIROS 助理模式 daily-log——除非你也做"perpetual session",否则不适用
- `findCanonicalGitRoot` 解决 worktree 共享——你的会话不通过 git tracking 时不需要
- `tengu_*` GrowthBook flag——你有自己的实验框架就用自己的

### 10.4 三个不能"抄走就能用"的核心 idea

整理完发现有三个 idea 即使抄走概念也得自己实现:

#### Idea 1: **"模型当下决策写"+"后台兜底"双层写入**

- **不要指望模型每次都记得存**——主 agent 在生产里 95% turn 该存的没存
- 加一层 background agent 在 turn 末扫描,主 agent 漏的 fallback 抽取
- 协调机制:**主 agent 已写过的 message range,background skip**(message 扫描即可,不需要新字段)

#### Idea 2: **prefetch + Disposable 的 turn 时机利用**

- turn 起手就 fire 一个长 promise(memory search / skill discovery / 任何上游推断),consume 在 turn 末
- model streaming 的时间是免费的——把 prefetch 跑在那段时间里,prompt 写到 model 看到的时差就是 prefetch latency 的覆盖窗
- `Symbol.dispose` 让 cleanup 集中,各 return 点不用各自 abort
- telemetry 加 `hidden_by_first_iteration` 看 prefetch 是否在 stream 完之前就 done(决定要不要继续做这个 prefetch)

#### Idea 3: **scope 语义放在 prompt 里,不放在 API 里**

- 不要做 `POST /memory?scope=team` 这种 hard route
- 给模型一个统一写入 API(直接 FileWrite),目录分层(personal/team)
- 在 system_prompt 里告诉模型 4 type 各自的 `<scope>` 倾向 + 冲突解决规则
- 让模型自己决定写哪——它有语义理解,你的 API 没

---

## 11. 一句话总结 Phase 3

> **Claude Code 的 memory 不是"一个 KV store",而是"5 类写入路径 × 3 类读出消费点 × 3 层 scope" 的笛卡尔积,通过 closed taxonomy / eval-driven prompt / prefetch + Disposable / lock-as-timestamp / snapshot propagation / cohort-gated A/B 等设计,在"模型当下记不住"的根本约束下,用"主 agent 写 → background 兜底 → cross-session 巩固"三层兜底保证长期 memory 真的能积累。**

后端服务最值得偷的三个东西:
1. **`loadMemoryPrompt → string | null` 单入口 + 5 步优先级链**——一个函数管所有 memory 注入决策
2. **prefetch + `using` Symbol.dispose + 三层 dedup**——长会话 sideQuery 资源的标准模式
3. **主 agent 当下写 + background turn-end 抽取兜底**——单层永远漏,双层才稳

---

