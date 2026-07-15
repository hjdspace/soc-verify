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
