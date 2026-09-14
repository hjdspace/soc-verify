# 17 — 按已发布结果执行增量跳过

**What to build:** 重复导入或显式重编只重做失效工作，待审阅、拒绝和部分发布不会被误认为完整成功。

**Blocked by:** [10 — 分段编译长手册并恢复断点](10-long-source-compile.md)；[12 — 配置视觉模型并审阅图像解读](12-vision-interpretation.md)；[16 — 重编来源并按证据合并既有知识](16-source-aware-merge.md)

**Status:** done

**Smart zone:** M。此票保留独立范围，复用前序契约，不吸收其他子系统的实现或最终门禁修复。

**合并来源:** 旧稿 29。旧编号仅用于追溯；执行依赖只认上方新编号。

**最小上下文:** spec §4；源码索引 R03 的 checkIngestCache；R09 指纹思路。按符号读取需要的函数及相关测试，不载入整个参考仓库。

**依据:** [实现规格](D:/AI/soc-verify/docs/prd/knowledge-base-llm-wiki-spec.md)；[源码核查与绝对路径索引](D:/AI/soc-verify/docs/prd/knowledge-base-llm-wiki-source-audit.md)；[执行总则](../README.md)

**范围外:** 不增加自动监听、定时全库重编或缓存GC。

**验收映射:** A02 A08 A12；User Stories：27。

## Acceptance criteria

- [x] 来源/转换/视觉/模型/规则/purpose/提示及实际读依赖参与缓存指纹。
- [x] 仅完整已发布产出可成功命中，还需验证产出存在与来源/依赖有效。
- [x] awaiting_review不重复生成，全拒绝保留决定避免刷新烧token，force新建尝试。
- [x] published_partial不记录完整成功；索引刷新失败只重试索引。
- [x] 变化schema、模型、parsed或删除产出文件均能精准失效；未变化不会重复LLM调用。
- [x] 完成相关行为测试、typecheck/lint，并记录实际修改范围与验证证据。纯实验/门禁按本票实测要求验收；无代码修改不重复运行无关项目检查。

## 执行与交接

先用既有入口和小型 fixture 走通本票行为，再覆盖上述失败情形。合并票内部按“验证/前置整理 → 实现 → 行为验证”的顺序进行，不另立中间领取票；技术验证失败则保留证据并停止依赖实现，不能假定通过。

初始阅读目标不超过实际窗口约20%，争取在40%–50%前进入修改与首轮验证；这是预算而非实测保证。若需要新增架构决策、额外独立子系统或无界排错，记录具体阻塞并拆出后续工作，不能删减验收来维持票数。

完成后追加实际公开契约/符号、修改范围、验证命令与结果、后继需要的最小信息；不要求下一个 Agent 阅读过程聊天。

## 实现记录

### 公开契约/符号

**新增模块 `src/main/kb/compile-cache.ts`：**
- `computeCacheFingerprint(input: CompileCacheFingerprintInput): string` — 缓存指纹计算（sha256，因子：COMPILE_CACHE_VERSION + sourceId + sourceRevision + parsedHash + visionHash + schemaHash + purposeHash + modelFingerprint + readDependencyHash + publishedPageIds 排序）
- `checkCompileCache(kbPath, input): Promise<CheckCompileCacheResult>` — 缓存命中检查（指纹比对 + partial 排除 + 来源修订校验 + 产出文件存在性校验）
- `saveCompileCache(kbPath, sourceId, entry: CompileCacheEntry): Promise<void>` — 保存缓存条目到 `.kb/compile-cache/<sourceId>.json`
- `clearCompileCache(kbPath, sourceId): Promise<void>` — 清除缓存与拒绝记录（force 重编译用）
- `recordRejection(kbPath, sourceId, sourceRevision, rejectedAt): Promise<void>` — 记录全拒绝决定到 `.kb/compile-cache/<sourceId>.rejection.json`
- `checkRejection(kbPath, sourceId, sourceRevision): Promise<CheckRejectionResult>` — 检查拒绝记录（来源修订变化自动失效）
- 类型：`CompileCacheFingerprintInput`, `CompileCacheEntry`, `RejectionEntry`, `CheckCompileCacheResult`, `CheckRejectionResult`
- 常量：`COMPILE_CACHE_VERSION = 1`

**修改 `src/main/kb/compile.ts`：**
- `CompileResult` 新增 `CompileCacheHit` 分支（`ok: true; cached: {...}; usage: []; retryCount: 0; repairAttempted: false; chunking: null`）
- `CompileDeps` 新增 `force?: boolean`（用户显式重编译时跳过缓存与拒绝记录检查）
- `compileWikiSource` 入口处新增缓存检查块：force=false 时先查拒绝记录 → 再查缓存指纹
- 编译成功后在 stageProposal 之后计算最终 `compileCacheFingerprint` 并写入 changeSet

**修改 `src/shared/kb-types.ts`：**
- `WikiChangeSet` 新增 `compileCacheFingerprint?: string | null`

**修改 `src/main/kb/publish.ts`：**
- `publishChangeSet` 成功后调用 `saveCompileCacheAfterPublish`（compile origin + 有指纹 → saveCompileCache）
- `publishChangeSet` 全拒绝（nothingAccepted）时调用 `recordRejectionAfterPublish`
- 新增内部函数 `saveCompileCacheAfterPublish` 和 `recordRejectionAfterPublish`

**修改 `src/main/kb/ingest-queue.ts`：**
- `RunOutcome` 类型包含 `CompileCacheHit`
- `runCompile` 结果处理：缓存命中时跳过 `setPhase('validating')`，直接返回
- `settleRun`：缓存命中走 `outcome.ok` 分支，任务设为 `done`（无 staging、无发布流程）

### 修改范围

| 文件 | 变更类型 |
|------|----------|
| `src/main/kb/compile-cache.ts` | 新增（318 行） |
| `src/main/kb/compile.ts` | 修改：import 缓存模块 + `CompileCacheHit` 类型 + `force` 选项 + 缓存检查逻辑 + 指纹写入 changeSet |
| `src/shared/kb-types.ts` | 修改：`WikiChangeSet` 增加 `compileCacheFingerprint` 字段 |
| `src/main/kb/publish.ts` | 修改：import 缓存模块 + `saveCompileCacheAfterPublish` + `recordRejectionAfterPublish` + `publishChangeSet` 集成 |
| `src/main/kb/ingest-queue.ts` | 修改：`RunOutcome` 含 `CompileCacheHit` + `runCompile` 缓存命中跳过 validating |
| `tests/kb-compile-cache.test.ts` | 新增（20 个行为测试） |
| `tests/kb-compile.test.ts` | 修改：`'cached' in res` 类型守卫 + 修正 warning 断言（"来源感知合并"） |
| `tests/kb-compile-long.test.ts` | 修改：`'cached' in res` 类型守卫 |
| `tests/kb-compile-merge.test.ts` | 修改：`'cached' in res` 类型守卫 |
| `tests/kb-compile-repair.test.ts` | 修改：`'cached' in res` 类型守卫 |
| `tests/kb-compile-vision.test.ts` | 修改：`'cached' in res` 类型守卫 |

### 验证命令与结果

```
npm run typecheck          # PASS（tsconfig.node + tsconfig.web + tsconfig.runner-pi）
npm run lint               # PASS（0 errors, 0 warnings）
npx vitest run tests/kb-compile-cache.test.ts   # 20/20 passed
npx vitest run tests/kb-compile.test.ts          # 15/15 passed
npx vitest run tests/kb-compile-long.test.ts     # 8/8 passed
npx vitest run tests/kb-compile-merge.test.ts    # 2/2 passed
npx vitest run tests/kb-compile-repair.test.ts   # 15/15 passed
npx vitest run tests/kb-compile-vision.test.ts   # 8/8 passed
npx vitest run tests/kb-publish.test.ts          # 23/23 passed
npx vitest run tests/kb-ingest-queue.test.ts     # 26/26 passed
```

### 后继需要的最小信息

- **force 重编译入口**：当前 `enqueueCompile` 不传 `force`，普通编译默认检查缓存。如需 UI 层"显式重编译"按钮，在 `WikiIngestTask` 加 `force?: boolean` 标记（类似 `textOnly`），`runCompile` 传 `deps.force = task.force === true`。
- **索引刷新失败重试**：spec §4 提到"接受后衍生索引失败只重试索引，不重跑编译"。当前 publishChangeSet 的索引重建是原子提交的一部分（index.md/overview.md 在写集内），不存在单独的索引刷新失败场景。如后续拆分索引刷新为独立步骤，需补充重试逻辑。
- **缓存 GC**：范围外，不增加自动清理。缓存文件是派生数据，可安全手动删除 `.kb/compile-cache/` 目录。
