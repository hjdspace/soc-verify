# Worker Thread 用于时序违例日志解析

时序违例日志文件可能达到 50MB+，解析后产生几十万条违例记录。解析工作在 Worker Thread 中执行，主进程只负责数据库批量插入。

Python 版本需要 3 套解析器实现（`VioLogParser`、`HighPerformanceVioLogParser`、`EnhancedStreamingParser`）是因为 Python GIL 限制和手动 GC 管理需求。Node.js 的 `readline.createInterface` + `fs.createReadStream` 天然支持流式读取和背压，V8 GC 不需要手动管理。因此只需要单一解析器实现。

Worker Thread 负责文件 I/O 和解析，通过 `parentPort.postMessage` 分批回传解析结果（每 1000 条一批）。主进程接收后使用 `better-sqlite3` 的 `transaction()` 批量插入。这样主进程始终保持响应，不阻塞 IPC 和窗口管理。

如果未来需要在 electron-vite 中配置 Worker Thread 构建，确保 `worker.format` 设置为 `es` 或在 `electron.vite.config.ts` 中正确配置 worker 入口。
