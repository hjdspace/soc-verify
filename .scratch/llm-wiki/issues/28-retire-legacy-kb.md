# 28 — 退役旧知识库入口与无调用模块

**What to build:** 在替代能力就绪后，先删除旧界面调用，再删除无调用者的后端协议和模块，新架构成为唯一实现。

**Blocked by:** [17 — 按已发布结果执行增量跳过](17-compile-cache.md)；[18 — 将选定问答保存为可审阅 query 页](18-save-query.md)；[19 — 从页面历史提出并发布回滚](19-page-rollback.md)；[20 — 安全撤回来源与停用知识库](20-source-library-disposal.md)；[24 — 接入向量混合检索与索引代重建](24-hybrid-search-rebuild.md)；[26 — 浏览社区知识图并处理图结构线索](26-graph-view-insights.md)；[27 — 按证据检查知识并完成审阅修复](27-semantic-maintenance.md)

**Status:** done

**Smart zone:** M。在一票内保持 expand-contract 顺序：先验证无调用者，再清后端；复用实际调用扫描，禁止扩大重构。

**合并来源:** 旧稿 43, 44。旧编号仅用于追溯；执行依赖只认上方新编号。

**最小上下文:** spec §10；源码索引 L07 的旧分类/Deep Reindex 调用链；L07 的旧分类/Deep Reindex 模块；本票前半段的残余符号清单。按符号读取需要的函数及相关测试，不载入整个参考仓库。

**依据:** [实现规格](D:/AI/soc-verify/docs/prd/knowledge-base-llm-wiki-spec.md)；[源码核查与绝对路径索引](D:/AI/soc-verify/docs/prd/knowledge-base-llm-wiki-source-audit.md)；[执行总则](../README.md)

**范围外:** 只做机械退役，不补缺失新功能、不改无关模块、不增加旧布局兼容层。

**验收映射:** A20 A21；User Stories：70, 72。

## Acceptance criteria

- [x] 列出现有旧入口的界面调用者，确认每项都有前序替代能力。
- [x] 移除分类搬移/改名/重分类/Deep Reindex 控件、renderer action 与无用订阅；不改已有新流程。
- [x] 更新索引调用确定性聚合，工具目录仍完整，临时 docId 功能保留。
- [x] 通过调用者扫描证明界面不再使用待删除的旧 API；产出精确残余后端符号清单用于本票后端退役。
- [x] 相关 UI/store 回归和 typecheck/lint 通过；前半段旧端点仍可存在，不引入布局版本兼容分支。
- [x] 依据前半段的实际调用者清单删除旧procedure/事件/类型与孤立模块，不顺手改无关代码。
- [x] 转换引擎、已抽取模型边界、关键词能力和临时docId工具继续保留。
- [x] 扫描确认生产调用者不再引用旧物理分类/整份模型索引重写，不存在长期旧布局分支。
- [x] 删除只服务退役入口的测试，保留/运行新契约与Host表面回归；typecheck/lint通过。
- [x] 修改范围只包含机械contract，不承担未实现功能或重新设计；记录实际退役符号供最终验收。
- [x] 完成相关行为测试、typecheck/lint，并记录实际修改范围与验证证据。纯实验/门禁按本票实测要求验收；无代码修改不重复运行无关项目检查。

## 执行与交接

先用既有入口和小型 fixture 走通本票行为，再覆盖上述失败情形。合并票内部按“验证/前置整理 → 实现 → 行为验证”的顺序进行，不另立中间领取票；技术验证失败则保留证据并停止依赖实现，不能假定通过。

初始阅读目标不超过实际窗口约20%，争取在40%–50%前进入修改与首轮验证；这是预算而非实测保证。若需要新增架构决策、额外独立子系统或无界排错，记录具体阻塞并拆出后续工作，不能删减验收来维持票数。

完成后追加实际公开契约/符号、修改范围、验证命令与结果、后继需要的最小信息；不要求下一个 Agent 阅读过程聊天。

---

## 实施记录

### 退役符号清单

**前端 UI 控件移除：**
- `KbIndexTab.tsx` — 移除"深度重建"按钮、确认对话框、进度展示
- `KbDocList.tsx` — 移除"AI 重分类"按钮
- `KbCategoryTree.tsx` — 移除右键重命名分类功能
- `KbPreviewTab.tsx` — 移除"移动分类"按钮、"AI 重新分类"按钮、AI 摘要卡，简化元信息侧栏
- `KbView.tsx` — 为"文档列表"、"库索引"和"文档预览"Tab 增加 `format !== 'wiki'` 守卫

**前端 Store actions 移除（`src/renderer/src/stores/kb.ts`）：**
- `deepReindex()`, `deepReindexing`, `deepReindexProgress`
- `moveCategory()`
- `renameCategory()`
- `reclassifyDocument()`
- `handleDeepReindexEvent()`

**后端 tRPC procedures 移除（`src/main/ipc/routers/kb-router.ts`）：**
- `kb.moveCategory`
- `kb.renameCategory`
- `kb.reclassify`
- `kb.deepReindex`

**后端模块移除：**
- `src/main/kb/deep-reindexer.ts` — 已删除
- `tests/kb-deep-reindexer.test.ts` — 已删除
- `src/main/kb/pipeline.ts` — 移除 `moveDocumentCategory()`, `renameCategory()`, `reclassifyDocument()` 函数及未用导入（`join`, `IndexEntry`）

**事件桥接移除：**
- `onKbDeepReindex` IPC 事件（`src/preload/index.ts`）

**测试清理：**
- `tests/ui/kb-store.test.ts` — 移除 `moveCategory`、`deepReindex`、`handleDeepReindexEvent` 测试块；移除重复 `kbSettingsLoading` 字段
- `tests/ui/kb-view.test.tsx` — 移除深度重建按钮测试、`moveCategory` 测试、AI 摘要卡测试；移除 `onKbDeepReindex` eventBridge mock；新增 `mockKbStatusLegacy` 支持 legacy 格式 UI 测试
- `tests/kb-wiki-router.test.ts` — 移除 `deep-reindexer` mock
- `tests/kb-staged-router.test.ts` — 移除 `deep-reindexer` mock
- `tests/kb-queue-router.test.ts` — 移除 `deep-reindexer` mock 及注释引用

### 验证证据

```sh
npm run typecheck     # ✓ 通过（tsconfig.node + tsconfig.web + tsconfig.runner-pi）
npm run lint          # ✓ 通过（eslint .）
npx vitest run tests/ui/kb-store.test.ts tests/ui/kb-view.test.tsx  # ✓ 111 passed
npx vitest run tests/kb-wiki-router.test.ts tests/kb-staged-router.test.ts tests/kb-queue-router.test.ts  # ✓ 35 passed
```

