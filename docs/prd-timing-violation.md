# PRD: 后仿时序违例处理 — 日志解析 + 确认流程 + Dashboard 展示

## Problem Statement

SoC 验证工程师在后仿真阶段面临大量时序违例（Timing Violation）需要逐一确认。现有流程依赖一个独立的 Python 工具（PyQt5 桌面应用 + Web 服务器），存在以下痛点：

1. **工具割裂**：时序违例确认工具独立于 SoC Verify 平台运行，工程师需要在多个工具间切换，无法在同一桌面应用中完成从仿真到违例确认的全流程。

2. **Python 版本架构差**：Python 版本的 `models.py` 是 2700 行的 God Class，混杂数据库操作、业务逻辑和 Qt 信号；3 套解析器逻辑重复（`VioLogParser`、`HighPerformanceVioLogParser`、`EnhancedStreamingParser`）；过度工程化的性能优化文件（`comprehensive_performance_system.py`、`adaptive_parser_system.py` 等）增加维护负担。复刻时必须重新设计架构。

3. **大数据集性能瓶颈**：时序违例可能达几十万条，Python 版本用多线程解析 + 手动 GC 管理来应对，但在 Electron 主进程中不能阻塞 IPC 和窗口管理，需要不同的性能策略。

4. **Web 展示与桌面应用割裂**：Python 版本通过独立 HTTP 服务器提供 Web 展示，与 PyQt5 桌面窗口分离。在 SoC Verify 中应集成到渲染进程的 React UI 中。

## Solution

将 Python 版后仿时序违例处理工具完整复刻到 SoC Verify Electron 桌面应用中，作为主进程新模块 `src/main/timing-violation/` 实现，通过 tRPC router 暴露 API，前端在 CenterArea 中以新的 Workbench Destination 展示 Violation Dashboard。

**日志解析**：单一解析器实现（替代 Python 版本的 3 套），使用 Node.js 流式 I/O（`readline` + `fs.createReadStream`）天然支持流式读取和背压。解析工作在 Worker Thread 中执行，主进程只负责数据库批量插入，不阻塞 UI。

**数据存储**：使用 `better-sqlite3`（同步 API，无需连接池）+ WAL 模式 + PRAGMA 优化。3 张表（timing_violations / confirmation_records / violation_patterns）重新设计字段和索引，新增 `seed` 和 `subsys` 字段。

**确认流程**：完全复刻 Python 版本的自动确认（复位时间/复位区间）、手动确认（单条/批量）、历史 Pattern 匹配（精确 + 模糊匹配 + Pattern Normalization）。

**Dashboard 展示**：CenterArea 新 Destination，统计卡片 + 分布图表（Recharts）+ 虚拟滚动表格（`@tanstack/react-virtual`），取代 Python 版本的独立 Web 服务器。

**导出**：全部复刻 Excel（`exceljs`）/ CSV / DB 导出导入合并功能。

**AI 集成**：预留 `suggestConfirmation` 接口，本期不实现 AI 辅助确认。

## Python 参考文件清单

> 以下 Python 文件是功能复刻的参考来源，位于 `D:\doc\python\runsim_r3p0\plugins\user\timing_violation\` 目录下。每个文件标注了对应的复刻目标和关键逻辑。

### 核心功能文件

| Python 文件 | 行数 | 复刻目标 | 关键逻辑说明 |
|-------------|------|---------|-------------|
| `parser.py` | 747 | `parser/vio-parser.ts` + `parser/time-utils.ts` + `parser/parser-worker.ts` | 日志解析器主体。`VioLogParser` 类：逐行解析 `----` 分隔的 key-value 对，`_validate_violation` 验证四字段完整性，`_process_violation` 转换时间单位，`convert_time_to_fs` / `convert_time_to_ns` 时间转换。`CaseInfoParser` 类：从目录名解析 case_name 和 corner，VALID_CORNERS 列表。`AsyncVioLogParser` / `HighPerformanceAsyncParser`：QThread 异步包装（Node.js 用 Worker Thread 替代）。`HighPerformanceVioLogParser`：流式分块解析（Node.js 用 readline 替代）。 |
| `models.py` | 2704 | `db/tv-database.ts` + `db/tv-repository.ts` + `confirm/confirmation-manager.ts` + `confirm/pattern-matcher.ts` + `confirm/pattern-normalizer.ts` | **God Class，需拆分**。`DatabaseConnectionPool`：连接池（better-sqlite3 不需要）。`ViolationDataModel`：数据库初始化 + PRAGMA 配置 + 表创建 + 索引创建；`add_violations` 批量插入（含 fallback）；`sync_batch_confirmations` 批量同步确认；`update_confirmation` 单条确认更新；`auto_confirm_by_reset_time` 复位时间自动确认；`auto_confirm_by_reset_time_and_interval` 复位区间自动确认；`save_pattern` / `get_pattern_suggestions` / `apply_historical_confirmations` Pattern 匹配与应用；`_normalize_check_info` Check 信息标准化（模糊匹配核心逻辑）；`batch_update_confirmations` 批量更新；`export_patterns_to_excel` / `export_patterns_to_csv` / `export_patterns_to_database` 导出；`import_patterns_from_database` 导入；`merge_databases` / `_merge_single_database` / `_merge_confirmation_records` / `_merge_violation_patterns` 数据库合并；`backup_database` 备份；`get_database_statistics` 统计。 |
| `enhanced_streaming_parser.py` | 775 | `parser/vio-parser.ts`（合并到单一解析器） | `ViolationAwareChunker`：按违例记录分块。`MemoryPressureDetector`：内存压力检测（Node.js 不需要，V8 GC 自动管理）。`EnhancedStreamingParser`：分块流式解析 + 自适应块大小。**Node.js 版本不需要这套，用 readline 流式 I/O 替代。** |
| `regression_scanner.py` | 582 | `scanner/violation-scanner.ts` + `scanner/path-parser.ts` | `RegressionFileInfo` / `RegressionScanResult` dataclass。`RegressionDirectoryScanner`：递归扫描目录树，`_parse_standard_structure` 解析标准目录结构（`<case>_<corner>/<case>_<seed>/log/vio_summary.log`），`_parse_flexible_structure` 通用模式解析，`_detect_case_status` 检测 PASS/FAIL（检查 `sprd_log_pass.log`），`_find_corner_in_path` / `_find_subsys_in_path` 从路径提取元信息，按 subsys/corner/case/status 分组。`AsyncRegressionScanner`：QThread 异步包装。 |
| `regression_batch_manager.py` | ~300 | `scanner/violation-scanner.ts`（批量处理逻辑） | `BatchProcessConfig` / `BatchProcessResult` dataclass。`RegressionBatchManager`：管理扫描结果、文件选择状态、批量处理配置。`set_scan_result` / `get_subsys_list` / `get_corner_list` / `get_case_list` / `toggle_file_selection` / `process_selected_files`。 |
| `web_server.py` | ~2900 | `routers/violation-router.ts` + `routers/confirmation-router.ts`（API 部分） + `components/timing-violation/*`（UI 部分） | `ViolationWebAPI`：HTTP API 处理器。`get_metadata` 获取 corner/case 列表；`get_violations` 分页查询违例（含筛选排序）；`get_statistics` 统计信息；`update_violation` 更新确认；`batch_update` 批量确认；`auto_confirm` 自动确认；`get_patterns` / `save_pattern` Pattern 管理；`export_data` 导出。**Web 服务器本身不需要，API 逻辑迁移到 tRPC router。** |
| `configuration_manager.py` | ~1000 | `tv-config.ts` | `ConfigurationManager` 类：管理基于违例数量的性能配置文件（`PerformanceProfile` dataclass）。`_load_profiles` / `_load_settings` / `_load_usage_history` 加载配置；`auto_select_profile` 根据违例数量自动选择配置；`get_current_profile` 获取当前配置。**Node.js 版本不需要性能 profile 系统，但配置持久化（Corner 列表、复位时间默认值、自动备份设置）需要保留。** |
| `auto_backup.py` | ~320 | `db/tv-database.ts`（backup 方法） | `DatabaseBackupManager`：数据库自动备份。`create_backup` 创建备份（优先文件复制，备用 SQLite API）；`_backup_by_file_copy` 文件复制备份；`_backup_by_sqlite_api` SQLite API 备份；`_verify_backup_quick` 验证备份；`_cleanup_old_backups` 清理旧备份（保留 5 份）；`start_auto_backup` / `stop_auto_backup` 定时备份线程。 |
| `config/performance_profiles.json` | 325 | — | 性能配置文件 JSON（small/medium/large/very_large_dataset 四档），含 parser_config、display_config、memory_config、ui_config、optimization_config。**Node.js 版本不需要，配置由 `tv-config.ts` 管理。** |
| `__init__.py` | — | — | 包初始化文件，无业务逻辑。 |

### Web 展示文件（UI 参考）

| Python 文件 | 行数 | 复刻目标 | 关键逻辑说明 |
|-------------|------|---------|-------------|
| `summary_web/chart_data_converter.py` | ~430 | `components/timing-violation/TVDistributionCharts.tsx` | `ChartDataConverter`：将统计数据转换为 Chart.js 格式。`convert_status_pie_chart` 状态分布饼图；`convert_subsystem_bar_chart` 子系统违例柱状图；`convert_corner_comparison_chart` corner 对比图。**Node.js 版本用 Recharts 替代 Chart.js，数据转换逻辑参考但重写。** |
| `summary_web/data_summary_processor.py` | ~600 | `routers/violation-router.ts`（统计 API） | `HighPerformanceDataProcessor`：高性能 Excel 数据汇总。`_parse_directory_structure` 解析目录结构；`_scan_excel_files` 扫描 Excel 文件；`_parse_excel_data_pandas` / `_parse_excel_data_optimized` 数据解析；`_generate_summary_statistics` 生成统计；`_generate_html_report` 生成 HTML 报告。**HTML 报告生成不需要，统计逻辑迁移到 tRPC。** |
| `summary_web/data_summary_dialog.py` | ~280 | — | `DataSummaryDialog`（PyQt5 QDialog）：Excel 目录选择、数据汇总进度展示、HTML 报告打开。**不需要复刻，用 React 组件替代。** |
| `summary_web/html_generator.py` | ~1900 | — | `HTMLReportGenerator`：使用 Jinja2 模板生成静态 HTML 报告。`generate_report` 生成完整报告；`_copy_assets` 复制 CSS/JS 资源；`_generate_charts` / `_generate_tables` / `_generate_statistics` 生成各组件 HTML。**不需要复刻，Dashboard 直接用 React 渲染。** |
| `summary_web/jinja2_template_engine.py` | ~140 | — | `Jinja2TemplateEngine`：Jinja2 模板引擎封装，含 `tojson` / `percentage` 自定义过滤器。**不需要复刻。** |
| `summary_web/template_engine.py` | ~250 | — | `TemplateEngine`：简化版 HTML 模板引擎（不依赖 Jinja2），支持变量替换、模板包含、条件渲染。**不需要复刻。** |
| `summary_web/template_config_manager.py` | ~250 | — | `TemplateConfigManager`：模板配置管理，加载/保存 `template_config.json`。**不需要复刻。** |
| `summary_web/config/template_config.json` | ~100 | — | 模板路径和默认变量配置。**不需要复刻。** |
| `summary_web/error_handler.py` | ~230 | — | `ErrorHandler`：Web 报告生成时的错误处理和恢复策略。**不需要复刻。** |
| `summary_web/performance_optimizer.py` | ~200 | — | `PerformanceOptimizer`：Web 报告分页和懒加载优化。**不需要复刻，前端用虚拟滚动替代。** |
| `summary_web/test_pagination.py` | ~160 | — | 分页功能测试脚本。**不需要复刻。** |
| `summary_web/__init__.py` | — | — | 包初始化文件，无业务逻辑。 |
| `summary_web/templates/` | — | UI 布局参考 | Jinja2 HTML 模板（`base.html`、`summary_report.html`、`components/charts.html`、`components/tables.html`、`components/statistics.html`、`components/filters.html`、`components/header.html`、`components/violation_records.html`、`components/optimized_charts.html`、`components/performance_optimized_table.html`），作为 Dashboard 布局参考。 |
| `summary_web/assets/js/` | — | UI 交互参考 | `summary.js`（主交互逻辑）、`components.js`（组件交互）、`subsystem_charts.js`（子系统图表）、`chart_data_utils.js`（图表数据工具），作为前端交互参考。 |
| `summary_web/assets/css/` | — | UI 样式参考 | `custom.css`、`summary.css`、`components.css` 等样式文件，作为 Dashboard 样式参考。 |

### 可忽略的文件（过度工程化，不需要复刻）

| Python 文件 | 原因 |
|-------------|------|
| `comprehensive_performance_system.py` | 过度工程化的性能系统，Node.js 不需要 |
| `comprehensive_error_handler.py` | 通用错误处理，Node.js 有更好的方案 |
| `adaptive_parser_system.py` | 自适应解析系统，单一解析器足够 |
| `automatic_memory_optimizer.py` | 内存优化器，V8 GC 自动管理 |
| `component_interaction_optimizer.py` | 组件交互优化器，不需要 |
| `integrated_memory_system.py` | 内存系统集成，不需要 |
| `memory_manager.py` | 内存管理器，不需要 |
| `performance_integration_system.py` | 性能集成系统，不需要 |
| `performance_optimizer.py` | 性能优化器，不需要 |
| `performance_reporting_system.py` | 性能报告系统，不需要 |
| `profile_optimizer.py` | Profile 优化器，不需要 |
| `violation_data_streaming.py` | 数据流式传输，不需要 |
| `violation_performance_monitor.py` | 性能监控，不需要 |
| `database_monitor.py` | 数据库监控，不需要 |
| `diagnose_database.py` | 数据库诊断工具，不需要 |
| `smart_ui_renderer.py` | 智能 UI 渲染器，不需要 |
| `optimization_suggestion_engine.py` | 优化建议引擎，不需要 |
| `strategy_manager.py` | 策略管理器，不需要 |
| `main_window.py` / `main_window_integration.py` | PyQt5 主窗口，用 React 替代 |
| `configuration_dialog.py` / `corner_selection_dialog.py` | PyQt5 对话框，用 React 组件替代 |
| `regression_batch_ui.py` | PyQt5 回归批量 UI，用 React 组件替代 |
| `start_web_server.py` / `start_web_server_linux.py` | Web 服务器启动脚本，不需要 |
| `start_with_protection.py` | 保护模式启动，不需要 |
| `enhanced_batch_processor.py` | `MemoryAwareBatchProcessor`：内存感知批处理器，自适应批大小。Node.js 不需要。 |
| `performance_integration_example.py` | 性能集成系统示例代码，不需要 |
| `generate_test_data.py` | 测试数据生成器，不需要 |
| `install_dependencies.py` | 依赖安装脚本，不需要 |
| `README.md` | 项目说明文档，作为需求参考已分析 |
| `demo_database_merge.py` | 数据库合并演示脚本，不需要 |
| `diagnose_linux_issue.py` | Linux 问题诊断脚本，不需要 |
| `fuzzy_matching_demo.py` | 模糊匹配演示脚本，不需要 |
| `linux_compatibility_fix.py` | Linux 兼容性修复，不需要 |
| `performance_test.py` | 性能测试脚本，不需要 |
| `verify_merge_functions.py` | 合并函数验证脚本，不需要 |
| `.gitignore` / `CACHEDIR.TAG` / `lastfailed` / `nodeids` | Git/pytest 缓存文件，不需要 |

### 测试文件参考

> 以下 Python 测试文件可作为测试用例设计参考，位于 `D:\doc\python\runsim_r3p0\plugins\user\timing_violation\` 根目录和 `summary_web/tests/` 目录下。**不需要复刻测试代码本身**，但可参考其测试场景设计 TypeScript 测试。

| Python 测试文件 | 参考价值 |
|----------------|---------||
| `test_fuzzy_matching.py` | Pattern 模糊匹配的测试用例设计 |
| `test_corner_independent.py` | Pattern corner 无关匹配的测试用例 |
| `test_database_merge.py` / `test_merge_simple.py` | 数据库合并的测试用例 |
| `test_database_duplicate_fix.py` | 违例去重的测试用例 |
| `test_large_data_cleanup.py` | 大数据集清理的测试用例 |
| `test_summary_table.py` | 汇总表格的测试用例 |
| `summary_web/tests/test_pagination.py` | 分页功能的测试用例 |
| `summary_web/tests/test_performance.py` | 性能测试的测试用例 |
| `summary_web/tests/test_complete_flow.py` | 完整流程的集成测试用例 |
| `summary_web/tests/test_basic_functionality.py` | 基础功能测试用例 |

### 中文文档参考

> 以下中文文档位于 Python 项目目录下，包含功能实现总结和使用示例，可作为业务逻辑参考。

| 文档 | 参考价值 |
|------|---------|
| `复位区间功能实现总结.md` | 复位区间自动确认的实现逻辑和边界条件 |
| `复位区间功能使用示例.md` | 复位区间功能的使用场景示例 |
| `回归批量功能使用示例.md` | 回归批量扫描和处理的操作流程 |
| `回归批量时序违例抓取.md` | 回归批量违例抓取的需求说明 |
| `回归批量时序违例抓取_问题修复报告.md` | 回归批量功能的已知问题和修复方案 |
| `回归批量时序违例抓取实现总结.md` | 回归批量功能的实现总结 |
| `时序违例数据汇总.md` | 数据汇总功能的需求说明 |
| `violation_web_display.md` | Web 展示的设计说明 |
| `web_log_load.md` | Web 日志加载的设计说明 |

### utils 目录参考

| Python 文件 | 路径 | 复刻目标 | 关键逻辑说明 |
|-------------|------|---------|-------------|
| `time_unit_converter.py` | `D:\doc\python\runsim_r3p0\utils\` | `parser/time-utils.ts` | 时间单位转换工具，与 `parser.py` 中的 `convert_time_to_fs` / `convert_time_to_ns` 逻辑一致。 |

## User Stories

### 日志解析

1. 作为 SoC 验证工程师，我 want 选择单个 `vio_summary.log` 文件进行解析，so that 将违例条目导入平台数据库
2. 作为 SoC 验证工程师，我 want 在解析大文件时看到进度反馈，so that 知道平台正在工作
3. 作为 SoC 验证工程师，I want 解析过程不冻结 UI，so that 解析时仍能操作应用其他部分
4. 作为 SoC 验证工程师，I want 解析时自动从文件路径推断 case_name 和 corner 信息，so that 不需要手动输入
5. 作为 SoC 验证工程师，I want 解析时自动提取 seed 信息，so that 同一用例不同 seed 的违例可以区分
6. 作为 SoC 验证工程师，I want 解析时自动检测用例 PASS/FAIL 状态（检查 `sprd_log_pass.log`），so that 统计中能按状态分组
7. 作为 SoC 验证工程师，I want 支持多种时间单位（FS/PS/NS）的自动转换，so that 不同格式的日志都能正确解析
8. 作为 SoC 验证工程师，I want 解析重复文件时自动去重（INSERT OR IGNORE），so that 不会产生重复记录
9. 作为 SoC 验证工程师，I want 看到解析结果的摘要（总数、新增数、跳过数），so that 确认导入符合预期

### 回归扫描

10. 作为 SoC 验证工程师，I want 选择回归根目录进行递归扫描，so that 自动发现所有 `vio_summary.log` 文件
11. 作为 SoC 验证工程师，I want 在标准模式下按 `<case>_<corner>/<case>_<seed>/log/vio_summary.log` 结构解析，so that 提取完整的 subsys/corner/case/seed 元信息
12. 作为 SoC 验证工程师，I want 在通用模式下按任意层级目录解析，so that 支持非标准目录结构
13. 作为 SoC 验证工程师，I want 扫描结果按子系统、corner、用例、状态分组展示，so that 可以选择性处理
14. 作为 SoC 验证工程师，I want 在分组视图中勾选/取消勾选文件，so that 选择需要处理的子集
15. 作为 SoC 验证工程师，I want 一键选中/取消某子系统/corner 下的所有文件，so that 快速批量选择
16. 作为 SoC 验证工程师，I want 看到每个文件的元信息（路径、大小、修改时间、用例状态），so that 判断是否需要处理
17. 作为 SoC 验证工程师，I want 批量处理选中的文件，so that 一次性导入多个文件的违例数据
18. 作为 SoC 验证工程师，I want 看到批量处理的实时进度，so that 知道处理到哪个文件了

### 数据展示与查询

19. 作为 SoC 验证工程师，I want 在 Dashboard 中看到统计卡片（总违例数、已确认数、待确认数、已忽略数），so that 一览确认进度
20. 作为 SoC 验证工程师，I want 在 Dashboard 中看到按子系统分布的违例数量柱状图，so that 定位违例最多的子系统
21. 作为 SoC 验证工程师，I want 在 Dashboard 中看到按 corner 分布的违例数量图，so that 知道哪个 corner 违例最多
22. 作为 SoC 验证工程师，I want 在 Dashboard 中看到按用例分布的违例数量图，so that 定位问题用例
23. 作为 SoC 验证工程师，I want 看到状态分布饼图（已确认/待确认/已忽略），so that 直观了解确认比例
24. 作为 SoC 验证工程师，I want 在违例列表表格中分页浏览违例数据，so that 处理几十万条数据时不卡顿
25. 作为 SoC 验证工程师，I want 表格使用虚拟滚动，so that 滚动浏览大量数据时流畅
26. 作为 SoC 验证工程师，I want 按用例名、corner、状态、子系统筛选违例列表，so that 快速定位特定违例
27. 作为 SoC 验证工程师，I want 在搜索框中输入关键字搜索 Hier 或 Check 信息，so that 模糊查找特定违例
28. 作为 SoC 验证工程师，I want 按时间戳、NUM、Hier 等字段排序违例列表，so that 按需排序查看
29. 作为 SoC 验证工程师，I want 在表格中直接看到每条违例的确认状态（颜色标记），so that 一眼区分待确认和已确认
30. 作为 SoC 验证工程师，I want 点击表格行展开查看违例详情（完整 Hier、Check、时间、文件路径），so that 不需要额外打开文件

### 自动确认

31. 作为 SoC 验证工程师，I want 输入复位时间（纳秒）自动确认该时间之前的违例，so that 快速过滤复位期间噪声
32. 作为 SoC 验证工程师，I want 输入复位区间（起止时间）自动确认区间内的违例，so that 处理多个复位阶段
33. 作为 SoC 验证工程师，I want 自动确认时如果指定 corner 未找到记录则回退到 default corner，so that 兼容不同 corner 命名
34. 作为 SoC 验证工程师，I want 自动确认的记录标记为"系统自动"确认人，so that 区分人工和自动确认
35. 作为 SoC 验证工程师，I want 自动确认的记录附带原因说明（如"复位期间时序违例（<= 1000ns），可以忽略"），so that 后续审查可追溯
36. 作为 SoC 验证工程师，I want 同时使用复位时间和复位区间条件自动确认（OR 关系），so that 灵活组合确认条件

### 手动确认

37. 作为 SoC 验证工程师，I want 选中一条违例进行手动确认，so that 逐条审查重要违例
38. 作为 SoC 验证工程师，I want 在确认对话框中填写确认人、确认结果（pass/issue）、确认理由，so that 记录完整的确认信息
39. 作为 SoC 验证工程师，I want 选中多条违例进行批量确认，so that 一次性确认相同类型的违例
40. 作为 SoC 验证工程师，I want 编辑已确认的记录，so that 修正错误的确认结论
41. 作为 SoC 验证工程师，I want 将违例标记为"忽略"（ignored），so that 暂时不处理但保留记录
42. 作为 SoC 验证工程师，I want 确认后看到表格实时更新状态，so that 确认操作即时反馈

### 历史 Pattern 匹配

43. 作为 SoC 验证工程师，I want 每次手动确认后自动保存 Pattern（hier + check → confirmer + result + reason），so that 下次遇到相同违例可以自动建议
44. 作为 SoC 验证工程师，I want 对新导入的违例一键应用历史确认模式，so that 自动确认已知问题
45. 作为 SoC 验证工程师，I want Pattern 匹配支持精确匹配（hier + check 完全相同），so that 精确应用历史结论
46. 作为 SoC 验证工程师，I want Pattern 匹配支持模糊匹配（标准化 check_info 后比较），so that 相似违例也能匹配
47. 作为 SoC 验证工程师，I want 模糊匹配规则标准化 check 信息（括号前必须匹配，括号内前两部分去冒号后内容匹配，第三部分忽略），so that 时间值不同但检查类型相同的违例能匹配
48. 作为 SoC 验证工程师，I want 查看所有历史 Pattern 列表，so that 管理和审查确认模式
49. 作为 SoC 验证工程师，I want 清除所有历史 Pattern，so that 重新开始模式积累
50. 作为 SoC 验证工程师，I want Pattern 匹配时不依赖 corner（corner 无关），so that 不同 corner 下的相同违例共享确认结论

### 数据导出与导入

51. 作为 SoC 验证工程师，I want 将违例数据导出为 Excel 文件，so that 在电子表格中进一步分析
52. 作为 SoC 验证工程师，I want 将违例数据导出为 CSV 文件，so that 导入其他工具处理
53. 作为 SoC 验证工程师，I want 将历史 Pattern 导出为 Excel 文件，so that 分享给团队成员
54. 作为 SoC 验证工程师，I want 将历史 Pattern 导出为 CSV 文件，so that 版本管理
55. 作为 SoC 验证工程师，I want 将历史 Pattern 导出为独立数据库文件（只含 violation_patterns 表），so that 方便他人导入
56. 作为 SoC 验证工程师，I want 从导出的数据库文件导入 Pattern（合并模式），so that 合并团队成员的确认经验
57. 作为 SoC 验证工程师，I want 导入 Pattern 时自动合并相同模式（累加使用次数），so that 不产生重复
58. 作为 SoC 验证工程师，I want 合并多个完整数据库，so that 汇总不同机器上的违例数据
59. 作为 SoC 验证工程师，I want 数据库合并前自动备份，so that 操作失误可以回退
60. 作为 SoC 验证工程师，I want 数据库合并时显示进度，so that 知道合并进度

### 数据管理

61. 作为 SoC 验证工程师，I want 清除指定用例的违例数据，so that 重新导入正确数据
62. 作为 SoC 验证工程师，I want 清除指定用例指定 corner 的数据，so that 精确清理
63. 作为 SoC 验证工程师，I want 更新用例的 corner 信息（批量修改），so that 修正错误的 corner 标记
64. 作为 SoC 验证工程师，I want 查看数据库统计信息（总违例数、已确认数、待确认数、Pattern 数、用例数），so that 评估确认进度
65. 作为 SoC 验证工程师，I want 数据库路径可配置，so that 自定义存储位置

### 配置

66. 作为 SoC 验证工程师，I want 在项目配置文件中定义 Corner 列表，so that 适配不同芯片项目
67. 作为 SoC 验证工程师，I want 配置默认复位时间，so that 不需要每次输入
68. 作为 SoC 验证工程师，I want 配置子系统识别规则（如以 `_sys` 结尾），so that 适配不同项目结构
69. 作为 SoC 验证工程师，I want 启用/禁用自动备份，so that 控制备份行为

### AI 预留

70. 作为 SoC 验证工程师，I want 未来 AI Agent 能分析违例的 Hier 和 Check 信息并建议确认结果，so that 减少人工确认工作量（本期预留接口，不实现）
71. 作为 SoC 验证工程师，I want 未来 AI Agent 能从大量历史确认记录中学习模式，so that AI 建议越来越准确（本期预留接口，不实现）

## Implementation Decisions

### 模块架构

- 时序违例功能作为主进程新模块 `src/main/timing-violation/` 实现，不作为插件系统的新 PluginKind。日志解析格式（`vio_summary.log`）是通用的，不因 EDA 工具不同而变化。
- 模块内按职责分层：`db/`（数据库）、`parser/`（解析器 + Worker Thread）、`scanner/`（回归扫描）、`confirm/`（确认逻辑 + Pattern 匹配）、`export/`（导出导入）。
- tRPC router 拆分为 4 个子 router：`violation-router`（解析、查询、统计）、`confirmation-router`（自动/手动确认、批量确认）、`pattern-router`（Pattern CRUD、导出导入）、`scan-router`（回归扫描、批量处理）。
- 前端组件放在 `src/renderer/src/components/timing-violation/`，按功能拆分为 Dashboard、StatsCards、DistributionCharts、ViolationTable、ConfirmationDialog、ScanProgress、PatternManager、FilterBar。
- 前端状态用独立 Zustand store `src/renderer/src/stores/timing-violation.ts` 管理。
- 前端在 CenterArea 中注册新的 Workbench Destination（`timing-violation`）。

### 数据存储

- 使用 `better-sqlite3` 作为 SQLite 库，同步 API，不需要连接池和线程锁。
- 启用 WAL 模式 + PRAGMA 优化（synchronous=NORMAL, cache_size=10000, temp_store=MEMORY, mmap_size=256MB）。
- 数据库文件路径用户可配置，默认 `.socverify/timing-violation/tv.db`。
- 配置文件 `.socverify/timing-violation/config.json` 存储 Corner 列表、子系统识别规则、默认复位时间等。

### Schema 设计

- 3 张表保持，重新设计字段和索引（来自 ADR-0012）。
- `timing_violations` 表新增 `seed` 和 `subsys` 字段，唯一键改为 `(case_name, corner, seed, hier, check_info, time_fs)`。
- `confirmation_records` 表的 `violation_id` 加 `UNIQUE` 约束确保 1:1 关系。
- 简化索引，移除 Python 版本中冗余的覆盖索引。

Schema 定义（来自 ADR-0012 prototype）：

```sql
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
```

### 解析器

- 单一解析器实现，使用 Node.js `readline.createInterface` + `fs.createReadStream` 流式读取（来自 ADR-0013）。
- 解析工作在 Worker Thread 中执行，通过 `parentPort.postMessage` 分批回传（每 1000 条一批）。
- 主进程接收结果后用 `better-sqlite3` 的 `transaction()` + `prepare()` 批量插入。
- Python 版本的 3 套解析器合并为 1 套，因为 Node.js 流式 I/O 天然解决 Python GIL 和 GC 问题。
- Python 版本的 `MemoryPressureDetector`、`ViolationAwareChunker`、自适应块大小等不需要。

### Pattern Normalization

- 完全复刻 Python 版本 `_normalize_check_info` 的模糊匹配逻辑。
- 规则：括号前内容必须完全匹配；括号内按逗号分三部分，前两部分去除冒号后时间信息只匹配冒号前内容，第三部分完全忽略。

### 回归扫描

- 独立扫描器实现，不复用现有 `src/main/regression/regression-manager.ts`（扫描目标和解析逻辑不同）。
- 支持标准模式和通用模式两种目录结构解析。
- Corner 列表和子系统识别规则从配置文件读取，不硬编码。

### Dashboard UI

- 使用 Recharts 替代 Python 版本的 Chart.js。
- 表格使用 `@tanstack/react-virtual` 实现虚拟滚动。
- 数据通过 tRPC 分页查询，不在前端全量加载。

### 实现阶段

- 垂直切片 3 阶段（来自 ADR-0014）：
  - Phase 1：最小闭环（单文件解析 → DB 存储 → 列表展示）— ✅ 已完成（Issue #1, #2, #3）
  - Phase 2：完整确认流程（自动 + 手动确认 + Pattern 匹配 + Pattern CRUD）— ✅ 已完成（Issue #4, #5, #6）
  - Phase 3：高级功能（回归扫描 + 图表 + 导出 + AI 接口预留）— ✅ 已完成（Issue #7/#8/#9/#10）

### 依赖添加

- `better-sqlite3` — SQLite 数据库
- `exceljs` — Excel 导出
- `recharts` — React 图表库
- `@tanstack/react-virtual` — 虚拟滚动

## Testing Decisions

### 测试缝

复用现有 2 条测试缝（与 AGENTS.md 定义一致）：

1. **主进程模块测试缝**：直接导入主进程模块，使用临时目录做文件系统测试。参考 `tests/simulation/log-analyzer.test.ts` 和 `tests/coverage/coverage-manager.test.ts`。
   - `tests/timing-violation/vio-parser.test.ts` — 解析器单测：各种日志格式、边界情况、大文件、多行 Check、无效条目
   - `tests/timing-violation/pattern-normalizer.test.ts` — Pattern Normalizer 单测：精确匹配、模糊匹配、各种 Check 格式
   - `tests/timing-violation/confirmation-manager.test.ts` — 确认逻辑单测：复位时间条件、复位区间条件、Corner 回退、历史模式应用
   - `tests/timing-violation/violation-scanner.test.ts` — 扫描器单测：标准模式解析、通用模式解析、PASS/FAIL 检测

2. **UI 组件测试缝**：使用 `@testing-library/react` + mock stores。参考 `tests/ui/coverage-dashboard.test.tsx`。
   - `tests/ui/tv-dashboard.test.tsx` — Dashboard 渲染和交互测试
   - `tests/ui/tv-violation-table.test.tsx` — 虚拟滚动表格测试

### 测试原则

- 只测试外部行为，不验证内部实现细节。
- 解析器和 Pattern Normalizer 作为纯函数测试，快且可靠。
- 数据库测试使用临时目录创建真实 SQLite 文件（不 mock DB），测试后清理。
- UI 组件测试 mock tRPC proxy 和 Zustand store，只验证渲染和交互行为。
- 测试数据使用真实 `vio_summary.log` 格式片段，不使用抽象的 mock 数据。

## Out of Scope

- **AI 辅助确认**：本期预留 `suggestConfirmation` 接口但不实现。AI 分析违例并建议确认结果属于后续增量功能。
- **Python 版本的性能优化系统**：`comprehensive_performance_system.py`、`adaptive_parser_system.py`、`memory_manager.py` 等过度工程化的文件不复刻。Node.js 的 V8 GC 和流式 I/O 天然解决了这些问题。
- **Python 版本的 Web 服务器**：独立 HTTP 服务器不保留，Web API 逻辑迁移到 tRPC router，Web UI 迁移到 React 组件。
- **Python 版本的 PyQt5 UI 组件**：`main_window.py`、`configuration_dialog.py`、`corner_selection_dialog.py`、`regression_batch_ui.py` 等 PyQt5 组件不复刻，用 React 组件替代。
- **Python 版本的 HTML 报告生成**：`summary_web/html_generator.py` 和 Jinja2 模板不复刻，Dashboard 直接用 React 渲染。
- **数据库诊断和监控工具**：`diagnose_database.py`、`database_monitor.py` 等辅助工具不复刻。
- **多用户协作**：单用户桌面应用，不提供多人协作功能。

## Further Notes

### Python 参考文件位置

- 时序违例插件主目录：`D:\doc\python\runsim_r3p0\plugins\user\timing_violation\`
- utils 目录：`D:\doc\python\runsim_r3p0\utils\`

### 关键 ADR

- [ADR-0011](./adr/0011-timing-violation-module-architecture.md) — 模块架构决策
- [ADR-0012](./adr/0012-better-sqlite3-for-timing-violation.md) — 数据存储决策
- [ADR-0013](./adr/0013-worker-thread-for-violation-parsing.md) — Worker Thread 解析决策
- [ADR-0014](./adr/0014-vertical-slice-phasing-for-timing-violation.md) — 垂直切片实现阶段

### 交付文档

- [timing-violation-handoff.md](./timing-violation-handoff.md) — 完整交付文档，含架构设计、文件结构、API 设计、实现计划、配置格式、关键实现注意事项

### 领域术语

- 时序违例领域术语已添加到 `CONTEXT.md`，包含 Timing Violation、Violation Confirmation、Violation Pattern、Corner、Reset Time、Regression Scan、Violation Dashboard、Pattern Normalization 等 8 个术语定义。

### better-sqlite3 原生编译注意事项

`better-sqlite3` 需要原生编译。在 Electron 中使用需要通过 `electron-rebuild` 重新编译为 Electron 的 Node.js 版本。或在 `package.json` 中添加 postinstall 脚本。

### Worker Thread 构建配置

`electron.vite.config.ts` 需要配置 Worker Thread 构建，确保 worker 文件以正确的格式输出。Worker 通过 `new Worker(new URL('./parser-worker.ts', import.meta.url))` 创建。
