# 日志路径解析混合策略

编译/仿真日志的路径解析和错误提取采用混合策略：首先尝试通过 simulation 插件的 `getCompileErrors()` 获取结构化错误（如果插件支持），若插件返回空或不可用，则回退到文件系统路径解析——从 Python `log_analyze_utils.py` 移植的 `getCompileLogPath()` / `getSimulationLogPath()` 函数，尝试多种常见路径模式。日志错误提取的正则模式（Xcelium `*E,*F`、VCS `Error-[...]`、UVM_ERROR、SPRD_ERROR 等）完全从 Python `extract_compile_errors.py` / `extract_sim_errors.py` 移植，因为它们是经过实战验证的 EDA 日志解析模式。选择混合策略而非纯插件或纯文件系统，是因为文件系统方式更通用（无需依赖特定插件实现），而插件方式在可用时能提供更精确的结构化数据。
