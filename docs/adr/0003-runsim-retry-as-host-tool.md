# runsim_retry 作为 Host Tool 注入 omp

编译错误修复后需要重新仿真。我们选择将 `runsim_retry` 实现为 Host Tool，注册到 `HostToolsRegistry`，使 omp AI Agent 可以在修复源代码后自主调用该工具重新执行仿真，实现全自动修复-重仿流程。该工具内部复用 `SimulationManager.run()` 或 `simTerminalLinker.register()`（根据执行模式选择），参数包含 case 名称、命令、工作目录等。备选方案是作为 tRPC API 由渲染端在 AI 完成后调用，但那需要用户等待 AI 完成后手动触发或轮询 AI 状态，无法实现真正的全自动流程。选择 Host Tool 方式使 AI 拥有完整的决策自主权——何时修复、何时重仿、何时停止。
