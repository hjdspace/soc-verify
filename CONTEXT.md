# SoC Verify

AI Agent 驱动的 SoC 验证一站式管理平台——从项目 kickoff 到 Tape-Out 的完整周期管理。

## Language

### 仿真与执行域

**Simulation Run**:
一次仿真执行实例，由 `runId` 唯一标识，包含用例、子系统、选项和状态。
_Avoid_: execution, test run

**Terminal Simulation Run**:
通过终端 PTY 执行的仿真运行，与 `Simulation Run` 的区别在于执行方式——终端方式直接在交互式 shell 中执行 runsim 命令，而非隐藏子进程。
_Avoid_: terminal execution, PTY run

**Simulation Status**:
仿真的终局状态，取值为 `pass`、`fail`、`error`、`aborted`、`running`、`pending`。
_Avoid_: result, outcome

**Run Completion**:
仿真到达终局状态（`pass`、`fail`、`error`）的时刻。`run:completed` 事件在此刻触发。
_Avoid_: finish, done

### 错误分析域

**Error Type**:
失败仿真的错误分类——`compile_error`（编译报错）或 `sim_error`（仿真报错）。判定依据：编译日志中是否存在编译器错误行。
_Avoid_: failure category, error kind

**Compile Error**:
编译阶段产生的错误，由 EDA 工具（Xcelium/VCS）的编译器报告。特征行包括 Xcelium 的 `*E,*F` 格式和 VCS 的 `Error-[...]` 格式。
_Avoid_: build error, elaboration error

**Simulation Error**:
仿真阶段产生的错误，包括 UVM_ERROR/UVM_FATAL、SPRD_ERROR/SPRD_FATAL、VCS `*E` 格式等。编译通过但仿真运行时出错。
_Avoid_: runtime error, test failure

**Error Context**:
从日志中提取的错误信息及其周围上下文行，格式化后发送给 AI Agent 进行分析。
_Avoid_: error snippet, error block

**ErrorAnalysisCoordinator**:
主进程模块，监听 `run:completed` 事件，检测 FAIL 后自动判定错误类型、提取错误上下文、创建 AI Agent 会话并触发分析流程。
_Avoid_: error handler, failure processor

**Error Analysis Session**:
为单个失败用例创建的独立 AI Agent 会话，拥有专属的 omp 进程和 Host Tools。支持多个 case 并行分析。
_Avoid_: fix session, debug session

### 日志解析域

**Compile Log Path**:
编译日志文件的文件系统路径。常见模式包括 `case_name/log/irun_compile.log`、`case_name/log/compile.log` 等。
_Avoid_: build log, compilation log

**Simulation Log Path**:
仿真日志文件的文件系统路径。常见模式包括 `case_name/log/irun_sim.log`、`case_name/log/vcs_sim.log` 等。
_Avoid_: sim log, test log

**Log Analyzer**:
日志分析工具模块，从 Python 移植。包含编译错误提取器（Xcelium/VCS 正则）、仿真错误提取器（UVM/SPRD/VCS 正则）、日志路径解析和仿真状态检查。
_Avoid_: log parser, log scanner

**Context Lines**:
错误行前后抓取的上下文行数，默认 10 行，用于为 AI 提供足够的错误环境。
_Avoid_: surrounding lines, error scope

### AI 修复域

**Auto-Fix Flow**:
编译错误的自动修复流程：FAIL 检测 → 错误类型判定 → 错误上下文提取 → AI Agent 分析修复 → runsim_retry 工具重新仿真。最大重试 3 次。
_Avoid_: auto-repair, auto-correct

**runsim_retry**:
Host Tool，AI Agent 可调用以重新执行仿真。参数包含 case 名称、命令、工作目录等。
_Avoid_: re-run tool, simulation retry

**Retry Count**:
同一用例的自动修复-重仿循环计数，达到上限（3 次）后停止自动修复，将最终结果展示给用户。
_Avoid_: attempt count, iteration count

**Error Analysis Prompt**:
发送给 AI Agent 的初始消息，包含错误上下文、用例信息、修复指令。编译错误版本要求 AI 修复代码并调用 runsim_retry；仿真错误版本要求 AI 给出建议但不修改文件。
_Avoid_: fix prompt, debug message

### Diff Review 域

**Diff Review**:
用户审阅 AI Agent 通过 WRITE/EDIT 工具产生的代码改动的流程。用户可接受（保留改动）或拒绝（撤销改动）每个改动块。审阅在中栏 `DiffReviewView` 中进行，展示完整文件内容并高亮修改部分。
_Avoid_: code review, change review

**Hunk**:
Diff 中连续的 add/del 行块，是接受/拒绝的最小单元。一个 EDIT 工具调用（oldText→newText）可能产生多个 hunk。WRITE 工具创建的新文件整体为一个 hunk。
_Avoid_: diff block, change block

**Before Reconstruction**:
通过逆序撤销所有 tool call 的 newText→oldText 来重建文件修改前状态的过程。用于在 `DiffReviewView` 中计算完整文件 diff。如果某个 newText 已被后续编辑覆盖，该 hunk 标记为不可拒绝。
_Avoid_: reverse patch, undo reconstruction

**Review Queue**:
全局的待审阅文件改动队列，跨所有会话汇总。按文件路径聚合——同一文件的多次 EDIT/WRITE 调用合并为一个 review 条目。
_Avoid_: change list, pending changes

**Delayed Batch Apply**:
用户在 DiffReviewView 中逐个勾选 hunk 的接受/拒绝状态，点击「应用」或跳转下个文件时，后端一次性应用所有拒绝（将拒绝的 hunk 的 new 部分替换回 old 部分）。
_Avoid_: instant apply, live apply

**Overwritten Hunk**:
因后续编辑覆盖而无法在当前文件中定位到 newText 的 hunk。标记为不可拒绝，但仍可接受。
_Avoid_: stale hunk, conflicted hunk

### 工作区域

**Workbench**:
应用中栏承载文件、终端、仿真记录、Diff Review 等工作内容的统一空间，同一时刻有一个活动 destination。
_Avoid_: center area, main panel

**Workbench Destination**:
用户在 Workbench 中打开的一个类型化目标，包含展示该目标所需的身份和上下文。
_Avoid_: center tab ID, view string

### 覆盖率域

**Coverage Merge Session**:
一次覆盖率数据导入单元，对应一个 merged coverage database（如 `cov_merge/`）。由 session ID 唯一标识，不与单个 Simulation Run 绑定。用户手动指定 cov_merge 目录后由平台生成报告。
_Avoid_: coverage run, coverage report instance

**Coverage Report**:
EDA 工具从覆盖率数据库生成的文本报告。三种类型：Summary（层级树摘要）、Detail（每个实例/bin 的覆盖详情）、Metrics（覆盖率密度/复杂度等额外维度）。
_Avoid_: coverage output, coverage file

**Coverage Tree**:
覆盖率数据的层级模块树，反映设计层次结构。每个节点代表一个设计模块（如 `tb_top → chip_top → dut → u_analog_bb`），节点间有 parent/children 关系。
_Avoid_: module hierarchy, design tree

**Coverage Metric**:
覆盖率测量类型，共 8 种：line、branch、toggle、condition、fsm_state、fsm_transition、functional、assertion。每种指标在树的每个节点上都有一个 Coverage Triplet。
_Avoid_: coverage type, coverage kind

**Coverage Triplet**:
某个节点上某个 metric 的三部分值：`{ percentage, covered, total }`。`covered` 和 `total` 是整数计数；`percentage` = covered/total × 100。当 metric 不适用时，三个值均为 null。
_Avoid_: coverage value, metric value

**Coverage Target**:
某个 metric 的阈值百分比，高于该值认为覆盖率达标。平台内置行业默认值（line 95%、branch 90%、toggle 85%、fsm_state 100%、fsm_transition 90%、condition 85%、functional 100%），用户可在项目设置中覆盖。assertion 无行业默认目标。
_Avoid_: coverage goal, coverage threshold

**Coverage Gap**:
某个模块上某个 metric 的覆盖率低于 Target 的情况。Deficit = Target − Actual。是 Coverage Closure 的输入。
_Avoid_: coverage hole, coverage miss

**Coverage Delta**:
两次 Merge Session 之间某个 metric 覆盖率的变化量，用于跟踪迭代改进效果。Delta > 0 表示有效，Delta = 0 表示 stimulus 未命中 gap。
_Avoid_: coverage change, coverage improvement

**Coverage Triage**:
对 Coverage Gap 的根因分类和置信度评估。根因类型：missing_scenario、wrong_config、dead_code、sampling_issue、encoding_mismatch。置信度：high、medium、low。
_Avoid_: gap analysis, coverage diagnosis

**Coverage Closure**:
迭代流程：识别 Gap → 生成定向测试 → 运行仿真 → 检查 Delta → 重复。每个 Gap 最多 5 轮，连续 2 轮 Delta < 1% 触发升级。Dead code 确认和 exclusion 审批需要人工介入。
_Avoid_: coverage convergence, coverage completion

**Closure Workspace**:
AI Coverage Closure 闭环的临时工作区，路径 `.socverify/coverage/closure/<closureId>/`。AI 生成的测试代码写到此处，run_simulation 从此处执行，不污染正式项目目录。闭环结束后通过 Test Promotion 决定哪些测试提升到正式目录。
_Avoid_: closure sandbox, temp test dir

**Test Promotion**:
Coverage Closure 结束后，用户通过 Diff Review 审阅 Closure Workspace 中的测试代码，决定哪些测试"提升"到正式项目目录的过程。接受的测试从临时目录复制到正式目录，拒绝的丢弃。
_Avoid_: test merge, test adoption

**Gap Scheduler**:
Coverage Closure 中多 Gap 的并行调度策略。所有 Gap 同时开始处理，受 SessionManager 并发上限（10）限制。每个 Gap 独立跑仿真 + merge + report，精确计算单个 Gap 的 Delta。
_Avoid_: gap queue, closure coordinator

**Delta Validation**:
对 Coverage Delta 的可信度验证策略，分阶段引入。Phase 1 不检测（依赖闭环后 Diff Review）；Phase 2 多指标联动检查（如 line gap 修复要求 line + branch 同步上升）；Phase 3 assertion 同步上升检查。防止 AI 生成测试引入假覆盖。
_Avoid_: delta check, coverage verification

**Coverage Exclusion**:
建议排除的覆盖率项（如 dead code、unreachable ifdef 路径）。必须经人工审批后才能排除，不可自动排除。
_Avoid_: coverage waiver, coverage filter

**Coverage Preprocessing**:
覆盖率数据从 EDA 原始格式到结构化数据的两步流水线：第一步平台根据 EDA Tool Configuration 运行命令生成文本报告；第二步 CoverageParserPlugin 解析文本报告为 Coverage Tree。两步分离使 EDA 工具命令执行和文本解析可独立演化。
_Avoid_: coverage conversion, coverage extraction

**EDA Tool Configuration**:
项目级配置，指定 EDA 工具类型（Cadence IMC / Synopsys VCS urg / Mentor Questa vcover）、cov_merge 默认路径、命令模板。用于 Coverage Preprocessing 第一步。
_Avoid_: coverage settings, EDA config
