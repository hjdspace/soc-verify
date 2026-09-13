# LLM Wiki 源码核查与移植参考

核查日期：2026-09-13。本文记录静态源码证据，不表示已运行参考应用、真实模型测试或 Electron 打包 spike。目标规格见 [实现 spec](knowledge-base-llm-wiki-spec.md)，架构取舍见 [ADR 0034](../adr/0034-llm-wiki-knowledge-base.md)。

## 核查基线

- 实际参考仓库：`D:\AI\llm_wiki`
- HEAD：`e8082119649e6a8e1cf85eaf289adcabfdf39d4e`；工作区干净；`package.json` 为 `0.6.11`。
- 本项目：`D:\AI\soc-verify`。核查开始时 `CONTEXT.md` 已修改，ADR 0034 与 spec 尚未跟踪；在这些草稿上修订，不覆盖其他工作。
- 路径统一给出绝对路径；行号对应以上参考提交，定位时优先搜索表中符号。文档中的路径是开发参考，不得写入可搬移知识库的持久化记录。

## 真实处理链

1. `source-lifecycle.ts` 将来源复制入 `raw/sources`，以相对路径建立来源身份；来源目录导入保留结构。同名处理不是本项目草稿所写的一律覆盖，文件导入会调用 `getUniqueDestPath`。
2. `ingest-queue.ts` 保存任务、控制 worker 与取消信号；`ingest-commit-coordinator.ts` 预约提交顺序。准备和模型生成可以并发，写入进入项目锁。恢复出来的积压任务默认等人工恢复，不能把旧注释里的“自动恢复”当成实际行为。
3. `ingest.ts` 读取文本、schema、purpose、index、overview；可选保存 parsed Markdown；提取图片并可调用视觉模型生成描述。内容缓存命中也可能补图片，因此“命中即零写入”不是参考实现的契约。
4. 普通来源先产出简洁结构化分析，再生成 FILE/REVIEW 块。长来源走逐块分析、累计摘要与磁盘 checkpoint；大输出可能增加独立 REVIEW 调用，截断还可能触发修复调用，已有页面可能额外调用正文合并。实际费用绝不只是固定两次调用。
5. 提交内解析 FILE、清洗 frontmatter、统一来源与日期、校验路径/路由、读取最新页面合并后写文件；聚合路径不接受模型覆盖，应用补索引与日志。失败可能已经写入一部分页面；完整性门禁阻止成功缓存，但不回滚已写文件。
6. REVIEW 块进入知识待办 store；随后保存成功缓存、更新向量。这里的 REVIEW 主要是矛盾、缺页和建议，不是本项目要求的逐 hunk 发布审批。
7. Query：Rust 后端扫描 wiki、做关键词排序与向量召回，两路 RRF 后再预留名额补图邻居。相关页面的四权重公式是另一个模块，不能与 Rust 搜索的图排序混为一谈。
8. Lint：结构检查以页面引用计算；语义检查在本次版本中主要读取各页前 500 字，不能承诺检出了全文矛盾。另有待办去重、解决状态保留和处理后复核机制。

## 必须纠正的原草稿结论

| 编号 | 核查结论 | 对本项目规格的影响 | 证据 |
| --- | --- | --- | --- |
| F01 | Raw 层原件可能是用户唯一保存的副本；Page History、审批选择、操作日志不能凭当前页面重建 | 按资产和派生数据分别定义保留规则，禁止把 `raw/` 或 `.kb/` 整体当缓存清理 | 本项目 `layout.ts`、`registry.ts`；参考 R03、R17 |
| F02 | `buildAnalysisPrompt` 明确写了不输出 chain-of-thought、hidden reasoning | 改称“结构化分析 → 页面生成”；低温不代表确定性 | R01 `ingest.ts:2165` |
| F03 | 串行提交不等于多文件原子事务；参考实现允许部分落盘后报错 | 本项目人工审阅必须增加发布日志、恢复门禁与基线冲突检查 | R01 `ingest.ts:1166`、`:1380`；R04 |
| F04 | `mergePageContent` 合并失败或正文低于 70% 阈值后，回退到新正文 + 数组并集，备份是 best effort | 不能声称上游已保证“不丢旧知识”；本项目异常合并保留旧页并阻止该变更发布 | R05 `page-merge.ts` |
| F05 | 单来源修订页有 `replaceExistingBody` 分支；一律并集合并会让撤回论断永久残留 | 区分同来源修订与新增来源；给来源修订和过时证据定义契约 | R01 `ingest.ts:2034`；R05 |
| F06 | 缓存主要键为来源身份和文本哈希，检查产出文件存在 | 本项目增加 schema/purpose、转换/读图/编译配置指纹，审批拒绝与成功缓存分开 | R03 |
| F07 | schema 校验在缺 type 时可返回成功，未知 type 也不总是拒绝；加载失败可返回 null | 本项目八种类型必须闭集校验，坏 schema 不得静默失去约束 | R06 |
| F08 | `parsedMarkdownOutputPath` 只支持列举的转换格式，并非所有文件；输出可选 | “常开、所有支持来源均有可查全文”是本项目扩展，要定义 Markdown/CSV 路径规则 | R07 |
| F09 | 长来源分段与 embedding 分块是两套逻辑；前者仍有字符切分 | 不能把 embedding 的保表格承诺直接套给编译；分别验收全文覆盖与超大原子块 | R01 `ingest.ts:2591`、`:2872`；R10 |
| F10 | 搜索是关键词/向量 RRF，再补图结果；index 注入不产生查询排名 | 去掉“四路统一 RRF 与上游一致”的断言；明确元数据与正文是否同属关键词信号 | R08 |
| F11 | Rust 图排序按 seed 排名贡献，图名额约为最终窗口的 15%–30%；Relatedness 四权重用于另一套 TS 关联图 | 本项目应选定一套搜索契约，不能无意同时实现两套图排序 | R08 `search.rs:511`；R11 |
| F12 | 上游向量按文件 stem 关联，发现重名仅记录警告；图模块亦有独立的名称解析 | 本项目统一页面身份与链接解析，禁止跨目录同名覆盖索引记录 | R08 `search.rs:365`；R11 |
| F13 | embedding 也存在截短重试、部分 chunks 成功后 upsert；Rust 另有配置指纹实现 | 本项目不能承诺向量覆盖全文却不报告跳过的块；同维度换模型也必须重建 | R09 |
| F14 | 图聚类、低连通性与桥接节点是启发式结构特征 | 不把它们写成已证实的知识盲区或语义矛盾；类型亲和还需覆盖 comparison/pitfall/interface | R11、R12 |
| F15 | 结构孤儿指缺少其他知识页入链，不是漏登 index | 聚合页不能参与孤儿入度与社区统计，否则所有页面都被 index 连接，检查失效 | R12 |
| F16 | 本项目 Diff Review 按项目文件和工具调用重建 before，接受即保留磁盘内容；知识库允许在项目目录外 | 共用入口/展示组件，新增按 kbId 授权的 staged 适配器；禁止伪造工具调用接入旧撤销 API | L04 |
| F17 | 本项目 anydoc 的 PDF 分支仅文本；参考另有 pdfium 提图和视觉描述 | 本期按用户确认补提图与 AI 读图；PDF 矢量图还需页面渲染，不能只抽栅格对象 | L02、R13 |
| F18 | 当前 `log://` 返回空文本、`case://` 返回占位对象；`cov://` 依赖注入的 CoverageManager | 仅“接受 URI”不代表证据可读取；本期显示解析能力与失效原因，不伪造证据成功 | L05 |
| F19 | 参考使用 Rust `lancedb = 0.27.2`，不是 Electron Node SDK 的兼容性证据 | 选 Node SDK 精确版本并实测打包；React 同版本也不足以证明 sigma/CSP/worker 可用 | R09、R16 |
| F20 | 当前 spec 的 80% 完整度、ECharts 数百节点必卡等说法没有本次测量证据 | 删除数值断言，依赖选择保留为待实测设计，预算和验收独立记录 | L01、R16 |

## 参考源码绝对路径索引

| 索引 | 文件与定位符号 | 用途与不能照搬的部分 |
| --- | --- | --- |
| R01 | [ingest.ts](D:/AI/llm_wiki/src/lib/ingest.ts:663)：`autoIngestImpl`、`parseFileBlocks`、`buildAnalysisPrompt`、`buildGenerationPrompt`、`analyzeLongSourceInChunks`、`writeFileBlocks` | 全链路、提示组织、块修复；不照搬部分写入成功语义和超长内容静默压缩 |
| R02 | [source-identity.ts](D:/AI/llm_wiki/src/lib/source-identity.ts:8)：`sourceIdentityForPath`、`sourceSummarySlugFromIdentity`；[碰撞测试](D:/AI/llm_wiki/src/lib/ingest-source-path-collision.test.ts) | 目录/扩展名参与身份，长文件名与 slug 哈希；本项目页面身份须统一 |
| R03 | [ingest-cache.ts](D:/AI/llm_wiki/src/lib/ingest-cache.ts)：`checkIngestCache`、`saveIngestCache` | 缓存命中必须验证产出存在；缺配置指纹与审批语义 |
| R04 | [ingest-queue.ts](D:/AI/llm_wiki/src/lib/ingest-queue.ts)：`pauseProcessing`、`restoreQueue`、`startTask`；[ingest-commit-coordinator.ts](D:/AI/llm_wiki/src/lib/ingest-commit-coordinator.ts)：`reserve` | 排队、epoch、AbortSignal、顺序提交；持久化错误不能在本项目也吞掉 |
| R05 | [page-merge.ts](D:/AI/llm_wiki/src/lib/page-merge.ts)：`mergePageContent`；[sources-merge.ts](D:/AI/llm_wiki/src/lib/sources-merge.ts) | 数组合并、锁定字段、单源修订；必须注意异常回退会使用新正文 |
| R06 | [wiki-schema.ts](D:/AI/llm_wiki/src/lib/wiki-schema.ts)：`parseWikiSchemaRouting`、`validateWikiPageRouting`；[ingest-sanitize.ts](D:/AI/llm_wiki/src/lib/ingest-sanitize.ts) | 可执行 Page Types 路由、frontmatter 边界清洗；本项目采取更严格失败策略 |
| R07 | [parsed-source-output.ts](D:/AI/llm_wiki/src/lib/parsed-source-output.ts)：`parsedMarkdownOutputPath`、`persistParsedMarkdown` | `raw/parsed/<相对原件路径>.md` 与原子写；本项目常开 |
| R08 | [search.rs](D:/AI/llm_wiki/src-tauri/src/commands/search.rs:484)：`apply_rrf_scores`、`graph_result_quota`、`blend_graph_results`；[search.ts](D:/AI/llm_wiki/src/lib/search.ts) | 关键词/向量融合、图扩展配额、前后端同服务；不把 basename 当身份 |
| R09 | [embedding.ts](D:/AI/llm_wiki/src/lib/embedding.ts)：`preparePageEmbeddingRows`、`embedPage`、`embedAllPages`；[page_embedding.rs](D:/AI/llm_wiki/src-tauri/src/commands/page_embedding.rs)：`embedding_fingerprint`；[vectorstore.rs](D:/AI/llm_wiki/src-tauri/src/commands/vectorstore.rs) | chunk upsert、重建、配置指纹；Rust/TS 两份实现有差异，不假定行为完全一致 |
| R10 | [text-chunker.ts](D:/AI/llm_wiki/src/lib/text-chunker.ts)：`chunkMarkdown`；[text-chunker.test.ts](D:/AI/llm_wiki/src/lib/text-chunker.test.ts) | 标题面包屑、表格/围栏原子块、oversized；需覆盖无首尾竖线表格、缩进围栏、Unicode 与偏移 |
| R11 | [graph-relevance.ts](D:/AI/llm_wiki/src/lib/graph-relevance.ts)：`WEIGHTS`、`TYPE_AFFINITY`；[wiki-graph.ts](D:/AI/llm_wiki/src/lib/wiki-graph.ts)；[wikilink-transform.ts](D:/AI/llm_wiki/src/lib/wikilink-transform.ts) | 四信号关联、图数据与链接展示；本项目共用解析器并按 kbId 隔离缓存 |
| R12 | [lint-structural-core.ts](D:/AI/llm_wiki/src/lib/lint-structural-core.ts)：`computeStructuralLint`；[lint.ts](D:/AI/llm_wiki/src/lib/lint.ts:205)：`runSemanticLint`；[graph-insights.ts](D:/AI/llm_wiki/src/lib/graph-insights.ts)：`detectKnowledgeGaps` | 结构规则和启发式；语义检查须取证正文，不能只读 500 字摘要 |
| R13 | [extract_images.rs](D:/AI/llm_wiki/src-tauri/src/commands/extract_images.rs)；[extract-source-images.ts](D:/AI/llm_wiki/src/lib/extract-source-images.ts)；[image-caption-pipeline.ts](D:/AI/llm_wiki/src/lib/image-caption-pipeline.ts)；[vision-caption.ts](D:/AI/llm_wiki/src/lib/vision-caption.ts) | 原图、页码、哈希、读图缓存与有限并发；参考按图片哈希和语言缓存，模型和上下文不完整参与键 |
| R14 | [review-store.ts](D:/AI/llm_wiki/src/stores/review-store.ts)；[sweep-reviews.ts](D:/AI/llm_wiki/src/lib/sweep-reviews.ts)；[lint-fixes.ts](D:/AI/llm_wiki/src/lib/lint-fixes.ts) | 待办稳定身份、保留解决状态、修复后复核；不是页面发布审批 |
| R15 | [source-lifecycle.ts](D:/AI/llm_wiki/src/lib/source-lifecycle.ts)：`importSourceFiles`、`deleteSourceFiles`、`migrateSourcePath`；[source-delete-decision.ts](D:/AI/llm_wiki/src/lib/source-delete-decision.ts)：`decidePageFate` | 来源新增/删除对引用、缓存和知识页的影响；不照搬直接删除单来源知识页 |
| R16 | [package.json](D:/AI/llm_wiki/package.json)；[Cargo.toml](D:/AI/llm_wiki/src-tauri/Cargo.toml:43)；[graph-layout-worker.ts](D:/AI/llm_wiki/src/components/graph/graph-layout-worker.ts)；[graph-view.tsx](D:/AI/llm_wiki/src/components/graph/graph-view.tsx) | 技术栈、LanceDB Rust 依赖、图布局 worker；本项目独立选择精确依赖 |
| R17 | [file_history.rs](D:/AI/llm_wiki/src-tauri/src/commands/file_history.rs) | 页面历史；不能由当前版本复原曾经被删的内容 |

## 本项目接入位置（以代码为准）

| 索引 | 绝对路径 | 本次重构职责 |
| --- | --- | --- |
| L01 | [layout.ts](D:/AI/soc-verify/src/main/kb/layout.ts)、[pipeline.ts](D:/AI/soc-verify/src/main/kb/pipeline.ts)、[registry.ts](D:/AI/soc-verify/src/main/kb/registry.ts)、[scanner.ts](D:/AI/soc-verify/src/main/kb/scanner.ts) | 布局单一所有者、身份替换、持久任务入口、库识别；不能沿用不含扩展名的 docName 主键 |
| L02 | [converter.ts](D:/AI/soc-verify/src/main/kb/converter.ts)、[anydoc-engine.ts](D:/AI/soc-verify/src/main/kb/engines/anydoc-engine.ts)、[PdfPreview.tsx](D:/AI/soc-verify/src/renderer/src/components/office/PdfPreview.tsx) | 保留转换能力，修正先删旧产物问题；现有 pdfjs 本地 worker 可供 PDF 渲染 spike 参考 |
| L03 | [llm-config.ts](D:/AI/soc-verify/src/main/kb/llm-config.ts)、[indexer.ts](D:/AI/soc-verify/src/main/kb/indexer.ts)、[kb-settings.ts](D:/AI/soc-verify/src/main/kb/kb-settings.ts)、[kb-types.ts](D:/AI/soc-verify/src/shared/kb-types.ts) | 已有多协议和凭证解析可复用；编译/视觉/嵌入角色分离，任务显式绑定项目和库 |
| L04 | [diff-review.ts](D:/AI/soc-verify/src/renderer/src/stores/diff-review.ts)、[diff-review-ops.ts](D:/AI/soc-verify/src/renderer/src/stores/diff-review-ops.ts)、[project-router.ts](D:/AI/soc-verify/src/main/ipc/routers/project-router.ts) | 保留代码审阅的已写入撤销路径；新增 KB staged 发布适配器，不扩张项目文件授权范围 |
| L05 | [kb-tools.ts](D:/AI/soc-verify/src/main/host/tools/kb-tools.ts)、[host-uris.ts](D:/AI/soc-verify/src/main/host/host-uris.ts)、[tool-catalog.ts](D:/AI/soc-verify/src/main/host/tool-catalog.ts)、[context-injector.ts](D:/AI/soc-verify/src/main/kb/context-injector.ts) | Agent 查询/读取契约、工具目录、注入；旧文档里的 `src/main/omp/` 已不是实际路径 |
| L06 | [kb-router.ts](D:/AI/soc-verify/src/main/ipc/routers/kb-router.ts)、[preload/index.ts](D:/AI/soc-verify/src/preload/index.ts)、[kb.ts](D:/AI/soc-verify/src/renderer/src/stores/kb.ts)、[KbView.tsx](D:/AI/soc-verify/src/renderer/src/components/kb/KbView.tsx) | tRPC 命令与事件、队列和知识页 UI；新事件必须携带 kbId/taskId/revision |
| L07 | [deep-reindexer.ts](D:/AI/soc-verify/src/main/kb/deep-reindexer.ts)、[KbIndexTab.tsx](D:/AI/soc-verify/src/renderer/src/components/kb/KbIndexTab.tsx)、[searcher.ts](D:/AI/soc-verify/src/main/kb/searcher.ts) | 退役整份模型索引重写，保留关键词能力，统一确定性索引入口 |
| L08 | [kb-router.test.ts](D:/AI/soc-verify/tests/kb-router.test.ts)、[kb-tools.test.ts](D:/AI/soc-verify/tests/kb-tools.test.ts)、[kb-host-tools.test.ts](D:/AI/soc-verify/tests/kb-host-tools.test.ts)、[kb-store.test.ts](D:/AI/soc-verify/tests/ui/kb-store.test.ts)、[kb-view.test.tsx](D:/AI/soc-verify/tests/ui/kb-view.test.tsx) | 现有行为测试入口；补文件系统故障注入和真实打包验收，不能仅靠 router mock |

## 结论边界

参考实现有价值的是持续知识编译、来源身份、增量处理、交叉引用与健康维护的整体循环。它并未替本项目解决审批发布、可恢复多文件提交、完整原文证据、Electron 原生包和内网模型能力等问题。spec 必须把“上游已实现”“本项目决定增加”“需 spike 验证”分别写清楚。

本轮文档验证：94 个本地链接及行号目标存在，代码围栏闭合，无尾随空白；`git diff --check`、`npm run typecheck` 与 `npm run lint` 通过。仅修改 Markdown，未运行实现级 Vitest、真实模型调用或新增依赖打包测试；这些验证不能替代 spec 中 A01–A22 的后续验收。
