# PRD: SoC Verify M2-M7 — 项目管理到 TO 全链路

## Problem Statement

SoC 验证工程师在从项目 kickoff 到 TO（Tape-Out）的整个周期中，需要在多个分散的工具之间切换：文件浏览器查找用例、命令行启动仿真、独立工具查看覆盖率、电子表格跟踪回归状态、AI 编码助手与验证流程割裂。这些工具之间缺乏数据互通，工程师被迫在不同上下文中反复切换，验证效率低下且容易遗漏关键信息。

M1 已完成 omp RPC 核心（AI Agent 基座），包括 JSONL 协议客户端、会话管理器、Host Tools/URI 骨架、SubsysDiscovery 接口。但所有 Host Tools 返回空数据，没有项目管理能力，没有仿真执行功能，没有 UI 交互——平台目前是一个空壳。

## Solution

在 M1 的 omp RPC 基座上，构建完整的 SoC 验证一站式管理平台。通过插件系统适配不同 SoC 项目的验证工具链（VCS/Xcelium/Verilator 等），将项目管理、仿真执行、覆盖率分析、回归测试、AI 辅助验证整合到单一 Electron 应用中。AI Agent（omp）通过 Host Tools 深度集成到验证流程中，能主动调用仿真、查看覆盖率、分析编译错误、辅助调试。

平台采用三栏布局：左栏项目文件树 + 用例树 + dashboard，中栏多功能区（终端 / AI 产物 / 文件查看），右栏 AI Agent 多会话 + 后台任务，底部仿真选项浮窗。

## User Stories

### 项目管理（M2）

1. 作为 SoC 验证工程师，我 want 打开一个 SoC 项目目录，so that 平台能加载项目结构并展示文件树
2. 作为 SoC 验证工程师，我 want 在多个项目之间快速切换，so that 能同时支持不同芯片的验证工作
3. 作为 SoC 验证工程师，我 want 平台自动发现项目中的子系统（subsystem），so that 不需要手动配置项目结构
4. 作为 SoC 验证工程师，我 want 平台自动发现每个子系统下的验证用例，so that 能快速浏览全部用例
5. 作为 SoC 验证工程师，我 want 按状态（pass/fail/running/pending）过滤用例，so that 能快速定位需要关注的用例
6. 作为 SoC 验证工程师，我 want 平台持久化项目配置（上次打开的会话、UI 布局等），so that 重启后恢复工作状态
7. 作为 SoC 验证工程师，我 want 创建新项目（指定项目根目录、命名、选择插件），so that 快速初始化验证环境
8. 作为 SoC 验证工程师，I want 查看项目概览（子系统数、用例数、通过率），so that 一眼了解项目整体状态

### 插件系统（M2）

9. 作为 SoC 验证工程师，I want 为项目选择和配置插件（case-parser, subsys-discoverer, simulation-runner 等），so that 平台能适配不同项目的工具链
10. 作为 SoC 验证工程师，I want 平台自动加载项目配置的插件，so that 不需要每次手动启动
11. 作为插件开发者，I want 按照插件接口契约（PluginManifest + 具体 Plugin 接口）开发插件，so that 插件能被平台自动发现和加载
12. 作为插件开发者，I want 平台提供插件 SDK 和文档，so that 快速开发新插件
13. 作为 SoC 验证工程师，I want 在项目设置中查看已加载插件列表及其状态，so that 确认插件正常工作
14. 作为 SoC 验证工程师，I want 启用/禁用特定插件，so that 在调试时隔离问题

### 仿真执行（M3）

15. 作为 SoC 验证工程师，I want 在用例树上右键启动单个用例仿真，so that 快速验证某个用例
16. 作为 SoC 验证工程师，I want 批量选择用例启动仿真，so that 运行一组回归
17. 作为 SoC 验证工程师，I want 在底部浮窗中配置仿真选项（波形、超时、seed 等），so that 灵活控制仿真行为
18. 作为 SoC 验证工程师，I want 仿真选项表单根据插件 schema 动态生成，so that 不同项目的选项自动适配
19. 作为 SoC 验证工程师，I want 实时查看仿真运行状态（running/pass/fail），so that 跟踪仿真进度
20. 作为 SoC 验证工程师，I want 在中栏终端中查看仿真实时输出，so that 即时发现错误
21. 作为 SoC 验证工程师，I want 中止正在运行的仿真，so that 快速停止无效的长仿真
22. 作为 SoC 验证工程师，I want 查看仿真编译错误（结构化的错误列表），so that 快速定位代码问题
23. 作为 SoC 验证工程师，I want 仿真完成后自动刷新用例状态，so that 不需要手动刷新
24. 作为 SoC 验证工程师，I want 在后台运行多个仿真任务，so that 并行推进验证工作
25. 作为 SoC 验证工程师，I want 查看仿真历史记录（时间、选项、结果），so that 对比不同运行

### 终端集成（M3）

26. 作为 SoC 验证工程师，I want 在中栏打开多个终端标签页，so that 同时运行不同命令
27. 作为 SoC 验证工程师，I want 终端支持 xterm.js 全功能（颜色、滚屏、搜索），so that 有原生终端体验
28. 作为 SoC 验证工程师，I want 终端工作目录自动跟随选中的项目/子系统，so that 不需要手动 cd
29. 作为 SoC 验证工程师，I want 终端会话持久化（重开恢复），so that 不丢失终端上下文

### AI 辅助验证核心流（M4）

30. 作为 SoC 验证工程师，I want 在右栏与 AI Agent 对话，so that 让 AI 辅助分析验证问题
31. 作为 SoC 验证工程师，I want AI Agent 能自主调用 list_subsys / list_cases 工具查看项目结构，so that AI 理解验证上下文
32. 作为 SoC 验证工程师，I want AI Agent 能自主调用 run_simulation 工具启动仿真，so that AI 能主动验证假设
33. 作为 SoC 验证工程师，I want AI Agent 能自主调用 get_run_status / get_compile_errors 查看仿真结果，so that AI 能分析失败原因
34. 作为 SoC 验证工程师，I want AI Agent 能自主调用 get_coverage 查看覆盖率，so that AI 能识别覆盖盲区
35. 作为 SoC 验证工程师，I want AI Agent 通过 case:/// URI 读取用例详情，so that AI 能理解用例内容
36. 作为 SoC 验证工程师，I want AI Agent 通过 log:/// URI 读取仿真日志，so that AI 能分析日志
37. 作为 SoC 验证工程师，I want AI Agent 通过 cov:/// URI 读取覆盖率数据，so that AI 能深度分析覆盖情况
38. 作为 SoC 验证工程师，I want 查看 AI Agent 的流式消息输出（打字机效果），so that 实时感知 AI 正在做什么
39. 作为 SoC 验证工程师，I want 查看 AI Agent 的工具调用过程（调用名、参数、结果），so that 理解 AI 的推理链
40. 作为 SoC 验证工程师，I want 中止 AI Agent 的当前操作，so that 打断无效的 AI 推理
41. 作为 SoC 验证工程师，I want 创建多个 AI Agent 会话（不同任务并行），so that 同时推进多个分析
42. 作为 SoC 验证工程师，I want 在 AI 会话间快速切换，so that 查看不同任务的进展
43. 作为 SoC 验证工程师，I want AI 会话历史持久化（重开恢复），so that 不丢失对话上下文
44. 作为 SoC 验证工程师，I want 给 AI 发送图片（截图、波形图等），so that 让 AI 分析视觉信息
45. 作为 SoC 验证工程师，I want 动态切换 AI 模型（provider/model），so that 在不同任务中使用最合适的模型
46. 作为 SoC 验证工程师，I want 查看 AI 可用模型列表，so that 选择最优模型
47. 作为 SoC 验证工程师，I want 使用 AI 会话分支（branch）功能，so that 从某个历史点探索不同方向
48. 作为 SoC 验证工程师，I want AI Agent 使用 steer（引导）模式插入消息，so that 在 AI 思考过程中补充信息
49. 作为 SoC 验证工程师，I want 查看 AI Agent 的子代理（subagent）活动，so that 了解 AI 是否在委派子任务
50. 作为 SoC 验证工程师，I want 在右栏查看后台任务列表（仿真、AI 任务），so that 掌控所有异步工作

### 环境搭建与覆盖率（M5）

51. 作为 SoC 验证工程师，I want 通过环境搭建向导配置仿真工具链（VCS/Xcelium/Verilator），so that 快速初始化验证环境
52. 作为 SoC 验证工程师，I want 平台自动检测已安装的 EDA 工具，so that 不需要手动指定路径
53. 作为 SoC 验证工程师，I want 配置环境变量（PATH、LICENSE_FILE 等），so that 仿真工具能正常运行
54. 作为 SoC 验证工程师，I want 查看覆盖率概览（行覆盖率、翻转覆盖率、功能覆盖率、断言覆盖率），so that 评估验证完整度
55. 作为 SoC 验证工程师，I want 按子系统查看覆盖率分布，so that 定位覆盖盲区
56. 作为 SoC 验证工程师，I want 查看覆盖率趋势图（随时间变化），so that 跟踪覆盖率进展
57. 作为 SoC 验证工程师，I want 下钻查看未覆盖的代码行/信号，so that 精确定位覆盖缺口
58. 作为 SoC 验证工程师，I want 导出覆盖率报告（HTML/JSON），so that 与团队共享

### 回归与 Dashboard（M6）

59. 作为 SoC 验证工程师，I want 创建回归套件（选择一组用例 + 运行选项），so that 标准化回归流程
60. 作为 SoC 验证工程师，I want 调度回归运行（立即/定时/CI 触发），so that 灵活安排回归
61. 作为 SoC 验证工程师，I want 查看回归结果摘要（通过率、失败列表、耗时），so that 快速评估回归状态
62. 作为 SoC 验证工程师，I want 对比两次回归运行（新增失败、修复的用例），so that 识别回归变化
63. 作为 SoC 验证工程师，I want 在 dashboard 查看项目整体状态（用例通过率、覆盖率趋势、近期回归），so that 一览项目健康度
64. 作为 SoC 验证工程师，I want dashboard 支持自定义指标卡片，so that 关注最关心的指标
65. 作为 SoC 验证工程师，I want 查看 TO 检查清单（覆盖率门槛、回归通过率、签核状态），so that 跟踪 TO 就绪度
66. 作为 SoC 验证工程师，I want 标记 TO 检查项状态（通过/待办/阻塞），so that 团队协同跟踪 TO 进度
67. 作为 SoC 验证工程师，I want 导出 TO 就绪报告，so that 向管理层汇报

### MCP/Skill 管理与凭据（M7）

68. 作为 SoC 验证工程师，I want 在设置中配置 LLM API 凭据（API key、endpoint），so that AI Agent 能连接到 LLM 服务
69. 作为 SoC 验证工程师，I want 凭据安全存储（加密），so that API key 不会泄露
70. 作为 SoC 验证工程师，I want 管理多个 LLM provider 凭据，so that 在不同模型间切换
71. 作为 SoC 验证工程师，I want 安装/卸载 omp skills（预定义技能包），so that 扩展 AI Agent 的验证能力
72. 作为 SoC 验证工程师，I want 查看 skill 列表及其描述，so that 了解可用技能
73. 作为 SoC 验证工程师，I want 配置 MCP 服务器（Model Context Protocol），so that AI Agent 能访问外部工具和数据源
74. 作为 SoC 验证工程师，I want 查看 MCP 服务器状态（连接/断开），so that 确认外部工具可用
75. 作为 SoC 验证工程师，I want 配置项目级 AI 系统提示词，so that 定制 AI 的验证策略

### 全局体验

76. 作为 SoC 验证工程师，I want 全局搜索（用例、文件、日志、AI 对话），so that 快速定位信息
77. 作为 SoC 验证工程师，I want 命令面板（Ctrl+Shift+P），so that 键盘驱动高效操作
78. 作为 SoC 验证工程师，I want 深色/浅色主题切换，so that 适应不同工作环境
79. 作为 SoC 验证工程师，I want 平台响应迅速（操作延迟 < 100ms），so that 不被工具拖慢
80. 作为 SoC 验证工程师，I want 有意义的错误提示和恢复建议，so that 遇到问题时能自行解决
81. 作为 SoC 验证工程师，I want 国际化支持（中/英），so that 团队成员使用各自语言

## Implementation Decisions

### 插件系统架构

- 插件系统基于 M0 定义的 `PluginKind` 类型（case-parser / subsys-discoverer / coverage-parser / simulation-runner / sim-option-schema）和各 Plugin 接口契约
- 插件以 npm 包形式分发，项目通过配置文件声明依赖的插件
- M2 实现 `PluginLoader`（M0 占位）为真实插件加载器，支持从 `node_modules` 和项目本地路径加载
- `SubsysDiscovery` 接口（M1 定义）由 `SubsysDiscoveryPlugin` 适配实现，注入到 `HostToolsRegistry`
- `HostToolsRegistry` 的 7 个 Host Tools handler 从 M1 的 placeholder 替换为调用对应插件实现

### 项目管理与存储

- 项目状态（当前打开项目、会话列表、UI 布局）持久化到用户数据目录（`app.getPath('userData')`）
- 项目配置存储在项目根目录的 `.socverify/` 隐藏目录中（插件配置、AI 系统提示词、仿真选项模板等）
- tRPC router 新增 `project` 子路由：`project.open` / `project.close` / `project.list` / `project.getState` / `project.saveConfig`
- 文件树通过 `chokidar` 监听项目目录变化，增量更新

### 仿真执行

- 仿真通过 `SimulationRunnerPlugin` 执行，插件返回 `SimulationRunHandle`（含 runId）
- 仿真状态通过轮询 `SimulationRunnerPlugin.getStatus(runId)` 或文件系统 watch 更新
- 终端使用 `node-pty` 在主进程创建 PTY，通过 IPC 转发到渲染端 `xterm.js`
- 仿真选项浮窗根据 `SimOptionSchemaProvider.getSchema()` 动态生成表单
- 多仿真并发通过 `SessionManager` 现有的并发管理（上限 10）或独立任务队列管理

### AI Agent 集成

- AI 会话事件（agent_start/end、message_update、tool_execution_* 等）通过 `sessionEvent` 事件转发到渲染端
- 渲染端 Zustand store 维护会话状态机：idle → streaming → tool_executing → idle
- AI 消息渲染支持 markdown、代码高亮、工具调用卡片、图片内联
- 会话持久化通过 omp 的 `--resume` 和 `sessionPath` 机制（M1 已支持）
- 动态 provider/model 切换通过 tRPC `session.setModel` / `session.getAvailableModels`（M1 已实现 API 层）

### 覆盖率分析

- 覆盖率通过 `CoverageParserPlugin` 解析，返回结构化的 `CoverageData`
- 覆盖率可视化使用图表库（recharts 或 visx）渲染趋势图、分布图
- 覆盖率数据缓存到项目 `.socverify/coverage/` 目录，支持历史对比
- Host URI `cov:///` handler 从 M1 placeholder 替换为调用 `CoverageParserPlugin`

### 回归与 Dashboard

- 回归套件配置存储在项目 `.socverify/regressions/` 目录
- 回归执行通过批量调用 `SimulationRunnerPlugin.run()` 实现
- Dashboard 使用可拖拽布局（react-grid-layout），指标卡片可自定义
- TO 检查清单存储在项目 `.socverify/to-checklist.json`，支持团队共享

### MCP/Skill/凭据

- LLM 凭据使用 Electron `safeStorage` API 加密存储
- omp skills 通过 omp 的 skill 管理机制安装/卸载
- MCP 服务器配置通过 omp 的 extension 机制管理
- tRPC router 新增 `settings` 子路由：`settings.getCredentials` / `settings.setCredential` / `settings.listSkills` / `settings.installSkill` / `settings.listMcpServers`

### 动态能力

M1 已实现 3 个动态能力的 API 层：
- **动态 Host Tools/URI**：SessionManager 提供 `registerHostTool`/`unregisterHostTool`/`registerHostUriScheme`/`unregisterHostUriScheme`，注册后自动同步到 omp。M2+ 插件系统通过此 API 动态注册插件工具
- **动态 provider/model**：tRPC `session.setModel`/`session.getAvailableModels` 已暴露给渲染端
- **动态子系统/用例发现**：`SubsysDiscovery` 接口（M1 定义）+ `NoopDiscovery`（空实现）。M2 替换为基于 `SubsysDiscoveryPlugin` 的真实实现

## Testing Decisions

### 测试缝策略

采用 3 个测试缝，覆盖后端全链路、插件契约、前端渲染：

**缝 1：tRPC API 集成缝（主缝）**
- 所有后端功能通过 tRPC router 端到端测试
- Mock 策略：mock omp 子进程（不实际 spawn bun）、mock 文件系统（项目目录结构用临时目录）、mock 插件实现
- 测试范围：项目管理、会话管理、仿真执行、覆盖率、回归、AI Agent 事件流
- 优点：测试外部行为而非实现细节，refactor 不破坏测试
- 先例：M1 的 `tests/omp/` 已有 vitest 单元测试基础

**缝 2：插件契约缝**
- 通过 `PluginManifest + Plugin 接口` 契约测试插件实现
- 每种 PluginKind 有独立的契约测试套件（case-parser, subsys-discoverer, coverage-parser, simulation-runner, sim-option-schema）
- 测试范围：插件接口合规性、错误处理、边界条件
- 优点：插件可独立开发和测试，不需要完整平台

**缝 3：UI 组件缝**
- React 组件测试，mock tRPC proxy 和 omp 事件
- 测试范围：组件渲染、用户交互（点击、输入、拖拽）、状态转换
- 工具：@testing-library/react + vitest
- 优点：验证用户可见行为，不测试内部状态

### 测试质量标准

- 好测试只验证外部行为（输入→输出），不验证内部实现（私有方法、状态结构）
- 测试命名描述行为意图（"returns empty list when no subsystems found" 而非 "test listSubsys"）
- 每个 bug fix 先写失败测试再修复（TDD red-green-refactor）
- 测试覆盖率目标：核心模块 > 80%，UI 组件 > 60%

## Out of Scope

- **omp 引擎本身的功能开发**：omp 是外部依赖（git submodule），只使用其 RPC API，不修改其源码
- **EDA 工具集成**：VCS/Xcelium/Verilator 等的具体集成由插件实现，平台只提供插件接口和运行框架
- **CI/CD 流水线**：平台的 CI 集成由独立工具处理，不在平台范围内（M6 只提供回归调度和结果展示）
- **多用户协作**：平台是单用户桌面应用，不提供实时协作功能（TO 检查清单通过文件共享实现异步协作）
- **Web 版本**：平台是 Electron 桌面应用，不提供 Web 版本
- **移动端**：不支持移动端
- **DUT 硬件交互**：不直接与 DUT 硬件交互，硬件在环测试由仿真工具处理

## Further Notes

### 里程碑依赖关系

- M2（项目/存储/发现）是所有后续里程碑的基础，必须最先完成
- M3（仿真/终端）依赖 M2 的项目管理和插件系统
- M4（AI 辅助核心流）依赖 M2 的项目发现和 M3 的仿真执行（AI 通过 Host Tools 调用仿真）
- M5（环境搭建/覆盖率）依赖 M3 的仿真执行（覆盖率是仿真产物）
- M6（回归/dashboard/TO）依赖 M3 仿真和 M5 覆盖率
- M7（MCP/skill/凭据/打磨）可在 M4 完成后并行开发，最终打磨在所有功能完成后

### 技术约束

- Electron 主进程使用 ESM（`"type": "module"`），`lib: ["ES2024"]`（支持 `Promise.withResolvers`）
- omp 运行时：开发时用 Bun 直接运行 `engine/oh-my-pi/packages/coding-agent/src/cli.ts --mode rpc`
- 打包时 omp 源码通过 `electron-builder.yml` 的 `extraResources` 内嵌，排除 `node_modules`/`.git`/`dist`/`target`
- tRPC IPC 使用 `electron-trpc` 0.7.1（CJS 输出绕过 ESM 不兼容）
- 渲染端通过 `@main/ipc/router` 导入 `AppRouter` 类型获取类型安全 IPC
