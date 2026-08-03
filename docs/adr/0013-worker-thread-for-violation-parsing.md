# Worker Thread 用于时序违例日志解析

时序违例日志文件可能达到 50MB+，解析后产生几十万条违例记录。解析工作在 Worker Thread 中执行，主进程只负责数据库批量插入。

Python 版本需要 3 套解析器实现（`VioLogParser`、`HighPerformanceVioLogParser`、`EnhancedStreamingParser`）是因为 Python GIL 限制和手动 GC 管理需求。Node.js 的 `readline.createInterface` + `fs.createReadStream` 天然支持流式读取和背压，V8 GC 不需要手动管理。因此只需要单一解析器实现。

Worker Thread 负责文件 I/O 和解析，通过 `parentPort.postMessage` 分批回传解析结果（每 1000 条一批）。主进程接收后使用 `better-sqlite3` 的 `transaction()` 批量插入。这样主进程始终保持响应，不阻塞 IPC 和窗口管理。

如果未来需要在 electron-vite 中配置 Worker Thread 构建，确保 `worker.format` 设置为 `es` 或在 `electron.vite.config.ts` 中正确配置 worker 入口。

## 实现状态

### Issue #1 已实现（调整方案）

**实际实现采用主进程直接解析，未使用 Worker Thread**。原因：

1. Node.js 的 `readline.createInterface` + `fs.createReadStream` 天然是异步非阻塞的，支持背压，不会冻结 UI
2. Worker Thread 在 electron-vite CJS 输出中有构建复杂度，需要额外的 worker 格式配置
3. `readline` 的异步 I/O 模型在单线程中已经足够处理 50MB+ 的日志文件

**已实现文件**：
- `src/main/timing-violation/parser/vio-parser.ts` — 流式解析器（`parseLogStream` + `parseLogFile`），使用 `readline` + `createReadStream`
- `src/main/timing-violation/parser/parser-worker.ts` — Worker Thread 入口已编写（`parseLogStream` + 分批发送），保留用于未来需要 Worker 的场景
- `src/main/timing-violation/parser/time-utils.ts` — 时间单位转换（FS/PS/NS → 飞秒）
- `src/main/timing-violation/parser/case-info-parser.ts` — 路径推断 case_name/corner/seed/subsys

**解析器特性**：
- `----` 分隔线标记违例结束
- Key-Value 格式 `KEY : VALUE` 解析
- 多行 Check 字段追加
- 四字段完整性验证（NUM/Hier/Time/Check）
- FS/PS/NS/无单位 自动转换为飞秒
- 从文件路径推断 case_name/corner/seed/subsys（标准回归目录结构）
- 支持显式 caseName/corner 覆盖

**Worker Thread 保留**：`parser-worker.ts` 已实现完整的 Worker 入口代码（分批发送、进度回调、错误处理），如果未来需要处理超大规模文件（>200MB），可在 `violation-router.ts` 中切换为 Worker 模式。
