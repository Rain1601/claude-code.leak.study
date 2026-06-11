# Phase 1 问答索引

> 配套阅读:[../phase1-agent-loop.md](../phase1-agent-loop.md)
>
> 这份索引列出针对 Phase 1 笔记的所有问答。每个问题独立成文件(`qaNN.<主题>.md`),方便单独查阅、链接、增删。

## 问答列表

| # | 主题 | 一句话回答 |
|---|---|---|
| [01](./qa01.processUserInput.md) | `processUserInput` 是做什么的?slash 命令 / 附件展开 / 模型覆盖分别是什么? | 用户裸输入 → agent loop 可消费消息数组的总入口;slash = `/xxx` 命令分本地态和 prompt 态;附件 = `@file` 等结构化展开;模型覆盖 = 命令 frontmatter 单轮切模型 |
| [02](./qa02.systemInit.md) | `system_init` 消息是 system_prompt 加工后的最终 prompt 吗? | **不是**。`system_init` 是给客户端 UI 的元数据帧,`system_prompt` 是给 LLM 的指令文本,两条独立通道 |
| [03](./qa03.systemInitFields.md) | `system_init` 是不是就是 mcp / tools / skills 这些"工具组"? | 工具组只是其中一类,完整三类:**能力清单 + 运行环境 + 会话策略** |
| [04](./qa04.memoryMechanicsPrompt.md) | `memoryMechanicsPrompt` 是什么?为什么记忆里会有 prompt? | 名字误导——它是**记忆系统的"使用说明书"**,不是记忆内容;说明书静态走 system_prompt 吃 cache,内容动态走 user context |
| [05](./qa05.memoryMechanicsPromptExample.md) | 给一个 `memoryMechanicsPrompt` 的真实例子? | 完整真实输出 + 段落 ⇄ 源码对照表 + 几个有趣的"工程刻痕"(位置敏感、eval 历史、故意不 DRY 等) |
| [06](./qa06.submitMessageIsNotPromptBuilder.md) | `submitMessage` 那块是"构建提示词后 call LLM"吗? | **不对**。它是 turn 的"启动器/总线",不直接 call LLM;一次 submitMessage = 一个 turn = N 次 LLM call;没有"最终提示词"对象,system+messages 始终分两条轴 |
| [07](./qa07.preprocessingPipeline.md) | `query()` 里的预处理流水线具体怎么走? | 5 层 + 闸门:`applyToolResultBudget → snip → microcompact → contextCollapse → autocompact → blocking_limit`,**代价从低到高**,前面够用就别动后面;每次 callModel 前都跑一遍 |
| [08](./qa08.toolInventory.md) | Claude Code 总共有多少 tool?先归类 | **没有固定数字**:本仓库 ~44 个工具入口、完整代码库 ≥ 57 个、运行时实际暴露 20-30 个。按功能/可见性/语义角色三种分类法在文档里;Phase 2 主菜从这里继续 |

## 新增问答约定

新建文件命名:`qaNN.<驼峰主题>.md`(NN 两位数,继续上一编号)。

每个文件结构:

```markdown
# QN. <问题原文>

> 配套阅读:[../phase1-agent-loop.md](../phase1-agent-loop.md) · [索引](./question.md)
>
> **提问背景**:<引用笔记的哪一节或哪一句>

## 回答

<答案正文>

## 对照源码

- `src/xxx.ts:行号` — 说明
- ...

## 对我们后端的启示(可选)

| Claude Code 做法 | 后端可借鉴 |
|---|---|
| ... | ... |
```

新建完成后,记得在上面的"问答列表"表格里追加一行。
