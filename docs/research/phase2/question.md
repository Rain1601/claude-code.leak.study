# Phase 2 问答索引 · 工具系统设计

> 研究目标:把 Claude Code 的工具系统(`Tool` 接口、`getTools` 注册表、`runToolUse` 执行脚手架、`StreamingToolExecutor`、MCP 集成、Skill 系统、ToolSearch 按需加载、TaskV2 拆分)摸清楚,为我们 Web/API 后端 agent 服务提炼可借鉴设计。
>
> **配套主笔记**:[../phase2-tool-system.md](../phase2-tool-system.md) — 已写,10 节(大图 / Tool 接口规约 / 注册表 / 工具来源 / 执行脚手架 / 流式 vs batch / 权限链 / ToolSearch / 设计要点 / 后端启示)。本索引里的 Q&A 是对它的深化追问。
>
> **研究起点**:[../phase1/qa08.toolInventory.md](../phase1/qa08.toolInventory.md) — 工具盘点(44 个工具入口、12 大功能类、按角色分层)

## 研究路线图

按重要性排序(可调),每个会发展成一个或多个 qa 文件:

| # | 主题 | 主要问题 | 主要源码 |
|---|---|---|---|
| ① | **Tool 接口规约**(Phase 1 笔记第 1 节深化) | 每个字段在 44 个工具里的实际用法,典型实现 | `src/Tool.ts`、`src/tools/<X>Tool/<X>Tool.ts` |
| ② | **`isConcurrencySafe` / `isReadOnly` / `isDestructive` 的实际分布** | 谁声明什么、为什么、边界情况 | 各工具实现 |
| ③ | **`runToolUse` 执行脚手架**(Phase 1 留白) | hook 顺序、错误捕获、结果包装、`contextModifier` 触发时机 | `src/services/tools/toolExecution.ts` |
| ④ | **`StreamingToolExecutor`**(Phase 1 留白) | 模型还在 stream 就开始执行的真实机制 | `src/services/tools/StreamingToolExecutor.ts` |
| ⑤ | **MCP 集成** | server 发现、工具动态注入、auth/elicitation/resource、prompt cache 友好的合并顺序 | `src/services/mcp/*` |
| ⑥ | **Skill 系统** | bundled vs user skill、SkillTool 怎么中转 | `src/skills/*`、`src/tools/SkillTool/` |
| ⑦ | **ToolSearch / deferred tools** | schema 按需加载的协议设计;阈值;模型怎么发现 | `src/tools/ToolSearchTool/`、`src/utils/toolSearch.ts` |
| ⑧ | **TaskV2(5 个 CRUD)的拆分动机** | 为什么从 `TodoWrite` 一刀切拆成 Create/Get/Update/List/Stop+Output | `src/tools/TaskCreateTool/` 等 |
| ⑨ | **权限链**(`canUseTool` / `validateInput` / `checkPermissions`) | 三步检查的语义差,handler 路由 | `src/Tool.ts` + `src/hooks/useCanUseTool.tsx` + `src/hooks/toolPermission/` |

> 上面顺序不强制,你提问的方向决定我先深入哪条线。

## 问答列表

| # | 主题 | 一句话回答 |
|---|---|---|
| [01](./qa01.multipleToolsHandling.md) | 一次多个 tools 怎么调度? | 模型一轮发多 `tool_use`,Claude Code 按工具自报的 `isConcurrencySafe(input)` **保顺序切段**,read-only 段并发(默认上限 10)、非 read-only 段独占串行;另有 `StreamingToolExecutor` 让模型还在 stream 时就开跑 |
| [02](./qa02.perRequestOptimization.md) | 请求模型前有优化函数吗? | **没有单一函数,是 `query()` 每圈 ~10 个有序阶段**:消息压缩 5 层 → `assembleToolPool` cache-friendly 排序 → ToolSearch 过滤 schema → system_prompt 拼装 → 模型切换 → callModel → withhold-then-recover 自愈;成本递增、cache 严守 |

## 新增问答约定

延续 Phase 1 的约定:

- 文件命名:`qaNN.<驼峰主题>.md`(NN 两位数,自 01 起)
- 文件结构:`提问背景 → 回答 → 对照源码 → 对我们后端的启示(可选)`
- 新建完成后,记得在上面"问答列表"追加一行

## 相关参考(跨阶段)

- [../phase2-tool-system.md](../phase2-tool-system.md) — **Phase 2 主笔记**(工具系统设计)
- [../phase1-agent-loop.md](../phase1-agent-loop.md) — Phase 1 主笔记(agent loop 骨架)
- [../phase1/qa08.toolInventory.md](../phase1/qa08.toolInventory.md) — 工具盘点(Phase 2 入口)
- [../phase1/question.md](../phase1/question.md) — Phase 1 问答索引
