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
两次覆盖率数据快照之间某个 metric 覆盖率的变化量，快照来源可以是两次 Merge Session，也可以是 Closure 内两次 Coverage Recovery。用于跟踪迭代改进效果。Delta > 0 表示有效，Delta = 0 表示 stimulus 未命中 gap。
_Avoid_: coverage change, coverage improvement

**Coverage Triage**:
对 Coverage Gap 的根因分类和置信度评估。根因类型：missing_scenario、wrong_config、dead_code、sampling_issue、encoding_mismatch。置信度：high、medium、low。
_Avoid_: gap analysis, coverage diagnosis

**Coverage Closure**:
迭代流程：识别 Gap → 聚合为 Closure Target → 生成定向测试 → 运行仿真 → Coverage Recovery → 检查 Delta → 重复。每个 Closure Target 最多 5 轮，连续 2 轮 Delta < 1% 触发升级。Dead code 确认和 exclusion 审批需要人工介入。
_Avoid_: coverage convergence, coverage completion

**Closure Target**:
Coverage Closure 的模块级工作项：用户选中的设计模块上所有未达标 metric 的聚合。一个 Closure Target 对应一个 AI Agent 会话和一套迭代历史，判定达标的标准是该模块全部 metric 达到 Coverage Target。取代早期的 per-gap（模块 × metric）工作项粒度。
_Avoid_: closure gap, closure work item

**Coverage Recovery**:
平台（而非 AI）驱动的覆盖率回收流程：收集本轮仿真产生的 simv.vdb → 与基线 VDB 合并运行 urg 生成新报告 → 重新解析为 Coverage Tree → 计算 Coverage Delta。是 Closure 闭环中 Delta 可信的前提。
_Avoid_: coverage refresh, re-merge

**Closure Workspace**:
AI Coverage Closure 闭环的临时工作区，路径 `.socverify/coverage/closure/<closureId>/`。AI 生成的测试代码写到此处，run_simulation 从此处执行，不污染正式项目目录。闭环结束后通过 Test Promotion 决定哪些测试提升到正式目录。
_Avoid_: closure sandbox, temp test dir

**Test Promotion**:
Coverage Closure 结束后，用户通过 Diff Review 审阅 Closure Workspace 中的测试代码，决定哪些测试"提升"到正式项目目录的过程。接受的测试从临时目录复制到正式目录，拒绝的丢弃。
_Avoid_: test merge, test adoption

**Target Scheduler**:
Coverage Closure 中多 Closure Target 的并行调度策略。所有 Target 同时开始处理，受 SessionManager 并发上限限制。每个 Target 独立跑仿真 + Coverage Recovery，精确计算单个 Target 的 Delta。
_Avoid_: gap queue, closure coordinator

**Delta Validation**:
对 Coverage Delta 的可信度验证策略，分阶段引入。Phase 1 不检测（依赖闭环后 Diff Review）；Phase 2 多指标联动检查（如 line gap 修复要求 line + branch 同步上升）；Phase 3 assertion 同步上升检查。防止 AI 生成测试引入假覆盖。
_Avoid_: delta check, coverage verification

**Coverage Exclusion**:
建议排除的覆盖率项（如 dead code、unreachable ifdef 路径）。完整链路：AI 在 Triage 升级时输出 exclusion 建议（含 reason）→ 人工审批 → 平台生成 exclusion 文件（urg -elfile 格式）→ 下次报告生成时应用。AI 不可自动排除。
_Avoid_: coverage waiver, coverage filter

**Coverage Preprocessing**:
覆盖率数据从 EDA 原始格式到结构化数据的两步流水线：第一步平台根据 EDA Tool Configuration 运行命令生成报告（VCS urg 优先生成类型化 XML 报告，降级为文本报告）；第二步 CoverageParserPlugin 解析报告为 Coverage Tree。两步分离使 EDA 工具命令执行和报告解析可独立演化。
_Avoid_: coverage conversion, coverage extraction

**EDA Tool Configuration**:
项目级配置，指定 EDA 工具类型（Cadence IMC / Synopsys VCS urg / Mentor Questa vcover）、cov_merge 默认路径、命令模板、执行后端（direct / LSF）。用于 Coverage Preprocessing 第一步。
_Avoid_: coverage settings, EDA config

### 时序违例域

**Timing Violation**:
后仿真阶段 EDA 工具报告的时序违例条目，从 `vio_summary.log` 日志中解析。每条违例包含 NUM（序号）、Hier（层级路径）、Time（违例时刻）、Check（检查类型和详细信息）四个核心字段。
_Avoid_: timing violation entry, VIO entry

**Violation Confirmation**:
对一条 Timing Violation 的确认结论——是否为真实问题需要修复。包含 status（pending/confirmed/ignored）、confirmer（确认人）、result（pass/issue）、reason（确认理由）四个字段。每条违例有且只有一条确认记录。
_Avoid_: violation review, violation disposition

**Violation Pattern**:
从历史确认记录中提取的重用模板，以 (hier_pattern, check_pattern) 为键。当新违例的层级路径和检查信息匹配已有模式时，自动建议确认人、结果和理由，减少重复确认工作。支持精确匹配和模糊匹配（标准化 check_info 后比较）。
_Avoid_: confirmation template, violation template

**Corner**:
工艺-电压-温度组合（PVT condition），如 `npg_f1_ssg`、`npg_f2_ffg`。一条违例属于一个 corner，一个用例在多个 corner 下可能有不同的违例集合。Corner 列表项目相关，当前为展锐特定列表。
_Avoid_: PVT corner, process corner

**Reset Time**:
仿真复位阶段的截止时间（纳秒）。时间戳 ≤ Reset Time 的违例被视为复位期间的噪声，可自动确认忽略。扩展概念 Reset Interval 允许指定多个时间区间进行自动确认。
_Avoid_: reset period, reset threshold

**Regression Scan**:
递归扫描回归目录树，发现所有 `vio_summary.log` 文件并解析出 subsys/corner/case/seed 元信息的过程。支持标准模式（`<case>_<corner>/<case>_<seed>/log/vio_summary.log`）和通用模式。
_Avoid_: regression discovery, batch scan

**Violation Dashboard**:
时序违例数据的可视化展示面板，包含统计概览（总数/已确认/待确认）、按子系统/corner/用例的分布图表、违例列表的分页检索和筛选。取代 Python 版本独立的 Web 服务器，集成到 Electron 渲染进程。
_Avoid_: violation web view, timing report page

**Pattern Normalization**:
对 Check 信息进行标准化以实现模糊匹配的规则：层级路径必须完全匹配；括号前的检查类型必须匹配；括号内按逗号分割为三部分，前两部分去除冒号后的时间信息只匹配冒号前的内容，第三部分完全忽略。
_Avoid_: check normalization, fuzzy match rule

### 用例数据库域

**Case Database**:
项目级 SQLite 数据库（`.socverify/cases.db`），作为用例数据的单一数据源，包含子系统、用例和仿真历史三张表。所有消费者（UI、AI Agent、时序违例、Dashboard）统一从 DB 读取数据，插件降级为「扫描器」仅在刷新时调用。
_Avoid_: case store, case cache

**Case Scanner**:
`SubsysDiscoveryPlugin` 和 `CaseParserPlugin` 在数据库架构中的新角色——不再作为实时数据源，而是在项目打开（后台增量扫描）或用户点击「刷新」时被调用，扫描结果写入 Case Database。
_Avoid_: case data source, case provider

**Simulation Run Record**:
`simulation_runs` 表中的一行记录，代表一次仿真运行的完整信息（case_name, subsys, status, start_time, end_time, duration_ms, corner, seed, options_json）。由 `run:completed` 事件监听器写入 DB，支持 Dashboard 的时间趋势查询和不稳定用例识别。
_Avoid_: sim log, run entry

**Simulation Phase**:
用例所属的仿真阶段（如 DVR1、DVR2、DVR3、DVS1、DVS2、POST），由 `CaseParserPlugin` 从 case_cfg 解析返回。作为用例的属性存储在 `cases` 表的 `phase` 列中，Dashboard 可按阶段分组查询通过率。阶段列表项目相关，可配置。
_Avoid_: verification stage, simulation stage

**Case Scan**:
通过 Case Scanner 全量扫描项目用例配置文件并写入 Case Database 的过程。项目打开时若 DB 已有数据则秒开，后台并行执行 Case Scan 增量更新；用户点击「刷新」按钮时触发全量 Case Scan。
_Avoid_: case discovery, case indexing

### 回归域

**Regression List**:
一个回归列表文件（通常 `.lst`），包含多行 case 定义。每行字段：on/off、block、case、seed、iterative、tag、priority、config、CFG_DEF、env/base、plusargs。由 `RegressionDiscovery` 从 `$PROJ_ENV` 目录树自动发现，不做 seed × plusargs 交叉展开（这是 runsim 脚本的职责）。
_Avoid_: regression suite, test list

**Regression Group**:
一个回归组文件（通常 `.grp`），包含多个 Regression List 或 Regression Group 的文件路径引用。支持两级嵌套，递归解析时最大深度 10 层，检测循环引用。
_Avoid_: regression collection, batch group

**Regression Entry**:
Regression List 文件中的一行 case 定义，是回归的最小组成单元。包含 on/off 开关、block 名、case 名、seed 模式、迭代次数、标签、优先级、config、CFG_DEF、env/base、plusargs 等字段。
_Avoid_: regression case, regression item

**Regression Discovery**:
从 `$PROJ_ENV` 目录树自动扫描回归列表文件的过程。扫描三个来源：`$PROJ_ENV/<subsys>/regression/`（子系统直接列表）、`$PROJ_ENV/udtb/<subsys>/<block>/regression/`（ip2soc 列表，合并到子系统维度）、`$PROJ_ENV/udtb/usvp/regression/<short>/`（usvp 列表，通过 `.socverify/usvp-subsys-map.json` 映射短名到子系统全名）。按文件绝对路径去重，以文件内容格式判断是 List 还是 Group。
_Avoid_: regression scan, regression indexing

**Regression Run**:
通过 `runsim -regr <file>` 提交的一次回归执行。可选附加选项：`-tag`（只跑特定标签）、`-nt`（non-tag，排除特定标签）、`-fm`（fail mode，只跑失败用例）、`-cov`（收集覆盖率）、`-regr_work`（工作目录）、`-merge`（回归完成后自动 coverage merge）。输出流式写入终端面板，状态记录在回归历史中。
_Avoid_: regression execution, regression batch

**Regression History**:
持久化的回归执行记录，存储在 `.socverify/regressions/regr_<timestamp>.json` 中。包含 runId、文件路径、子系统、命令、选项、提交时间、进程状态（running/completed/aborted/failed）、退出码、输出尾部。不记录 case 级别的 pass/fail（由 runsim 管理）。
_Avoid_: regression results, regression log

**usvp Subsystem Mapping**:
`.socverify/usvp-subsys-map.json` 配置文件，将 usvp 回归目录下的短名映射到子系统全名（如 `apcpu` → `apcpu_sys`、`sp` → `aon_sys`）。文件不存在时短名直接作为子系统名展示。映射是项目特定的。
_Avoid_: usvp mapping, subsystem alias

### Dashboard 域

**Dashboard**:
中栏 CenterArea 中的完整验证数据可视化面板，由标签页分区组成，包含趋势图、子系统热力图、失败列表、回归进度、耗时分布、不稳定用例、阶段通过率、调试难度等图表。数据全部来自 Case Database 的 SQL 聚合查询。通过 `workbench.open({ type: 'dashboard' })` 打开。
_Avoid_: dashboard panel, metrics view

**Dashboard Summary**:
左侧 LeftRail 概览页中的缩略数据区域，包含统计行（子系统数/用例数/通过率/失败数）、迷你回归进度条、7 天 pass/fail sparkline 趋势，以及「打开完整仪表盘」按钮。数据为 Dashboard 数据的子集，供用户快速概览。
_Avoid_: overview stats, mini dashboard

**Unstable Case**:
在多次仿真运行中既有 pass 又有 fail 记录的用例（也称 flaky case）。Dashboard 的不稳定用例标签页按失败率降序列出此类用例，展示 pass 次数、fail 次数、总运行次数、失败率、最近一次状态。SQL 查询：`GROUP BY case_name HAVING SUM(CASE WHEN status='pass' THEN 1 ELSE 0 END) > 0 AND SUM(CASE WHEN status='fail' THEN 1 ELSE 0 END) > 0`。
_Avoid_: flaky test, intermittent failure

**Debug Difficulty**:
用例调试难度的量化指标，由两个维度表征：(1) 首次提交仿真到首次 pass 的时间（天）；(2) pass 之前的 fail 次数。两个值越大，调试难度越高。Dashboard 的调试难度标签页用散点图展示（X 轴=天数，Y 轴=fail 次数），右上角用例为调试难度最高者。SQL 通过窗口函数查找每个用例的首次 run 时间和首次 pass 时间。
_Avoid_: case complexity, fix difficulty

**Dashboard Time Range**:
Dashboard 顶部的全局时间范围选择器，可选全部/最近 7 天/最近 30 天/自定义。所有图表默认使用该范围过滤 `simulation_runs` 数据，但回归进度始终按全量统计（衡量整体完成度）。
_Avoid_: date filter, time window

**Dashboard Theme**:
ECharts 图表的主题，通过读取应用 CSS 变量（`--background`/`--foreground`/`--primary`/`--status-pass`/`--status-fail` 等）动态构建 ECharts theme 对象。主题切换时重新构建，确保图表颜色与 UI 完全一致。
_Avoid_: chart theme, echarts skin

### 知识库域

**Knowledge Base**:
用户注册的任意目录，作为 Markdown 文档知识资产的容器，自包含（源文档副本、转换产物、索引、图片资产），可整体拷贝迁移。应用级注册，项目级挂载使用。
_Avoid_: 文档库, doc library, document store

**KB Registration**:
将一个目录登记为知识库的动作，登记信息存应用全局配置。注册空目录时初始化标准结构（`sources/`、`docs/`、`index.md`）。
_Avoid_: library creation, 库创建

**KB Mount**:
项目与知识库的挂载关系，存项目配置。挂载后库对项目内 AI Agent 会话可见（索引注入 + kb_search）。v1 单库挂载，架构预留多库。
_Avoid_: library link, 库关联

**Source Document**:
上传时复制入库的原始文档副本（pdf/docx/pptx 等），存 `sources/`，是重新转换的唯一依据。同名上传即覆盖并触发重转。
_Avoid_: 原件, original file

**Conversion**:
anydoc 将 Source Document 转为 GitHub-Flavored Markdown 的过程。嵌入图片提取到 `docs/assets/<文档名>/` 并在 markdown 中替换为相对路径链接。
_Avoid_: transformation, 文档解析

**Conversion Failure**:
anydoc 无法产出有意义 Markdown 的情况，以错误码呈现（扫描版 PDF → `unsupported`、加密文档 → `encrypted` 等）。失败条目在文档列表中可见、可重试。
_Avoid_: conversion error

**KB Index**:
单文件 `index.md`，知识库的目录结构索引：层级目录树 + 每文档的标题、一句话摘要、关键词、相对路径链接。AI Agent 速查知识库的入口地图，用户可直接阅读编辑。
_Avoid_: catalog, 目录清单

**Auto Classification**:
转换完成后由 LLM 根据文档内容决定其归属的分类子目录（`docs/<分类>/`），与 Fast Reindex 合并为一次 LLM 调用。用户可拖拽改分类后重建索引。
_Avoid_: auto categorization

**Fast Reindex**:
直连 LLM API 的一次性调用，基于文档骨架（标题结构 + 前若干行）为新增文档生成索引条目并增量合并进 KB Index。上传转换成功后自动触发。
_Avoid_: quick index

**Deep Reindex**:
走完整 omp Agent 会话的索引重建模式，agent 可逐文档深入阅读后重写摘要，质量上限高、耗时更长。用户手动触发。
_Avoid_: full reindex

**doc_to_markdown**:
Host Tool。AI Agent 按需将任意支持格式文档转为 Markdown 返回内容，不入库。Agent 承接"看 word/pdf 文档"类任务时的决策路径。
_Avoid_: convert tool

**kb_search**:
Host Tool。跨挂载知识库检索（KB Index 关键词 + `docs/` 全文匹配），返回匹配文档路径与摘要。
_Avoid_: knowledge query, kb query
