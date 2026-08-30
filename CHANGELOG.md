# Changelog

本文件记录 SoC Verify 项目的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

---

## [0.4.4](https://github.com/hjdspace/soc-verify/compare/v0.4.3...v0.4.4) (2026-08-31)

### Features

* **ui:** beautiful-ui 设计语言公共映射层——语义阴影/缓动/keyframes 收敛，GlideMenu 行间滑动高亮共享化
* **ui:** 划选 AI 操作条 SelectionActions——划选浮条 + Discard/Retry 恢复原文，扩展到主页面文件/产物表面（FileEditor md 预览、CodeMirror 编辑区挂载宿主）
* **ui:** 洞察轮播 InsightCards——recharts 双系列对比折线/异常检测柱状/占比分段条，InsightPanel 宿主映射三查询 + 追问 pill 开 AI 面板
* **ui:** 洞察带全宽布局——InsightPanel 去 max-w-md，InsightCards 页内左右分栏，窄容器降级单列
* **ui:** TaskRows 视觉吸收 TodoPanel 换肤——任务行卡片化、错峰 fade-up 入场、终态实徽 pop-in、放弃态红 tint 重试 pill
* **ui:** RecordsTable 拆解吸收三模式——TagList 溢出折叠、列宽拖拽手柄、AI 根因列逐行计算
* **ui:** 批量编辑采纳表 DiffTable——stage 状态机分阶段着色（删除红 tint → 新增行展开 + 页脚 fade-up），逐行勾选统计与 busy 确认
* **ui:** 通用建议卡 RecommendationCard——置信度信号条 + 备选方案抽屉 + CTA success 态，TVAISuggestionCard 重构接入
* **ui:** 状态 chips 筛选 FilterTable——计数徽标实时派生 + FilterCollapseRow grid-rows 折叠，HistoryTable 接入状态筛选
* **ui:** ScrubField 数值微调控件——label 即 slider 手柄三路改值，覆盖率阈值 TargetsSection 与 RunConfigModal 类型筛选接入
* **ui:** CommandPalette 搜索体验强化——SearchList 小件共享化（清除按钮/空状态卡/匹配片段高亮），HistoryView 搜索框同模式复用
* **ui:** 引用来源展开升级 ContextCards chunk 卡——chip 错峰淡入，KB 预览摘要卡同形态接入
* **chat:** 引用来源对齐 beautiful-ui——重叠图标堆叠胶囊 + 展开卡片列表
* **chat:** 模型菜单瘦身（仅名称 + 上下文大小）、输入框弹窗对齐 beautiful-ui Prompt Bar

### Bug Fixes

* **chat:** 引用来源不再把名称罗列误判为文件路径——全大写段拒绝 + 打开前存在性校验兜底
* **editor:** 工具卡片路径行号后缀剥离——打开文件并自动选中指定行区间
* **chat:** 回合收尾操作栏增加未落地工具兜底门槛
* **ui:** 划选操作条 review 修复——Retry 后 Discard 基线改取 live store，pending tool 扫描限定本回合
* **ui:** 状态 chips 筛选分隔线改跟随可见末行；建议卡字段不全时隐藏确认 CTA 消除假 success 态

### Refactor

* **ui:** RecordsTable/批量采纳表 review 修订——renderTag 渲染层收敛单点，removal/addition 行共用 interactiveRowProps

## [0.4.3](https://github.com/hjdspace/soc-verify/compare/v0.4.2...v0.4.3) (2026-08-29)

### Features

* **project:** 支持 `~` 波浪号路径展开，agent 工具参数 home 简写不再被拼入项目根
* **chat:** 工具卡片集成 ToolChips 分组式渲染——折叠头 + 行式条目 + diff chips 悬停预览
* **chat:** AI 聊天流式体验优化——模糊尾缘光标与回合收尾操作栏，回合后自动生成建议追问
* **chat:** 修复 regenerate 命令失效
* **scm:** 源代码管理支持点击文件展开 diff 审查
* **ai:** 新增 thinking level 配置（模型配置、runner RPC、AI composer）
* **ai:** 每个 credential 可选择 OpenAI API 格式（chat/completions vs responses）
* **ai:** TraceWeave 升级到 v2.0 并新增内置 MCP 就绪诊断
* **tools:** ToolCard 实现技能读取检测与 skill 徽标
* **simulation:** 仿真运行 command/cwd 持久化到数据库（新增表列、记录保存与类型增强）
* **simulation:** 仿真视图左侧面板新增 tab 切换与 CaseCfgPanel 用例配置管理
* **simulation:** 目录搜索功能增强，命令预览增强并剥离 `cd` 前缀
* **simulation:** 预设选择器与保存功能增强
* **simulation:** ScreenshotsPreview 支持图片缩放与拖拽
* **theme:** 新增 Apple Light / Apple Dark 主题，主题选择替换为 ThemeGroup 组件

### Bug Fixes

* **chat:** 流式尾缘仅应用于最后一个文本块，消除兄弟块级重复模糊
* **agent:** 推理模型声明 reasoning_content 回传 compat，修复 deepseek 系 thinking 模式 tool_calls 400
* **simulation:** 仿真 store 活跃运行列表去重

### Refactor

* **ui:** 枚举渲染统一为 EnumField 组件，OptionCard/OptionField 组件重构
* **ui:** 背景类统一调整（bg-glass/bg-scrim），动画令牌与 reduced motion 增强
* **file-tree:** 图标处理简化，用例树渲染与动画优化

## [0.4.2](https://github.com/hjdspace/soc-verify/compare/v0.4.1...v0.4.2) (2026-08-27)

### Features

* **titlebar:** 添加 AI 面板折叠按钮
* **dashboard:** 添加里程碑动作展开菜单并引入图标库
* **error-display:** 添加结构化错误消息展示组件
* **ui:** 集成视觉库——ThinkingOrbs 替换 AI 加载指示器（issue 01+02）
* **ui:** liquid-gooey NavRail 视图切换指示器 + ap-chase 弃用与全量验证（issue 04+05）
* **visual:** border-beam 集成到 4 个焦点/审批组件
* **editor:** 添加 CSV 文件表格编辑器
* **simulation:** 新增 SimArtifactResolver 仿真产物解析器，正确解析仿真日志路径
* **simulation:** 增强仿真状态检查机制与日志路径解析
* **simulation:** 仿真记录新增 command 和 cwd 字段，活跃运行列表增强
* **simulation:** 新增仿真调试工具（sim-debug.ts）与内联调试按钮
* **simulation:** 新增仿真调试原型页面（浮动调试停靠栏、行操作、终端工具栏）
* **simulation:** 新增仿真 rerun 按钮与 EDA 工具启动器
* **regression:** 新增 RunConfigModal 回归配置弹窗与回归命令构建器
* **regression:** RegressionView 增强运行配置与活跃回归展示
* **regression:** 回归追踪器新增 getTerminalId 方法，SuiteCard/SuiteCardGrid 新增 actions 属性
* **regression:** 回归选项新增 dashboard 属性并改进 getRunTerminal
* **file-tree:** FileTree 新增 dirId 属性支持懒加载与按需展开
* **file-tree:** 实现 isDirectoryToolResult 函数与 GrepBody 正则高亮
* **tools:** 新增 CopyButton 组件用于文本复制，ReadBody 支持目录结果与文本复制
* **tools:** ToolCard 增强目录处理与图标，GenericBody 改进输出展示
* **session:** 新增 credentialSnapshot 函数与会话上下文工厂 providerId
* **session:** 会话路由增强——holistic swap 功能与异步模型设置重构
* **session:** 日志模块增强——LogEvent 与 registerLogSink
* **session:** stdout 写入拦截增强以确保 JSONL 合规
* **deps:** 添加 @firecrawl/anydoc 到外部模块
* **ai-panel:** 创建 ai-panel.css 设计令牌样式与 AI 面板原型 UI
* **theme:** 主题管理增强——applyTheme 设置主题色调
* **ui:** RightPanel 新增复制图标与样式更新，HistoryTable 支持子系统展示

### Bug Fixes

* **error-analysis:** 修复模拟目录失效时错误分析失败
* **simulation:** 修复仿真目录路径与状态检查
* **build:** 修复 tsconfig.json 引用格式

### Refactor

* **file-tree:** 替换 lucide 图标为本地 VS Code 图标集
* **file-tree:** 移除目录预取改为展开时按需加载
* **nav-rail:** 移除液态指示器改用底线激活态
* **security:** 重构目录安全检查并新增 containment 方法
* **regression:** 重构回归终端处理与 runsim 命令生成解析
* **regression:** 移除 OptionCard 回归测试功能与 pickRegrFile procedure，清理 SimOptionPanel
* **regression:** 将 buildRegrCommand 迁移到共享 regression-command 模块
* **simulation:** 重构仿真路由以改进产物处理与状态处理
* **tools:** 重构多个工具组件——BashBody、EditBody、WriteBody、GrepBody→GlobBody、DiffLineView、MarkdownRenderer、McpBody、ClickablePathHeader、ApprovalCard、SubagentCard→AgentRow、ThinkingBlock、TodoPanel
* **session:** 重构异步模型设置逻辑与会话核心
* **build:** 移除 tsconfig.runner.json composite 选项

### Documentation

* **simulation:** 文档化仿真状态判定与日志目录指南（PASS/FAIL 判定原则、$PROJ_WORK 环境变量）
* **context:** 增强 CONTEXT.md 回归概念
* **regression:** 创建统一回归启动流程 PRD 与 ADR

### Tests

* **simulation:** 新增仿真调试工具、getSeedFromLog、SimControlToolbar Debug 按钮端到端测试
* **file-tree:** 新增懒加载、目录展开与 dirId 验证测试
* **regression:** 新增 RunConfigModal、回归命令 dashboard 选项、getTerminalId 未知 runId、RegressionView 测试
* **session:** 新增 session-router 模型交换行为与 SessionManager 环境凭据测试
* **ui:** RunListPanel 调试功能与 ToolCard data-status 属性测试增强

## [0.4.1](https://github.com/hjdspace/soc-verify/compare/v0.4.0...v0.4.1) (2026-08-25)

### Features

* **model-config:** 模型配置重构——按 provider 独立模型列表与独立上下文窗口
* **breadcrumb:** 为目录段添加下拉导航并禁用 EISDIR 路径点击
* **editor:** Markdown 预览新增 Mermaid 图表渲染支持
* **settings:** 新增多类设置标签页组件
* **tools:** 新增多类工具展示组件并移除全局 OptionDock
* **codex:** 添加 Codex 引擎集成相关文档和 ADR

### Bug Fixes

* **test:** 修复 5 个失败测试用例——llm-config cred.models 可选链 + searchCases file_path 匹配 + electronTRPC 全局 mock + session-core mock 路径
* **test:** 启用测试并行化并修复 Mermaid 不稳定测试
* **build:** 修正 electron 镜像配置变量名使用连字符
* **session:** 处理会话进程死亡后清理会话状态并增强错误处理
* **test:** CaseTreePanel 测试断言修正——使用 accessible name 而非 title
* **session-messages:** 静默跳过 MCP 挂载通知避免误显示
* **agent:** 修复运行器可执行权限丢失并扩展生成失败诊断
* **chat/mermaid:** 修复全局清理 mermaid 临时节点导致的图表渲染冲突
* **chat/mermaid:** 阻止错误渲染并清理残留节点

### Refactor

* **kb:** 移除 MarkItDown 引擎，回归 anydoc 单引擎
* **diff-review:** 从 diff-review store 提取纯函数到 diff-review-ops.ts
* **runner:** 从 992 行 index.ts 提取命令处理器到独立模块
* **timing-violation:** 拆分 timing-violation store 为 4 个领域 store
* **sim-view:** 从 CenterArea 提取内联仿真视图
* **coverage:** 拆分 Coverage Store 为 4 个聚焦子 store（core/gaps/closure/export）
* **session:** 拆分 Session Store 为三个子 store（core/messages/approval），2281 行 session.ts 拆分为四个文件
* **terminal:** 移除预捕获登录 shell 环境以避免重复初始化
* **markdown-renderer:** 重构组件以优化流式渲染与组件复用
* **app-shell:** 移除 OptionDock，重构 AppShell 布局与 RightPanel 集成
* **project:** 重构项目类型并新增接口，环境变量解析与同步逻辑优化
* **sim-store:** 重构活跃运行合并逻辑与仿真 store 状态管理

### Performance

* **sim:** RunListPanel 虚拟滚动优化——引入手写虚拟滚动与 RunRow memo

### Build

* 优化打包配置，裁剪包体积并优化构建流程

## [0.4.0](https://github.com/hjdspace/soc-verify/compare/v0.3.2...v0.4.0) (2026-08-23)

### Features

* **sim-run:** 持久化仿真运行记录并支持跨重启恢复列表
* **simulation:** 仿真视图三栏布局整合 — CaseTreePanel + SimOptionPanel + RunListPanel（Issues #3 #4 #5 #6）
* **sim-option-panel:** 新增 SimOptionPanel 组件，支持仿真视图内选项配置
* **agent-tools:** 新增 AgentToolsTab 组件与工具管理设置面板，支持启用/禁用 agent 工具
* **tool-settings:** 新增工具目录元数据、静态工具目录与工具过滤应用方法
* **error-handling:** 新增全局错误处理机制——ErrorBoundary 组件、全局错误事件处理与未捕获异常处理器
* **regression:** 增强 RegressionRunner，支持数据库同步功能
* **case-scanner:** 实现 CaseStatsRegistry 扫描监视功能
* **project:** RTL 目录文件监视与防抖
* **session:** 会话中止处理改进与瞬态传输错误处理
* **codex-engine:** 新增 Codex 引擎集成 SDK 桩模块——SessionManager、MCPManager、ModelRegistry、logger、mcp-client、ambient module 声明
* **ipc:** 新增 ipc-channels.ts IPC 通道常量定义
* **subagent:** 新增子代理生命周期与进度事件日志

### Bug Fixes

* **sim-run:** 限制运行中仿真列表高度并加载总览活跃数据
* **sim-view:** 优化导航栏顺序、修复仿真页面双滚动条和运行列表格式
* **test:** 用 getByTestId 替换 getByText 避免多元素匹配

### Refactor

* **sim-view:** 提取 SimCommandBar 并合并执行模式分组
* **sim-view:** 将子系统用例入口移入仿真视图并精简文件抽屉
* **sim-view:** 提取共享组件并新增 simLeftPanelWidth 到 UI store
* **agent-tools:** 重构 AgentToolsTab 优化工具管理
* **task:** 重构 TaskBody 使用 result 替代 resultText，重构任务状态处理与解析函数
* **title-gen:** 重构 AI 标题生成机制——简化为仅使用用户消息触发
* **agent:** 改进 AgentClient 进程终止与处理
* **session:** 重构会话标题生成测试

### Build

* **tsconfig:** 更新 tsconfig.runner.json lib 配置

## [0.3.2](https://github.com/hjdspace/soc-verify/compare/v0.3.1...v0.3.2) (2026-08-20)

### Features

* **chat:** 智能消息列表滚动：支持固定底部与滚动到底部按钮
* **chat:** 用 Markdown 渲染子代理任务指令内容
* **diff:** 优化新文件 diff 计算及代理通知消息处理
* **diff-review:** 重构为内联编辑器模式，增强 diff 引擎稳定性
* **editor:** 实现 Vim 模式、Minimap、缩进指引、语法高亮、面包屑导航、状态栏及编辑器持久化
* **prototype:** 新增 subagent 卡片 UI 方案原型及数据通路适配
* **scripts:** 新增 TLS 证书自愈模块，解决本地代理导致的证书验证失败
* **session:** AI 自动总结会话标题，修复重启后会话名丢失
* **project:** 实现项目内联重命名功能

### Bug Fixes

* **chat:** 修复 useShallow 避免 useSessionStore 订阅导致无限重渲染
* **chat:** 修复无语言标记的 fenced code block 被错误渲染为行内代码的问题
* **diff-review:** 修复已审查或缺失条目时无法打开文件路径的问题
* **project:** 修复 Linux 上项目文件监视器递归导致阻塞的问题
* **subagent:** 修复 subagent 日志累积丢失问题，改为正序累积日志
* **ui:** 修复 Linux 上 hover 样式丢失并添加按钮按下反馈

### Refactor

* **coverage:** 合并覆盖率数据的批量加载，消除重复的 resolveSession 调用
* **docs:** 将 PRD 和 Issues 文档按目录分类整理
* **runner:** 提取审批逻辑并支持对话历史种子恢复
* **runner:** 提取 write snapshot 模块并支持自定义工作目录

## [0.3.1](https://github.com/hjdspace/soc-verify/compare/v0.3.0...v0.3.1) (2026-08-18)

### Features

* **coverage:** AI 覆盖率闭合 P1——urg session.xml 解析、模块级 ClosureTarget、EDA 配置迁移
* **coverage:** Orchestrator 闭合集成 Recovery 与 finalizeRecovery 恢复机制（issue #5）
* **coverage:** 闭合详情 UI 与 AI 排除建议链（issues #6 #7）
* **settings:** 设置界面重构为左侧垂直分组导航布局，新增 UI 原型文档

### Bug Fixes

* **coverage:** 修复 get_coverage_grade 工具中数据源引用错误

### Refactor

* **sysbase-gen:** 全面重构向导步骤——StepReview/StepOptional 重命名与功能增强、StepMini 模板生成与预览、StepCsv 组件、DUT Spec 模板生成器、目录推断与折叠、命令构建器重构、顶层配置支持
* **sysbase-gen:** clk 参数改为可选，新增 XCELIUM_HOME/XLM_ROOT 环境变量处理与回退逻辑
* **coverage:** 覆盖率解析增强——summaryOnly 选项、详细报告解析与进度跟踪、IMC summary 格式文档、summary 优先导入优化
* **filetree:** 文件树懒加载优化——getDirChildren 子路由、FileTreeNode 懒加载、目录展开性能提升
* **security:** 内容安全策略改进——CSP 修改、local-resource 协议注册、FileEditor 图片预览与缩放
* **tests:** 增强测试覆盖——sysbase 模板/目录/时钟测试、StepReview 可选参数测试、mock adapter 与 parseDetails 测试

## [0.3.0](https://github.com/hjdspace/soc-verify/compare/v0.2.7...v0.3.0) (2026-08-17)

### Features

* **kb:** 完成知识库全功能迭代——anydoc 依赖接入与 Conversion 服务、KB 注册/挂载/kb-router 最小闭环、上传-转换-分类-索引流水线、Host Tools 与索引上下文注入、知识库 UI（列表/索引/预览 Tab + 移动分类 + 深度重建）、kb_search 挂载检测与 markitdown 第二引擎、AI 分类降级/重分类及凭证模型字段
* **kb:** 重构知识库架构——拆分 LLM 配置逻辑到独立模块、统一路径与文档逻辑、文件上传统一 pickAndUpload 流程、活跃项目替代默认项目、域行为提取与类型整合
* **sysbase-gen:** 新增 SoC 验证环境生成器完整模块——向导式 UI（DUT Spec/Mini Case/CLK/RAL/Module IO/Optional/Subsys/RTL/Review 九步）、Zustand store、命令构建器、目录推断、模板加载、路径扫描、Module IO runner、gen-runner 事件执行、配置持久化、tRPC 子路由与共享类型
* **drawio:** 新增 DrawIO 图表查看器支持及相关工具，支持中键拖拽缩放交互
* **coverage:** 适配 Cadence IMC 24.09 新命令格式，新增层级覆盖率解析
* **env:** 新增登录 shell 环境捕获逻辑以正确检测 EDA 工具与环境变量
* **app:** 新增应用单实例锁，防止多开
* **theme:** 新增主题持久化（tRPC settings + Zustand），防止默认主题闪烁
* **ask:** 新增交互式 AskQuestion 工具处理——IPC 转发、answer 格式化、AskQuestionCard 组件
* **workbench:** 新增关闭所有 Tab 功能与项目切换 switchProject 方法
* **terminal:** 新增终端视图选中文本复制功能
* **xlsx:** 新增列宽格式转换功能与 XlsxEditor onSaveAs 回调
* **composer:** 新增 ComposerEditor 组件并集成到 RightPanel
* **diff-review:** 增强 diff 审查功能——reviewedFiles 持久化、warning 结果处理、加载失败错误处理
* **docs:** 添加知识库相关文档（ADR、issues、PRD、原型）和术语定义，添加 UVM Harness 白皮书文档
* **project:** 启动时项目恢复与子系统动态获取过滤
* **docs:** 添加 SoC 验证环境生成器文档与原型 UI

### Bug Fixes

* **drawio:** 修复 lightbox 工具栏布局异常并添加拖拽交互

### Refactor

* **kb:** 优化知识库架构候选方案 4/5a/6——域行为提取、类型整合、活跃项目 Owner

### Build

* **deps:** 移除 shell: true 并修复 spawn 调用以规避 DEP0190 警告

## [0.2.7](https://github.com/hjdspace/soc-verify/compare/v0.2.6...v0.2.7) (2026-08-13)

### Features

* **todo:** 新增 todo 面板功能，支持多状态任务展示与会话级折叠状态
* **env:** 新增环境变量管理功能与文件路径交互优化
* **mcp:** 集成 TraceWeave 作为内置 MCP 服务器
* **python:** 新增 Python 路径解析、终端 shell 修复及 MCP 配置增强

### Bug Fixes

* **diff-review:** 恢复 AI edit diff review 工作流

### Refactor

* **env:** 统一环境变量目录管理，移除冗余状态

## [0.2.6](https://github.com/hjdspace/soc-verify/compare/v0.2.5...v0.2.6) (2026-08-11)

### Features

* **dashboard:** 完成仪表盘全功能迭代，新增 Overview/Trend/Failures/Regression/Duration/Unstable/Phase 七大数据标签页，支持多维度统计与 ECharts 可视化
* **terminal:** 新增自定义 bashrc 配置与 Linux 终端适配优化

### Bug Fixes

* **env-checker:** 修复过滤器处理逻辑与相关 bug

### Refactor

* **suspicious-files:** 重构可疑文件管理流程与持久化逻辑
* **env-checker:** 重构 EnvChecker 功能模块与默认目录获取
* **regression:** 重构回归分析工具与默认目录解析
* **coverage:** 重构覆盖率合并工具与默认目录获取
* **project:** 重构项目目录解析与 Git 仓库扫描流程
* **imports:** 优化 case-repository 导入与下载流程

### Build

* **linux-sqlite:** 支持通过环境变量自定义 Node.js 下载源

### Documentation

* **dashboard:** 添加仪表盘相关文档与术语表

## [0.2.5](https://github.com/hjdspace/soc-verify/compare/v0.2.4...v0.2.5) (2026-08-09)

### Features

* **plugin:** 新增 UI 插件类型支持，实现用户级插件系统，支持全局插件发现、优先级管理与 EDA 日志摘要插件
* **markdown:** 新增 Mermaid 图表渲染支持，包含样式作用域隔离、主题适配、缩放与平移交互
* **session:** 添加上下文管理功能，支持上下文用量展示、手动压缩与压缩状态管理
* **session-router,discovery:** 新增 case stats include flag 并修复子系统用例计数

### Refactor

* **ui:** 重构上下文用量指示器交互逻辑

## [0.2.4](https://github.com/hjdspace/soc-verify/compare/v0.2.3...v0.2.4) (2026-08-08)

### Features

* **case-db:** 实现基于 SQLite 的用例数据库方案，新增 Case Database、Scanner 和 getSubsystems 从 DB 读取
* **case-db:** CaseStatsService 全量从 DB 读取，Repository 新增 getLatestStatusBySubsys/getAllLatestStatuses/getCaseNameToSubsysMap，移除 PluginBackedDiscovery 依赖和 TTL 缓存
* **case:** 新增 case 信息的 phase 字段支持
* **database:** 新增 SQLite 数据库查看功能
* **unisoc:** 新增 USVP 伪子系统支持，改进 case parser
* **frontend:** SubsysList 文件节点默认折叠，按需点击展开，保留批量展开/折叠和搜索点击功能

### Bug Fixes

* **case-scanner:** 调整清除数据顺序以适配外键约束

### Refactor

* **violation-router:** 实现 ADR 0017，将 case→subsys 数据源从插件切换到 cases DB
* **SubsysList:** 重构子系统用例加载和展开逻辑
* **case-scanner:** 简化同步模式清理逻辑

---

## [0.2.3](https://github.com/hjdspace/soc-verify/compare/v0.2.2...v0.2.3) (2026-08-07)

### Features

* **host-tools:** 拆分 HostTools 单体为注册器 + 工具模块，新增 EventRelay 实现 IPC 事件转发与管理
* **host-tools:** 新增 RTL 上下文、仿真、覆盖率统计、文档创建和 xlsx 编辑等 Host Tool
* **tools:** 新增 17 个工具子路由（time-analyzer、system-monitor、sv-ifdef-checker、regression-list-gen、regression-analyzer、register-table-parser、reg2c、log-analyzer、git-quick-pull、git-manager、git-diff、find-replace、env-checker、coverage-merger、code-line-counter、c-sv-converter、batch-execution）
* **tools:** 新增共享 input-validation 辅助工具
* **git-manager:** 实现 Git 仓库管理（RepoCard、TagDialog、UpdateDialog、SingleRepoUpdateDialog、批量更新与回主分支）
* **git-quick-pull:** 增强并行执行和实时日志输出
* **terminal:** 新增 TerminalPanel 组件和 SimControlToolbar 仿真控制工具栏
* **simulation:** 增强 runsim 命令生成与解析，新增 rerunWithCommand 和 getSeedFromLog
* **window:** 实现窗口工厂与 IPC 控制，新增系统托盘功能
* **linux:** 新增 Linux 平台 IME 和 D-Bus 设置
* **session:** 实现 SessionContextFactory 会话上下文工厂
* **coverage:** 在 worker 线程中解析覆盖率，新增插件路径解析
* **coverage-merger:** 增强日志流式传输和历史记录管理
* **time-analyzer:** 增强实时事件流和额外时间单位支持
* **register-table-parser:** 新增 autoFix 选项和工具函数
* **theme:** 更新主题支持和验证命令
* **window:** 新增窗口关闭偏好管理

### Refactor

* **linux:** 清理冗余代码并完善终端依赖兼容性
* **terminal:** 用 TerminalPanel 替换 TerminalView（CenterArea 和 BottomPanel）
* **coverage:** 重构 CoverageDashboard 和覆盖率管理器以提升性能
* **git-manager:** 重构 GitManager 以增强仓库管理
* **session:** 重构 tv-ai-advisor 会话创建逻辑
* **tools:** 简化 tools 路由结构，重构 RegressionListGen 为 TypeScript
* **c-sv-converter:** 重构 C/SV 转换器增强功能
* **register-table-parser:** 重构为统一工作表接口
* **coverage-merger:** 重构日志为 IPC 事件实时输出

### Performance

* **coverage:** 优化 CoverageTreeTable 过滤和渲染性能

### Build

* 新增 build-linux-sqlite 构建脚本，将 better-sqlite3 加入 asarUnpack 配置

---

## [0.2.2](https://github.com/hjdspace/soc-verify/compare/v0.2.1...v0.2.2) (2026-08-06)

### Features

* **surface:** 实现 View Manager 核心架构，提供视图边界与叠加层同步（Issue #1 #2）
* **surface:** 完成 Document Surface 迁移（Issue #3 #4）
* **browser:** 移除 webview 基础设施并新增 Browser Surface（Issue #5 #6）
* **browser:** 实现浏览器标签持久化与书签管理
* **browser:** 支持 window.open、SSO 登录和证书处理（Issue #9）
* **browser:** 实现下载管理与权限处理（Issue #10）
* **browser:** 新增页内查找、浏览器快捷键和统一 URL 打开（Issue #11 #12）
* **browser:** 添加浏览器视图 URL 同步逻辑
* **tools:** 新增工具注册中心、工具窗口管理和工具下拉菜单集成
* **tools:** 新增 Git Diff、Git Manager、Git Quick Pull 多仓库管理工具
* **tools:** 新增 Register Table Parser 和 Reg2C（Excel 转 C 头文件）
* **tools:** 新增 SV Ifdef Checker 和 C-SV Converter
* **tools:** 新增 Batch Execution 批量执行和 Code Line Counter 代码统计
* **tools:** 新增 Coverage Merger 覆盖率合并和 Environment Checker 环境检查
* **tools:** 新增 Find Replace、Log Analyzer 和 Performance Monitor
* **tools:** 新增 Regression Analyzer、Regression List Gen 和 Time Analyzer
* **timing-violation:** 新增 TV AI Advisor，提供时序违例智能建议
* **timing-violation:** 新增 Pattern 管理和回归扫描，支持精确与模糊匹配
* **timing-violation:** 新增导出/导入功能，支持 Excel/CSV 导出和数据库迁移
* **timing-violation:** 新增 TVDistributionCharts 分布图表
* **timing-violation:** 增强 TVDashboard，支持 case corner 加载和 reset interval 配置
* **timing-violation:** 实现子系统批量更新和历史确认应用
* **coverage:** 新增覆盖率导入进度跟踪
* **overview:** 新增项目概览缓存（5 秒 TTL）和 Zustand store

### Refactor

* **surface:** 重构导航状态获取逻辑，统一使用 navigationHistory 对象
* **timing-violation:** 重命名 dbPath 为 dataDir，改进目录处理

### Chore

* 批量清理未使用变量、导入项和冗余依赖

---

## [0.2.1](https://github.com/hjdspace/soc-verify/compare/v0.2.0...v0.2.1) (2026-08-04)

### Features

* **officecli:** 新增 Office 文档预览、PDF 预览、XLSX 原地编辑和 AI 文档创建能力
* **timing-violation:** 新增时序违例解析、数据库管理、仪表盘筛选统计和确认工作流
* **simulation:** 增强仿真命令解析、回归列表文件选择和运行状态聚合统计

### Bug Fixes

* **terminal:** 改进终端 shell、工作目录和仿真会话处理，增强二进制启动失败诊断
* **config:** 规范化 EDA 配置和 JSON 解析，提升配置兼容性

### Refactor

* **officecli:** 拆分 XLSX 读取工具并改用 stdin 传递批处理 JSON
* **timing-violation:** 引入 better-sqlite3、worker 解析和共享数据库缓存

---

## [0.2.0](https://github.com/hjdspace/soc-verify/compare/v0.1.10...v0.2.0) (2026-08-03)

### Features

* **plugin:** 完成 VS Code 风格插件扩展宿主实现，支持命令和视图贡献
* **plugin:** 扩展宿主视图容器与宿主 API，增强插件与宿主的集成能力
* **plugin:** 完成插件生命周期 SDK 与迁移，提供完整插件开发与迁移支持
* **editor:** 添加 HTML 文件预览和在外部浏览器中打开功能
* **editor:** 支持 Markdown 预览中点击内部链接打开文件
* **settings:** 实现字体管理功能，支持 UI 字体、代码字体和字号预设
* **layout:** 添加可折叠的底部终端面板，支持拖拽调整大小和内容显示
* **session:** 完成仿真终端与 AI 错误分析功能迭代
* **tools:** 新增工具元数据、会话回调与 UI 展示优化
* **markdown:** 添加 rehype-raw 支持 HTML 渲染

### Documentation

* **plugin:** 添加插件开发指南文档
* **docs:** 添加插件审计与选项 UI 原型

### Chore

* **gitignore:** 添加 .tmp/ 目录到忽略列表

---

## [0.1.10](https://github.com/hjdspace/soc-verify/compare/v0.1.9...v0.1.10) (2026-07-25)

### Features

* **mcp:** 新增多作用域 MCP 配置管理、工具查看与配置重载功能，优化连接错误提示
* **prompt:** 添加默认系统提示词展示，终端降级兼容修复
* **coverage:** 新增 CSV、grade、bins 等覆盖率报告解析与命令支持，增强覆盖率报告生成器
* **coverage:** 新增覆盖率分析工具注册，新增 TestContribution 类型与 EDA 命令更新
* **coverage:** 增强 coverage store 覆盖率分析能力，新增调试信息与导入日志处理
* **coverage:** 增强 CoveragePanel，新增 grade 与 uncovered 标签页
* **coverage:** 新增 getImportLog procedure，提供详细导入结果
* **search:** 实现倒排索引高效文本搜索，新增 CaseIndexManager 优化用例索引
* **search:** 搜索新增子系统过滤能力
* **platform:** 实现 Linux 输入法与 D-Bus 会话总线设置，改进 D-Bus 检测与处理

### Bug Fixes

* **skills:** 修复 Windows 平台技能删除 bug
* **mcp:** 添加 MCPManager 实例空值检查，避免崩溃

### Refactor

* **search:** 重构 searchCases 使用 caseIndexManager，文件树更新时失效索引

---

## [0.1.9](https://github.com/hjdspace/soc-verify/compare/v0.1.8...v0.1.9) (2026-07-23)

### Features

* **scm:** 新增文件暂存、取消暂存、丢弃和提交功能，提供完整 Git 工作流操作
* **mcp:** 新增 getMcpStatus 命令与 API，支持查询 MCP 服务器运行状态
* **mcp:** 新增 MCP 配置读写模块，支持项目级与用户级 MCP 服务器配置
* **coverage:** 新增覆盖率注册表，实现按项目缓存 CoverageManager 实例
* **error-analysis:** 新增错误分析会话工厂与 prompt 模板，抽离错误分析逻辑

### Refactor

* **plugins:** 重构插件适配器导入路径，从 host/plugin-discovery 迁移到 plugin-adapters 目录，统一导入路径
* **ipc:** 拆分 router-context 导出逻辑，将业务逻辑下沉到对应服务模块

---

## [0.1.8](https://github.com/hjdspace/soc-verify/compare/v0.1.7...v0.1.8) (2026-07-23)

### Features

* **coverage:** 新增内置覆盖率解析器插件，支持解析 IMC、VCS urg、vcover 等多种 EDA 工具覆盖率报告
* **coverage:** 新增覆盖率导入与合并的目录浏览功能，提升交互体验
* **settings:** 新增 `readSkill` procedure 与 `readSkillContent` 方法，支持通过文件路径读取技能内容
* **settings-ui:** SettingsPanel 新增内容加载与展开/折叠切换

### Bug Fixes

* **coverage:** 增强 CoverageManager 错误处理，报告生成失败时创建 meta.json 并优雅降级
* **coverage:** 修复测试在无报告生成器场景下的处理，确保优雅降级
* **ci:** 修复 GitHub Action Release 发布流程，上传资产前创建 draft release 解决 `release not found` 错误

---

## [0.1.7](https://github.com/hjdspace/soc-verify/compare/v0.1.6...v0.1.7) (2026-07-23)

### Features

* **coverage:** 实现端到端覆盖率导入，构建层级树数据模型，支持会话级覆盖率状态合并
* **coverage-ui:** 新增覆盖率树形表与 Dashboard 仪表盘，提供层级化可视化分析
* **coverage-ai:** 新增 AI Host Tools 与 `cov://` URI Scheme，使 AI Agent 可访问覆盖率数据
* **coverage-closure:** 实现 Coverage Closure 闭环循环，集成 AI 编排器驱动覆盖率收敛迭代与 UI 状态展示
* **coverage-export:** 新增覆盖率导出能力，支持 HTML 报告与 JSON 结构化输出
* **coverage-promotion:** 实现 Test Promotion 与闭环后整合，完成 AI 驱动验证全流程闭环
* **terminal:** 命令执行新增项目工作目录支持

### Bug Fixes

* **terminal:** 修复子进程退出码处理，使 handleTerminalExit 正确反映退出状态
* **agent:** 实现 agent 进程错误监听器，捕获子进程异常

### Refactor

* **terminal:** 重构 runsim 重试工具改用 TerminalManager，统一终端调度入口

### Build

* **native:** 增强原生模块 patch 脚本，spawn-helper 复制到 prebuild 目录

---

## [0.1.6](https://github.com/hjdspace/soc-verify/compare/v0.1.5...v0.1.6) (2026-07-21)

### Features

* **credentials:** 新增凭据更新功能，支持部分字段更新（apiKey 可选保留原值）
* **platform:** 新增 Linux D-Bus 会话总线设置，抑制错误日志
* **agent:** 新增 ensureV1Prefix 函数，确保 baseUrl 正确包含 /v1 前缀

### Bug Fixes

* **session:** 修复会话管理器中 baseUrl 缺少 v1 前缀导致 OpenAI 兼容代理请求失败
* **agent:** 实现 stdout 守卫，防止非 JSONL 输出破坏 RPC 协议通信

### Refactor

* **terminal:** 重构 node-pty 二进制路径查找逻辑，返回结构化数据
* **agent:** 重构 OpenAI 模型获取逻辑，统一使用 fetchOpenAICompatibleModels 函数

### Build

* 新增 node-pty Linux 原生二进制构建脚本，支持 Docker 交叉编译
* package:linux 脚本集成 build-linux-pty 步骤

### Tests

* 新增 OpenAI 兼容代理 baseUrl 处理测试

---

## [0.1.5](https://github.com/hjdspace/soc-verify/compare/v0.1.4...v0.1.5) (2026-07-20)

### Features

* **skills:** 实现完整技能管理功能
* **project:** 新增用例搜索功能，支持模糊匹配
* **file-tree:** 新增 FileTree 组件右键上下文菜单，支持在系统文件管理器中打开
* **ipc:** 新增 openInSystem procedure，支持文件/目录在系统中打开
* **terminal:** 终端管理器增强错误处理，新增 fallback 模式与 backend 状态查询
* **simulation:** 仿真命令执行处理增强，新增 backend 与 warning 状态属性
* **toast:** Toast 系统新增 warning 类型

### Refactor

* **types:** 拆分单体类型文件并重构代码结构
* **ipc:** 重构 Bun 全局声明并增强日志

---

## [0.1.4](https://github.com/hjdspace/soc-verify/compare/v0.1.3...v0.1.4) (2026-07-19)

### Features

* **context:** 添加文件/文件夹上下文选择功能
* **option-dock:** 优化预设管理功能，添加提示与预览效果
* **app:** 新增关闭行为持久化与托盘菜单重置选项
* **ipc, simulation:** 新增全套 IPC RPC 路由与仿真管理重构
* **session, message:** 用户消息新增技能 chip 展示
* **agent, credentials:** 新增运行时模型切换与多 provider 凭据支持

### Refactor

* **ui:** 优化 UI 样式与标题栏功能，新增测试用例
* **theme:** 统一替换硬编码颜色为主题变量，重构主题系统
* **renderer:** 深化前端工作流模块

---

## [0.1.3](https://github.com/hjdspace/soc-verify/compare/v0.1.2...v0.1.3) (2026-07-17)

### Features

* **skills:** 新增内置技能/扩展系统，支持内置技能目录发现与加载（built-in extension directory、additionalExtensionPaths、SelectedSkill builtin source、electron-builder 内置扩展打包）
* **multimodal:** 新增多模态图片处理，支持 FileTree 图片拖拽与 LLM 图片输入（handlePrompt 图片处理、CSP 图片源放行）
* **agent:** 新增思考过程展示（ThinkingBlock 组件、assistant 消息 reasoning 内容分离提取）
* **agent:** 新增模型输入覆盖配置（buildModelInputOverrideConfig）
* **ui:** 新增流式光标组件与动画（memoized StreamingCursor、cursor blink animation）
* **perf:** 实现消息更新与持久化节流，优化大流量会话性能
* **project:** 新增 Git 忽略文件处理，FileTree 标记 gitIgnored 文件
* **session:** 增强会话事件日志与摘要能力
* **skills:** 新增 SOC 验证环境生成技能（SKILL.md、run_extract_mod_io.sh、env.json.template）
* **app:** 新增应用图标与系统托盘支持

### Bug Fixes

* **build:** 修复 Windows EPERM 重命名错误，增加重试机制
* **build:** 禁用 electron-builder 自动发布
* **build:** 移除硬编码 electronDist，补充 author 字段
* **security:** 调整 CSP 策略以支持图片源
* **project:** 从忽略模式中移除 `.socverify`

### Refactor

* **runner:** 重构 runner 图片处理逻辑
* **diff-review:** 重构 DiffReviewView 使用 displayType 区分行类型
* **agent:** 优化 handlePrompt 图片处理流程

### Documentation

* 新增 CSV 格式、RTL 规范、技能错误码参考、配置解析、SOC 命令模板等文档
* 更新 README，补充新功能与 native addon 提取说明

### Tests

* 新增图片透传、模型输入覆盖配置、OpenAI 兼容模型、会话消息事件处理等测试

### Build

* 新增 native addon 下载与解压脚本，打包前自动获取依赖
* 新增 omp 版本读取与缓存步骤
* node-pty 加入 asarUnpack
* 配置国内镜像加速 Electron 下载

---

## [0.1.2](https://github.com/hjdspace/soc-verify/compare/v0.1.1...v0.1.2) (2026-07-16)

### Features

* **diff-review:** 新增代码 Diff Review 系统（Diff Engine、DiffReviewView、队列管理、diff-review procedures）
* **error-analysis:** 新增仿真失败自动错误分析（LogAnalyzer、ErrorAnalysisCoordinator、read_file tool、runsim_retry）
* **terminal:** 新增终端仿真执行与运行中案例面板（TerminalView、SimTerminalLinker、session tab 管理）
* **plugins:** 新增 Unisoc 插件集（case-parser、simulation-runner、sim-option-schema）
* **agent:** 重构 agent 运行时，支持预编译二进制 runner 模式

### Refactor

* **terminal:** 重构 TerminalManager 数据批处理与 session 管理
* **simulation:** 重构仿真事件处理、case ID 唯一性处理
* **ui:** 重构 ToolCard、SubsysList、OptionDock 等组件

### Documentation

* 新增 CONTEXT.md 与 diff review、error analysis、hybrid log path 策略 ADR

### Tests

* 新增 log analyzer 与 unisoc-case-parser 单元测试

### Build

* 新增 Rollup、LightningCSS 依赖
* 更新 .gitignore 忽略 .socverify/

---

## [0.1.1](https://github.com/hjdspace/soc-verify/compare/v0.1.0...v0.1.1) (2026-07-13)

### Features

* **session:** 新增会话历史管理功能，支持恢复和删除历史会话
* 新增工具卡片功能与highlight.js语法高亮支持
* **session:** add persisted last selected model feature
* add source control workflow

### Refactor

* **ai-session:** 重构会话管理，支持恢复历史会话并优化UI
* **session:** 重构会话恢复与存储逻辑，优化体验
* **ipc,store:** 重构会话ID匹配与持久化逻辑，实现懒加载运行时会话
* **RightPanel:** 优化会话标签页加载指示器逻辑

---

## [0.1.0] - 2026-07-13

首个正式版本，覆盖 M0-M7 全部里程碑，实现 SoC 验证全流程管理。

### M0 — 项目脚手架

#### 新增
- Electron 43 + electron-vite 5 三进程构建配置（main / preload / renderer）
- React 19 + TypeScript 7 渲染进程基础架构
- Tailwind CSS v4 + shadcn/ui (new-york) 样式体系
- Zustand 5 状态管理基础
- electron-trpc 0.7.1 IPC 桥接
- Vitest 4 测试框架与三缝测试架构
- 自定义无边框窗口 + TitleBar 组件
- 6 套主题系统（light / dark / midnight / carbon / nord / solarized-light）
- 三栏布局骨架（LeftRail / CenterArea / RightPanel + OptionDock）

### M1 — omp RPC 核心

#### 新增
- 将 oh-my-pi 作为 git submodule 引入 `engine/oh-my-pi/`
- `OmpRpcClient`：基于 JSONL 的 RPC 客户端，通过 stdin/stdout 与 omp 子进程通信
- `SessionManager`：多会话生命周期管理（并发上限 10），支持动态注册/注销 Host Tools 和 URI Schemes
- `HostToolsRegistry`：7 个默认 Host Tools（list_subsys / list_cases / run_simulation / get_run_status / get_compile_errors / get_coverage / read_file）
- `HostUriRegistry`：3 种 URI scheme 处理（`case:///` / `log:///` / `cov:///`）
- `SubsysDiscovery` 接口 + `NoopDiscovery` 占位实现
- tRPC 暴露 `session.setModel` 和 `session.getAvailableModels` 到渲染端
- 61 个单元测试覆盖类型、Host Tools、Host URIs、Discovery

### M2 — 项目管理 / 插件系统 / 发现

#### 新增
- `ProjectManager`：多项目打开/关闭/切换，文件树浏览，项目状态持久化
- `PluginLoader`：从 `node_modules` 或本地路径加载 5 种 PluginKind 插件
- `PluginBackedDiscovery`：插件驱动的子系统发现与用例解析适配层
- 内置 `unisoc-subsys-discoverer` 插件（Unisoc 子系统发现参考实现）
- AI Chat UI 基础界面
- tRPC `project` 子路由（open / close / list / getFileTree / getSubsystems / getCases / getPlugins / togglePlugin / savePluginConfig）

#### 修复
- 取消设置 `ELECTRON_RUN_AS_NODE` 环境变量，修复 Electron 应用启动失败

### M3 — 仿真执行 / 仿真选项 / 终端集成

#### 新增
- `SimulationManager` + `SimulationRegistry`：仿真生命周期管理，编译错误解析，运行历史
- tRPC `simulation` 子路由（run / getStatus / getCompileErrors / abort / listActiveRuns / getHistory / getRunDetail / compareRuns）
- 仿真选项 UI：`SimOptionSchemaProvider` 集成、动态表单生成、预设管理
- UI 测试基础设施（@testing-library/react + jsdom）
- 终端集成：node-pty PTY + xterm.js 多标签终端
- tRPC `terminal` 子路由（create / write / resize / destroy / list）
- 右键上下文菜单触发仿真

### M4 — AI 辅助验证核心流

#### 新增
- AI 流式聊天：消息流式传输、Markdown 渲染（react-markdown + remark-gfm）、工具卡片展示
- 会话状态机管理
- AI 多会话管理：多会话并行、会话切换、会话历史
- 高级功能：会话中止（steer）、消息过滤、错误解析
- `TaskStore`：后台任务面板，监控运行中的仿真/AI会话/回归任务
- tRPC `session` 子路由扩展（create / send / abort / destroy / steer / onEvent）

### M5 — 环境搭建 / 覆盖率分析

#### 新增
- 环境配置向导：EDA 工具自动检测、环境变量配置、tRPC `env` 子路由
- `CoverageManager`：多维度覆盖率分析（行 / Toggle / 功能 / 断言）
- tRPC `coverage` 子路由（getOverview / getBySubsys / getTrend / exportHtml / exportJson）
- 覆盖率可视化：趋势图、子系统钻取、HTML/JSON 导出
- `CoveragePanel` UI 组件

### M6 — 回归 / Dashboard / TO 检查

#### 新增
- `RegressionManager`：回归套件管理、批量执行、结果汇总
- tRPC `regression` 子路由
- Dashboard 面板：项目仿真和覆盖率指标全景视图
- tRPC `dashboard` 子路由
- TO 检查清单：流片前检查项管理、自动评估、报告导出
- tRPC `to` 子路由
- 命令面板（CommandPalette）：快捷键触发快速操作
- 后台任务面板（TaskPanel）

### M7 — 技能发现 / 凭据管理 / 打磨

#### 新增
- 项目持久化恢复：应用启动时自动加载已保存项目，懒启动文件监视器
- omp 预编译二进制支持：`resolveOmpBinaryPath` 解析内嵌二进制，支持预编译模式启动
- `CredentialManager`：API 密钥安全存储、自定义接口地址
- tRPC `settings` 子路由（凭据 CRUD）
- `OpenAICompatibleClient`：OpenAI 兼容代理，支持对接第三方 LLM 服务
- 技能发现系统：扫描项目和用户级 SKILL.md 文件
- 会话模型持久化：模型信息存储与更新
- 前端技能选择、上下文文件管理
- `/` 和 `@` 快捷键快速添加技能与文件上下文
- 自动会话命名（基于首条消息生成名称）
- 项目文件搜索接口（tRPC `search` 子路由）
- `FileEditor` 组件：CodeMirror 代码编辑器，支持多语言语法高亮
- 文件读写 tRPC 接口

#### 重构
- 将 omp 相关代码从 `src/main/omp/` 迁移到 `src/main/agent/` 和 `src/main/host/` 目录
- RPC 客户端与会话启动流程重构，支持传入 API 密钥和环境变量
- Agent 客户端长任务改为发送即忘（fire-and-forget）模式
- 替换 chokidar 为原生 `fs.watch` 提升文件监视性能

#### 修复
- 修复会话 store 中重复渲染用户消息的问题（过滤非 assistant 角色事件）
- 修复 OpenAI 兼容协议不匹配导致的 403 错误
- 修复插件加载器路径适配多运行环境问题
- 修复项目持久化丢失问题
- 修复插件自动加载问题
- 修复会话模型设置不持久化的问题
- 修复 `endpoint` 重命名为 `baseUrl` 的兼容问题
- 打包时正确包含 plugins 目录资源

#### 测试
- 新增 unisoc 子系统发现插件测试
- 新增 OpenAI 兼容会话适配测试
- 新增项目加载性能回归测试
- 新增插件契约合规测试
- 新增 UI 组件测试（OptionDock / RightPanel / SubsysList）

---

## 版本号说明

- **主版本号**：不兼容的 API 修改
- **次版本号**：向下兼容的功能新增
- **修订号**：向下兼容的问题修复

详细发布说明见 [release-notes/](./release-notes/) 目录。
