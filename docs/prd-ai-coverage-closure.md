# PRD: AI 辅助覆盖率收敛 — session.xml 解析 + Coverage Recovery + 模块级闭环 + Exclusion 链路

> Status: **ready-for-agent**
> 关联: [ADR 0023](adr/0023-xcov-methodology-inhouse.md) · [ADR 0024](adr/0024-urg-session-xml-first-parsing.md) · [ADR 0025](adr/0025-closure-recovery-and-module-target.md) · [ADR 0026](adr/0026-coverage-exclusion-chain.md) · 取代 [ADR 0009](adr/0009-ai-coverage-full-closure.md) 决策 8 · 术语见 [CONTEXT.md](../CONTEXT.md) 覆盖率域

## Problem Statement

SoC 验证工程师在使用当前桌面的覆盖率分析与 AI 收敛能力时面临四个核心痛点：

1. **VCS 覆盖率解析脆弱且配置语义错误**：urg 的 `dashboard.txt`/`hierarchy.txt` 采用启发式文本解析，列名随 urg 版本变化即失效；`covMergeDir` 默认值指向 `urgReport`（urg 的典型**输出**目录名），当 VDB 输入目录用语义颠倒，新项目开箱即错。

2. **AI 收敛闭环实际不闭合**：闭环每轮迭代结束后只重读同一份覆盖率缓存——新测试产生的 `simv.vdb` 没有合并、没有重跑 urg、没有重新解析，Delta 恒为 0；Gap 关闭判定是占位逻辑（整体 delta ≥ 1% 即关闭），并非真实的 Coverage Target 达标判定。用户看到的"AI 收敛"没有真实效果。

3. **per-gap 工作项粒度浪费资源**：每个 模块×metric gap 独立 AI 会话，同一模块的 line/branch/toggle 三个 gap 各自读一遍 RTL、生成三批可能重叠或冲突的测试，仿真资源消耗随 gap 数线性膨胀。

4. **dead_code 类 gap 没有豁免出路，且过程不可见**：AI 判定为不可达代码的 gap 只能硬补测试浪费算力；闭环运行过程无 UI 可观察、不可中止、无审批入口。

## Solution

借鉴开源项目 xverif/xcov 的方法论（不引入其二进制依赖）：

- **urg 报告管道修正**：summary 命令改用 `-xml_verbose -show summary` 生成类型化 `session.xml`，解析器 XML 优先、text 降级；修正 `covMergeDir` 默认值并迁移旧配置。
- **Coverage Recovery**：平台（而非 AI）在每轮迭代后自动收集新仿真的 VDB → urg 合并生成新报告 → 重新解析 → 计算真实 Delta。基线 VDB 只读。
- **模块级 Closure Target**：闭环工作项从 per-gap 改为模块级聚合——一个模块的全部未达标 metric 一个 AI 会话一轮一起补，达标判定为该模块全部 metric 达到 Coverage Target。
- **Exclusion 完整链路**：AI 建议（带 reason）→ 人工审批 → 平台生成 urg `-elfile` 格式 EL 文件 → 下次报告应用；豁免前后双数字可追溯。
- **EDA 执行 direct + LSF 双模式**：EDA Tool Configuration 增加 `execBackend`，LSF 模式经 `bsub -K` 提交 farm，超时 bkill，失败不静默回退。
- **完整闭环 UI**：覆盖率页入口 + 闭环详情页（实时进度、迭代历史、exclusion 审批面板、中止控制）。

分两期交付：**P1 后端闭环真打通**（urg 修正、session.xml 解析、自动 Recovery、模块级闭环重构、direct 后端）；**P2 完整 UI + exclusion 链路 + LSF 模式**。

## User Stories

### 报告生成与解析（P1）

1. 作为 SoC 验证工程师，我 want 导入 VCS 覆盖率时平台自动用 `-xml_verbose -show summary` 生成类型化 XML 摘要报告，so that 层级树解析不再依赖随 urg 版本变化的文本列名
2. 作为 SoC 验证工程师，我 want 解析器优先读取 session.xml 并按 URG SCORE 语义计算，so that 覆盖率数据确定可信
3. 作为 SoC 验证工程师，我 want 只有 text 报告的旧报告目录仍能解析（自动降级），so that 已缓存的报告与旧项目数据不失效
4. 作为 SoC 验证工程师，I want cov_merge 默认路径语义正确（指向含 simv.vdb/merged.vdb 的目录），so that 新项目开箱即用
5. 作为 SoC 验证工程师，I want 升级后旧项目配置自动迁移到新命令模板与默认值，so that 不需要手动编辑配置文件
6. 作为 SoC 验证工程师，I want detail 报告（uncovered 项导出）用独立命令生成到独立目录，so that 与 summary 解析互不影响、可独立缓存
7. 作为 SoC 验证工程师，I want 解析遇到违背 SCORE 语义的数据（covered > total、负值 sentinel）时报错而非静默错算，so that 错误数据不会流入闭环
8. 作为 SoC 验证工程师，I want 导入过程实时看到当前执行的 urg 阶段与耗时，so that 知道平台在处理哪一步
9. 作为 SoC 验证工程师，I want 在项目设置中查看和编辑修正后的 urg 命令模板，so that 特殊项目可自定义参数

### Coverage Recovery（P1）

10. 作为 SoC 验证工程师，I want 每轮 AI 迭代结束后平台自动合并本轮仿真产生的 VDB 并重新生成报告，so that Delta 反映真实覆盖率变化而非缓存复读
11. 作为 SoC 验证工程师，I want Recovery 过程中基线 cov_merge 目录只读不被修改，so that 原始覆盖率数据安全
12. 作为 SoC 验证工程师，I want 每轮 Recovery 的报告保留在该轮迭代的目录下，so that 迭代历史可追溯
13. 作为 SoC 验证工程师，I want Recovery 失败（ urg 报错/超时）时该 target 暂停并明确报错，so that 闭环不会在错误数据上继续迭代
14. 作为 SoC 验证工程师，I want 闭环结束后一键将最终覆盖率固化为新的 Coverage Merge Session，so that 收敛成果进入常规趋势跟踪

### 模块级 Closure Target（P1）

15. 作为 SoC 验证工程师，I want 在覆盖率树上选中模块启动 AI 收敛，so that 一次处理该模块全部未达标 metric
16. 作为 SoC 验证工程师，I want target 的达标判定是该模块全部 metric 达到 Coverage Target，so that 闭环报告"完成"时真正达标
17. 作为 SoC 验证工程师，I want 同一模块的多种 metric 在一个 AI 会话一轮内一起补，so that 不重复读 RTL、不生成相互冲突的测试
18. 作为 SoC 验证工程师，I want 多个模块 target 并行收敛且受会话并发上限保护，so that 资源消耗可控
19. 作为 SoC 验证工程师，I want 每轮迭代记录生成的测试文件列表与逐 metric Delta，so that 可审查 AI 的工作过程
20. 作为 SoC 验证工程师，I want 连续多轮无显著提升自动升级人工并保留全部迭代记录，so that 不浪费算力且可接手
21. 作为 SoC 验证工程师，I want 达到最大轮数仍不达标时升级人工并说明原因，so that 有明确的人工交接点

### 闭环 UI（P2）

22. 作为 SoC 验证工程师，I want 覆盖率两种视图（树表格/仪表盘）都有"启动 AI 收敛"入口，so that 从分析直接进入行动
23. 作为 SoC 验证工程师，I want 闭环详情页实时显示每个 target 的轮次、状态与当前动作（生成测试/仿真/Recovery），so that 过程完全可见
24. 作为 SoC 验证工程师，I want 查看某轮迭代的 Delta 明细（各 metric 前后对比），so that 判断 AI 测试是否有效
25. 作为 SoC 验证工程师，I want 查看每轮生成的测试文件列表并可打开内容，so that 可人工检查测试质量
26. 作为 SoC 验证工程师，I want 随时中止整个闭环或单个 target，so that 异常时及时止损
27. 作为 SoC 验证工程师，I want 闭环结束后生成的测试进入 Test Promotion 审阅流程，so that 接受的测试提升到正式目录
28. 作为 SoC 验证工程师，I want 查看 target 升级原因与 AI 的 triage 结论（根因分类/置信度），so that 快速接手人工处理

### Exclusion 链路（P2）

29. 作为 SoC 验证工程师，I want AI 升级时对判定为 dead_code 的 gap 给出带 reason 与置信度的 exclusion 建议，so that 人工审批有依据
30. 作为 SoC 验证工程师，I want 在审批面板逐条 approve/reject exclusion 建议，so that 豁免完全可控
31. 作为 SoC 验证工程师，I want 审批通过后平台自动生成 EL 文件并在下次报告生成时应用，so that 不需要手写 exclusion 文件
32. 作为 SoC 验证工程师，I want 查看豁免前后的覆盖率双数字，so that 豁免的影响可追溯
33. 作为 SoC 验证工程师，I want AI 在任何情况下都不能自动排除覆盖率项，so that 安全底线不可逾越

### LSF 执行模式（P2）

34. 作为 SoC 验证工程师，I want EDA 命令可配置为 LSF 提交（指定 queue/resource），so that 大型设计的 merge/report 跑在 farm 上
35. 作为 SoC 验证工程师，I want LSF 作业超时自动 bkill 并报错，so that 闭环不会悬挂等待
36. 作为 SoC 验证工程师，I want LSF 失败时明确报错而不静默回退本机执行，so that 行为可预期、问题不被掩盖
37. 作为 SoC 验证工程师，I want 查看 LSF 作业的排队/运行状态与耗时，so that 排障有据

### AI 会话侧（P1）

38. 作为 SoC 验证工程师，I want 闭环中 AI 的 get_coverage 返回最新 Recovery 后的覆盖率，so that AI 基于最新数据决策
39. 作为 SoC 验证工程师，I want AI 的每轮 prompt 包含该模块全部 gap 与此前轮次的结果，so that AI 不重复已失败的策略
40. 作为 SoC 验证工程师，I want 闭环外普通 AI 会话调用覆盖率 Host Tools 时数据源与规则不变，so that 现有功能无回归

## Implementation Decisions

### 总体

- 借鉴 xcov 方法论自研，不引入 xcov 二进制、Python runtime、pynpi 或 Synopsys 私有组件依赖（ADR 0023）。
- 本 spec 的闭环工作项设计**取代 ADR 0009 决策 8**（per-gap Gap Scheduler → 模块级 Target Scheduler）；ADR 0009 其余决策（Summary-First 数据策略、Closure Workspace 隔离、Delta Validation 路线图、Test Promotion）继续有效。
- 两期交付：P1 = 报告管道修正 + session.xml 解析 + Coverage Recovery + 模块级闭环重构（direct 后端）；P2 = 完整闭环 UI + exclusion 链路 + LSF 后端。

### EDA Tool Configuration 扩展

- schema 新增字段：`execBackend: 'direct' | 'lsf'`（默认 direct）、`lsfQueue`（lsf 模式必填）、`lsfResource`（可选）、startup/run 超时（默认 120s/600s）。
- `vcs-urg` 工具的命令模板语义修正：summaryCommand 改为 xml_verbose + show summary 形态；原全量 text 报告命令移作 detailCommand（产物供 uncovered 项导出）；gradeCommand 不变；csv/bins 维持无默认。
- `vcs-urg` 的 covMergeDir 默认值从 `urgReport` 改为 `cov_merge`；加载旧配置时按新默认值与命令语义迁移（存储的旧模板值属于旧语义时替换为新默认）。
- 配置校验：execBackend=lsf 时 queue 必填，保存时校验并报错。

### 解析器（builtin CoverageParserPlugin）

- 解析优先级：session.xml（类型化 XML，确定性）→ dashboard.txt + hierarchy.txt（启发式，降级）→ 全部缺失时报错。旧报告目录自动走降级路径。
- URG SCORE 语义固化：父 scope 分数已含 subtree，禁止累加 descendants；多 metric 聚合百分比取算术平均、不返回聚合计数；covered > total、负值 sentinel 视为解析错误 fail-closed；不适用值为 null。
- code/assertion/functional coverage 按 XML 各自 type 建模，映射到平台 8 种 Coverage Metric。

### Coverage Recovery（新模块）

- 触发时机：ClosureOrchestrator 每轮迭代 AI agent_end 且扫描完生成的测试之后。
- 流程：收集本轮 run_simulation 产生的 simv.vdb 路径 + 基线 cov_merge VDB → 构造 urg 合并命令（一次读多个 -dir）→ 报告输出到 `.socverify/coverage/closure/<closureId>/<targetId>/round_<n>/report/` → 解析 → 计算 Delta。
- 基线 cov_merge 目录严格只读；合并视图通过 urg 多 VDB 输入实现，不修改用户 merged.vdb。
- 失败处理：urg 报错/超时 → 该 target 本轮标记失败，闭环暂停该 target 并推送错误事件，不静默重试。
- Recovery 通过现有 CommandRunner 抽象注入执行，P1 direct、P2 接 LSF backend。

### ClosureManager / ClosureOrchestrator 重构

- 工作项数据模型从 ClosureGap（模块×metric 单 gap）改为 **ClosureTarget**：目标模块路径/名称 + 该模块全部未达标 metric 的 gap 列表 + 迭代历史 + 状态机（pending/in_progress/closed/escalated/failed）。CoverageGap 类型保留为 detectGaps 的检测输出，聚合发生在 closure 启动时。
- 迭代循环重排：startIteration → 创建会话 → prompt（含模块全部 gap 与历史轮次结果）→ waitForAgentEnd → 扫描测试 → **Coverage Recovery** → 计算 Delta → completeIteration → 达标/升级/失败判定 → 销毁会话。
- 达标判定：target 模块全部 metric 达到 Coverage Target（替换 deltaOverall ≥ 1 占位逻辑）；升级判定维持连续 N 轮 delta < 1%。
- 并发：全部 target 并行启动，受 SessionManager 并发上限限制。

### Exclusion 链路（P2）

- 建议数据模型：语义 selector（module + metric + file/line 或 bin 名）+ 必填 reason + AI 置信度 + 状态（pending/approved/rejected）。AI 仅在 triage 升级时输出建议，不可自动排除。
- 审批通过 → 平台生成 urg `-elfile` 格式 EL 文件（`.socverify/coverage/exclusions/<sessionId>.el`）→ 下次 Coverage Preprocessing / Recovery 的 urg 命令附加 `-elfile` 应用。单向生成，不做 EL 反向导入。
- 豁免后达标判定基于豁免后数字；迭代历史同时记录豁免前后两套数字。

### LSF backend（P2）

- runner 层实现：`bsub -K -q <queue> [-R <resource>] <cmd>` 提交；要求 VDB/报告目录位于共享存储；startup 超时（等 PEND→RUN）与 run 超时后按 job id bkill；失败 fail-closed 不回退 direct。

### 契约变更

- tRPC：coverage router 的配置读写 procedures 扩展 execBackend/LSF 字段；closure router 新增闭环详情/迭代历史/exclusion 审批 procedures；闭环启动参数从 gap 列表改为模块选择。
- 事件流：closure:event 事件载荷扩展 recovery 阶段事件（recovery_started/done/failed）与 target 级达标/升级明细，沿用 webContents.send + eventBridge 模式。
- Host Tools：get_coverage 数据源更新为最新 Recovery 结果；闭环内 AI prompt 注入模块级 gap 聚合与历史轮次上下文。

## Testing Decisions

- 好测试只断言外部可观察行为：解析输出的 Coverage Tree 结构与数值、状态机的状态迁移与事件序列、命令构造结果（命令行字符串/产物路径）、tRPC 契约的输入输出。不测内部私有方法与实现细节。
- 复用现有 5 个测试缝，不新增缝：

1. **闭环主缝**（closure-orchestrator.test.ts）：注入 fake sessionManager + fake EDA runner/recovery，覆盖模块级 target 编排、recovery 调用时机、达标/升级判定、中止与失败路径。P1 核心。
2. **解析器缝**（coverage-imc-regression.test.ts 模式）：真实 builtin 插件 + fixture 报告目录。新增 session.xml fixture（按 xcov 文档 schema 构造：多 metric subtree score、code/assert/functional type、不适用 null）；保留现有 text fixture 做降级回归与 SCORE 语义 fail-closed 用例。
3. **状态机缝**（closure-manager.test.ts）：模块级 target 的状态迁移、迭代历史、升级阈值。
4. **报告生成/配置缝**（coverage-manager.test.ts 模式）：mock CommandRunner 断言修正后的 urg 命令行（-xml_verbose -show summary、-elfile、多 -dir 合并）、covMergeDir 迁移、LSF bsub 命令构造与超时路径。
5. **UI store 缝**（tests/ui/* 模式，P2）：闭环详情 store 的事件流消费、审批状态、中止交互。

- 验收约束：当前无 VCS 环境，session.xml fixture 为构造样本，端到端验收 mock EDA 命令；拿到真实环境后需用真实 urg 产物回归 fixture。
- 每步修改后依次执行 build / typecheck / test / lint 四件套（项目规范）。

## Out of Scope

- xcov/xverif 二进制或 MCP 集成、其内容寻址 cache、run manifest provenance 校验（ADR 0023 不采纳项）。
- exclusion 的 EL 反向导入、pynpi 原生 exclusion 状态读写、CSV source of truth 四 EL 双向同步（ADR 0026 被拒绝项）。
- IMC / vcover 的 exclusion 链路（本次 EL 生成仅面向 VCS urg -elfile）。
- Delta Validation Phase 2/3 的自动化检查（维持 ADR 0009 路线图节奏，本次仍为 Phase 1）。
- 仿真执行链路（run_simulation）的 LSF 化改造——runner 抽象预留，由仿真插件后续自行采用。
- 覆盖率两视图本身的展示改造（沿用现有 PRD 已交付能力，本次仅加入口）。

## Further Notes

- 领域术语（Closure Target、Coverage Recovery、Target Scheduler 等）已更新至 CONTEXT.md 覆盖率域，实现时以词条为准。
- P1 结束后应可通过 Host Tools 调用与 closure 事件流验证闭环正确性（delta 非恒零、达标判定真实），风险前置释放后再进入 P2 UI。
- 本文档即 issue tracker 条目，状态行 `ready-for-agent` 为分派标签；完成后按两期拆分执行。
