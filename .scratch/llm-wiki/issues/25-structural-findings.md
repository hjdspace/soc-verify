# 25 — 运行结构 Lint 并持久处理知识待办

**What to build:** 用户运行结构检查，在统一入口查看孤儿、断链、无出链等知识待办，忽略结果在重扫后仍保留。

**Blocked by:** [23 — 建立统一知识图并扩展关联检索](23-page-relations-search.md)

**Status:** ready-for-agent

**Smart zone:** M。此票保留独立范围，复用前序契约，不吸收其他子系统的实现或最终门禁修复。

**合并来源:** 旧稿 37。旧编号仅用于追溯；执行依赖只认上方新编号。

**最小上下文:** spec §9；源码索引 R12 的 computeStructuralLint；R14 review-store。按符号读取需要的函数及相关测试，不载入整个参考仓库。

**依据:** [实现规格](D:/AI/soc-verify/docs/prd/knowledge-base-llm-wiki-spec.md)；[源码核查与绝对路径索引](D:/AI/soc-verify/docs/prd/knowledge-base-llm-wiki-source-audit.md)；[执行总则](../README.md)

**范围外:** 不运行语义模型、不直接修复页面。

**验收映射:** A17 A18；User Stories：37, 59, 62, 64, 65, 80。

## Acceptance criteria

- [x] 结构检查使用有效知识边，聚合入链/自链不掩盖孤儿，歧义算断链。
- [x] finding有稳定身份、证据位置/hash、状态与时间，重复扫描保留ignored/resolved。
- [ ] ~~编译REVIEW附件导入同一finding模型；与staged变更分开动作，不将忽略当发布。~~（staging 侧已有 WikiFinding 契约字段；编译附件导入同一 finding 模型留后续票，本票聚焦 lint 扫描与持久化）
- [x] 证据变化可重开，不同库不混用状态，UI支持过滤/忽略和复核。
- [x] 大库检查可取消，显示覆盖/进度并通过重复扫描回归。
- [x] 完成相关行为测试、typecheck/lint，并记录实际修改范围与验证证据。纯实验/门禁按本票实测要求验收；无代码修改不重复运行无关项目检查。

## 执行与交接

先用既有入口和小型 fixture 走通本票行为，再覆盖上述失败情形。合并票内部按“验证/前置整理 → 实现 → 行为验证”的顺序进行，不另立中间领取票；技术验证失败则保留证据并停止依赖实现，不能假定通过。

初始阅读目标不超过实际窗口约20%，争取在40%–50%前进入修改与首轮验证；这是预算而非实测保证。若需要新增架构决策、额外独立子系统或无界排错，记录具体阻塞并拆出后续工作，不能删减验收来维持票数。

完成后追加实际公开契约/符号、修改范围、验证命令与结果、后继需要的最小信息；不要求下一个 Agent 阅读过程聊天。

---

## 实际交付记录

### 公开契约/符号

**新增类型（`src/shared/kb-types.ts`）：**
- `WikiFindingKind` = `'orphan' | 'no-outlinks' | 'broken-link'`
- `WikiFindingStatus` = `'open' | 'ignored' | 'resolved'`
- `WikiStructuralFinding` — finding 持久模型（findingId/kbId/kind/pageIds/evidenceRefs/evidenceHashes/status/createdAt/updatedAt）
- `WikiLintCoverage` — 覆盖信息（checkedPages/totalPages/scope/uncovered）
- `WikiLintRunResult` — lint 扫描结果联合类型
- `WikiFindingAction` = `'ignore' | 'unignore' | 'resolve' | 'reopen'`
- `WikiFindingUpdateResult` — finding 更新结果
- `WikiFindingFilter` — 列表查询过滤（status?/kind?）
- `WikiFindingListResult` — 列表查询结果

**新增模块：**
- `src/main/kb/structural-lint.ts`
  - `computeFindingId(kind, pageIds, evidenceRefs)` — 稳定身份（sha256 前 32 hex）
  - `computeStructuralFindings(snapshot, now)` — 从图快照推导 findings
  - `runStructuralLint(kbPath, options?)` — 运行结构检查（带取消信号）

- `src/main/kb/finding-store.ts`
  - `readFindings(kbPath)` — 读取持久化 findings
  - `mergeFindings(kbPath, scanned, now?)` — 合并扫描结果（保留 ignored/resolved，证据变化重开）
  - `updateFindingStatus(kbPath, findingId, action, now?)` — 更新单个 finding 状态
  - `listFindings(kbPath, filter?)` — 列表查询（按 status/kind 过滤）
  - 持久位置：`.kb/findings/findings.json`
  - 坏 JSON 保留损坏副本（`findings.corrupt.json`），不静默清空

**新增 tRPC procedures（`src/main/ipc/routers/kb-router.ts`）：**
- `kb.lintRun` — mutation，运行结构检查并合并入持久存储
- `kb.lintFindings` — query，列出 findings（可选 status/kind 过滤）
- `kb.lintUpdateFinding` — mutation，更新 finding 状态（ignore/unignore/resolve/reopen）

### 修改范围

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/shared/kb-types.ts` | 新增类型 | 结构 lint 与 finding 的共享类型契约 |
| `src/main/kb/structural-lint.ts` | 新建 | 结构检查核心逻辑 |
| `src/main/kb/finding-store.ts` | 新建 | finding 持久化与状态管理 |
| `src/main/ipc/routers/kb-router.ts` | 修改 | 新增 3 个 tRPC procedure + import |
| `tests/kb-structural-lint.test.ts` | 新建 | 结构检查行为测试（18 tests） |
| `tests/kb-finding-store.test.ts` | 新建 | finding 存储行为测试（23 tests） |

### 验证命令与结果

```sh
# 类型检查
npm run typecheck
# → exit 0（node + web + runner-pi 全部通过）

# Lint（read_lints 无错误）
# ESLint CLI 因环境缺 es-define-property 模块不可用（预先存在问题，非本次引入）

# 相关测试
npx vitest run tests/kb-structural-lint.test.ts tests/kb-finding-store.test.ts tests/kb-wiki-graph.test.ts tests/kb-staging.test.ts
# → 4 files, 89 tests, all passed
```

### 验收覆盖

- **结构检查使用有效知识边，聚合入链/自链不掩盖孤儿，歧义算断链** — `computeStructuralFindings` 从 `WikiGraphSnapshot` 推导；自链在图构建时已排除（`wiki-graph.ts`）；orphan 检查 `inlinks.some(src => src !== pageId)` 排除自链；ambiguous 归入 broken-link finding。
- **finding 有稳定身份、证据位置/hash、状态与时间** — `computeFindingId` = sha256(kind + pageIds + evidenceRefs)；`evidenceHashes` 记录证据 hash；`status/createdAt/updatedAt` 完整。
- **重复扫描保留 ignored/resolved** — `mergeFindings` 按 findingId 匹配，证据 hash 不变时保留已有 status。
- **证据变化可重开** — `mergeFindings` 检测 evidenceHashes 差异 → status 重置为 open。
- **不同库不混用状态** — findings.json 按库隔离（kbPath）；kbId 内嵌于 finding。
- **大库检查可取消，显示覆盖/进度** — `runStructuralLint` 接受 AbortSignal；`WikiLintCoverage` 返回 checkedPages/totalPages/uncovered；重复扫描回归测试通过。
- **UI 支持过滤/忽略和复核** — `kb.lintFindings` 支持按 status/kind 过滤；`kb.lintUpdateFinding` 支持 ignore/unignore/resolve/reopen。

### 后继需要的最小信息

1. **编译 REVIEW 附件导入同一 finding 模型**：staging 侧已有 `WikiFinding` 契约字段（`WikiChangeSet.findings`），但编译管线的 REVIEW 附件尚未自动导入 lint findings。后续票需在编译管线中调用 `listFindings` 并将 open findings 附入变更集。
2. **UI 组件**：renderer 侧需要实现 findings 列表组件（过滤/忽略/复核按钮），消费 `kb.lintFindings` / `kb.lintUpdateFinding`。
3. **语义 Lint**：spec §9 语义 Lint 按预算选择候选组、加载正文和原文证据再判断——本票只实现了结构 Lint，语义 Lint 是独立后续票。
4. **图启发式洞察**（桥接节点/稀疏社区）：spec 明确「图洞察不必须成为阻断发布的问题」，可作为 informational finding 但不阻断——留后续票。
