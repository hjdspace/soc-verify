# Closure 编排重构——平台驱动 Coverage Recovery + 模块级 Closure Target

现有 ClosureOrchestrator 存在两个结构性缺陷，本次重构修复：

1. **Delta 恒为零**：迭代结束后 `getCoverageSummary(sessionId)` 重读同一份缓存——新测试产生的 simv.vdb 未合并、未重跑 urg、未重解析，deltaBefore === deltaAfter，闭环实际不闭合。
2. **per-gap 粒度浪费**：每个 模块×metric gap 独立 omp 会话，同一模块的 line/branch/toggle 三个 gap 各自读一遍 RTL、生成三批可能重叠/冲突的测试。

本 ADR **取代 ADR 0009 决策 8**（Gap Scheduler 的 per-gap 工作项设计），其余决策（Summary-First、Closure Workspace、Delta Validation 路线图、Test Promotion）不变。

## 关键决策

1. **Coverage Recovery 由平台驱动**：每轮迭代结束（AI agent_end 后），orchestrator 收集本轮 run_simulation 产生的 simv.vdb 路径 + 基线 cov_merge VDB，运行 urg 合并生成新报告（`urg -full64 -dir vdb1 vdb2 ... -report <round-dir>`），重新解析得到真实 deltaAfter。merge 是确定性 EDA 操作，由平台执行而非 AI——AI 专注生成测试，不承担 EDA 操作失控风险（merge 参数写错、误碰用户基线 VDB）。

2. **闭环工作项 = Closure Target（模块级聚合）**：用户在覆盖率树上选中模块，该模块所有未达标 metric 聚合为一个 Target，一个 omp 会话一轮内一起补。依据：同一份 RTL，一个 directed test 通常同时提升 line/branch/toggle/condition 等多种 code metric。会话数与仿真次数按模块数（而非 gap 数）收敛。达标判定：Target 模块全部 metric 达到 Coverage Target（替代现占位逻辑 deltaOverall >= 1）。

3. **与 ADR 0009 决策 8 的关系**：被拒绝的"按模块分组并行"是 gap 工作项之上的调度分组（两级结构，归因复杂）；本决策将工作项本身定义为模块级（一级结构），delta 归因天然落在单模块上，不存在"多个 gap 的测试同时提升同一模块"的归因歧义。

4. **EDA 执行 backend：direct + LSF 双模式**：EDA Tool Configuration 增加 `execBackend: 'direct' | 'lsf'` 与 LSF queue/resource 配置。direct = 本机 spawn（现状）；lsf = `bsub -K -q <queue> [-R <resource>] <cmd>` 提交，要求 VDB/报告目录在共享存储。startup timeout（默认 120s）与 run timeout（默认 600s）可配，超时按 job id bkill。失败不静默回退 direct（fail-closed，与 xcov 语义一致）。

5. **Recovery 报告不污染基线**：每轮 Recovery 的 urg 报告输出到 `.socverify/coverage/closure/<closureId>/<targetId>/round_<n>/report/`，基线 cov_merge VDB 只读；合并视图通过 urg 一次读多 VDB 实现，不修改用户 merged.vdb。闭环全部结束后，用户可通过"导入新 Merge Session"固化最终覆盖率。

## 被拒绝的方案

- **AI 自主 merge**（新增 merge_coverage Host Tool，prompt 指导 AI 操作）：灵活，但把确定性 EDA 操作交给 AI 有失控风险，且 AI 上下文被 EDA 操作细节占用。
- **人工确认 merge**（每轮暂停等用户手动 merge）：最保守但体验差，与"AI 辅助收敛"目标背离。
- **维持 per-gap 粒度 + 只修 Recovery**：闭环能闭合，但同一模块多 gap 的重复读 RTL / 冲突测试 / 仿真资源 ×N 问题仍在。
