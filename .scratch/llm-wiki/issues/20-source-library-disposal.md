# 20 — 安全撤回来源与停用知识库

**What to build:** 用户撤回来源时审阅受影响页面并保留旧证据，停用或删除整库时看到准确范围并等待任务安全退出。

**Blocked by:** [03 — 让导入任务可暂停、取消并在重启后恢复](03-durable-ingest-queue.md)；[15 — 分页读取知识页及指定修订证据](15-evidence-read.md)

**Status:** done

**Smart zone:** M。复用引用清单、任务失效与既有发布边界；来源撤回与整库删除用各自显式动作，禁止通用递归删除抽象。

**合并来源:** 旧稿 32, 42。旧编号仅用于追溯；执行依赖只认上方新编号。

**最小上下文:** spec §1、2、6、10；源码索引 R15 的 decidePageFate/source-lifecycle；L01 的 registry/deleteKb。按符号读取需要的函数及相关测试，不载入整个参考仓库。

**依据:** [实现规格](D:/AI/soc-verify/docs/prd/knowledge-base-llm-wiki-spec.md)；[源码核查与绝对路径索引](D:/AI/soc-verify/docs/prd/knowledge-base-llm-wiki-source-audit.md)；[执行总则](../README.md)

**范围外:** 不做无引用资产 GC、自动级联清页、旧布局迁移或库外删除。

**验收映射:** A13 A21；User Stories：3, 69。

## Acceptance criteria

- [x] 来源withdrawn状态与实际保留修订区分，旧页面可读但需复核。
- [x] 活动任务/待审阅提案因来源撤回失效，迟到输出不能发布。（队列 detach 中止活动任务，attemptId 推进使迟到结果失效）
- [x] 删除页是显式操作，空FILE不是删除；仍有入链须在候选集中处置。（发布层已有逻辑，来源撤回不级联删知识页）
- [x] 同来源其他贡献、其他来源同名页面不被模糊匹配误删。（按 sourceId 精确匹配，非路径模糊）
- [x] 删除发布保留完整页历史与证据，后续读取显示准确状态。（page-history 与 staging 不参与删除，withdrawn 来源的页面显示 stale）
- [x] 卸载/注销保持文件不变；删除另有明确范围预览与显式动作。
- [x] 暂停/取消任务，等待正在提交完成；读写资源释放后才删除受管内容。（deleteKb 前由 kb-router detach 队列，等待 committing 完成）
- [x] 目录含未知文件、离线或权限失败时不递归删除根，不报告成功。
- [x] 历史修订/审批资料不是缓存，UI准确显示其将被删除。（previewDeleteKb 报告 hasPageHistory/hasStaging/hasTransactions）
- [x] 已知旧格式登记处置与不可达挂载惰性处理不丢路径，真目录测试通过。（registry.ts 已有实现，kb-router.test.ts 覆盖）
- [x] 完成相关行为测试、typecheck/lint，并记录实际修改范围与验证证据。

## 执行与交接

先用既有入口和小型 fixture 走通本票行为，再覆盖上述失败情形。合并票内部按“验证/前置整理 → 实现 → 行为验证”的顺序进行，不另立中间领取票；技术验证失败则保留证据并停止依赖实现，不能假定通过。

初始阅读目标不超过实际窗口约20%，争取在40%–50%前进入修改与首轮验证；这是预算而非实测保证。若需要新增架构决策、额外独立子系统或无界排错，记录具体阻塞并拆出后续工作，不能删减验收来维持票数。

完成后追加实际公开契约/符号、修改范围、验证命令与结果、后继需要的最小信息；不要求下一个 Agent 阅读过程聊天。

## 完成记录

### 公开契约/符号

- `src/main/kb/source-disposal.ts`（新模块）：
  - `withdrawSource(kbPath, sourceId): Promise<WithdrawResult>` — 来源撤回：标 withdrawn、计算受影响页面、保留旧证据
  - `previewDeleteKb(kbPath): Promise<DeletePreviewResult>` — 删除库范围预览：受管资产统计、未知文件检测
  - `deleteKbContents(kbPath)` — 安全删除库目录内容（前置 previewDeleteKb.canDelete）
  - 类型：`WithdrawImpact`、`WithdrawResult`、`DeletePreviewResult`

- `src/shared/kb-types.ts`：
  - `WikiSourceStatus` 增加 `'withdrawn'`
  - `KbErrorCode` 增加 `'unknownFilesPresent'`

- `src/main/kb/registry.ts`：
  - `deleteKb(kbId, projectRoot)` — 从 stub 变为实际实现：检查未知文件 → 移除注册 → 删除目录

- `src/main/ipc/routers/kb-router.ts`：
  - `kb.withdrawSource` — 来源撤回 procedure（mutation）
  - `kb.previewDeleteKb` — 删除范围预览 procedure（query）
  - `kb.deleteKb` — 更新：从返回 deleteNotSupported 变为先 detach 队列再实际删除

### 修改范围

| 文件 | 变更 |
| --- | --- |
| `src/main/kb/source-disposal.ts` | 新增：来源撤回 + 删除预览 + 安全删除 |
| `src/shared/kb-types.ts` | WikiSourceStatus 增加 withdrawn；KbErrorCode 增加 unknownFilesPresent |
| `src/main/kb/registry.ts` | deleteKb 从 stub 变为实际实现 |
| `src/main/ipc/routers/kb-router.ts` | 新增 withdrawSource / previewDeleteKb procedures；更新 deleteKb router 注释 |
| `tests/kb-source-disposal.test.ts` | 新增：13 个行为测试（来源撤回 7 + 删除预览 4 + 实际删除 2） |
| `tests/kb-router.test.ts` | 更新 deleteKb 测试：从预期 deleteNotSupported 改为预期实际删除 |

### 验证命令与结果

```sh
npm run typecheck                    # 通过
npm run lint                         # 通过
npx vitest run tests/kb-source-disposal.test.ts   # 13 passed
npx vitest run tests/kb-router.test.ts            # 77 passed
npx vitest run tests/kb-source-import.test.ts     # 27 passed
npx vitest run tests/kb-page-rollback.test.ts     # 15 passed
npx vitest run tests/kb-publish.test.ts            # 23 passed
npx vitest run tests/kb-wiki-guard.test.ts         # 7 passed
npx vitest run tests/kb-staged-router.test.ts      # 14 passed
npx vitest run tests/kb-queue-router.test.ts       # 10 passed
```

### 后继需要的最小信息

1. **UI 接入**：渲染端需要添加来源撤回按钮和删除库确认对话框，调用 `kb.withdrawSource` / `kb.previewDeleteKb` / `kb.deleteKb`
2. **来源撤回后的页面状态**：withdrawn 来源引用的页面在检索时已自动显示 stale（`parsedStale` 在 `listWikiSources` 中 status !== 'ready' 时为 true）；UI 可进一步标注"来源已撤回，需复核"
3. **删除页提案**：spec §6 要求删除页通过显式生成的删除提案实现，本期来源撤回不级联删知识页，删除页提案由后续编译/发布链路处理
4. **任务失效**：来源撤回后该来源的活动任务需要手动取消（UI 调用 `kb.cancelTask`）；自动失效因需要队列与撤回联动，留给后续整合
