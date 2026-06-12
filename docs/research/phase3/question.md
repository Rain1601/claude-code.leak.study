# Phase 3 问答索引 · 记忆系统(Memory)

> 研究目标:把 Claude Code 的 memory 系统拆清楚——MEMORY.md 加载、`memdir/` 各层 scope、`autoDream` 后台巩固、`AgentTool` 子 agent memory snapshot 传播。为我们 Web/API 后端 agent 服务提炼"长会话记忆怎么落地"的设计参考。
>
> **配套主笔记**:[../phase3-memory.md](../phase3-memory.md) — 已写,11 节(大图 / memdir 加载链路 / 三条 read path / autoDream / DreamTask / Agent memory + snapshot / Team memory / 5 类写入路径 / 工程刻痕 / extractMemories / 后端启示 + 一句话总结)
>
> **研究起点**:Phase 1 笔记里反复点名"Phase 3 主菜":`startRelevantMemoryPrefetch` / `nested_memory` / `relevant_memories` / `services/autoDream/` / `memdir/MEMORY.md` 注入。

## 研究路线图

按重要性排序(可调),每个会发展成一个或多个 qa 文件:

| # | 主题 | 主要问题 | 主要源码 |
|---|---|---|---|
| ① | **`loadMemoryPrompt` 三档 dispatch 的边界** | KAIROS 为什么覆盖 TEAMMEM?Cowork 注入路径 vs 默认路径选哪个?`skipIndex` flag 改变了什么? | `src/memdir/memdir.ts:419-507` |
| ② | **prefetch + Disposable 的 turn 时机** | 为什么 `using` 选这里而非 try/finally?`hidden_by_first_iteration` telemetry 揭示什么? | `src/utils/attachments.ts:2346-2424` + `src/query.ts:301-304` |
| ③ | **三层 dedup 设计** | selector 输入 / 输出 / readFileState 三层各防什么?mark-after-filter 那个 bug 怎么发现的? | `src/utils/attachments.ts:2226-2541` |
| ④ | **autoDream 4 道门 + lock 一物多用** | mtime IS lastConsolidatedAt 的好处与坑?60min stale + PID 检测有什么 corner case? | `src/services/autoDream/autoDream.ts:95-189` + `consolidationLock.ts:1-140` |
| ⑤ | **fork agent 继承父 cache** | `createCacheSafeParams` 怎么避免 prompt cache 重建?哪些字段必须一致? | `src/services/autoDream/autoDream.ts:224-228` + `src/utils/forkedAgent.ts` |
| ⑥ | **Agent memory snapshot 3-action 决策表** | initialize vs prompt-update vs none 的边界?markSnapshotSynced 静音是什么用例? | `src/tools/AgentTool/agentMemorySnapshot.ts:98-197` |
| ⑦ | **Team memory 双段路径校验** | resolve-then-realpath 的 ordering 必要性?dangling symlink 为什么 throw 而不 silent skip? | `src/memdir/teamMemPaths.ts:109-256` |
| ⑧ | **4 type taxonomy 的封闭设计** | 为什么不允许用户起新 type?eval 怎么决定的"Before recommending" 段标题? | `src/memdir/memoryTypes.ts:14-256` |
| ⑨ | **5 类写入路径的协调机制** | extractMemories 怎么用 `hasMemoryWritesSince` 协调主 agent?为什么 KAIROS 不和 TEAMMEM 并存? | `src/services/extractMemories/extractMemories.ts` + `src/memdir/memdir.ts:427-431` |
| ⑩ | **prompt cache 友好的"daily mutable"设计** | `header` pre-compute + date_change attachment 怎么让 system_prompt 跨午夜不破 cache? | `src/utils/attachments.ts:504-514` + `src/memdir/memdir.ts:329-334` |

> 上面顺序不强制,你提问的方向决定我先深入哪条线。

## 问答列表

(待添加 — 主笔记写完后按上面路线图开始)

## 新增问答约定

延续 Phase 1/2 的约定:

- 文件命名:`qaNN.<驼峰主题>.md`(NN 两位数,自 01 起)
- 文件结构:`提问背景 → 回答 → 对照源码 → 对我们后端的启示(可选)`
- 新建完成后,记得在上面"问答列表"追加一行

## 相关参考(跨阶段)

- [../phase3-memory.md](../phase3-memory.md) — **Phase 3 主笔记**(记忆系统)
- [../phase2-tool-system.md](../phase2-tool-system.md) — Phase 2 主笔记(工具系统)
- [../phase2-context-compaction.md](../phase2-context-compaction.md) — Phase 2 主笔记(上下文压缩)
- [../phase1-agent-loop.md](../phase1-agent-loop.md) — Phase 1 主笔记(agent loop 骨架)
- [../phase1/qa04.memoryMechanicsPrompt.md](../phase1/qa04.memoryMechanicsPrompt.md) — `memoryMechanicsPrompt` 的"使用说明书"角色(Phase 3 主笔记 §1.2 深化)
- [../phase1/qa07.preprocessingPipeline.md](../phase1/qa07.preprocessingPipeline.md) — 预处理流水线(包含 startRelevantMemoryPrefetch 的位置)
