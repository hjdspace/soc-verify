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
