# AI Agent 错误分析会话策略

每个失败的 case 需要独立的 AI Agent 会话以支持并行处理。我们选择新增 tRPC API `session.createForErrorAnalysis`，在内部复用 `sessionManager.createSession()` 创建新的 omp 进程，注入错误类型相关的 system prompt，并自动发送错误上下文作为首条消息。这样每个失败用例拥有独立的 Agent Tab 和 omp 进程，最多支持 10 个并发分析会话（受 `MAX_CONCURRENT_SESSIONS` 限制）。备选方案是复用现有 `session.create` + 手动 `session.send`，但那无法注入专属 system prompt，也无法在创建时自动发送上下文，需要渲染端额外编排。
