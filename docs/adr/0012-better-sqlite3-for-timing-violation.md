# better-sqlite3 作为时序违例数据存储

时序违例数据使用 `better-sqlite3` 存储，启用 WAL 模式 + PRAGMA 优化（synchronous=NORMAL, cache_size=10000, temp_store=MEMORY, mmap_size=256MB），不使用连接池。

Python 版本使用连接池是因为 Python `sqlite3` 模块是同步阻塞的，需要多连接实现并发。`better-sqlite3` 是同步 API，天然串行化，在 Electron 主进程中安全使用，不需要连接池和线程锁。批量插入性能可达 10 万+/秒（使用 `transaction()` + `prepare()` + `executemany`）。

数据库文件路径用户可配置，默认 `.socverify/timing-violation/tv.db`，与现有 `.socverify/coverage/` 约定一致。Schema 保持 3 张表（violations / confirmations / patterns）但重新设计字段和索引：violations 表新增 `seed`、`subsys` 字段，唯一键改为 `(case_name, corner, seed, hier, check_info, time_fs)`。

Considered options:
- `node:sqlite`（Node.js 22+ 内置）——API 仍在实验阶段，Electron 43 兼容性不确定。
- 保留 Python 版本的连接池——同步 API 不需要，增加复杂度。

## 实现状态

### Issue #1 + #2 已实现

- `better-sqlite3` v13 已添加到 `package.json` dependencies，`@types/better-sqlite3` v9 在 devDependencies
- `electron.vite.config.ts` 中 `better-sqlite3` 标记为 `external`（原生模块不打包）
- `tv-schema.ts` 定义 3 张表（timing_violations / confirmation_records / violation_patterns）+ 8 个索引
- `tv-database.ts` 实现 `initDatabase`（WAL + PRAGMA: synchronous=NORMAL, cache_size=10000, temp_store=MEMORY, mmap_size=256MB）、`createMemoryDatabase`（测试用）、`closeDatabase`
- `tv-repository.ts` 实现批量插入（`transaction()` + `prepare()` + `INSERT OR IGNORE`，命名参数 `@caseName` 等）、`ensureConfirmationRecords`（`INSERT INTO ... SELECT ... WHERE NOT IN`）、分页查询（动态 WHERE + ORDER BY + LIMIT/OFFSET）、统计（COUNT + GROUP BY）、元数据（DISTINCT）、清除（级联删除）
- 数据库文件路径默认 `.socverify/timing-violation/tv.db`，可通过 `config.json` 配置
- DB 实例按 `projectId` 缓存在 `violation-router.ts` 和 `confirmation-router.ts` 中（共享同一缓存键）
- 唯一键 `(case_name, corner, seed, hier, check_info, time_fs)` 实现 INSERT OR IGNORE 去重

### Issue #3 + #4 + #5 已实现

- `tv-repository.ts` 新增 `getPatterns`（查询所有 Pattern）和 `clearAllPatterns`（清除所有 Pattern）函数
- `confirmation-manager.ts` 中所有确认操作使用 `transaction()` 保证原子性：
  - `autoConfirmByResetTime` / `autoConfirmByInterval` — 批量 UPDATE confirmation_records（status='confirmed', confirmer='系统自动', is_auto_confirmed=1）
  - `updateConfirmation` — 单条 UPDATE + `savePattern`（事务内）
  - `batchUpdateConfirmations` — 批量 UPDATE + 多条 `savePattern`（事务内）
  - `savePattern` — Pattern 存在时累加 `match_count`（SELECT + UPDATE），不存在时 INSERT
- Corner 回退逻辑：指定 corner 未找到记录时回退到 `default` corner（`cornersToTry = [corner, 'default']`）
- OR 条件查询：复位时间和复位区间条件用 SQL `OR` 连接，一次查询完成

### Issue #6 + #7 已实现

**Pattern 匹配（Issue #6）**：
- `pattern-matcher.ts` 中 `findMatchingPattern` 使用两步查询：
  1. 精确匹配：`SELECT ... WHERE hier_pattern = ? AND check_pattern = ?`（`ORDER BY last_used DESC LIMIT 1`）
  2. 模糊匹配：`SELECT ... WHERE hier_pattern = ?`（获取所有相同 hier 的 Pattern，在 JS 中标准化比较）
- `applyHistoricalConfirmations` 使用 `transaction()` 保证原子性：
  - 查询 pending 违例 → 逐条匹配 Pattern → `UPDATE confirmation_records` + `UPDATE violation_patterns`（match_count + 1, last_used = now）
  - Corner 无关匹配：不使用 corner 作为查询条件
  - 支持可选 corner 过滤参数（仅应用于指定 corner 的违例）

**回归扫描与批量处理（Issue #7）**：
- `batchProcessFiles` 使用 `transaction()` + `INSERT OR IGNORE` 逐文件批量插入违例数据
- 每个文件处理后调用 `ensureConfirmationRecords` 确保确认记录同步
- 进度回调通过 `onProgress(current, total, inserted)` 传递实时进度

### Issue #8 + #9 已实现

**分布图表（Issue #8）**：
- `getStatistics` 已返回 `bySubsys` / `byCorner` / `byCase` 分布数据（Issue #3 时已实现）
- 前端 Recharts 图表组件直接消费分布数据，无需后端改动

**导出导入（Issue #9）**：
- `tv-exporter.ts` 中 `exportViolationsToExcel` / `exportViolationsToCsv` 使用 `queryViolationsForExport` 查询全部违例（含确认信息），不使用分页
- `exportPatternsToExcel` / `exportPatternsToCsv` 导出 Pattern 表全部记录
- `tv-db-transfer.ts` 中 `exportPatternsToDatabase` 创建只含 `violation_patterns` 表的独立 SQLite 文件
- `importPatternsFromDatabase` 使用 `transaction()` 保证原子性：相同 Pattern 累加 `match_count`，新 Pattern 直接 INSERT
- `mergeDatabases` 合并多个完整 DB：violations 用 `INSERT OR IGNORE` 去重，确认记录只覆盖 `pending` 状态的，Pattern 合并同 `importPatternsFromDatabase` 逻辑
- 数据库合并前自动备份（`copyFileSync` 复制目标 DB 到 `.backup-{timestamp}` 文件）
- Excel 导出使用 `exceljs` 动态 `import()` 避免影响启动性能
