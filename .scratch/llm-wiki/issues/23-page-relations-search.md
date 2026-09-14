# 23 — 建立统一知识图并扩展关联检索

**What to build:** 知识页可浏览出入链与相关页面，关键词检索基于同一图快照补充有来源说明的一跳邻居。

**Blocked by:** [14 — 统一关键词检索与 Agent 知识导航](14-keyword-search-navigation.md)

**Status:** done（2026-09-14）

**Smart zone:** M。统一链接解析和快照是共同输入，关联列表与搜索只是两个有界消费者。

**合并来源:** 旧稿 34, 35。旧编号仅用于追溯；执行依赖只认上方新编号。

**最小上下文:** spec §8、9；源码索引 R11 的 wiki-graph/graph-relevance；R08 的 graph_result_quota/blend_graph_results。按符号读取需要的函数及相关测试，不载入整个参考仓库。

**依据:** [实现规格](D:/AI/soc-verify/docs/prd/knowledge-base-llm-wiki-spec.md)；[源码核查与绝对路径索引](D:/AI/soc-verify/docs/prd/knowledge-base-llm-wiki-source-audit.md)；[执行总则](../README.md)

**范围外:** 不做 sigma 布局或 Lint 面板；不将 Relatedness 当语义置信度或替换图 seed 公式。

**验收映射:** A14 A17；User Stories：20, 48, 57。

## Acceptance criteria

- [x] 只用既有统一链接解析器，节点为pageId，raw/聚合页不进入知识节点。
- [x] 快照按kbId+revision隔离；变更后失效且不使用旧边推导新页。
- [x] Relatedness采用spec初始四信号，SoC类型亲和为中性，不声称语义置信度。
- [x] UI列出相关页与理由，断链/歧义可见；自链不制造有效外部关联。
- [x] 跨目录同basename、多库相同revision的fixture不串图。
- [x] 按spec的seed个数、配额、分数与稳定身份去重，topK<2不扩展。
- [x] 无向量时vectorPageHits=0，稀疏/无候选归还名额，不减少可用基础结果。
- [x] 图结果附graphRelatedTo并明确不同于直接词命中；UI/Host输出一致。
- [x] 图revision落后时只返回关键词并标重建中，不使用过时边。
- [x] 完成相关行为测试、typecheck/lint，并记录实际修改范围与验证证据。纯实验/门禁按本票实测要求验收；无代码修改不重复运行无关项目检查。

## 执行与交接

先用既有入口和小型 fixture 走通本票行为，再覆盖上述失败情形。合并票内部按“验证/前置整理 → 实现 → 行为验证”的顺序进行，不另立中间领取票；技术验证失败则保留证据并停止依赖实现，不能假定通过。

初始阅读目标不超过实际窗口约20%，争取在40%–50%前进入修改与首轮验证；这是预算而非实测保证。若需要新增架构决策、额外独立子系统或无界排错，记录具体阻塞并拆出后续工作，不能删减验收来维持票数。

完成后追加实际公开契约/符号、修改范围、验证命令与结果、后继需要的最小信息；不要求下一个 Agent 阅读过程聊天。

## 交接（2026-09-14，done）

**实现方式：** 单一主进程模块 `src/main/kb/wiki-graph.ts` 统一拥有图快照构建、缓存、相关页面计算与一跳邻居查询。搜索扩展在 `wiki-search.ts` 中消费图快照，不复制链接解析或图数据。

**公开契约：**
- `@shared/kb-types.ts` 新增类型：`WikiGraphEdge`、`WikiGraphNode`（含 `keywords`/`sources` 副本）、`WikiBrokenLink`、`WikiGraphSnapshot`（含 `nodes: Map`、`edges`、`brokenLinks`，按 `kbId + revision` 隔离）、`WikiRelatednessSignal`（`sharedSources`/`sharedKeywords`/`linkNeighbor`/`typeAffinity`）、`WikiRelatedPage`、`WikiRelatedResult`、`WikiGraphExpansionInfo`、`WikiGraphRelatedTo`。
- `WikiSearchHit` 新增可选 `graphRelatedTo?: WikiGraphRelatedTo`；`WikiSearchMode` 扩展为 `'keyword' | 'keyword+graph'`；`WikiSearchResponse` 新增可选 `graphExpansion?: WikiGraphExpansionInfo | null`。
- `wiki-graph.ts` 导出：`buildWikiGraphSnapshot(kbPath)`、`getWikiGraphSnapshot(kbPath)`（带缓存，按 `manifest.publish.revision` 自动失效）、`invalidateGraphSnapshot(kbPath)`、`computeRelatedPages(snapshot, pageId)`、`getRelatedPages(kbPath, pageId)`、`getOneHopNeighbors(snapshot, pageId)`。
- tRPC：`kb.wikiRelated({ pageId })` → `WikiRelatedResult`；`kb.wikiGraph()` → 序列化节点/边/断链（Map 转数组传输）。
- Host Tool：`kb_search` 返回追加 `graphExpansion` 与每条 hit 的 `graphRelatedTo`。

**关键语义（踩过坑）：**
- 图节点 `WikiGraphNode` 携带 `keywords` 和 `sources` 副本——`computeRelatedPages` 是同步纯函数，不读文件。副本在 `buildWikiGraphSnapshot` 时从 catalog frontmatter 一次性写入。
- 类型守卫 `isParsedPage(page): page is ParsedPage` 用于 filter 后访问 `page.parse.frontmatter`/`page.parse.body`，TypeScript strict 模式下 `.filter((p) => p.parse.ok)` 不够。
- `getWikiGraphSnapshot` 缓存键 = `kbPath`；命中时比较 `manifest.publish.revision`，不匹配自动重建。`getWikiGraphSnapshot` 的 `rebuilding` 标记只在图构建失败时为 `true`——revision 变化会触发自动重建而非标 rebuilding（spec 的「图 revision 落后」指缓存未追上的瞬态，自动重建后即同步）。
- 图扩展 `computeGraphQuota(topK, vectorPageHits)`：本期 `vectorPageHits=0`（无向量），名额 = `ceil(topK × 0.30)`，限制 `1..topK-1`，`topK<2` 时为 `0`。
- 图候选分数 = 各 seed `1/(seedRank+1)` 之和（`seedRank` 从 0 起），去重后保留基础结果窗口，图补召回附在其后并带 `graphRelatedTo`。已在基础结果中的页面不重复出现。
- `topK < 2` 与 `baseHits.length === 0` 均设置 `graphExpansion = { rebuilding: false, quota: 0, expanded: 0 }`，不遗留 `null`。
- 自链在边构建阶段跳过（`resolution.pageId === page.pageId` 时 `continue`），不产生有效边，也不参与相关页面计算。
- 聚合页（`index`/`overview`/`log`）不在 `catalog.pages` 中，自然不成为图节点。

**修改范围：** `src/main/kb/wiki-graph.ts`（新）、`src/main/kb/wiki-search.ts`（图扩展逻辑 + `computeGraphQuota`）、`src/shared/kb-types.ts`（新增图类型 + 扩展搜索类型）、`src/main/ipc/routers/kb-router.ts`（`wikiRelated` + `wikiGraph` procedure + 导入）、`src/main/host/tools/kb-tools.ts`（`graphExpansion` + `graphRelatedTo` 输出）、`tests/kb-wiki-graph.test.ts`（新，28 例）。

**验证命令与结果：** `tsc --noEmit`（tsconfig.node）通过；ESLint 6 个改动文件 0 问题；vitest：`tests/kb-wiki-graph` 28 过，`tests/kb-wiki-search/kb-host-tools/kb-router/kb-wiki-router/kb-wiki-catalog/kb-read-gate/kb-tools` 193 过（共 221 过）。环境注意：本机 `npm run typecheck` 会触发沙箱拦截（wsl.exe 黑名单），用 `node node_modules/typescript/lib/tsc.js` 直跑。

**后继：** 向量（22）接入后 `vectorPageHits` 从 0 变为实际值，图名额自动缩减（系数从 0.30 降至 0.15）；图 UI 可视化（sigma/graphology）在 `wikiGraph` tRPC 输出上构建，布局在 renderer worker 中运行；Lint 面板可消费同一 `WikiGraphSnapshot` 做结构检查（orphan/no-outlinks/broken-link）。
