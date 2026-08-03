# Timing Violation 模块架构

时序违例功能作为主进程新模块 `src/main/timing-violation/` 实现，通过 tRPC router 暴露 API，而非作为插件系统的新 PluginKind。理由：日志解析格式（`vio_summary.log`）是通用的，不因 EDA 工具不同而变化；Corner 列表和目录结构约定是项目相关的，通过配置文件而非插件解决。

模块内按职责分层：`db/`（数据库）、`parser/`（解析器+Worker Thread）、`scanner/`（回归扫描）、`confirm/`（确认逻辑+Pattern 匹配）、`export/`（导出导入）。tRPC router 拆分为 `violation-router`、`confirmation-router`、`pattern-router`、`scan-router` 四个子 router。

前端在 CenterArea 中添加新的 Workbench Destination（`timing-violation`），组件按功能拆分 + 独立 Zustand store。
