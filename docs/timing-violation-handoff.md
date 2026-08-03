# 时序违例功能复刻 — 交付文档

> 本文档供后续 Agent session 使用，包含完整的设计决策、架构方案、实现计划和关键业务规则。

## 0. 文档索引

| 文档 | 路径 | 说明 |
|------|------|------|
| PRD | `docs/prd-timing-violation.md` | 产品需求文档，含 71 条用户故事和完整 Python 参考文件清单 |
| Issues | `docs/issues-timing-violation.md` | 10 个垂直切片 issue，按依赖顺序排列 |
| ADR-0011 | `docs/adr/0011-timing-violation-module-architecture.md` | 模块架构决策 |
| ADR-0012 | `docs/adr/0012-better-sqlite3-for-timing-violation.md` | 数据存储决策 |
| ADR-0013 | `docs/adr/0013-worker-thread-for-violation-parsing.md` | Worker Thread 解析决策 |
| ADR-0014 | `docs/adr/0014-vertical-slice-phasing-for-timing-violation.md` | 垂直切片实现阶段 |
| 领域术语 | `CONTEXT.md` | 时序违例域术语定义（8 个术语） |

**Issue 依赖关系图**：
```
Issue #1 (DB+解析+表格) ──────────────────────────────────────┐
  ├── Issue #2 (筛选+排序+搜索)                               │
  ├── Issue #3 (统计卡片) ──── Issue #8 (分布图表)             │
  ├── Issue #4 (自动确认)                                     │
  ├── Issue #5 (手动确认) ──── Issue #6 (Pattern匹配) ───┐    │
  ├── Issue #7 (回归扫描)                                 │    │
  ├── Issue #9 (导出导入) ◄──────────────────────────────┘    │
  └── Issue #10 (数据管理+配置+AI预留) ◄──────────────────────┘
```

## 1. 背景与目标

将 Python 版后仿时序违例处理工具（`D:\doc\python\runsim_r3p0\plugins\user\timing_violation`）复刻到 SoC Verify Electron 桌面应用中。

**核心要求**：
1. 完全实现 Python 版本的所有功能
2. 保证代码架构可扩展性（Python 版本架构不好）
3. 处理几十万条违例的性能问题
4. 文档维护，支持多 Agent session 交付

## 2. Python 项目分析摘要

### 2.1 核心功能清单

| 功能 | Python 文件 | 说明 |
|------|------------|------|
| 日志解析 | `parser.py` | 解析 `vio_summary.log`，提取 NUM/Hier/Time/Check |
| 高性能解析 | `enhanced_streaming_parser.py` | 流式分块解析，内存压力检测 |
| 数据模型 | `models.py` (2700行) | SQLite CRUD + 连接池 + 确认逻辑 + Pattern 匹配 |
| 回归扫描 | `regression_scanner.py` | 递归扫描目录树，发现 vio_summary.log |
| 回归批量 | `regression_batch_manager.py` | 批量文件选择和处理 |
| Web 展示 | `web_server.py` | 独立 HTTP 服务器，Bootstrap + Chart.js |
| 数据汇总 | `summary_web/` | HTML 报告生成，图表数据转换 |
| 配置管理 | `configuration_manager.py` | 配置持久化 |
| 自动备份 | `auto_backup.py` | 数据库自动备份 |
| 性能优化 | 多个 `*performance*` / `*memory*` 文件 | 过度工程化，大部分不需要 |

### 2.2 数据库 Schema（Python 版本）

```sql
-- timing_violations 表
id, case_name, corner, num, hier, time_fs, time_display, check_info, file_path, created_at
UNIQUE(case_name, corner, num, hier, check_info)

-- confirmation_records 表
id, violation_id, status, confirmer, result, reason, is_auto_confirmed, confirmed_at, created_at, updated_at

-- violation_patterns 表
id, hier_pattern, check_pattern, default_confirmer, default_result, default_reason, match_count, last_used
UNIQUE(hier_pattern, check_pattern)
```

### 2.3 Python 版本架构问题

1. **God Class**：`models.py` 2700 行，混杂 DB 操作、业务逻辑、Qt 信号
2. **3 套解析器重复**：`VioLogParser`、`HighPerformanceVioLogParser`、`EnhancedStreamingParser` 逻辑相同
3. **连接池 bug**：`return_connection` 内递归调用自身
4. **过度工程化**：`comprehensive_performance_system.py`、`adaptive_parser_system.py` 等文件复杂且冗余
5. **PyQt5 深度耦合**：QThread、pyqtSignal 遍布所有模块
6. **Web 服务器割裂**：独立 HTTP 服务器与桌面应用分离

### 2.4 关键业务规则（必须保留）

#### 2.4.1 日志格式

```
------------------------------------------------------------
NUM    : 1
Hier   : tb_top.xxx.xxx
Time   : 1523423 FS
Check  : setup( posedge xxx, xxx )
------------------------------------------------------------
```

- 分隔线 `----` 标记一条违例的结束
- Key-Value 格式：`KEY : VALUE`（注意 ` : ` 两侧有空格）
- Check 字段可能跨多行（后续行无 ` : ` 分隔符时追加到 Check 值）
- 必须包含 NUM、Hier、Time、Check 四个字段才算有效违例

#### 2.4.2 时间单位转换

```
FS (飞秒) → 1
PS (皮秒) → 1000
NS (纳秒) → 1000000
无单位   → 1 (假设为飞秒)
```

- `time_fs`：整型，存储为飞秒，用于比较和排序
- `time_display`：字符串，原始显示值
- `time_ns`：浮点，纳秒表示，用于自动确认条件

#### 2.4.3 Pattern Normalization（模糊匹配规则）

对 Check 信息进行标准化以实现模糊匹配：

1. 找到括号位置，**括号前的内容必须完全匹配**（检查类型必须相同）
2. 括号内按逗号分割为三部分：
   - 第 1 部分：去除冒号后的时间信息，只匹配冒号前内容
   - 第 2 部分：同上
   - 第 3 部分：完全忽略
3. 比较标准化后的结果

示例：
```
原始: setup( posedge clk: 1523423 FS, negedge data: 100 PS, margin: -50 PS)
标准化: setup( posedge clk, negedge data)
```

#### 2.4.4 Corner 列表（Unisoc 默认）

```
npg_f1_ssg, npg_f2_ssg, npg_f3_ssg, npg_f4_ssg, npg_f5_ssg, npg_f6_ssg, npg_f7_ssg
npg_f1_ffg, npg_f2_ffg, npg_f3_ffg, npg_f4_ffg, npg_f5_ffg, npg_f6_ffg, npg_f7_ffg
npg_f1_tt, npg_f2_tt, npg_f3_tt
```

#### 2.4.5 回归目录结构

**标准模式**：
```
./regression/<subsys>/.../<case_name>_<corner_name>/<case_name>_<seed_number>/log/vio_summary.log
```

**通用模式**：
```
./regression/任意层级目录/<case_name>_<seed_number>/log/vio_summary.log
```

- 用例状态检测：检查同目录下是否存在 `sprd_log_pass.log` 文件
- 子系统识别：目录名以 `_sys` 结尾或为 `top`

#### 2.4.6 自动确认规则

1. **复位时间确认**：`time_fs <= reset_time_ns * 1000000` 且 status='pending' 的违例自动确认
2. **复位区间确认**：`time_fs` 在 `[interval_start_ns, interval_end_ns]` 范围内的违例自动确认
3. **Corner 回退**：如果指定 corner 未找到记录，回退到 `default` corner
4. **历史模式应用**：精确匹配 (hier, check_info) → 模糊匹配 (normalized check_info)

## 3. 设计决策汇总

所有决策经过 grilling 会话与用户确认，详见 ADR：

| 决策 | ADR | 选项 |
|------|-----|------|
| 模块位置 | [0011](./adr/0011-timing-violation-module-architecture.md) | 主进程新模块 `src/main/timing-violation/` + tRPC |
| 数据存储 | [0012](./adr/0012-better-sqlite3-for-timing-violation.md) | `better-sqlite3` + WAL + PRAGMA，无连接池 |
| DB 路径 | 0012 | 用户可配置，默认 `.socverify/timing-violation/tv.db` |
| Schema | 0012 | 3 表保持，重新设计字段和索引 |
| 解析器 | [0013](./adr/0013-worker-thread-for-violation-parsing.md) | 单一解析器，Node.js 流式 I/O |
| Worker Thread | 0013 | Worker Thread 解析 + 主进程批量插入 |
| Corner 列表 | — | 项目级配置 `.socverify/timing-violation/config.json` |
| Dashboard UI | 0011 | CenterArea 新 Destination + 虚拟滚动 + Recharts |
| Pattern 匹配 | — | 完全复刻 Python `_normalize_check_info` 逻辑 |
| 回归扫描 | 0011 | 独立扫描器，不复用现有 regression 模块 |
| Router 拆分 | 0011 | violation / confirmation / pattern / scan 四个子 router |
| 导出 | — | 全部复刻，Excel 用 `exceljs` |
| AI 集成 | — | 预留接口，本期不实现 |
| 文件结构 | 0011 | 分层式：db/ parser/ scanner/ confirm/ export/ |
| 前端 | 0011 | 按功能拆分组件 + 独立 Zustand store |
| 测试 | — | 3 条缝：tRPC 集成 + 组件 + 解析器单测 |
| 实现阶段 | [0014](./adr/0014-vertical-slice-phasing-for-timing-violation.md) | 垂直切片 3 阶段 |

## 4. 架构设计

### 4.1 主进程文件结构

```
src/main/timing-violation/
├── db/
│   ├── tv-database.ts            # 数据库管理（初始化、PRAGMA、迁移）
│   ├── tv-repository.ts          # 数据访问层（CRUD 操作）
│   └── tv-schema.ts              # Schema 定义和迁移脚本
├── parser/
│   ├── vio-parser.ts             # 日志解析器（纯函数，无副作用）
│   ├── parser-worker.ts          # Worker Thread 入口
│   └── time-utils.ts             # 时间单位转换工具
├── scanner/
│   ├── violation-scanner.ts      # 回归目录扫描器
│   └── path-parser.ts            # 目录路径解析（提取 subsys/corner/case/seed）
├── confirm/
│   ├── confirmation-manager.ts   # 确认逻辑（自动+手动）
│   ├── pattern-matcher.ts        # Pattern 匹配（精确+模糊）
│   └── pattern-normalizer.ts     # Check 信息标准化
├── export/
│   ├── tv-exporter.ts            # 导出（Excel/CSV）
│   └── tv-db-transfer.ts         # DB 导出导入合并
├── tv-config.ts                  # 配置管理（Corner 列表、DB 路径等）
└── types.ts                      # 类型定义

src/main/ipc/routers/
├── violation-router.ts           # 违例相关 API（解析、查询、统计）
├── confirmation-router.ts        # 确认相关 API（自动、手动、批量）
├── pattern-router.ts             # Pattern 相关 API（CRUD、导出导入）
└── scan-router.ts                # 回归扫描 API（扫描、批量处理）
```

### 4.2 渲染进程文件结构

```
src/renderer/src/components/timing-violation/
├── TVDashboard.tsx               # 主容器
├── TVStatsCards.tsx              # 统计卡片（总数/已确认/待确认）
├── TVDistributionCharts.tsx      # 分布图表（Recharts）
├── TVViolationTable.tsx          # 虚拟滚动表格
├── TVConfirmationDialog.tsx      # 确认对话框
├── TVScanProgress.tsx            # 回归扫描进度
├── TVPatternManager.tsx          # Pattern 管理面板
└── TVFilterBar.tsx               # 筛选栏（case/corner/status/subsys）

src/renderer/src/stores/
└── timing-violation.ts           # Zustand store
```

### 4.3 数据库 Schema 设计（TypeScript 版本）

```sql
-- timing_violations 表
CREATE TABLE IF NOT EXISTS timing_violations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_name TEXT NOT NULL,
    corner TEXT,
    seed TEXT,
    subsys TEXT,
    num INTEGER NOT NULL,
    hier TEXT NOT NULL,
    time_fs INTEGER NOT NULL,
    time_display TEXT NOT NULL,
    check_info TEXT NOT NULL,
    file_path TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    UNIQUE(case_name, corner, seed, hier, check_info, time_fs)
);

-- confirmation_records 表（1:1 with violations）
CREATE TABLE IF NOT EXISTS confirmation_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    violation_id INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    confirmer TEXT,
    result TEXT,
    reason TEXT,
    is_auto_confirmed INTEGER DEFAULT 0,
    confirmed_at TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (violation_id) REFERENCES timing_violations(id)
);

-- violation_patterns 表
CREATE TABLE IF NOT EXISTS violation_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hier_pattern TEXT NOT NULL,
    check_pattern TEXT NOT NULL,
    default_confirmer TEXT,
    default_result TEXT,
    default_reason TEXT,
    match_count INTEGER DEFAULT 1,
    last_used TEXT DEFAULT (datetime('now', 'localtime')),
    UNIQUE(hier_pattern, check_pattern)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_violations_case_corner ON timing_violations(case_name, corner);
CREATE INDEX IF NOT EXISTS idx_violations_hier_check ON timing_violations(hier, check_info);
CREATE INDEX IF NOT EXISTS idx_violations_subsys ON timing_violations(subsys);
CREATE INDEX IF NOT EXISTS idx_violations_time_fs ON timing_violations(time_fs);
CREATE INDEX IF NOT EXISTS idx_violations_created_at ON timing_violations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_confirmations_violation ON confirmation_records(violation_id);
CREATE INDEX IF NOT EXISTS idx_confirmations_status ON confirmation_records(status);
CREATE INDEX IF NOT EXISTS idx_patterns_hier_check ON violation_patterns(hier_pattern, check_pattern);
```

**与 Python 版本的差异**：
- 新增 `seed`、`subsys` 字段
- 唯一键改为 `(case_name, corner, seed, hier, check_info, time_fs)` — 移除 `num`（文件内序号不适合做唯一键）
- `confirmation_records.violation_id` 加 `UNIQUE` 约束确保 1:1
- 简化索引（移除冗余的覆盖索引）

### 4.4 tRPC API 设计

#### violation-router

```typescript
// 解析单个日志文件
parseLog: mutation({ input: { filePath: string, caseName?: string, corner?: string } })
  → { success: boolean, count: number, errors: string[] }

// 分页查询违例列表
queryViolations: query({ input: {
  page: number, pageSize: number,
  caseName?: string, corner?: string, status?: string,
  subsys?: string, searchText?: string,
  sortField?: string, sortOrder?: 'asc' | 'desc'
} })
  → { total: number, items: ViolationWithConfirmation[] }

// 获取统计信息
getStatistics: query({ input: { caseName?: string, corner?: string } })
  → { total: number, confirmed: number, pending: number, ignored: number,
      bySubsys: Record<string, number>, byCorner: Record<string, number>,
      byCase: Record<string, number> }

// 获取元数据（corner列表、case列表等）
getMetadata: query()
  → { corners: string[], cases: string[], subsys: string[] }

// 清除用例数据
clearCaseData: mutation({ input: { caseName: string, corner?: string } })
```

#### confirmation-router

```typescript
// 自动确认（复位时间）
autoConfirmByResetTime: mutation({
  input: { caseName: string, corner: string, resetTimeNs: number }
}) → { confirmedCount: number }

// 自动确认（复位区间）
autoConfirmByInterval: mutation({
  input: { caseName: string, corner: string,
           resetTimeNs?: number,
           intervalStartNs?: number, intervalEndNs?: number }
}) → { confirmedCount: number }

// 手动确认单条
updateConfirmation: mutation({
  input: { violationId: number, status: string,
           confirmer: string, result: string, reason: string }
}) → { success: boolean }

// 批量确认
batchUpdateConfirmations: mutation({
  input: { violationIds: number[], status: string,
           confirmer: string, result: string, reason: string }
}) → { updatedCount: number }

// 应用历史确认
applyHistoricalConfirmations: mutation({
  input: { caseName: string, corner?: string }
}) → { appliedCount: number }

// AI 辅助确认（预留接口）
suggestConfirmation: query({
  input: { violationId: number }
}) → { confirmer?: string, result?: string, reason?: string, confidence?: number }
```

#### pattern-router

```typescript
// 获取所有 Pattern
getPatterns: query() → Pattern[]

// 获取 Pattern 建议
getPatternSuggestion: query({
  input: { hier: string, check: string }
}) → PatternSuggestion | null

// 保存 Pattern
savePattern: mutation({
  input: { hier: string, check: string, confirmer: string,
           result: string, reason: string }
}) → { success: boolean }

// 清除所有 Pattern
clearAllPatterns: mutation() → { success: boolean }

// 导出 Pattern
exportPatterns: mutation({
  input: { format: 'excel' | 'csv' | 'db', filePath: string }
}) → { success: boolean }

// 导入 Pattern
importPatterns: mutation({
  input: { filePath: string }
}) → { importedCount: number, updatedCount: number }

// 导出违例数据
exportViolations: mutation({
  input: { format: 'excel' | 'csv', filePath: string,
           caseName?: string, corner?: string }
}) → { success: boolean }
```

#### scan-router

```typescript
// 扫描回归目录
scanRegression: mutation({
  input: { regressionRoot: string, useStandardStructure: boolean }
}) → { scanResult: RegressionScanResult }

// 批量处理
batchProcess: mutation({
  input: { filePaths: string[], options: BatchProcessOptions }
}) → { result: BatchProcessResult }

// 获取批量处理进度
getBatchProgress: subscription() → BatchProgress
```

### 4.5 配置文件格式

`.socverify/timing-violation/config.json`:

```json
{
  "dbPath": ".socverify/timing-violation/tv.db",
  "corners": [
    "npg_f1_ssg", "npg_f2_ssg", "npg_f3_ssg", "npg_f4_ssg",
    "npg_f5_ssg", "npg_f6_ssg", "npg_f7_ssg",
    "npg_f1_ffg", "npg_f2_ffg", "npg_f3_ffg", "npg_f4_ffg",
    "npg_f5_ffg", "npg_f6_ffg", "npg_f7_ffg",
    "npg_f1_tt", "npg_f2_tt", "npg_f3_tt"
  ],
  "subsysPatterns": ["*_sys$", "^top$", "*_subsys$"],
  "defaultResetTimeNs": 1000,
  "autoBackup": true,
  "backupInterval": 100
}
```

## 5. 实现计划

### Phase 1 — 最小闭环（单文件解析 → 存储 → 列表展示）

**主进程**：
- [ ] `src/main/timing-violation/types.ts` — 类型定义
- [ ] `src/main/timing-violation/tv-config.ts` — 配置管理
- [ ] `src/main/timing-violation/db/tv-schema.ts` — Schema 定义
- [ ] `src/main/timing-violation/db/tv-database.ts` — DB 初始化、PRAGMA
- [ ] `src/main/timing-violation/db/tv-repository.ts` — 基础 CRUD
- [ ] `src/main/timing-violation/parser/time-utils.ts` — 时间转换
- [ ] `src/main/timing-violation/parser/vio-parser.ts` — 日志解析器
- [ ] `src/main/timing-violation/parser/parser-worker.ts` — Worker Thread
- [ ] `src/main/ipc/routers/violation-router.ts` — parseLog + queryViolations + getStatistics + getMetadata
- [ ] 在 `src/main/ipc/router.ts` 注册 violation sub-router
- [ ] `package.json` 添加 `better-sqlite3` 依赖

**渲染进程**：
- [ ] `src/renderer/src/stores/timing-violation.ts` — Zustand store
- [ ] `src/renderer/src/components/timing-violation/TVDashboard.tsx` — 主容器
- [ ] `src/renderer/src/components/timing-violation/TVStatsCards.tsx` — 统计卡片
- [ ] `src/renderer/src/components/timing-violation/TVViolationTable.tsx` — 虚拟滚动表格
- [ ] `src/renderer/src/components/timing-violation/TVFilterBar.tsx` — 筛选栏
- [ ] 在 CenterArea 中注册 `timing-violation` Destination
- [ ] 添加 `@tanstack/react-virtual` 依赖（虚拟滚动）

**测试**：
- [ ] 解析器单测（各种日志格式、边界情况）
- [ ] tRPC violation-router 集成测试
- [ ] TVDashboard 组件测试

**验证**：
```sh
npm run build && npm run typecheck && npm run test
```

### Phase 2 — 完整确认流程

**主进程**：
- [ ] `src/main/timing-violation/confirm/pattern-normalizer.ts` — Check 标准化
- [ ] `src/main/timing-violation/confirm/pattern-matcher.ts` — 精确+模糊匹配
- [ ] `src/main/timing-violation/confirm/confirmation-manager.ts` — 自动+手动确认
- [ ] `src/main/ipc/routers/confirmation-router.ts` — 所有确认 API
- [ ] `src/main/ipc/routers/pattern-router.ts` — Pattern CRUD API
- [ ] 在 router.ts 注册 confirmation + pattern sub-router

**渲染进程**：
- [ ] `src/renderer/src/components/timing-violation/TVConfirmationDialog.tsx` — 确认对话框
- [ ] `src/renderer/src/components/timing-violation/TVPatternManager.tsx` — Pattern 管理
- [ ] 更新 store 添加确认相关状态

**测试**：
- [ ] Pattern Normalizer 单测（精确匹配、模糊匹配、边界情况）
- [ ] Confirmation Manager 单测（复位时间、复位区间、历史模式）
- [ ] confirmation-router + pattern-router 集成测试

### Phase 3 — 高级功能

**主进程**：
- [ ] `src/main/timing-violation/scanner/violation-scanner.ts` — 回归扫描器
- [ ] `src/main/timing-violation/scanner/path-parser.ts` — 路径解析
- [ ] `src/main/timing-violation/export/tv-exporter.ts` — Excel/CSV 导出
- [ ] `src/main/timing-violation/export/tv-db-transfer.ts` — DB 导出导入合并
- [ ] `src/main/ipc/routers/scan-router.ts` — 扫描 API
- [ ] 更新 pattern-router 添加导出导入 API
- [ ] 添加 `exceljs` 依赖

**渲染进程**：
- [ ] `src/renderer/src/components/timing-violation/TVDistributionCharts.tsx` — Recharts 图表
- [ ] `src/renderer/src/components/timing-violation/TVScanProgress.tsx` — 扫描进度
- [ ] 添加 `recharts` 依赖
- [ ] 在 TitleBar 或 LeftRail 中添加时序违例入口

**测试**：
- [ ] 回归扫描器单测
- [ ] 导出功能单测
- [ ] scan-router 集成测试
- [ ] 图表组件测试

## 6. 依赖添加

```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "exceljs": "^4.4.0",
    "recharts": "^2.12.0",
    "@tanstack/react-virtual": "^3.5.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

## 7. 关键实现注意事项

### 7.1 Worker Thread 配置

`electron.vite.config.ts` 需要配置 Worker Thread 构建。确保 worker 文件以正确的格式输出：

```typescript
// electron.vite.config.ts 中可能需要添加
worker: {
  format: 'es', // 或 'cjs'，取决于 Electron 主进程配置
}
```

Worker 通过 `new Worker(new URL('./parser-worker.ts', import.meta.url))` 创建。

### 7.2 better-sqlite3 原生编译

`better-sqlite3` 需要原生编译。在 Electron 中使用需要：

```sh
# 重新编译为 Electron 的 Node.js 版本
npx electron-rebuild
```

或在 `package.json` 中添加 postinstall 脚本。

### 7.3 批量插入性能

```typescript
// 推荐的批量插入模式
const insertMany = db.transaction((violations: Violation[]) => {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO timing_violations
    (case_name, corner, seed, subsys, num, hier, time_fs, time_display, check_info, file_path)
    VALUES (@caseName, @corner, @seed, @subsys, @num, @hier, @timeFs, @timeDisplay, @checkInfo, @filePath)
  `);
  for (const v of violations) {
    stmt.run(v);
  }
});
```

### 7.4 虚拟滚动表格

使用 `@tanstack/react-virtual` 实现虚拟滚动，避免渲染几十万行 DOM 节点：

```typescript
const rowVirtualizer = useVirtualizer({
  count: data.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 36, // 行高
  overscan: 10,
});
```

### 7.5 进度回调

Worker Thread 通过 `parentPort.postMessage` 分批发送结果：

```typescript
// parser-worker.ts 中
const BATCH_SIZE = 1000;
let batch: Violation[] = [];

for await (const violation of parseStream(filePath)) {
  batch.push(violation);
  if (batch.length >= BATCH_SIZE) {
    parentPort.postMessage({ type: 'batch', violations: batch, count: totalCount });
    batch = [];
  }
}
if (batch.length > 0) {
  parentPort.postMessage({ type: 'batch', violations: batch, count: totalCount });
}
parentPort.postMessage({ type: 'done', count: totalCount });
```

### 7.6 Workbench Destination 注册

参考现有 `src/renderer/src/components/layout/CenterArea.tsx` 中 Destination 的注册方式，添加 `timing-violation` 类型。

## 8. CONTEXT.md 已更新

时序违例领域术语已添加到 `CONTEXT.md`，包含以下定义：

- Timing Violation
- Violation Confirmation
- Violation Pattern
- Corner
- Reset Time
- Regression Scan
- Violation Dashboard
- Pattern Normalization

## 9. ADR 索引

| ADR | 标题 |
|-----|------|
| [0011](./adr/0011-timing-violation-module-architecture.md) | Timing Violation 模块架构 |
| [0012](./adr/0012-better-sqlite3-for-timing-violation.md) | better-sqlite3 作为时序违例数据存储 |
| [0013](./adr/0013-worker-thread-for-violation-parsing.md) | Worker Thread 用于时序违例日志解析 |
| [0014](./adr/0014-vertical-slice-phasing-for-timing-violation.md) | 时序违例功能垂直切片实现阶段 |

## 10. Python 源文件参考

| 功能 | Python 文件路径 | 行数 |
|------|-----------------|------|
| 日志解析 | `plugins/user/timing_violation/parser.py` | 747 |
| 数据模型 | `plugins/user/timing_violation/models.py` | 2704 |
| 增强解析 | `plugins/user/timing_violation/enhanced_streaming_parser.py` | 775 |
| 回归扫描 | `plugins/user/timing_violation/regression_scanner.py` | 582 |
| 回归批量 | `plugins/user/timing_violation/regression_batch_manager.py` | ~300 |
| Web 服务器 | `plugins/user/timing_violation/web_server.py` | ~2900 |
| 图表数据 | `plugins/user/timing_violation/summary_web/chart_data_converter.py` | ~430 |
| 数据汇总 | `plugins/user/timing_violation/summary_web/data_summary_processor.py` | ~600 |

**注意**：Python 项目路径为 `D:\doc\python\runsim_r3p0\plugins\user\timing_violation`，utils 在 `D:\doc\python\runsim_r3p0\utils`。
