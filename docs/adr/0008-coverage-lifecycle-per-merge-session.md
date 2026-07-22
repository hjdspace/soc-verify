# Coverage Lifecycle — Per-Merge-Session, Not Per-Simulation-Run

当前 `CoverageParserPlugin.parse(projectRoot, runId)` 以 Simulation Run ID 为键获取覆盖率数据。但实际 SoC 验证中，覆盖率数据是 **merge 后的**，不是单次仿真的产物。多次仿真运行的覆盖率数据库被 merge 到一个合并数据库（如 `cov_merge/`），报告从合并数据库生成。我们选择以 **Coverage Merge Session** 为生命周期单位，不绑定 Simulation Run ID。

## 关键决策

1. **Coverage Merge Session**：用户手动指定 cov_merge 目录，平台生成报告并创建一个 session（唯一 session ID）。session 不与 Simulation Run 绑定。一次 session 对应一次 merge 后的覆盖率快照。

2. **接口变更**：`CoverageParserPlugin.parse(projectRoot, runId)` 改为 `parse(projectRoot, sessionId, reportDir)` — 接收 session ID 和文本报告目录路径。`CoverageManager.getOrParse(runId)` 改为 `getOrParse(sessionId)`。

3. **session 管理**：session 列表存储在项目 `.socverify/coverage/sessions.json` 中。每个 session 记录：session ID、cov_merge 路径、EDA 工具类型、生成时间、报告路径。缓存的 CoverageData 存储在 `.socverify/coverage/<sessionId>.json`。

4. **趋势图基于 session 序列**：`CoverageManager.getTrend()` 从 session 列表中按时间顺序加载各 session 的 summary，生成趋势数据。不再依赖 runId 列表。

## 被拒绝的方案

- **仿真完成后自动 merge + 生成报告**（方案 B）：平台在仿真结束后自动 merge 覆盖率库并生成报告。但 merge 操作本身复杂（需要知道哪些 run 的 coverage 要 merge、merge 命令是什么、merge 到哪里），且不是所有仿真都需要覆盖率分析。强行绑定会增加仿真流程的复杂度。

- **混合模式**（方案 C）：仿真完成后自动 merge，也支持手动导入。看似灵活，但自动 merge 的逻辑复杂且不可靠（不同 EDA 工具的 merge 命令不同，且 merge 可能失败），不如让用户显式控制 merge 时机。
