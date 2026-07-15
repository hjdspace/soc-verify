# ErrorAnalysisCoordinator: 共享的错误分析触发架构

仿真有两条执行路径——后台子进程（`SimulationManager`）和终端 PTY（`simTerminalLinker`），两者都通过各自的 EventEmitter 发出 `run:completed` 事件。我们选择新建一个 `ErrorAnalysisCoordinator` 模块，同时监听 `simulationRegistry` 和 `simTerminalLinker` 的 `run:completed` 事件，在检测到 `fail`/`error` 状态时统一触发错误分析流程（错误类型判定 → 上下文提取 → AI 会话创建）。这避免了在两个路径中各自重复实现分析逻辑，也确保未来新增执行路径时只需接入一个监听器。备选方案是在 `SimulationManager.pollStatus()` 和 `simTerminalLinker.handleTerminalData()` 中各自内联分析逻辑，但那会导致代码重复和逻辑分歧。
