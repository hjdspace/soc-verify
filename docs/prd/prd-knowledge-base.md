# PRD: 文档知识库 — anydoc 驱动的 Markdown 知识库与 Agent 接入

> **Parent ADR**: [ADR 0021: anydoc 文档知识库](../adr/0021-anydoc-document-knowledge-base.md)
>
> **Glossary**: [术语表](../CONTEXT.md)（知识库域）
>
> **Issues**: [Issues: 文档知识库](../issues/issues-knowledge-base.md)
>
> **UI 原型**: [knowledge-base.html](../prototypes/knowledge-base.html)

## Problem Statement

SoC 验证周期内存在大量非代码文档：协议手册（AMBA/MIPI/DDR）、DUT spec、验证计划、设计评审材料，多为 pdf/docx/pptx 格式。当前平台面临以下痛点：

1. **AI 无法消费文档**：omp 引擎只能读文本文件，AI Agent 承接"看一下这个 word 文档"类任务时无路可走。验证工程师不得不手动复制粘贴文档内容给 AI，效率低且丢失结构。

2. **文档检索困难**：协议手册等文档分散在各处（本地目录、共享盘、邮件附件），工程师找"DDR5 的复位时序在哪个文档哪一章"全靠记忆和逐个翻找。

3. **提取方向能力空白**：现有 officecli 集成（ADR 0015）只覆盖 Markdown → Office（生成方向），Office → Markdown（提取方向）完全空白。两个方向不互补成对，文档无法进入 AI 可读的资产体系。

4. **内网离线约束**：SoC 验证工程师可能在内网 Linux 环境工作，文档转换能力必须纯本地运行，二进制依赖必须随包打包，不能依赖在线转换服务。

5. **文档知识无法沉淀复用**：协议手册这类跨项目复用的文档没有统一归宿，每个工程师各自维护一份，团队知识无法积累。

## Solution

集成 anydoc（firecrawl 出品，MIT，Rust + NAPI 预编译二进制，npm 分发）作为文档转换引擎，构建"多库注册、项目挂载、AI 自动分类、索引速查"的 Markdown 文档知识库体系。

**转换引擎内置**：anydoc 作为 npm 应用依赖直接打包（asarUnpack 解包 .node 原生模块），主进程函数调用（libuv 线程池，毫秒级单文档转换），完全离线可用，无下载器、无运行时回退链。

**自包含库结构**：知识库 = 用户注册的任意目录，内含 `sources/`（原始文档副本）、`docs/`（转换后 Markdown + assets 图片）、`index.md`（目录索引）。库可整体拷走、团队共享、重新转换不丢源。

**AI 自动分类与索引**：上传转换成功后，一次直连 LLM 调用完成 Auto Classification（归入分类子目录）+ Fast Reindex（生成标题/一句话摘要/关键词条目，增量合并进 index.md）。用户可拖拽改分类后重建索引；另有 Deep Reindex（omp Agent 会话逐文档深读重写摘要）作为手动触发的深度模式。

**Agent 三通道接入**：① `doc_to_markdown` Host Tool——按需转换任意文档返回 Markdown 内容（不入库），Agent 决策"看 word/pdf"任务的主路径；② `kb_search` Host Tool——跨挂载库检索（index 关键词 + 全文匹配）；③ 挂载库的 index.md 在会话创建时自动注入 Agent 上下文——Agent 零工具调用即知库内有什么。

**UI 集成**：LeftRail 新增"知识库"入口，Workbench 新 destination 类型，三 Tab（文档列表 / 库索引 / 文档预览）+ 分类树联动 + 拖拽上传 + 失败重试，风格与 Dashboard 一致。

## User Stories

### 库注册与挂载

1. 作为 SoC 验证工程师，我希望将任意目录注册为知识库，这样我的文档资产有统一归宿。
2. 作为 SoC 验证工程师，我希望注册空目录时自动初始化标准结构（sources/ docs/ index.md），这样我不需要手动建目录。
3. 作为 SoC 验证工程师，我希望在应用中注册多个知识库（如"芯片验证文档库"和"通用协议手册库"），这样项目文档和跨项目文档各归其位。
4. 作为 SoC 验证工程师，我希望在项目设置中选择挂载哪个知识库，这样不同项目可共享或隔离文档资产。
5. 作为 SoC 验证工程师，我希望知识库目录自包含可整体拷贝，这样我能与同事共享或迁移到新机器。
6. 作为 SoC 验证工程师，我希望看到库的统计信息（文档数、分类数、索引状态），这样我快速了解库的规模与健康度。

### 文档上传与转换

7. 作为 SoC 验证工程师，我希望拖拽 pdf/docx/pptx 文档到知识库界面即完成上传，这样我无需穿过文件对话框。
8. 作为 SoC 验证工程师，我希望上传的文档自动复制一份入库（Source Document），这样源文件被移动或删除后库仍可重新转换。
9. 作为 SoC 验证工程师，我希望上传后自动转换为 GitHub-Flavored Markdown，这样文档立即可被 AI 消费。
10. 作为 SoC 验证工程师，我希望文档中的嵌入图片（框图/时序图/位段图）提取入库并在 Markdown 中以相对路径引用，这样预览时图表可见。
11. 作为 SoC 验证工程师，我希望上传同名新版本文档时自动覆盖旧版并重新转换，这样库内版本始终最新。
12. 作为 SoC 验证工程师，我希望看到每个文档的转换状态（已转换/转换中/AI 分类中/失败），这样我清楚库内正在发生什么。
13. 作为 SoC 验证工程师，我希望转换失败时看到明确的错误原因（如扫描版 PDF 不支持、文档已加密），这样我知道如何补救。
14. 作为 SoC 验证工程师，我希望失败的转换可以一键重试，这样临时性问题（如文件占用）无需重新上传。
15. 作为 SoC 验证工程师，我希望删除文档时源文件与转换产物一起清理，这样库不会残留孤儿文件。

### AI 自动分类与索引

16. 作为 SoC 验证工程师，我希望新文档由 AI 自动归入合适的分类子目录（协议手册/寄存器手册/DVT 计划等），这样我不必逐个手动归类。
17. 作为 SoC 验证工程师，我希望库冷启动时 AI 根据首批文档建议顶层分类体系，这样空库不会因无分类而手足无措。
18. 作为 SoC 验证工程师，我希望可以手动把文档拖到另一分类并触发索引更新，这样 AI 分类不准确时我能纠正。
19. 作为 SoC 验证工程师，我希望每篇文档在索引中有标题、一句话摘要和关键词标签，这样我和 AI 都能快速判断文档内容。
20. 作为 SoC 验证工程师，我希望索引自动增量更新（新文档转换后即合并条目），这样我不需要记得手动刷新。
21. 作为 SoC 验证工程师，我希望索引 index.md 是人可读可编辑的 Markdown，这样我能直接修订 AI 生成的摘要。
22. 作为 SoC 验证工程师，我希望手动触发"深度重建索引"让 AI Agent 逐文档深读后重写摘要，这样重要库的索引质量更高。

### 知识库浏览与预览

23. 作为 SoC 验证工程师，我希望在知识库界面按分类树筛选文档列表，这样我按主题快速缩小范围。
24. 作为 SoC 验证工程师，我希望在平台内直接预览转换后的 Markdown（含提取的图片），这样不需要外部编辑器。
25. 作为 SoC 验证工程师，我希望预览时看到文档元信息（源文件、大小、转换时间、图片数）和 AI 摘要，这样不读全文也能掌握要点。
26. 作为 SoC 验证工程师，我希望以渲染视图查看 index.md 全貌，这样库的知识地图一目了然。

### AI Agent 接入

27. 作为 AI Agent，我希望有 doc_to_markdown 工具将任意支持格式文档转为 Markdown 返回内容，这样用户让我"看 word/pdf 文档"时我能直接承接。
28. 作为 AI Agent，我希望 doc_to_markdown 不污染知识库（按需转换不入库），这样临时性查看不会污染用户的文档资产。
29. 作为 AI Agent，我希望会话创建时挂载库的 index.md 自动注入上下文，这样我零工具调用就知道库内有什么可查。
30. 作为 AI Agent，我希望有 kb_search 工具按关键词检索挂载库（索引匹配 + 全文匹配），这样库很大索引被截断时我仍能定位文档。
31. 作为 AI Agent，我希望 kb_search 返回匹配文档的路径与摘要，这样我能决定下一步读哪个文件。
32. 作为 AI Agent，我希望知识库内的 Markdown 文档可用我自带的文件读取工具直接访问，这样速查路径最短。
33. 作为 AI Agent，我希望 doc_to_markdown 的错误信息可区分（unsupported/encrypted 等），这样我能向用户准确解释失败原因。

### 构建与离线

34. 作为项目构建者，我希望 anydoc 以 npm 依赖形式随包分发，这样不引入额外的二进制下载脚本。
35. 作为项目构建者，我希望 .node 原生模块被 asarUnpack 解包，这样打包后的应用能正确加载 anydoc。
36. 作为 SoC 验证工程师，我希望文档转换完全离线运行，这样内网环境无任何功能损失。
37. 作为项目构建者，我希望 anydoc 版本随 package.json 锁定，这样构建可重现。

## Implementation Decisions

### 转换引擎与打包

- anydoc npm 包作为应用依赖，electron-builder asarUnpack 解包 `**/*.node`；NAPI ABI 稳定，不需要 electron-rebuild。
- 主进程直接函数调用（`toDocument` / `toMarkdownBytes`），转换在 libuv 线程池执行，不阻塞事件循环，无子进程开销。
- 错误码透传 anydoc 的 `ConvertErrorCode` 联合（`unsupported` / `malformed` / `encrypted` / `resourceLimit` / `missingPart` / `io`），UI 与 Host Tool 均按错误码区分呈现。
- 图片处理走 `toDocument`：从 document model 的 assets 取图片字节（含 media type），写入 `docs/assets/<文档名>/`，Markdown 内对应位置替换为相对路径链接；asset 与 Markdown 位置按出现顺序匹配。

### 知识库模型

- **KB Registration** 存应用全局配置（注册表：库名 + 绝对路径）；**KB Mount** 存项目配置。v1 挂载数量限制为 1，数据结构与工具接口按多库设计（挂载关系是列表）。
- 库结构标准布局：`sources/`（原始副本）、`docs/`（分类子目录 + Markdown + `assets/<文档名>/`）、`index.md`。注册空目录时初始化；注册已有库时校验结构兼容。
- 同名上传覆盖策略：目标判定以 sources/ 内文件名为键，覆盖 Source Document、清理旧转换产物与旧 assets、重新走完整流水线。不做版本历史、不做文件系统 watch。
- 删除文档 = 删 Source Document + 对应 Markdown + 对应 assets 目录 + 索引条目。

### 转换-分类-索引流水线

- 上传（拖拽/选择）→ 复制入 sources/ → anydoc 转换（含图片提取）→ 单次 LLM 调用（Auto Classification + Fast Reindex：分类归属 + 标题 + 一句话摘要 + 关键词）→ 移入分类子目录 → 增量合并 index.md。
- Fast Reindex 走应用已配置的 openai-compatible 直连端点（与 error-analysis 等模块同一配置源），输入为文档骨架（标题层级 + 前若干行），非全文。
- index.md 为唯一索引载体（单文件，人机共读）；LLM 失败时降级为"无摘要占位条目"（标题 + 路径仍入索引），不阻塞上传流水线，可事后重试索引。
- 分类目录名由 LLM 从现有分类体系中选择或建议新分类（冷启动时建议顶层体系）；用户拖拽改分类 = 移动文件 + 该文档索引条目更新。
- Deep Reindex 走临时 omp Agent 会话（复用 Error Analysis Session 的会话工厂模式），逐文档深读重写摘要，手动触发，完成后原子替换 index.md。

### Host Tools 与上下文注入

- 新增两个 Host Tool，经 HostToolsRegistry 注册，inline input validator（项目惯例，非 zod）：
  - `doc_to_markdown(path)`：按需转换，返回 Markdown 内容字符串，不入库、不落盘产物。
  - `kb_search(query)`：先匹配挂载库 index.md 条目（标题/摘要/关键词），再对 docs/ 做全文匹配，返回路径 + 摘要列表（限量）。
- 索引注入：会话上下文工厂在创建会话时读取挂载库的 index.md 注入系统上下文（复用现有 session-context 机制，与项目信息注入同层）；超大索引截断并提示 Agent 改用 kb_search。
- `kb_add`（Agent 自主入库）不在 v1 范围。

### tRPC API 与 UI

- 新增 kb 子路由，procedure 覆盖：库注册/注销/列表/挂载、文档上传/列表/删除/重试、索引读取/手动更新/深度重建、文档预览读取。
- 转换进度与状态变化通过 `webContents.send` + eventBridge 原生 IPC 推送（项目惯例，tRPC subscription 不可用），通道命名 `kb:*`。
- UI：LeftRail"知识库"入口 + Workbench 新 destination（`kb` 类型）。三 Tab：文档列表（拖拽上传区 + 状态徽章 + 失败错误码 + 行内操作）、库索引（index.md 渲染 + 编辑入口）、文档预览（Markdown 渲染含图片 + 元信息侧栏 + AI 摘要）。分类树面板与列表联动筛选。
- 主题遵循应用 CSS 变量体系，原型已验证浅色/深色双主题。

## Testing Decisions

**测试哲学**：只测外部行为（procedure 输出、工具返回、文件系统副作用），不测内部实现细节；mock 外部边界（NAPI、LLM、electron），不 mock 被测模块内部。

三层测试缝（已与用户确认）：

1. **tRPC kb-router 缝**（最高缝）：mock kb 服务层（converter/indexer/registry），端到端验证每个 procedure 的输入校验、成功路径、错误降级。参照 `dashboard-router.test.ts` / `document-router.test.ts` 的既有模式。
2. **HostToolsRegistry 缝**：mock kb 服务层，验证 `doc_to_markdown` / `kb_search` 的注册、参数校验、返回结构、错误码透传。参照 `document-host-tools.test.ts`（该文件的工具数量断言需同步更新）。
3. **模块单测缝**：
   - converter：mock `@firecrawl/anydoc` NAPI 边界，纯测 assets 落盘路径规则、Markdown 链接替换、错误码映射、同名覆盖清理。
   - indexer：mock LLM 调用，纯测 prompt 组装（骨架截取）、index.md 增量合并（新条目插入/旧条目更新/删除条目移除）、LLM 失败降级占位。
   - registry：临时目录验证结构初始化、注册/挂载读写。

测试文件命名与放置沿用项目惯例（tests/ 根目录或按模块子目录）。

## Out of Scope

- **kb_add（Agent 自主入库）**：需防污染审批机制，留 v2。
- **OCR / 扫描版 PDF**：anydoc 无 OCR，明确不支持，UI 呈现错误码提示。
- **多库同时挂载**：v1 单库挂载（注册可多个，挂载一个），接口按多库预留。
- **版本历史**：同名覆盖即旧版丢弃，不保留历史版本。
- **文件系统 watch**：绕过 UI 的 sources/ 手动改动不自动感知，需手动重转。
- **向量检索 / 语义搜索**：kb_search 为关键词 + 全文匹配，向量库不在本期。
- **officecli 反向能力变更**：Markdown → Office 生成方向维持 ADR 0015 现状，不在此 PRD 内演进。

## Further Notes

- 本 PRD 由 grilling 会话 9 项决策综合而成，决策依据与被否替代方案详见 ADR 0021。
- UI 原型 `docs/prototypes/knowledge-base.html` 已按本 PRD 的三 Tab + 分类树 + 库对话框布局产出，供实施前视觉决策。
- 与 ADR 0015（officecli）的关系：officecli 管"生成"（Markdown → Office），anydoc 管"提取"（Office → Markdown），两者互补不重叠；doc-tools 的 read_document 走 officecli（结构化读取），doc_to_markdown 走 anydoc（Markdown 化），并存不冲突。
