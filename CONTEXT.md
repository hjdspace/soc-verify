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
为单个失败用例创建的独立 AI Agent 会话，拥有专属的 Agent Runner 进程和 Host Tools。支持多个 case 并行分析。
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
_Avoid_: test list

**Regression Group**:
一个回归组文件（通常 `.grp`），包含多个 Regression List 或 Regression Group 的文件路径引用。支持两级嵌套，递归解析时最大深度 10 层，检测循环引用。
_Avoid_: regression collection, batch group

**Regression Item**:
Regression Discovery 发现的一个可运行文件单元，Regression List 或 Regression Group 之一。回归运行配置中的选择单位，一次 Regression Run 只跑一个 Item。
_Avoid_: regression file, regression suite

**Regression Entry**:
Regression List 文件中的一行 case 定义，是回归的最小组成单元。包含 on/off 开关、block 名、case 名、seed 模式、迭代次数、标签、优先级、config、CFG_DEF、env/base、plusargs 等字段。
_Avoid_: regression case

**Regression Discovery**:
从 `$PROJ_ENV` 目录树自动扫描回归列表文件的过程。扫描三个来源：`$PROJ_ENV/<subsys>/regression/`（子系统直接列表）、`$PROJ_ENV/udtb/<subsys>/<block>/regression/`（ip2soc 列表，合并到子系统维度）、`$PROJ_ENV/udtb/usvp/regression/<short>/`（usvp 列表，通过 `.socverify/usvp-subsys-map.json` 映射短名到子系统全名）。按文件绝对路径去重，以文件内容格式判断是 List 还是 Group。
_Avoid_: regression scan, regression indexing

**Regression Suite**:
Regression Discovery 按子系统聚合的结果单元，汇总该子系统下全部 Regression Item 的 list/group 数量与 ON 用例数，是回归页子系统卡片的数据单位。只读聚合，不是用户创建的实体（与 ADR 0020 移除的手工 RegressionSuite 无关）。
_Avoid_: subsystem suite, regression summary

**Regression Run**:
通过 `runsim -regr <file>` 提交的一次回归执行，一次只跑一个 Regression Item。可选附加选项：`-tag`（只跑特定标签）、`-nt`（non-tag，排除特定标签）、`-fm`（fail mode，只跑失败用例）、`-cov`（收集覆盖率）、`-regr_work`（工作目录）、`-merge`（回归完成后自动 coverage merge）、`-m`（提交 dashboard，附 DE TAG）。输出流式写入终端面板，状态记录在回归历史中。
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
用户注册、供项目挂载的知识资产容器，包含原始证据与经审阅发布的知识，可整体拷贝后重新登记使用。
_Avoid_: 文档库, doc library, document store

**Raw Layer（原始层）**:
存放来源原件、需保留的历史修订及机械转换产物的知识库层。原件是受保护证据，派生产物只有在对应原件仍在时才能重建。
_Avoid_: sources layer, 原始资料区

**Wiki Layer（编译层）**:
存放经审阅发布的知识页和知识库导航、操作记录的层。重新生成知识不能保证复现过去的取舍与审阅结果。
_Avoid_: 生成层, compiled layer

**Wiki Page**:
具有类型、标题、摘要、来源与页面引用的知识页面，分为 Source Page 与 Knowledge Page。
_Avoid_: 知识条目, wiki entry

**Source Page（源摘要页）**:
针对单一来源修订的结构化摘要，包含要点、参数与章节地图，并链接到它贡献的知识页。
_Avoid_: 文档摘要, source summary

**Knowledge Page（知识页）**:
围绕实体、概念、对照、综合、问答、已知问题或接口组织的知识页面，可以从一个来源起步并持续吸收多个来源的贡献。
_Avoid_: 实体页, concept page, 主题页

**Pitfall Page（已知问题页）**:
按现象、根因、规避与证据组织的知识页，区分有证据的经验和未验证的推测。
_Avoid_: known issue, troubleshooting page

**Interface Page（接口页）**:
承载接口信号、位段与时序约束的知识页，保留适用范围及精确参数的原始证据。
_Avoid_: 寄存器页, signal page

**Query Page（问答页）**:
经用户主动选择并审阅发布的问题与回答，保留适用条件、来源证据和未证实项。
_Avoid_: 聊天归档, chat dump

**Wiki Schema（wiki 规则）**:
知识库的页面类型、组织方式与写作约定，约束编译提案的结构。
_Avoid_: wiki 配置, schema doc

**KB Registration**:
将一个目录登记为应用可管理知识库的动作；登记与文件内容的创建或删除是不同操作。
_Avoid_: library creation, 库创建

**KB Mount**:
项目与已注册知识库的使用关系，使项目会话能够检索和读取该库。当前一个项目同时挂载一个库。
_Avoid_: library link, 库关联

**Source Document**:
入库后具有稳定身份的来源文档，同一路径的更新属于该来源的新修订；同名但不同目录或格式的文档是不同来源。
_Avoid_: docName, original file

**Source Revision（来源修订）**:
某一来源在特定时点的原始内容，知识证据绑定具体修订。被已发布页、页面历史或待审阅提案引用的旧修订须保留。
_Avoid_: 当前文件, latest source

**Conversion**:
从来源原件提取全文文本和图像资产的本地机械处理，不包含模型生成的解释。
_Avoid_: transformation, 知识编译

**Parsed Markdown（转换产物）**:
来源修订经机械转换得到的全文 Markdown，用于原文检索和引用定位；不混入模型视觉解读。
_Avoid_: 知识摘要, generated source

**Conversion Failure**:
来源无法完成约定转换的情况，包括不支持、加密、损坏或资源限制；须与模型分析失败区分。
_Avoid_: conversion error, AI failure

**Visual Interpretation（视觉解读）**:
模型针对来源图像给出的解释，包含可见事实、关系和不确定项，并绑定原图与来源位置。它是待审阅知识，不能充当机械提取的原文。
_Avoid_: OCR 全文, 原图事实

**Knowledge Evidence（知识证据）**:
支撑知识论断的原文片段、图像或项目数据引用，能够标识来源修订和定位位置；引用失效与论断被证实是不同状态。
_Avoid_: 无版本链接, 推测来源

**KB Index**:
由已发布知识页的标题、摘要和主题信息聚合而成的完整导航目录。目录登记完整不代表页面间已经充分互联。
_Avoid_: catalog, 目录清单

**Wiki Log（wiki 日志）**:
知识库中可追溯的追加操作记录，不等同于页面历史或可丢弃运行日志。
_Avoid_: debug log, 页面快照

**Document Tagging（文档标签）**:
赋予来源摘要的主题标签，用于分组与筛选，不决定原件或转换产物的物理位置。
_Avoid_: auto classification, 文档分类目录

**Wiki Compile（知识编译）**:
依据来源、既有知识和写作规则生成或修订知识页提案的过程。编译完成不等于知识已发布。
_Avoid_: index build, 索引重建

**Ingest Queue（摄取队列）**:
记录并组织来源或选定问答处理任务的持久队列，保留未完成任务及其可恢复进度。
_Avoid_: build queue, 临时任务列表

**Staging Area（暂存区）**:
保留未发布知识提案、审阅基线和用户选择的区域，不参与默认知识消费。
_Avoid_: temp dir, 已发布知识

**Knowledge Change Set（知识变更集）**:
一次编译或修复产生的关联页面提案，用户选择后以最终候选集进行一致性校验和发布。
_Avoid_: tool call batch, 单页保存

**Knowledge Publication（知识发布）**:
把经审阅并校验的知识变更集变为正式可读知识的过程，须能从中断中恢复且不能覆盖过时审阅基线。
_Avoid_: 编译成功, 自动落盘

**Page History（页面历史）**:
保留知识页历次内容与变更来源的记录，用于追溯和回滚；其依赖证据也须可定位。
_Avoid_: 当前页面备份, 可清理缓存

**doc_to_markdown**:
Agent 按需转换库外文档的只读工具，不使文档成为知识库来源。
_Avoid_: ingest tool

**kb_search**:
Agent 对挂载库的已发布知识与可用来源全文进行检索的工具，返回可定位的结果及知识/证据状态。
_Avoid_: knowledge query, kb query

**kb_read**:
Agent 按知识或来源身份分页读取挂载库内容的工具，支持定位具体来源修订。
_Avoid_: 任意文件读取, doc_id 读取

**Knowledge Graph（知识图谱）**:
已发布知识页及其页面引用构成的关系网络，可从知识内容重建，不包含导航聚合页作为知识节点。
_Avoid_: link graph, 引用网络

**Graph Expansion（图扩展）**:
从初步检索命中的知识页出发，补充直接相关联页面的召回过程。
_Avoid_: neighbor search, 全图查询

**Relatedness（关联度）**:
用于推荐相关页面的关联强度，综合页面引用、来源重叠、共同邻居和类型关系；不是知识正确率。
_Avoid_: similarity, 置信度

**Lint**:
检查知识结构与语义问题的维护操作，结果应说明检查范围与证据，不承诺检出了全部问题。
_Avoid_: 全库正确性证明, 质量评分

**Knowledge Finding（知识待办）**:
编译或健康检查提出的矛盾、缺页、过时或关联建议，有待处理、忽略与复核解决等状态。处理待办不等同于批准页面变更。
_Avoid_: diff hunk, 已确认错误

**Graph Insight（图谱洞察）**:
从网络结构发现的稀疏社区、桥接节点等启发式线索，需结合内容判断其意义。
_Avoid_: 已证实知识盲区, 语义矛盾

### 多目录域

**Extra Directory（额外目录）**:
项目中除 rootPath 外挂接的目录，允许用户将多个文件系统目录纳入同一项目工作集。每个额外目录有独立的 ID、路径、分组类型和可选自定义标签。与 rootPath 共同构成项目的完整目录列表。存储于 `ProjectInfo.extraDirs: ExtraDirEntry[]`。
_Avoid_: linked dir, mounted dir, external dir

**Directory Group（目录分组）**:
额外目录的分类标签，固定为 `verify`（验证）或 `design`（设计）两类。验证分组下的目录是验证环境项目目录（如 SoC 验证环境、IP2SOC 验证环境），设计分组下的目录是设计目录（如子系统 RTL、SoC RTL）。决定目录在侧边栏和 AI system prompt 中的归属。rootPath 隐式属于验证分组。
_Avoid_: dir category, dir type, folder group

**Working Directory（工作目录 / cwd）**:
AI Agent session 的 `--cwd`，即 Agent Runner 子进程启动时的工作目录。可由用户在已添加目录中切换（默认为 rootPath）。切换工作目录会重建当前活跃 AI session（runner 的 cwd 在进程启动时固定）。非 cwd 目录的文件通过绝对路径访问，AI 由 system prompt 告知所有目录路径。
_Avoid_: active dir, primary dir, main dir

**ExtraDirEntry**:
额外目录的数据结构实体，包含 `{ id, path, group: 'verify'|'design', label?, isCwd, order, createdAt }`。rootPath 不存入 `extraDirs`（隐式属于验证分组的第一项），`extraDirs` 只存储用户后续添加的目录。
_Avoid_: dir entry, dir record

### AI 引擎域

**AI Engine（AI 引擎）**:
驱动 AI Agent 会话的底层引擎。运行时支持两种：pi（上游 `@earendil-works/pi-coding-agent`）和 Codex。本次迁移只将旧的 omp 实现替换为 pi，切换完成后不保留 omp/pi 双轨；Codex 作为独立引擎继续共存。新会话使用所选引擎，旧 omp 会话按 pi 的历史数据兼容规则重建，Codex 会话保持原引擎。引擎替换决策见 ADR 0033。
_Avoid_: agent backend, model provider

**Agent Runner**:
宿主与 AI Engine 之间的独立子进程边界，以统一协议承载命令、事件、工具和审批。
_Avoid_: engine process, omp runner

**Agent Event Contract（Agent 事件契约）**:
宿主与渲染进程之间统一的事件语义和 payload 约束，由 Agent Runner 将各引擎事件归一化后输出。覆盖消息、工具、审批、上下文、压缩、subagent 和错误生命周期；引擎替换不改变此契约。
_Avoid_: engine event, raw pi event

**Subagent Lifecycle（子代理生命周期）**:
subagent 以异步父子会话关系运行，向统一事件契约报告启动、进度、完成或失败；继承父会话的取消和工具审批边界，并将用量归属到可追踪的父子会话。
_Avoid_: fire-and-forget task, detached task

**Effective System Prompt（有效系统提示）**:
会话实际发送给 AI Engine 的最终系统提示，由引擎基础提示和 SoC Verify 应用规则组合而成。
_Avoid_: default prompt, append-only prompt

**Skill Source Compatibility（技能来源兼容）**:
应用发现 canonical pi skill 与受支持的其他生态 skill 来源时所使用的兼容边界。
_Avoid_: legacy skill write, permanent omp skills

**Managed Skill（托管技能）**:
由 Agent 学习机制生成或维护的可复用 `SKILL.md`，与用户编写的 authored skill 分离。
_Avoid_: implicit memory, authored skill

**Durable Lesson（持久经验）**:
通过学习工具保存的结构化经验记录，其可见范围由 Learning Scope 决定。
_Avoid_: managed skill, cross-project memory

**Learning Scope（经验作用域）**:
Durable Lesson 或 Managed Skill 的可见范围，分为项目级和用户级；用户级内容可跨项目发现。
_Avoid_: implicit global learning, unscoped memory

**Skill URI Contract（技能 URI 契约）**:
Agent 与应用引用 skill 及其内部文件的稳定 URI 形式为 `skill://<name>` 或 `skill://<name>/<relative-path>`；解析拒绝绝对路径和 `..` 穿越，底层 skill 来源目录对调用方透明。
_Avoid_: raw skill path, unrestricted skill URI

**Skill Resolution Priority（技能解析优先级）**:
同名 skill 按 `project > builtin > user` 解析，canonical pi 来源优先于同一作用域内的兼容目录；最终只暴露一个确定性结果。
_Avoid_: ambiguous skill, duplicate skill loading

**IAgentClient**:
引擎抽象接口，定义了 AI 引擎客户端的统一契约（`init` / `prompt` / `abort` / `steer` / `setModel` / `compact` / `destroy` / `onEvent` / `setToolCallHandler` / `setApprovalHandler`）。`PiAgentClient` 和 `CodexAgentClient` 分别实现此接口。SessionManager 依赖此接口而非具体实现。
_Avoid_: engine adapter, agent bridge

**Engine Session ID（引擎会话 ID）**:
跨引擎持久化的会话标识，统一使用 `engineSessionId` 命名，与具体 AI 引擎解耦。历史数据中的 `ompSessionId` 只读兼容一次，迁移后不再写入。
_Avoid_: ompSessionId, piSessionId

**Native Session Recovery Precedence（原生会话恢复优先级）**:
同一引擎恢复会话时用于决定原生 session 与 UI Transcript 哪个是权威来源的规则。
_Avoid_: transcript as source of truth, silent session rebuild

**Persisted Session Cwd（持久化会话工作目录）**:
应用会话创建时绑定并保存的工作目录，用于定位该会话的引擎原生存储。
_Avoid_: restore with active cwd, cwd-less native lookup

**Unavailable Session Cwd（不可用的会话工作目录）**:
Persisted Session Cwd 不存在或不可访问时的会话状态；该状态不允许 Agent 在其他目录隐式执行工具。
_Avoid_: silent cwd rebind, tool execution in wrong directory

**External Pi Session（外部 Pi 会话）**:
存在于当前工作目录对应的 pi 原生存储中、但尚未登记到 SoC Verify 会话索引的 session。
_Avoid_: imported session, application session

**Persisted Engine Kind（持久化引擎类型）**:
应用会话索引中标识其原生 session 所属 AI Engine 的字段。
_Avoid_: inferred engine, implicit engine routing

**Legacy Engine Session（旧引擎会话）**:
由已退役 AI Engine 创建、尚未在当前引擎中重建的应用会话。
_Avoid_: migrated session, converted session

**Regenerate Branch（重新生成分支）**:
从最后一条 user message 之前创建的新会话分支，用于重新生成回答；旧分支保留，新分支获得新的 `engineSessionId` 并承载后续事件。
_Avoid_: in-place regenerate, answer replacement

**PiAgentClient**:
实现 IAgentClient、通过 Agent Runner 驱动 pi 会话的客户端。
_Avoid_: AgentClient, OmpAgentClient, omp client

**Project Extension Trust（项目扩展信任）**:
项目本地 extension 在首次加载前需要用户确认并记录信任状态；应用内置和 lockfile 锁定的依赖可自动加载。该信任决定 extension 能否执行代码，不等同于单次工具调用审批。
_Avoid_: extension auto-load, tool approval

**MCP Server Trust（MCP 服务信任）**:
MCP server 首次启动前按 server 建立信任；应用内置或明确批准的 server 可自动启动，其他 server 需要用户确认。该信任控制本地进程和环境变量暴露，不等同于工具调用审批。
_Avoid_: MCP auto-start, tool approval

**MCP Runtime Degradation（MCP 运行时降级）**:
MCP extension 缺少应用要求的 headless 运行时接口时，对外暴露的受限能力状态。
_Avoid_: silent MCP failure, automatic turn replay

**Yolo Mode（全自动工具模式）**:
只跳过单次工具调用审批的运行模式，不授予项目 extension 加载或 MCP server 进程启动信任；后两类信任仍需独立建立。
_Avoid_: unrestricted mode, trust bypass

**Tool Approval Mode（工具审批模式）**:
统一适用于 pi、Codex、MCP 和 extension tools 的调用权限策略，取值为 `always-ask`、`write`、`yolo`，并按 read/write/exec 能力分级；write 工具调用保留前置快照和 Diff Review。
_Avoid_: engine-specific approval, allow-all mode

**Interactive Ask（交互式询问）**:
Agent 在一次工作过程中向用户请求补充信息或确认的应用自有工具，通过 Agent Event Contract 和 IPC/JSONL 连接 renderer，不依赖 TTY 或 pi-tui。
_Avoid_: TTY prompt, terminal question

**CodexAgentClient**:
Codex 引擎的 IAgentClient 实现。通过 JSON-RPC 2.0 over stdio 与 Codex App Server 子进程通信。将 `initialize` / `thread/start` / `turn/start` / `turn/interrupt` 等 JSON-RPC 方法映射到 IAgentClient 接口。转发 Codex 的 Thread/Turn/Item 事件到渲染进程（携带 `_engine: 'codex'` 标识）。
_Avoid_: codex client, app server client

**Codex App Server**:
OpenAI 开源（Apache-2.0）的有状态长生命周期进程，通过 JSON-RPC 2.0 暴露 Codex 的 Agent 能力。一个进程管理多个 Thread（会话），协议完全双向——客户端发请求，服务器也能主动发审批请求。预编译二进制从 GitHub Release 下载到 `resources/binaries/`。
_Avoid_: codex harness, codex core

**Thread（Codex 线程）**:
Codex 的持久会话容器，对应一次完整的 Agent 对话。可创建、恢复、分叉、归档。历史持久化到 `~/.codex/sessions/`。在 SoC Verify 中，Codex 的 threadId 映射到 `Engine Session ID`。
_Avoid_: codex session, conversation

**Turn（Codex 轮次）**:
Codex 的单次工作单元，由用户输入触发。包含多个 Item（步骤）。生命周期：`turn/started` → 多个 Item 事件 → `turn/completed`。在统一 Agent 事件模型中对应一次 agent 工作生命周期。
_Avoid_: codex prompt, codex turn

**Item（Codex 项）**:
Codex 的原子输入/输出单元。类型包括 `userMessage`、`agentMessage`、`commandExecution`、`fileChange`、`reasoning` 等。每个 Item 有明确生命周期：`item/started` → 可选 `item/*/delta`（流式）→ `item/completed`。
_Avoid_: codex event, codex step

**dynamicTools**:
Codex App Server 的实验性功能（需 `capabilities.experimentalApi = true`），允许在 `thread/start` 时动态注册自定义工具。SoC Verify 使用此机制将 Host Tools 暴露给 Codex Agent，与 Agent Runner 的 custom tool 定义概念对齐。
_Avoid_: codex custom tools, dynamic tool registration

**Engine Tag（引擎标识）**:
事件 payload 中的 `_engine` 字段（值为 `'pi'` 或 `'codex'`，历史数据中的 `'omp'` 视为 `'pi'` 的旧值），用于渲染进程区分事件来源引擎。CodexAgentClient 转发事件时添加此字段；pi（Agent Runner）事件不添加（默认视为 pi）。渲染进程的 `handleSessionEvent` 据此路由到对应引擎的事件处理分支。
_Avoid_: engine flag, source tag

### 终端增强域

**Terminal Theme Mode**:
终端主题的运行模式，取值为 `follow-ui`（跟随 UI 主题）或 `independent`（独立终端主题）。`follow-ui` 模式下从 CSS 变量读取 16 色 ANSI 调色盘，随 UI 主题切换自动联动；`independent` 模式下从内置或用户自定义的终端主题 JSON 读取调色盘，与 UI 主题解耦。
_Avoid_: terminal color mode, theme sync mode

**Terminal ANSI Palette**:
xterm.js `ITheme` 接口定义的 16 色 ANSI 调色盘（8 基础色 + 8 亮色），加上 background、foreground、cursor、selectionBackground 四个语义色。`follow-ui` 模式下由 UI 主题的 16 个 CSS 变量（`--term-black` 到 `--term-bright-white`）提供；`independent` 模式下由主题 JSON 的 hex 色值提供。
_Avoid_: terminal color scheme, xterm colors

**Enhanced Terminal**:
启用了 Prompt 美化和命令预测的交互式终端会话。通过 `TerminalCreateOptions.enhanced: true` 标记，主进程在 spawn shell 时注入 `ZDOTDIR`、`STARSHIP_CONFIG` 等环境变量。仅用于交互式终端；仿真终端（`sim:` 前缀）不启用 enhanced 模式。
_Avoid_: fancy terminal, decorated terminal

**Shell Integration**:
通过 OSC 133 转义序列标记命令边界的前端增强机制。shell 端在命令开始、输出前、命令完成时发送 OSC 133 序列，前端 xterm.js 解析后在命令行渲染装饰器（退出码图标、执行时间、复制按钮、命令折叠）。仅交互式终端启用；仿真终端的命令信息由 SimTerminalLinker 和 SimControlToolbar 提供。
_Avoid_: terminal integration, command markers

**Command Decorator**:
Shell Integration 的前端渲染产物，附着在命令行上方或下方的 UI 组件。包含退出码图标（绿勾/红叉）、执行时间、复制按钮和命令折叠（长输出可收起）。使用 xterm.js Decoration API 渲染，不写入 xterm.js buffer。
_Avoid_: command badge, terminal widget

**Nerd Font Registration**:
将打包的 Nerd Font 字体文件通过 Electron `app.registerFont()` 在系统级注册的过程，使所有 Electron 窗口中的文本（包括 xterm.js 渲染的终端）均可使用 Nerd Font 图标和 Powerline 符号。字体文件打包在 `resources/fonts/`。
_Avoid_: font loading, font install

**Starship Binary**:
跨 shell 的 Prompt 美化引擎（Rust 编写），打包为单二进制文件存于 `resources/binaries/`。通过 `STARSHIP_CONFIG` 环境变量指定配置文件路径。支持 zsh、bash、PowerShell、tcsh 等多种 shell，但不支持 csh。
_Avoid_: prompt engine, starship binary

### Token 监控域

**Token Usage Record**:
一次 LLM API 交互的 token 用量记录，是 Token Monitor 的最小数据单元。包含引擎标识、会话 ID、模型、输入/输出/缓存读/缓存写/推理 token 计数、总 token 数、成本和时间戳。来源于 `message_end` 事件的 `usage` 字段（实时）或 JSONL 日志解析（外部扫描）。以 `(engine, session_id, message_id)` 组合去重。
_Avoid_: token entry, usage row

**Token Monitor DB**:
项目级 SQLite 数据库（`.socverify/token-monitor.db`），存储 Token Usage Record 的单一数据源。使用 better-sqlite3（与 Case Database 和 Timing Violation DB 一致），per-request 粒度存储，通过 SQL 聚合查询支持热力图、趋势图和引擎/模型分解。独立于 Case Database，关注点分离。
_Avoid_: token store, usage database

**Token Usage Recorder**:
主进程模块，在 SessionManager 的事件转发路径中旁路拦截 `message_end` 事件，提取 assistant message 的 `usage` 字段写入 Token Monitor DB。不阻塞事件转发，写入失败仅记日志不影响 AI 会话。
_Avoid_: token collector, usage tracker

**Log Scanner**:
主进程模块，定时轮询（5 分钟间隔）外部 AI 工具的本地 JSONL 日志文件，解析 token 用量写入 Token Monitor DB。支持 claude-code（`~/.claude/projects/**/*.jsonl`，可通过 `$CLAUDE_CONFIG_DIR` 覆盖）和 codex CLI（`~/.codex/sessions/**/*.jsonl`，可通过 `$CODEX_HOME` 覆盖）。通过文件 mtime + byte offset 实现增量解析，避免全量重复扫描。
_Avoid_: log poller, file scanner

**Engine Tag**:
Token Monitor 的引擎标识，取值为 `'pi'`（SoC Verify 驱动的 pi 引擎，历史值 `'omp'` 归一化为 `'pi'`）、`'claude-code'`（外部 Claude Code CLI）、`'codex'`（SoC Verify 驱动或外部 Codex CLI 的统一标识）。与 AI 引擎域的 Engine Tag（`_engine` 字段）概念不同——后者区分事件来源引擎用于路由，前者用于 token 统计聚合。SoC Verify 驱动的 codex 和外部 codex CLI 的 token 记录都标记为 `'codex'`，通过 session_id 区分。
_Avoid_: tool name, client name

**Token Heatmap**:
Token Monitor 视图中的 365 天活动热力图（GitHub 风格），色深表示当日 token 消耗量。数据来自 `SELECT date(timestamp/1000, 'unixepoch') as day, SUM(total_tokens) FROM token_usage GROUP BY day`。
_Avoid_: activity grid, contribution graph

**ContextUsageIndicator vs Token Monitor**:
ContextUsageIndicator 显示当前会话上下文窗口的实时占用（还能发多少消息），数据来自 Agent Event Contract 的 `context_usage` 事件；优先采用 pi 原生值，缺失时由 Agent Runner 计算并标记为近似。Token Monitor 显示历史 token 消耗统计和趋势（用了多少 token），数据来自 `message_end` 事件的 `usage` 字段。两者职责分离，不互相替代。多轮 prompt cache 会使累计 token 很大而当前上下文仍只占一个窗口。
_Avoid_: context tracker

### RTL 解析域

**Design Source（设计源配置）**:
项目级配置，指定 RTL elaboration 的输入：一个或多个 VCS 风格 .f 文件，加上从 elaboration 产出的 top units 中选定的顶层模块。层级解析与编辑器语言服务共享的单一数据源。
_Avoid_: filelist config, RTL config

**RTL Hierarchy（RTL 层级）**:
DE 树 RTL 静态 elaboration 产生的模块实例树，含 generate 展开与参数实例化后的结构。不含 UVM/TB 运行时层级（明确非目标——静态 elaborator 原理上拿不到 class 实例树）。
_Avoid_: design tree, module tree

**Module Instance（模块实例）**:
RTL Hierarchy 的节点，对应 elaboration 后的一个实例。同一 Module Definition 的多次实例化产生多个节点，各自有独立的层级路径。
_Avoid_: cell, instance node

**Module Definition（模块定义）**:
源码中一个 module 声明的提炼产物：端口表（名称/方向/位宽）、参数、源文件位置。多个 Module Instance 共享一个 Definition。
_Avoid_: module signature, module template

**Protocol Bundle（协议束）**:
按命名规则聚合到同一协议实例的一组端口/信号（如一个 AXI4 端口的全部通道信号）。框图边收拢、模块接口分组、树节点徽标的公共消费单元。
_Avoid_: bus group, signal bundle

**Bundle Rule（束规则）**:
端口命名模式到协议类型（AXI4/AXI4-Lite/AHB/APB 等）的映射规则。内置 AMBA 规则包提供默认值，项目可在 `.socverify/` 下覆盖扩展。
_Avoid_: bundle pattern, protocol rule

**Design View（设计视图）**:
第七个顶层视图（与总览/仿真/覆盖率/回归/token/workspace 平级），承载 RTL 层级浏览器：层级树与框图联动，模块源码跳转走 Workbench 文件 tab。
_Avoid_: RTL view, hierarchy view
