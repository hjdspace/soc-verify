# ADR 0034: 知识库重构为 LLM Wiki 双层架构

## 状态

Accepted（原决策）；2026-09-13 源码复核修订稿，待本轮整体审定；2026-09-14 向量存储选型经实测**维持 LanceDB Node SDK**（§6），代价与缓解措施记录在 §6「向量存储选型实测」；备选 sqlite-vec 留档待条件触发。

实现规格见 [knowledge-base-llm-wiki-spec.md](../prd/knowledge-base-llm-wiki-spec.md)。

源码证据、参考提交及全部绝对路径见 [源码核查](../prd/knowledge-base-llm-wiki-source-audit.md)。本轮已确认：人工审阅后发布；本期图片提取 + AI 读图；保留被已发布页、页面历史或待审阅变更引用的旧版原件；支持用户主动保存问答为 query 页并审阅后发布。修订稿不构成对应用代码的实施指令。

## 背景

ADR 0021 交付的知识库实现了「文档可被 AI 消费」这一目标：anydoc 本地转换、单库挂载、index.md 注入、`kb_search` 检索。但它的知识模型是**文档仓库**——每篇文档转换出一个全文 Markdown、由 LLM 打上分类/摘要/关键词后归入 `docs/<分类>/`，知识在 ingest 时就停止了加工。

参照 `D:\AI\llm_wiki`（Tauri + React，实现 Karpathy 的 LLM Wiki 模式）后确认：双方索引都有导航作用，但差距还包括来源身份、长文档处理、图片理解、更新撤回、检索与知识维护，不能仅增加中间目录。参考代码基线为 `e8082119649e6a8e1cf85eaf289adcabfdf39d4e`，具体证据见源码核查。

LLM Wiki 的核心命题是知识**编译一次并保持最新**，而非每次提问重新检索拼装：

> the wiki is a persistent, compounding artifact. The cross-references are already there. The contradictions have already been flagged.

本次重构保留本地文档转换能力，重新组织原始层并新增编译层，借鉴参考实现的处理机制。库自包含、可整体拷贝、本地转换不上传原件三条约束不变；编译、视觉解读和嵌入需要用户配置的可达模型端点，不能将本地转换误写为所有 AI 能力均可离线运行。

## 决策

### 1. 两层架构，分别保护原始证据和已审阅知识

知识库由两个层构成，这个 split 的价值不在于目录名，而在于它编码的不变量：

- **Raw Layer** — 来源原件及其机械转换产物。原件与被引用的历史修订是需保护的证据；仅在对应原件仍在时，parsed 与提取图片才可重新转换，不能整体清理 raw。
- **Wiki Layer** — 经人工审阅发布的知识页和应用聚合页。知识页可重新生成，但无法保证重现原先的措辞、取舍和审批结果；日志记录不可重建，索引与汇总可以重建。

```
<kb>/
├── raw/                        # Raw Layer
│   ├── sources/                # 各来源当前原件；同路径上传产生新修订
│   ├── revisions/<sourceId>/<revision>/ # 被引用的旧版原件与转换证据
│   ├── parsed/                 # Parsed Markdown，镜像 sources 结构（report.pdf.md）
│   └── assets/<sourceId>/<revision>/ # 提取图/页面渲染图与定位清单
├── wiki/                       # 已发布知识；应用提交经审阅的 LLM 提案
│   ├── sources/                # Source Page
│   ├── entities/ concepts/ comparisons/ synthesis/ queries/
│   ├── pitfalls/ interfaces/   # SoC 扩展类型
│   ├── index.md                # KB Index，应用聚合生成
│   ├── log.md                  # Wiki Log，应用确定性 append
│   └── overview.md
├── schema.md                   # Wiki Schema：Page Types 路由表 + 写作约定
├── purpose.md                  # 知识库目标与范围
└── .kb/                        # 应用状态；不能整体当缓存删除
    ├── manifest.json           # 库身份、来源修订清单与已发布 revision
    ├── vectors/                # LanceDB 向量索引
    ├── staging/<taskId>/       # 编译暂存区
    ├── page-history/           # 需保护的页面历史快照
    ├── reviews/                # 需保护的审阅选择与知识待办处置
    ├── transactions/           # 未完成发布的恢复日志
    ├── vision/                 # 待用图像解读；发布采用的内容进入知识页/历史
    ├── ingest-queue.json       # 持久化队列
    └── compile-cache.json      # 源内容 SHA256 增量缓存
```

`raw/parsed/` 采用 llm_wiki 的命名（[parsedMarkdownOutputPath](D:/AI/llm_wiki/src/lib/parsed-source-output.ts:39)），目录结构严格镜像 `raw/sources/`，文件名保留原扩展名以避免 `report.pdf` / `report.docx` / 用户自写 `report.md` 撞名。llm_wiki 把该输出做成可选开关 `persistExtractedMarkdown`（默认关）；本重构**常开**，因为 Raw Layer 还要服务 `kb_search` 的全文检索与用户预览。

`schema.md` 与 `purpose.md` 位于库根（对齐 llm_wiki 的 `${pp}/schema.md`），不在 `wiki/` 内。KB Registration 与 KB Mount 的配置位置不变（应用全局 + 项目配置）。

### 2. 页面类型：通用六类 + SoC 扩展两类

`source`、`entity`、`concept`、`comparison`、`synthesis`、`query` 取自 llm_wiki，加两类 SoC 专属：`pitfall`（现象→根因→规避→证据）、`interface`（信号表/位段/接口时序）。

扩展刻意收敛到两类：类型一多，LLM 分类判断就会漂移，同一概念在不同 ingest 里落到不同目录会产生重复页与悬空链接，修复成本远高于多一类页面的收益。协议规则类知识由 `concept` 承载够用。

`schema.md` 的 `## Page Types` 表格是**机器可执行的约束**而非说明文档：应用解析成 `type → 目录` 路由表，LLM 写入时校验路径与 type 是否匹配（参照 [wiki-schema.ts](D:/AI/llm_wiki/src/lib/wiki-schema.ts) 的 `parseWikiSchemaRouting` / `validateWikiPageRouting`）。

### 3. Wiki 写权限：LLM 独占，人只审阅

LLM 生成知识页提案，应用负责校验和提交；用户只能阅读预览并在统一审阅入口接受/拒绝改动。索引、日志、汇总始终由应用维护。“LLM 独占写作”不是允许模型直接写正式目录。

理由：不提供自由正文编辑可以收敛写作入口，但无法消除并发编译、审阅等待与外部文件修改产生的冲突。每份提案仍需保存页面基线；提交时比对当前哈希，变化则重新生成差异并撤销旧审批，不能覆盖用户尚未看过的结果。

### 4. 编译驱动：直连 LLM 的两段式调用 + 持久化队列

Wiki Compile **不是 Agent 会话**，而是直连 LLM 的流式调用 + 自研文本块协议，对齐 llm_wiki：

- **结构化分析 → 页面生成**：参考 [buildAnalysisPrompt](D:/AI/llm_wiki/src/lib/ingest.ts:2165) 明确禁止输出隐藏思维链，要求简洁分析结果。温度在模型支持时设 0.1，不承诺确定性。FILE 块避免巨型 JSON 的转义负担，但仍会截断，必须检查流终止原因与块完整性。长文档分段分析、修复、合并、视觉解读会增加调用次数。
- **解析边界做路径沙箱**：LLM 生成路径必须落在 `wiki/` 下，拒绝绝对路径、`..`、Windows 保留名（[isSafeIngestPath](D:/AI/llm_wiki/src/lib/ingest.ts:394)）。源文档可能注入伪造的 FILE 标记，这道校验是安全边界。
- **持久化队列 + 有限并发 worker**：导入即自动入队，重试与重新导入走同一条路径（llm_wiki 已删除早期那条「开交互式 chat → 用户点 Save to Wiki」的重复实现，见 [handleIngest](D:/AI/llm_wiki/src/components/sources/sources-view.tsx:359) 注释）。队列支持暂停/恢复/重试/取消/重排。
- **增量缓存**：来源修订、转换/视觉产物、schema/purpose、编译配置与实际依赖页参与指纹；只有已成功发布且产出仍有效才允许跳过。待审阅和已拒绝提案不得冒充已编译成功；显式强制重编译绕过缓存。

**后果**：现有的 `Deep Reindex`（起 pi 会话深读重写 index.md，`src/main/kb/deep-reindexer.ts`）失去位置——index.md 不再由模型整份重写。该模块退役。

### 5. 聚合页分层治理

不让模型重写聚合页，但也不放弃语义索引能力——拆开：**LLM 写页面元数据，应用聚合索引**。

| 文件 | 归属 | 机制 |
| --- | --- | --- |
| `log.md` | 应用确定性 | append-only，固定前缀 `## [日期] ingest \| <来源>`，可 grep |
| `index.md` | 应用聚合 | 从各 Wiki Page 的 frontmatter（title / 摘要 / 关键词 / 类型 / 标签）生成；成员完整性与顺序由应用保证，不允许漏登页（不等于图中无孤儿） |
| `overview.md` | 应用聚合 | 同上，跨类型汇总视图 |

这保留了现有 `indexer.ts` 的摘要/关键词能力（LLM 把它们写进页面 frontmatter），同时消除模型重写整份索引导致的截断、漏项与顺序漂移。llm_wiki 的 `updateWikiIndexDeterministically`（[ingest.ts](D:/AI/llm_wiki/src/lib/ingest.ts:1572)）证明了混合模式可行：它由应用判定漏登页面并追加有界区块，标题取自页面的 `frontmatter.title`。

### 6. 检索：导航注入 + 混合召回 + 图扩展

| 信号 | 实现 |
| --- | --- |
| 索引导航 | 会话创建时有界注入类型骨架、计数与有限页面清单；不是参与 RRF 的排名列表 |
| 关键词 | 元数据匹配与正文匹配先合为一个排名，保留中文 bigram 与精确工程符号匹配；涵盖已发布 Wiki Page 与可用 Parsed Markdown |
| 图扩展 | 解析 `[[wikilink]]` 构建邻接表，对 top 结果做一跳扩展补召回 |
| 向量 | Node SDK 维持 `@lancedb/lancedb`（2026-09-14 实测确认）：单平台原生库 290.7MB 属已接受的已知代价，约 313MB 无用可选依赖必须按 §6 剔除；参考使用 Rust SDK，其尺度结论不可迁移到 Node 预编译产物；embedding 走用户配置端点 |

关键词和向量两路采用 RRF（k=60），然后为 wiki 一跳图邻居预留名额；这是 [search.rs](D:/AI/llm_wiki/src-tauri/src/commands/search.rs:484) 实际机制。不让元数据与正文重复计票。embedding 分块保持表格、代码块完整，超端点上限的原子块保留全文检索并报告向量未覆盖，不悄悄截短冒充完整嵌入。具体排序与返回契约见 spec。

**降级**：嵌入能力不可用时保留关键词 + 图扩展和导航注入，UI 按库/配置提示一次。401/403、模型不存在、限流与网络故障应分别报告，不能全部缓存为“不支持”。原生 SDK 无法加载属于发布 spike 失败，不与正常端点降级混同。

#### 向量存储选型实测（2026-09-14，issue 21）

2026-09-14 对 `@lancedb/lancedb@0.38.0` 与备选 `sqlite-vec@0.1.9` 做了同口径实测（开发/打包 Electron 下的 CRUD、重开、整页替换、asar 路径、能力边界与性能）。**结论：维持 `@lancedb/lancedb`**，接受原生库体积代价，并按下述措施压缩实际影响；备选实测数据留档，供条件触发时复用。

| 项 | `@lancedb/lancedb@0.38.0` | `sqlite-vec@0.1.9` |
| --- | --- | --- |
| 平台原生包（win-x64） | **290.7 MB** | **0.28 MB** |
| 安装包数 | 109 个（其中约 313 MB 是 lancedb 自带向量化用的 transformers/onnxruntime/openai，本项目 embedding 走用户端点、用不到） | 1 个，0 依赖 |
| ABI 面 | Node addon（N-API 10），需 asarUnpack | **零**：SQLite 扩展，由项目已装的 better-sqlite3 加载 |
| 发布平台 | 缺 darwin-x64 | 5 个平台全备，含 darwin-x64 |
| 许可证 | Apache-2.0 | MIT OR Apache |
| 维护活跃度 | 0.38.0（2026-08-31），持续发版 | 0.1.9（2026-03-31），约 4 个月无发布 |
| 20k×1024 写入 | 609 ms（32.8k 行/s） | 8.4 s（2.4k 行/s） |
| 20k×1024 查询 k=20 | 49.8 ms | 76 ms（5k→20ms / 10k→46ms / 20k→96ms，线性） |
| 索引体积（20k） | 78.3 MB | 81.3 MB |

已接受的代价与强制缓解措施：

1. **约 313 MB 无用可选依赖必须剔除（强制）**：lancedb 的 `optionalDependencies` 带 `@huggingface/transformers` + `onnxruntime-node`/`web` + `openai`（合计约 313 MB），仅供它自带的向量化子路径使用；本项目 embedding 走用户端点，**从不 import `lancedb/embedding/*`**。剔除方式：electron-builder `files` 排除上述三个包。实测 `--omit=optional` + 显式安装平台包可把安装树从 651.6 MB 降到 301.7 MB 且 7/7 功能断言仍全过；但**不能对本项目全局用 `--omit=optional`** —— 项目自身 `optionalDependencies` 里的 `@rollup/rollup-win32-x64-msvc`、`lightningcss-win32-x64-msvc` 是构建必需。
2. **原生库必须 asarUnpack**：产物是 `node_modules/@lancedb/lancedb-<platform>/*.node`，现有 `asarUnpack: ['**/*.node']` 已覆盖（`dist/win-unpacked` 中 `@firecrawl/anydoc-win32-x64-msvc` 为同构先例）。生效性仍需一次真实 `package:win` 复述。
3. **不需要 `@electron/rebuild`**：napi-rs 预编译 + N-API 10，实测在 dev Node 22（`NODE_MODULE_VERSION` 127）与 Electron 43 的 Node 24（148）下均可加载，区别于 node-pty/better-sqlite3 的 node-gyp 链。
4. **darwin-x64 仍是缺口**：npm 上无 `@lancedb/lancedb-darwin-x64@0.38.0`，`optionalDependencies` 也未声明，缺失是静默的（可选依赖不装不报错），而 `electron-builder.yml` 声明了 `mac: dmg`。**发布 macOS Intel 前必须先解决**（或限定 mac 构建为 arm64）。
5. 体积属**用户侧一次性成本**，不阻塞功能；若后续实测安装包体积不可接受，回到下方备选。

维持 LanceDB 的理由：参考实现同样只用它的基础能力（全仓库无 `create_index`/`IvfPq`/`distance_type`，纯 brute-force `vector_search`、无 ANN 索引），其性能与维护活跃度优势可直接继承；备选 sqlite-vec 虽体积小三个数量级，但为 pre-1.0、约 4 个月无发布，且无 ANN 出路。

**备选留档（触发重估时启用）**：`sqlite-vec@0.1.9` —— `vec0.dll` 0.28 MB、0 依赖、由项目已装的 better-sqlite3 加载（零 ABI 面）、含 darwin-x64、原生事务；代价是写入 2.4k 行/s（LanceDB 32.8k）、查询 76 ms（LanceDB 49.8 ms），且 O(N) 线性无 ANN 出路。**触发条件**：安装包体积被判定不可接受，或必须发布 macOS Intel 而 LanceDB 平台包仍缺失。

### 7. 审阅：Staging Area + 复用 Review Queue

编译产物先落 `.kb/staging/<taskId>/`，保存 before/proposed、来源修订与基线哈希。用户逐 hunk 或整页选择后，对本次关联页面的最终候选集统一校验，再发布并写 Page History。新页和 frontmatter 作为不可拆的审阅单元；不能接受引用新页 A 的变更同时拒绝 A 而不处理断链。

**为什么必须新建接入点**：当前 [diff-review.ts](D:/AI/soc-verify/src/renderer/src/stores/diff-review.ts) 根据已完成工具调用重建 before，接受表示保留磁盘内容，拒绝才执行撤销。KB 是相反的发布时机，并可位于项目目录外。共用入口和 diff 展示组件，增加 `kb-staged` 适配器及按 kbId 授权的 API；不伪造工具调用，不调用旧 `project` 拒绝接口修改暂存提案。参考实现是在锁内直接逐文件写入，既无本方案人工发布门禁，也无整批原子保证。

### 8. 文档标签取代物理分类

现有的 `Auto Classification`（LLM 决定 `docs/<分类>/`）取消。`raw/parsed/` 严格镜像 `raw/sources/`，物理位置完全由用户上传时的目录结构决定、可预测、无漂移。文档主题领域改为写入 Source Page 的 frontmatter tags，索引按类型和 pageId 确定性组织、界面支持标签筛选——筛选能力保留，但不再有重分类时的文件搬移。

### 9. 项目数据本期预留接口，二期接入

本项目差异化在于仿真日志、覆盖率树、时序违例确认记录和回归历史。pitfall 页的证据可保存 `log://` / `cov://` / `case://` 引用，但当前 [host-uris.ts](D:/AI/soc-verify/src/main/host/host-uris.ts) 的 log/case 仍是占位响应，cov 依赖项目数据服务。必须区分引用被接受、实际可解析与证据失效；不能宣称所有 URI 已可追溯全文。

本期**不**自动从仿真数据生成页面：仿真数据每次回归都在变，与文档知识（稳定、不常变）是两种更新节奏，混入同一 ingest 链路会让 wiki 页被反复重写，且日志含项目信息需脱敏。二期单独设计。

注意 `Violation Pattern`（已实现的「从历史确认记录提取 `(hier_pattern, check_pattern)` 重用模板」）本质上已是同类的知识沉淀机制，二期需与之合并而非并存两套。

### 10. 知识图谱：应用侧派生索引，驱动 Lint 与可视化

Wiki Layer 的 `[[wikilink]]` 引用关系被抽取为**知识图谱**（节点 = Wiki Page，边 = 引用），由应用维护在 `.kb/` 下、可整体重建。它是派生索引而非知识资产，因此不承载需要保护的状态。

图谱有三个消费方，因此**必须建在应用侧**，而不是做成让 Agent 每次现算的 Host Tool：

1. **检索的图扩展** — 以初筛结果为种子沿邻接表一跳扩散补召回，扩散名额按其余信号覆盖度动态分配（[blend_graph_results](D:/AI/llm_wiki/src-tauri/src/commands/search.rs:511)）
2. **Lint 的结构检查** — `orphan` / `broken-link` / `no-outlinks` 三类判定
3. **可视化** — 用户浏览知识网络

页面间的 **Relatedness** 可用直接链接 3.0、来源重叠 4.0、共同邻居（Adamic-Adar）1.5、类型亲和 1.0 作为初始参数（[graph-relevance.ts](D:/AI/llm_wiki/src/lib/graph-relevance.ts:30)），驱动相关页面面板。它不是参考 Rust 搜索图扩展的排序公式。SoC 扩展类型先用中性亲和度，待检索样例评估后调整。

**知识维护包含 Lint。** 除 Ingest（Wiki Compile）与 Query（检索），提供 **Lint** 发现潜在结构和语义问题：

- **语义 Lint**（LLM）：页面间的矛盾、被新来源取代的过时论断、重要但缺页的概念、缺失的交叉引用
- **结构 Lint**（图谱，零 LLM 成本）：孤儿页、断链、无出链页

在此之上做社区发现（Louvain）产出 **Graph Insight**：稀疏社区与桥接节点属于结构线索，不是已证实的知识盲区。结构/语义 Lint、图谱洞察与 REVIEW 项归入同一知识待办模型，和页面变更共用审阅入口；待办的“忽略/待处理/复核解决”不同于变更的“接受/拒绝/发布”。聚合页不参与知识图入度和社区统计。

**可视化采用力导向图**（sigma.js + graphology + ForceAtlas2 + Louvain，与 llm_wiki 同源），支持按社区着色、拖拽探索、节点点击跳转页面。注意这与 Dashboard 已有的 ECharts 是两套图形栈——ECharts 服务统计图表，sigma.js 服务 WebGL 大规模网络渲染，分工明确，不做统一。

#### 图渲染选型实测（2026-09-14，issue 26）

图 UI 的技术前提是「sigma 在这种 Electron + CSP + file:// 的组合下真的能跑」。参考仓库是 Tauri + 另一套 React 版本，**不能用同版本推定**，因此按 spec §11 的口径做了实测。

**选定并钉死的精确版本**（全部 devDependencies：渲染进程由 vite 打包，不进打包后的 node_modules）：

| 包 | 版本 | 许可证 | 角色 |
| --- | --- | --- | --- |
| `sigma` | **3.0.3** | MIT | WebGL 画布 |
| `graphology` | **0.26.0** | MIT | 图数据结构 |
| `graphology-layout-forceatlas2` | **0.10.1** | MIT | 力导向布局 |
| `graphology-types` | **0.24.8** | MIT | 仅类型（peer 要求 ≥0.24） |

**不引入的两个依赖**：`@react-sigma/core`（把画布生命周期交给 React 包装层，与「切库/卸载必须显式 terminate worker 并释放 WebGL 上下文」的要求相反，且多一层 React peer 兼容面）；`graphology-communities-louvain`（社区划分由主进程图洞察拥有，renderer 只消费 `WikiCommunitySummary`，重复实现会形成第二个拥有者）。

**兼容结论（实测，非推定）**：

| 项 | 实测结果 | 证据 |
| --- | --- | --- |
| Electron / Chromium | `v43.1.0`（Chromium **150.0.7871.47**，内置 Node 24.18.0） | `electron.exe --version` + 冒烟的运行时自描述 |
| WebGL | `WebGL 2.0 (OpenGL ES 3.0 Chromium)`，ANGLE D3D11，Intel Arc | 冒烟读取 `gl.getParameter` + `WEBGL_debug_renderer_info` |
| **`file://` 下的 module worker** | **可用**（worker 内再 `import` 兄弟模块也成功）。生产 `loadFile` 加载渲染进程，这一条决定了能不能把布局放进 worker | worker-probe（`.scratch/llm-wiki/spikes/26-graph/worker-probe`）与冒烟 |
| 产品 CSP 下的 worker | 可用。harness 的 CSP 与 `src/renderer/index.html` **逐字节一致**并在冒烟里断言 | 冒烟 check「harness 使用与产品一致的 CSP」 |
| 无 CDN | 全部请求仅 `file://`；worker 脚本 URL 为本地 chunk 路径；无 CSP 拦截日志 | 冒烟拦截 `webRequest` 并断言 |
| 首个可交互画面 | 8 页 fixture **228–530 ms**；1000 页 / 9987 边 **284–340 ms**（issue 30 门禁 ≤3 s） | 冒烟指标 `metrics.firstFrameMs` |
| 卸载释放 | worker `created 1 / terminated 1`；WebGL 上下文 `created 5 / lost 5` | 冒烟 unmount 阶段断言 |

**资源路径**：布局 worker 被 vite 打成同源本地 chunk（`assets/graph-layout.worker-<hash>.js`，182.5 kB，含 graphology + ForceAtlas2）；sigma（177.4 kB）与 graphology（136.2 kB）为**独立懒加载 chunk**，图视图不进入首屏关键路径。

**实测带出的硬约束（都已修，写在这里避免后人重踩）**：

1. **sigma 默认只注册 `circle` / `point` 两种节点程序**。`nodeReducer` 返回未注册的 `type`（如 `'border'`）会在**渲染时**抛错；而渲染由 React effect 触发，异常会顺着 effect 冒泡把整个视图卸载成空白。因此桥接节点强调只能改 `color` + `highlighted`，且渲染器的每个入口都必须 try/catch 后降级到邻接列表。
2. **sigma 的鼠标 captor 在拖拽期间会阻止 `mousemove` 继续冒泡**（实测 window 上的 bubble 监听收不到）。节点拖拽的 `mousemove`/`mouseup` 监听必须挂 **capture 阶段**。
3. **`downNode` 会被重复派发**。若每次都用当前坐标重置起点，「位移超过阈值才算拖拽」永远不成立，拖拽会被静默降级成点选；必须只在第一次记录起点。
4. **Tailwind v4 的自动源码探测以 vite root 为界**。冒烟 harness 的 root 是 `tests/smoke/kb-graph`，不显式 `@source` 时生成的 CSS **不含任何产品工具类**，后果是画布容器高度为 0、点选与拖拽根本无法验证。
5. **graphology / ForceAtlas2 只能存在于 worker chunk**。主线程降级路径若静态 import 它们，主 chunk 会背上约 270 kB（实测主 chunk 917 → 737 kB，gzip 158 → 133.7 kB）；降级路径改为动态 import 后二者落到独立 chunk。

**可复现入口**：`npm run smoke:kb-graph`（构建 harness → 在真实 Electron 中跑 `webgl` / `no-webgl` / `large` 三个场景 → 报告写到 `.scratch/llm-wiki/spikes/26-graph/smoke-report.json`）。harness 通过 `--harness=<目录>` 指定加载位置，因此后续发布门禁（issue 30）可以直接把它指向安装包内的资源目录复述，而不需要另写一套。

**未覆盖（明确交接）**：本次实测运行在生产构建产物 + 真实 Electron 运行时（`file://`、同款 CSP），**没有**复述 electron-builder 安装包内 `app.asar` 的加载路径；该复述属于 issue 30 的安装包门禁。

### 11. 直接替换现有实现，不做兼容与迁移

本次重构直接改写 `src/main/kb/` 的既有实现。**不保留旧代码路径、不引入产品版本分支、不做旧布局兼容**：已注册的旧结构知识库（`sources/` + `docs/` + `index.md`）不再被识别，用户需重新建库并重新上传。

不做兼容不等于删用户文件。识别为旧格式的登记可从活动列表与挂载关系移除，但应保留路径处置记录并提示重新注册新库；路径暂不可达不能判为旧格式。删除库只删除明确初始化的受管内容，未知文件阻止递归删除。内部任务协议/指纹可有格式字段，不使用产品命名版本后缀也不意味着永远无法检测损坏数据。

### 12. 来源修订、证据与可恢复发布

用户已确认保留被引用的旧版原件。同路径上传视为同一 Source Document 的新 Source Revision（原始字节 SHA256）；同名异目录/异扩展名为不同来源。替换当前原件前保存仍被引用的旧修订，原文定位与图片引用绑定修订而不是可变路径。Page History 也属于引用根，回滚不能指向已被清理的证据。

串行发布锁按库身份建立，校验读集和写集。应用使用持久提交清单、旧页快照及幂等日志：发布开始到完成期间，同库读 API 不暴露混合状态；崩溃后在开放读取前恢复或回退。普通文件系统的多次 rename 不等于事务，外部编辑器也不受应用读门禁约束。

### 13. 本期支持图片提取与 AI 读图

用户已确认本期加入视觉理解。文本仍由本地 anydoc 转换；PDF 另做本地图片提取与页面渲染兜底，以覆盖矢量时序图。优先评估项目已安装的 pdfjs 及本地 worker，不预先引入 Rust/pdfium 构建链。参考 [extract_images.rs](D:/AI/llm_wiki/src-tauri/src/commands/extract_images.rs)、[image-caption-pipeline.ts](D:/AI/llm_wiki/src/lib/image-caption-pipeline.ts)、[vision-caption.ts](D:/AI/llm_wiki/src/lib/vision-caption.ts)。

视觉模型与编译、嵌入分别配置能力和凭证引用；只向用户配置的端点发送所选图像与必要邻近文字。保留原图、页码/位置、模型解释和不确定项；精确时序值或寄存器位段不可无证据猜测。读图内容是知识提案，不混入机械 Parsed Markdown 冒充原文。缓存键包含图像字节、模型、提示与邻近上下文；失败可重试且不得伪报完整读图。

“AI 读图”不等于本期承诺通用扫描文档 OCR。纯扫描 PDF 的全文文本转换仍不支持；可保留并展示原文，但不把视觉概述当成全文转换成功。该范围及图片覆盖限制必须在 UI 可见。

### 14. 主动保存问答，闭合知识沉淀循环

用户已确认提供“保存为知识页”：选择问题和回答，保存必要消息内容与真实引用，生成 query 页提案，经同一审阅、发布、历史和索引链路处理。该操作由用户显式触发，不自动保存所有聊天，也不新增 Agent 直接发布权限。缺少证据的推断在页内保留未证实标记。

## 考虑的替代方案

- **保留文档仓库模型**：改动最少，但仍需每次重新综合跨文档知识，不能满足持续知识积累目标。
- **用模型摘要替代机械全文**：减少磁盘占用，但失去原文定位与核对依据；保留 parsed 全文。
- **模型自动发布知识页**：接近参考实现，审阅负担小；用户本轮明确选择人工审阅后发布，接受队列、冲突和事务恢复的成本。
- **完全复用现有代码审阅数据结构**：接入看似简单，但正式文件尚未写入、库根又可能不在项目范围；选择复用 UI 和差异展示，新增 staged 适配器。
- **知识页自由编辑**：控制直接，但增加用户修改与模型提案合并的成本；本期保持提案审阅写入。基线冲突检测仍必须存在。
- **索引由模型整体重写**：可能获得自然语言组织，但易漏项/截断；选择模型写各页语义元数据、应用确定性聚合。
- **只保存最新原件**：节省磁盘，但旧知识和页面历史的证据不能还原；用户选择保留被引用修订。
- **本期仅 PDF 文字或仅提图**：依赖和调用成本较小，但不能利用 SoC 时序/结构图；用户明确选择本期提图与 AI 读图，接受视觉端点和打包验证成本。
- **向量默认关闭**：配置简单，但语义能力需额外开启；沿用常开与按能力降级，不强制用户为检索成功配置向量。
- **sqlite-vec 复用 better-sqlite3**：可减少依赖种类；2026-09-14 已与 LanceDB 同口径实测（体积小三个数量级、零 ABI 面、含 darwin-x64、原生事务、实测性能仅常数倍落后），但为 pre-1.0、约 4 个月无发布且无 ANN 出路，**维持 LanceDB 初选**；实测数据留档，触发条件见 §6「向量存储选型实测」。
- **旧库只读兼容或自动迁移**：减少用户重新导入，但需维护旧知识模型及迁移边界；沿用原 ADR 不迁移、不双轨的决定，保留旧磁盘数据和处置路径，不自动删除原件。
- **只做图扩展、不做 Lint/图视图**：工作量小，但缺少知识维护入口；保留结构和语义检查及可视化。社区统计只是线索，不保证知识覆盖。
- **图视图统一到 ECharts**：复用已安装依赖；sigma 初选看重网络交互及 worker 布局。没有本项目基准可证明“数百节点 ECharts 必卡”，应以相同数据的打包实验校准取舍。

## 后果

- 新增候选依赖为 `@lancedb/lancedb`（精确 0.38.0 + lockfile）和 sigma/graphology 系列；所选精确版本、平台包、asar、N-API 与 React/CSP/worker 兼容性必须经 spike，不把参考仓库 semver 范围当安装命令。2026-09-14 已实测确认：napi-rs 预编译、**无需 `@electron/rebuild`**；`*.node` 已被现有 `asarUnpack` 覆盖；单平台原生库 290.7 MB，并带约 313 MB 本项目用不到的可选依赖（transformers/onnxruntime/openai），**必须用 electron-builder `files` 剔除，不得全局 `--omit=optional`**；**darwin-x64 无平台包**，发布 macOS Intel 前须解决。详见 §6「向量存储选型实测」。
- 图片解读需要额外视觉模型调用，页面渲染需要内存/取消控制。PDF 矢量图处理必须测试，不能以提取出照片替代验收。
- 来源修订、页面历史与待审阅资料增加磁盘占用；`.kb/` 不是统一可清理缓存目录。
- 同维度换 embedding 模型也触发索引重建；配置指纹隔离向量空间，重建失败不破坏已发布知识。
- `kb_search` 扩展来源/页面身份、类型、引用和状态；新增分页 `kb_read`。`doc_to_markdown` 及临时 `kb_doc_read/grep/outline` 语义保持独立。
- 按替代能力逐步重组 `src/main/kb/`，保留 anydoc/凭证/关键词可复用能力；Deep Reindex 与物理分类入口在替代链路就绪后退役。
- 旧库停用需要用户重新建库导入；当前无法访问的路径须区分于旧格式，不能自动清理登记后丢失路径信息。
- 内网可用性按能力区分：转换/预览本地运行，模型调用只走用户配置端点，未配置或失败时状态可见。

## 后续

实施切片、模块职责、接口契约、验收矩阵与 spike 完整定义在 [实现 spec](../prd/knowledge-base-llm-wiki-spec.md)。先来源/转换和图片能力，再打通单来源编译到审阅发布的完整链路，随后加跨来源修订、检索、问答沉淀、向量与图维护。

本轮只完成静态源码核查和文档修订，未运行参考模型调用或新增依赖的打包实验。术语见根 [CONTEXT.md](../../CONTEXT.md) 的知识库域；绝对路径定位见 [源码核查](../prd/knowledge-base-llm-wiki-source-audit.md)。
