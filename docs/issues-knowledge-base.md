# Issues: 文档知识库 — Tracer Bullet Vertical Slices

> **Parent PRD**: [docs/prd-knowledge-base.md](./prd-knowledge-base.md)
>
> **Parent ADR**: [ADR 0021: anydoc 文档知识库](./adr/0021-anydoc-document-knowledge-base.md)
>
> **Glossary**: [术语表](../CONTEXT.md)（知识库域）
>
> **UI 原型**: [knowledge-base.html](./prototypes/knowledge-base.html)
>
> 7 个垂直切片（tracer bullet），每个切片贯穿所有集成层（转换引擎 → 主进程服务 → tRPC API / Host Tools → 渲染端 UI → 测试），完成后可独立演示。
>
> Issues 按依赖顺序排列（blocker 在前）。#1 与 #2 无互相依赖，可并行。
>
> **Triage label**: `ready-for-agent`

---

## Issue #1: anydoc 依赖接入 + Conversion 服务

### Parent

[PRD: 文档知识库](./prd-knowledge-base.md)

### Triage

`ready-for-agent`

### What to build

建立知识库的转换基础：anydoc npm 依赖接入与 Conversion 服务。`npm install @firecrawl/anydoc` 作为应用依赖（版本随 package.json 锁定），electron-builder 配置 `asarUnpack: ["**/*.node"]` 解包原生模块，确保打包后主进程能正确加载（NAPI ABI 稳定，无需 electron-rebuild）。

新增 `src/main/kb/converter.ts` 封装转换核心：调用 anydoc 的 `toDocument()` 获取 document model（Markdown + assets 字节），把 assets 按出现顺序写入目标目录（`docs/assets/<文档名>/image-NNN.<ext>`，扩展名由 media type 推断），并将 Markdown 内图片占位替换为相对路径链接。错误处理透传 anydoc 的 `ConvertErrorCode` 联合（`unsupported` / `malformed` / `encrypted` / `resourceLimit` / `missingPart` / `io`），映射为带用户可读信息的 KBConvertError（如扫描版 PDF → "unsupported · 扫描版 PDF 无文字层，需 OCR（不支持）"）。

提供同名覆盖清理逻辑：转换前清理该文档旧的 Markdown 与旧 assets 目录，保证重转不留孤儿文件。

端到端路径：主进程调用 `convertDocument(sourcePath, docsDir)` → anydoc 转换 → Markdown 落盘 + 图片落盘 + 链接就绪 → 返回 `{ markdownPath, assetCount }` 或结构化错误。

### Acceptance criteria

- [ ] `@firecrawl/anydoc` 出现在 package.json dependencies，版本锁定
- [ ] electron-builder 配置 asarUnpack 解包 `**/*.node`，打包后可加载
- [ ] 转换成功路径：Markdown 落盘、图片按序落盘、md 内链接替换为相对路径
- [ ] 六种错误码透传为结构化错误（code + 用户可读信息）
- [ ] 同名覆盖：重转前清理旧 Markdown 与旧 assets
- [ ] `tests/kb-converter.test.ts` mock `@firecrawl/anydoc` NAPI 边界，覆盖上述全部行为（不真实调用原生模块）
- [ ] 附带 1-2 个真实小文档（tiny docx/csv）的冒烟测试（anydoc 纯本地毫秒级，验证 ABI 可用性）
- [ ] `npm run build && npm run typecheck && npm run test && npm run lint` 全部通过

### Blocked by

None — can start immediately.

---

## Issue #2: KB Registration + Mount + kb-router 最小闭环

### Parent

[PRD: 文档知识库](./prd-knowledge-base.md)

### Triage

`ready-for-agent`

### What to build

建立知识库的注册与挂载骨架。新增 `src/main/kb/types.ts`（KnowledgeBase 描述、挂载关系、文档状态等类型）与 `src/main/kb/registry.ts`：KB Registration 存应用全局配置（注册表：库名 + 绝对路径），注册空目录时初始化标准结构（`sources/`、`docs/`、`index.md` 空骨架）；注册已有目录时校验结构兼容（存在 sources/ 与 docs/ 即认可为知识库）。KB Mount 存项目配置，v1 挂载数量上限 1，数据结构用列表预留多库。注销库前校验未被挂载。

新增 `src/main/ipc/routers/kb-router.ts` 并在 `src/main/ipc/router.ts` 注册为 `kb: kbRouter`。procedure（inline input validator，非 zod）：`kb.list`（已注册库列表 + 每库文档数/分类数统计）、`kb.register`、`kb.unregister`、`kb.mount`（项目级）、`kb.unmount`、`kb.status`（当前挂载库 + 结构健康检查）。

端到端路径：渲染端 `trpc.kb.register.query({ name, path })` → 主进程初始化目录结构 → 写入全局注册表 → `kb.list` 返回新库。

### Acceptance criteria

- [ ] 注册空目录自动创建 `sources/`、`docs/`、`index.md` 骨架
- [ ] 注册已有结构目录通过兼容校验，不破坏既有内容
- [ ] 注册/注销/列表/挂载/卸载/状态全部 procedure 可用，输入校验完整
- [ ] 挂载关系持久化到项目配置，重开应用后保持
- [ ] v1 挂载第二个库被拒绝并返回明确错误
- [ ] 已挂载的库不可注销（先卸载提示）
- [ ] `tests/kb-router.test.ts` 覆盖全部 procedure 成功/失败路径（mock registry 存储，参照 dashboard-router 测试模式）
- [ ] `npm run build && npm run typecheck && npm run test && npm run lint` 全部通过

### Blocked by

None — can start immediately.

---

## Issue #3: 上传-转换-分类-索引流水线

### Parent

[PRD: 文档知识库](./prd-knowledge-base.md)

### Triage

`ready-for-agent`

### What to build

打通知识库核心流水线：上传 → Conversion → Auto Classification + Fast Reindex → index.md 增量合并。

新增 `src/main/kb/indexer.ts`：LLM 调用复用应用已配置的 openai-compatible 直连端点，输入为文档骨架（标题层级 + 前若干行，非全文），单次调用产出该文档的分类归属（从现有分类体系选择或建议新分类，冷启动时建议顶层体系）、标题、一句话摘要、关键词；LLM 失败时降级为占位条目（标题 + 路径，摘要留待重试），不阻塞上传。index.md 增量合并为纯函数：新条目插入对应分类节、旧条目更新、删除条目移除，保持人可读 Markdown 格式。

扩展 kb-router：`kb.upload`（文件路径列表 → 复制入 sources/ → Issue #1 转换 → LLM 分类索引 → 移入 `docs/<分类>/` → 合并 index.md）、`kb.documents`（文档列表：名称/分类/大小/状态/错误码）、`kb.delete`（源文件 + Markdown + assets + 索引条目一并清理）、`kb.retry`（重试失败转换）、`kb.categories`（分类树 + 计数）。同名上传覆盖：以 sources/ 文件名为键，覆盖后自动重走完整流水线。

状态与进度通过原生 IPC 推送（`webContents.send` + eventBridge，项目惯例；preload 新增 `kb:*` 通道）：文档状态变化（queued/converting/classifying/done/failed + errorCode）实时通知渲染端。

端到端路径：拖拽 docx 入库 → sources/ 副本 → Markdown + 图片落盘 → 分类目录归位 → index.md 出现摘要条目 → 列表 UI 数据（Issue #5 消费）全部就绪。

### Acceptance criteria

- [ ] 上传 → sources/ 副本 → 转换 → 分类归位 → index.md 增量条目，全自动
- [ ] 单次 LLM 调用同时产出分类 + 标题 + 摘要 + 关键词
- [ ] LLM 失败降级占位条目，上传流水线不中断，事后可重试索引
- [ ] 同名覆盖触发完整重转（旧产物清理）
- [ ] 扫描版 PDF（unsupported）、加密文档（encrypted）失败可见：状态 + 错误码持久化，可重试
- [ ] 删除清理全部三类产物 + 索引条目
- [ ] `kb:*` 事件推送状态变化，preload eventBridge 通道可用
- [ ] `tests/kb-indexer.test.ts` mock LLM：骨架截取、prompt 组装、增量合并（插入/更新/移除）、降级占位
- [ ] `tests/kb-router.test.ts` 扩展覆盖 upload/documents/delete/retry/categories
- [ ] `npm run build && npm run typecheck && npm run test && npm run lint` 全部通过

### Blocked by

- Issue #1（Conversion 服务）
- Issue #2（registry 与 kb-router 骨架）

---

## Issue #4: Host Tools + 索引上下文注入

### Parent

[PRD: 文档知识库](./prd-knowledge-base.md)

### Triage

`ready-for-agent`

### What to build

把文档能力暴露给 AI Agent。新增 `src/main/host/tools/kb-tools.ts`，经 HostToolsRegistry 注册两个工具（inline input validator）：

- `doc_to_markdown(path)`：按需转换任意支持格式文档，返回 Markdown 内容字符串，**不入库、不落盘产物**（临时内容直接返回）。Agent 承接"看 word/pdf 文档"任务的决策路径。转换失败返回结构化错误（错误码可区分，Agent 能向用户解释原因）。
- `kb_search(query)`：跨挂载知识库检索。先匹配 index.md 条目（标题/摘要/关键词），再对 docs/ Markdown 全文匹配，返回匹配文档路径 + 摘要列表（限量，如前 20 条），Agent 据此决定下一步读哪个文件。

新增 `src/main/kb/searcher.ts` 实现 kb_search 的匹配逻辑（index 条目解析 + 文件扫描 + 评分排序）。

索引上下文注入：会话上下文工厂在创建会话时读取挂载库的 index.md 注入 Agent 系统上下文（与项目信息注入同层，复用现有 session-context 机制）；索引超长时截断并附加提示"索引已截断，完整检索请使用 kb_search 工具"。

工具描述（description）写清适用场景与参数格式，Agent 能自主决策何时调用。

### Acceptance criteria

- [ ] `doc_to_markdown` 注册并可调用：返回 Markdown 内容、不产生库内文件
- [ ] `doc_to_markdown` 六种错误码透传，错误信息 Agent 可读
- [ ] `kb_search` 注册并可调用：索引匹配 + 全文匹配、评分排序、限量返回路径 + 摘要
- [ ] 挂载库 index.md 在会话创建时注入 Agent 上下文；未挂载库时不注入
- [ ] 索引超长截断策略生效，截断提示引导使用 kb_search
- [ ] `tests/kb-host-tools.test.ts`：mock kb 服务层，覆盖两工具注册、参数校验、成功/失败路径
- [ ] `tests/document-host-tools.test.ts` 的工具数量断言同步更新
- [ ] `npm run build && npm run typecheck && npm run test && npm run lint` 全部通过

### Blocked by

- Issue #1（doc_to_markdown 依赖 Conversion 服务）
- Issue #2（挂载关系）
- Issue #3（kb_search 依赖 docs/ 产物与 index.md）

---

## Issue #5: 知识库 UI — 列表 Tab

### Parent

[PRD: 文档知识库](./prd-knowledge-base.md)

### Triage

`ready-for-agent`

### What to build

知识库前端主视图（对照原型 `docs/prototypes/knowledge-base.html` 列表 Tab）。LeftRail 新增"知识库"入口，workbench store 新增 `{ type: 'kb' }` destination 类型，CenterArea 分发渲染 KbView。

新增 `src/renderer/src/stores/kb.ts`（Zustand，选择器风格遵循项目惯例）：库列表/当前挂载库、分类树、文档列表、上传状态。KbView 布局：

- **库头部**：库切换器（打开注册/挂载对话框：已注册库列表 + 挂载/卸载 + 注册新库的目录选择与结构提示）、统计（文档数/分类数/索引状态）、上传按钮
- **分类树面板**：分类列表 + 计数，点击筛选文档列表
- **文档列表**：类型图标（PDF/DOC/PPT/XLS 着色）、名称 + sources→docs 路径、分类徽章、大小、状态徽章（已转换/转换中 spinner/AI 分类中/失败 + 错误码明细如"unsupported · 扫描版 PDF"）、行内操作（重试/删除）
- **拖拽上传区**：拖入即调 `kb.upload`，展示支持格式提示

订阅 `kb:*` eventBridge 事件，状态变化实时刷新列表（无需轮询）。库注册/挂载对话框按原型（含目录结构提示 `<kb>/sources/ docs/ index.md`）。

端到端路径：LeftRail 点入口 → KbView 打开 → 拖拽 docx → 列表出现"转换中" → 状态流转到"已转换" → 分类树计数 +1。

### Acceptance criteria

- [ ] LeftRail 入口 + kb destination 打开/关闭（tab 标题、图标）
- [ ] 文档列表渲染全部状态形态（已转换/转换中/AI 分类中/失败含错误码明细）
- [ ] 拖拽上传与按钮上传均触发 `kb.upload`
- [ ] 失败条目可重试、可删除；删除有确认
- [ ] 分类树筛选联动；"全部文档"项
- [ ] 库注册/挂载/卸载/切换对话框完整可用
- [ ] `kb:*` 事件驱动列表实时刷新
- [ ] 主题遵循应用 CSS 变量（浅色/深色），语义色不写死 hex
- [ ] 组件测试覆盖主要交互（UI 覆盖率 > 60%，项目惯例）
- [ ] `npm run build && npm run typecheck && npm run test && npm run lint` 全部通过

### Blocked by

- Issue #2（注册/挂载数据源）
- Issue #3（上传流水线与文档列表数据源）

---

## Issue #6: 知识库 UI — 索引 Tab + 预览 Tab

### Parent

[PRD: 文档知识库](./prd-knowledge-base.md)

### Triage

`ready-for-agent`

### What to build

补全知识库前端另两个 Tab（对照原型）。

**索引 Tab**：index.md 渲染视图（目录树 + 摘要 + 关键词标签，标题可点击跳转预览）+ 工具栏（上次 Fast Reindex 时间、条目数、手动"更新索引"按钮触发增量 reindex、编辑入口）。编辑复用现有 Markdown 编辑能力（FileEditor），保存后下次会话注入生效。附说明文案"此文件即 AI Agent 会话启动时注入的库地图"。

**预览 Tab**：文档列表点击行打开。Markdown 渲染复用现有预览组件，图片相对路径解析到 `docs/assets/`（file 读取绕过 CSP 限制，参照 officecli Screenshots 的 dataURL 模式）。右侧元信息侧栏：源文件名、分类、大小（源/md）、图片数、转换时间 + AI 摘要卡（读取 index.md 该文档条目）。

**手动改分类**：文档行（或预览侧栏）提供"移动分类"操作 → 主进程移动文件 + 更新该文档索引条目（复用 Issue #3 的合并逻辑）→ 事件刷新。

端到端路径：列表点击文档 → 预览渲染含图片与 AI 摘要 → 索引 Tab 渲染全库地图 → 编辑 index.md 保存 → 移动文档到另一分类 → 分类树与索引同步更新。

### Acceptance criteria

- [ ] 索引 Tab 渲染 index.md：分类节 + 条目（标题/路径/摘要/关键词标签），条目点击打开预览
- [ ] 手动"更新索引"按钮触发增量 Fast Reindex
- [ ] index.md 可编辑保存，编辑后内容生效
- [ ] 预览 Tab：Markdown 渲染 + 提取图片可见（相对路径解析）+ 元信息侧栏 + AI 摘要卡
- [ ] 手动改分类：文件移动 + 分类树/列表/索引三处同步
- [ ] 组件测试覆盖 Tab 切换、渲染、移动分类交互
- [ ] `npm run build && npm run typecheck && npm run test && npm run lint` 全部通过

### Blocked by

- Issue #5（KbView 外壳与列表 Tab）

---

## Issue #7: Deep Reindex（omp 会话深度重建）

### Parent

[PRD: 文档知识库](./prd-knowledge-base.md)

### Triage

`ready-for-agent`

### What to build

深度索引重建：手动触发 → 创建临时 omp Agent 会话（复用 Error Analysis Session 的会话工厂模式，独立进程、完成后销毁）→ Agent 逐文档深读 `docs/` Markdown（可分批）→ 重写每文档摘要与关键词 → 按分类体系重写完整 index.md → 原子替换（写临时文件后 rename，失败不影响原 index.md）。

会话 prompt 定义重建任务：输入现有 index.md + 文档清单，输出符合 index.md 既定格式的完整新索引。进度通过 `kb:*` 事件推送（处理到第 N/总数），UI 在索引 Tab 工具栏显示"深度重建中"状态。并发与会话生命周期遵守 SessionManager 现有管理（不长期占用并发额度）。

UI：索引 Tab 工具栏新增"深度重建"按钮（含确认提示：耗时较长），完成后 toast + 索引刷新。

端到端路径：用户点"深度重建" → 进度事件流 → index.md 被高质量重写 → 预览/注入均使用新索引。

### Acceptance criteria

- [ ] 手动触发创建临时 omp 会话，完成后会话正确销毁
- [ ] 重建产出的 index.md 符合既定格式，分类体系保持或合理演化
- [ ] 原子替换：重建失败时原 index.md 完好
- [ ] 进度事件推送，UI 显示重建中状态与完成反馈
- [ ] 会话失败（如 LLM 配置异常）返回明确错误，不破坏库
- [ ] 测试：mock 会话工厂，覆盖触发/进度/成功替换/失败保护
- [ ] `npm run build && npm run typecheck && npm run test && npm run lint` 全部通过

### Blocked by

- Issue #3（index.md 结构与合并逻辑）
- Issue #6（UI 触发入口）
