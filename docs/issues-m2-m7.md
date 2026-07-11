# Issues: SoC Verify M2-M7 — Tracer Bullet Vertical Slices

> **Parent PRD**: [docs/prd-m2-m7.md](./prd-m2-m7.md)
>
> 23 个垂直切片（tracer bullet），每个切片贯穿所有集成层（tRPC API → 主进程 → 渲染端 UI → 测试），完成后可独立演示。
>
> Issues 按依赖顺序排列（blocker 在前）。

---

## Issue #1: 项目打开与文件树

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

用户通过"打开项目"选择一个 SoC 项目根目录，平台加载项目结构并在左栏展示文件树。文件树通过 chokidar 监听目录变化实时增量更新。支持在多个已打开项目间快速切换。左栏底部展示项目概览（子系统数、用例数、通过率）。

端到端路径：渲染端"打开项目"按钮 → tRPC `project.open` → 主进程 chokidar 监听目录 → 文件树数据通过 tRPC `project.getFileTree` 返回 → 渲染端左栏渲染文件树组件 → 目录变化通过事件推送到渲染端增量更新。

### Acceptance criteria

- [ ] 点击"打开项目"弹出目录选择对话框，选择后左栏展示文件树
- [ ] 文件树支持展开/折叠目录，点击文件在中栏显示内容
- [ ] 外部新增/删除文件时，文件树实时更新（chokidar 监听）
- [ ] 支持同时打开多个项目，通过 tab 或下拉切换
- [ ] 左栏底部展示项目概览卡片（子系统数、用例数、通过率——M2 阶段可为 0/N/A）
- [ ] tRPC API 有 `project.open` / `project.close` / `project.list` / `project.getFileTree` procedure
- [ ] tRPC API 集成测试覆盖项目打开/关闭/切换/文件树获取
- [ ] UI 组件测试覆盖文件树渲染和交互

### Blocked by

None — can start immediately.

---

## Issue #2: 插件系统核心

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

实现 PluginLoader（从 M0 占位升级为真实加载器），支持从 `node_modules` 和项目本地路径加载插件。插件注册表管理 5 种 PluginKind（case-parser / subsys-discoverer / coverage-parser / simulation-runner / sim-option-schema）。项目配置存储在 `.socverify/plugins.json`。项目设置 UI 中展示已加载插件列表、状态，支持启用/禁用插件。

端到端路径：项目打开时 PluginLoader 读取 `.socverify/plugins.json` → 动态 import 插件模块 → 验证 PluginManifest → 注册到 PluginRegistry → tRPC `project.getPlugins` 返回插件列表 → 渲染端设置面板展示 → 用户启用/禁用 → tRPC `project.togglePlugin` → 持久化配置。

### Acceptance criteria

- [ ] PluginLoader 能从 `node_modules` 和本地路径加载插件
- [ ] 插件加载后验证 PluginManifest（id/name/version/kind 字段完整性）
- [ ] PluginRegistry 按 PluginKind 分类管理插件实例
- [ ] 项目配置 `.socverify/plugins.json` 存储插件列表和启用状态
- [ ] tRPC 有 `project.getPlugins` / `project.togglePlugin` / `project.savePluginConfig` procedure
- [ ] 设置 UI 展示插件列表（名称、版本、类型、状态），支持启用/禁用开关
- [ ] 插件加载失败时展示有意义的错误信息，不影响其他插件
- [ ] 插件契约测试覆盖 5 种 PluginKind 的接口合规性
- [ ] tRPC API 集成测试覆盖插件加载/列表/启禁用

### Blocked by

None — can start immediately.

---

## Issue #3: 子系统发现

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

将 `SubsysDiscovery` 接口（M1 定义）从 NoopDiscovery 替换为基于 `SubsysDiscoveryPlugin` 的真实实现。PluginLoader 加载 subsys-discoverer 插件后，适配为 SubsysDiscovery 实现注入到 HostToolsRegistry。`list_subsys` Host Tool 返回真实子系统数据。左栏展示子系统列表。

端到端路径：项目打开 + 插件加载 → SubsysDiscoveryPlugin.discover(projectRoot) 返回 SubsysInfo[] → 适配为 SubsysDiscovery → 注入 HostToolsRegistry → omp Agent 调用 list_subsys 时返回真实数据 → tRPC `project.getSubsystems` 也返回子系统列表 → 渲染端左栏子系统列表组件渲染。

### Acceptance criteria

- [ ] SubsysDiscoveryPlugin 适配为 SubsysDiscovery 接口，注入 HostToolsRegistry
- [ ] `list_subsys` Host Tool 调用插件返回真实子系统数据（不再是空数组）
- [ ] 无 subsys-discoverer 插件时 fallback 到 NoopDiscovery（不崩溃）
- [ ] tRPC 有 `project.getSubsystems` query procedure
- [ ] 左栏展示子系统列表（名称、路径、用例数）
- [ ] 点击子系统可展开其下用例（与 Issue #4 联动）
- [ ] 插件契约测试覆盖 SubsysDiscoveryPlugin 接口
- [ ] tRPC API 集成测试覆盖子系统发现

### Blocked by

- Issue #2 (插件系统核心)

---

## Issue #4: 用例发现与过滤

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

实现 CaseParserPlugin 加载和调用，`list_cases` Host Tool 返回真实用例数据。左栏用例树展示每个子系统下的用例，支持按状态（pass/fail/running/pending/all）过滤用例。

端到端路径：插件加载 CaseParserPlugin → 调用 parse(projectRoot, subsys) 返回 CaseInfo[] → `list_cases` Host Tool 返回真实数据 → tRPC `project.getCases` query（带 subsys 和 status 参数）→ 渲染端用例树组件渲染 → 用户选择状态过滤 → 刷新用例列表。

### Acceptance criteria

- [ ] CaseParserPlugin 被正确加载和调用
- [ ] `list_cases` Host Tool 返回真实用例数据（支持 subsys 和 status 过滤参数）
- [ ] 无 case-parser 插件时 fallback 到空列表（不崩溃）
- [ ] tRPC 有 `project.getCases` query procedure，接受 subsys 和 status 参数
- [ ] 左栏用例树展示用例列表（名称、状态图标）
- [ ] 状态过滤下拉（pass/fail/running/pending/all）生效
- [ ] 插件契约测试覆盖 CaseParserPlugin 接口
- [ ] tRPC API 集成测试覆盖用例发现和过滤

### Blocked by

- Issue #3 (子系统发现)

---

## Issue #5: 项目持久化

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

项目状态（当前打开项目、UI 布局、上次会话列表）持久化到用户数据目录（`app.getPath('userData')`）。项目配置存储在项目根目录的 `.socverify/` 隐藏目录。重启应用后恢复上次工作状态。支持新建项目向导（指定根目录、命名、选择插件）。

端到端路径：用户关闭应用/切换项目 → 主进程保存状态到 userData → 下次打开应用 → 读取 userData → 自动恢复上次项目 → 恢复 UI 布局 → 恢复 AI 会话列表（会话内容在 Issue #11 恢复）。

### Acceptance criteria

- [ ] 应用关闭时保存当前项目 ID、UI 布局到 userData
- [ ] 应用启动时自动恢复上次打开的项目
- [ ] `.socverify/` 目录结构创建（plugins.json, config.json, sessions.json）
- [ ] 新建项目向导：选择根目录 → 命名 → 选择插件 → 创建 `.socverify/` 配置
- [ ] tRPC 有 `project.getState` / `project.saveState` / `project.create` procedure
- [ ] tRPC API 集成测试覆盖状态保存/恢复/新建项目

### Blocked by

- Issue #1 (项目打开与文件树)

---

## Issue #6: 仿真执行

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

集成 SimulationRunnerPlugin，实现 `run_simulation` / `get_run_status` / `get_compile_errors` 三个 Host Tool 的真实逻辑。用户可在用例树上右键启动单个用例仿真，或批量选择用例启动。仿真状态实时更新（running/pass/fail）。编译错误结构化展示。支持中止正在运行的仿真。

端到端路径：用户右键用例 → 选择"运行仿真" → tRPC `simulation.run` → 主进程调用 SimulationRunnerPlugin.run(opts) → 返回 runId → 轮询 getStatus(runId) → 状态变化通过事件推送 → 渲染端更新用例图标 → 仿真完成自动刷新 → 编译错误通过 tRPC `simulation.getCompileErrors` 获取 → 中栏结构化展示。

### Acceptance criteria

- [ ] `run_simulation` Host Tool 调用 SimulationRunnerPlugin.run() 返回 runId
- [ ] `get_run_status` Host Tool 返回真实仿真状态（running/pass/fail）
- [ ] `get_compile_errors` Host Tool 返回结构化编译错误列表
- [ ] 用例树右键菜单包含"运行仿真"选项
- [ ] 支持批量选择用例启动仿真
- [ ] 仿真状态实时更新（轮询或 watch）
- [ ] 支持中止正在运行的仿真（tRPC `simulation.abort`）
- [ ] 仿真完成后自动刷新用例状态
- [ ] 编译错误在中栏结构化展示（文件、行号、错误信息）
- [ ] 无 simulation-runner 插件时返回明确错误提示
- [ ] 插件契约测试覆盖 SimulationRunnerPlugin 接口
- [ ] tRPC API 集成测试覆盖仿真启动/状态/中止/编译错误

### Blocked by

- Issue #4 (用例发现与过滤)

---

## Issue #7: 仿真选项 UI

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

集成 SimOptionSchemaProvider，`get_sim_options_schema` Host Tool 返回真实 schema。底部仿真选项浮窗根据 schema 动态生成表单（string/number/boolean/enum 类型字段）。用户可展开/收缩浮窗，配置仿真选项后启动仿真。

端到端路径：项目打开 → 加载 sim-option-schema 插件 → 调用 getSchema(subsys) 返回 SimOptionSchema → 底部浮窗渲染动态表单 → 用户填写选项 → 选项随仿真启动传递给 SimulationRunnerPlugin。

### Acceptance criteria

- [ ] `get_sim_options_schema` Host Tool 返回真实 SimOptionSchema
- [ ] 底部浮窗根据 schema 动态生成表单（string→文本框, number→数字框, boolean→开关, enum→下拉）
- [ ] 浮窗可展开/收缩
- [ ] 仿真选项在启动仿真时传递给 simulation.run
- [ ] 支持保存选项模板（预设）
- [ ] 无 sim-option-schema 插件时显示默认空选项
- [ ] tRPC API 集成测试覆盖 schema 获取和选项保存
- [ ] UI 组件测试覆盖动态表单渲染

### Blocked by

- Issue #6 (仿真执行)

---

## Issue #8: 终端集成

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

在中栏集成终端功能，使用 node-pty 在主进程创建 PTY，通过 IPC 转发到渲染端 xterm.js。支持多终端标签页，终端工作目录自动跟随选中的项目/子系统。终端会话持久化（重开恢复）。

端到端路径：用户在中栏点击"新建终端" → tRPC `terminal.create` → 主进程 node-pty 创建 PTY → IPC 转发输入/输出 → 渲染端 xterm.js 渲染 → 用户输入命令 → 转发到 PTY → 输出转发回渲染端 → 关闭标签页销毁 PTY。

### Acceptance criteria

- [ ] 中栏支持打开多个终端标签页
- [ ] 终端使用 xterm.js，支持颜色、滚屏、搜索
- [ ] node-pty 在主进程创建真实 PTY（非 pseudo-terminal）
- [ ] 终端工作目录默认为项目根目录
- [ ] 选中子系统时，新终端工作目录自动切换到子系统路径
- [ ] tRPC 有 `terminal.create` / `terminal.write` / `terminal.resize` / `terminal.destroy` procedure
- [ ] 终端会话在项目重开时恢复（工作目录和历史输出）
- [ ] tRPC API 集成测试覆盖终端创建/写入/销毁
- [ ] UI 组件测试覆盖终端标签页交互

### Blocked by

- Issue #1 (项目打开与文件树)

---

## Issue #9: 仿真历史

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

仿真运行完成后记录历史（时间戳、用例、选项、结果、耗时），存储到 `.socverify/sim-history.json`。中栏仿真历史面板展示历史列表，支持查看运行详情和两次运行对比。

端到端路径：仿真完成 → 主进程记录历史条目 → 存储到 .socverify/sim-history.json → tRPC `simulation.getHistory` 返回列表 → 渲染端历史面板渲染 → 用户选择两条运行 → tRPC `simulation.compareRuns` → 渲染端对比视图。

### Acceptance criteria

- [ ] 每次仿真完成自动记录历史（时间、用例、选项、结果、耗时）
- [ ] 历史存储到 `.socverify/sim-history.json`
- [ ] tRPC 有 `simulation.getHistory` / `simulation.getRunDetail` / `simulation.compareRuns` procedure
- [ ] 中栏仿真历史面板展示历史列表（可按时间/用例/状态排序）
- [ ] 点击历史条目查看运行详情（完整选项、输出摘要、编译错误）
- [ ] 支持选择两次运行对比（选项差异、结果变化）
- [ ] tRPC API 集成测试覆盖历史记录和对比

### Blocked by

- Issue #6 (仿真执行)

---

## Issue #10: AI 对话与事件流

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

右栏 AI Agent 对话界面。用户输入消息 → tRPC `session.send` → omp Agent 处理 → 会话事件（agent_start/end, message_update, tool_execution_*）通过 sessionEvent 事件流推送到渲染端 → Zustand store 维护状态机（idle → streaming → tool_executing → idle）→ 渲染端流式渲染 AI 消息（打字机效果）+ 工具调用卡片。支持中止 AI 操作。

端到端路径：用户在右栏输入消息 → tRPC `session.send` → SessionManager.client.prompt(message) → omp 产生事件 → SessionManager 通过 EventEmitter 转发 → electron-trpc 事件订阅推送到渲染端 → Zustand store 更新状态 → React 组件渲染流式消息 + 工具卡片 → 用户点击"中止" → tRPC `session.abort` → client.abort()。

### Acceptance criteria

- [ ] 右栏展示 AI 对话界面（消息列表 + 输入框）
- [ ] 用户输入消息后，AI 响应流式渲染（打字机效果）
- [ ] AI 消息支持 markdown 渲染（代码高亮、列表、表格）
- [ ] 工具调用展示为卡片（工具名、参数、结果、耗时）
- [ ] 工具执行过程中显示加载状态
- [ ] 支持"中止"按钮打断 AI 操作
- [ ] Zustand store 维护会话状态机（idle/streaming/tool_executing）
- [ ] sessionEvent 事件通过 electron-trpc 订阅机制推送到渲染端
- [ ] AI 消息中的 case:///log:///cov:/// URI 可点击展开
- [ ] tRPC API 集成测试覆盖消息发送/事件流/中止
- [ ] UI 组件测试覆盖消息渲染和输入交互

### Blocked by

- Issue #1 (项目打开与文件树)

---

## Issue #11: AI 多会话管理

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

支持创建多个 AI Agent 会话（不同任务并行），会话间快速切换。会话历史持久化，项目重开时恢复上次会话列表。会话通过 omp 的 `--resume` 和 `sessionPath` 机制恢复上下文。

端到端路径：用户点击"新建会话" → tRPC `session.create` → SessionManager 创建新 OmpRpcClient → 右栏新增会话标签 → 用户切换标签 → tRPC `session.getState` 获取会话状态 → 渲染端恢复对话视图 → 项目重开 → 从 .socverify/sessions.json 读取会话列表 → 用 --resume 恢复每个会话。

### Acceptance criteria

- [ ] 右栏支持创建多个 AI 会话（标签页形式）
- [ ] 会话标签展示会话名称（自动生成或用户命名）
- [ ] 会话间切换不丢失对话上下文
- [ ] 项目重开时自动恢复上次会话列表
- [ ] 会话通过 omp --resume 恢复完整对话历史
- [ ] tRPC `session.list` 返回所有会话 ID 和元数据
- [ ] 关闭会话标签时可选"仅关闭"或"销毁会话"
- [ ] tRPC API 集成测试覆盖多会话创建/切换/恢复

### Blocked by

- Issue #10 (AI 对话与事件流)
- Issue #5 (项目持久化)

---

## Issue #12: AI 高级功能

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

AI Agent 高级功能：图片发送（截图/波形图）、会话分支（branch）、steer 引导模式、子代理活动展示、动态模型切换 UI、可用模型列表展示。

端到端路径：
- 图片：用户拖拽/粘贴图片到输入框 → tRPC `session.send` 带 images 参数 → omp 处理多模态输入
- 分支：用户选择某条历史消息 → 点击"从此分支" → tRPC `session.branch` → omp 创建分支会话
- Steer：AI 流式输出时用户输入 → tRPC `session.steer` → omp 插入引导消息
- 模型切换：用户点击模型选择器 → tRPC `session.getAvailableModels` → 列表展示 → 选择 → tRPC `session.setModel`
- 子代理：omp 产生 subagent_lifecycle/progress/event 事件 → 渲染端展示子代理活动卡片

### Acceptance criteria

- [ ] 输入框支持拖拽/粘贴图片（PNG/JPG）
- [ ] 图片随消息发送到 AI Agent
- [ ] 会话分支：从任意历史消息创建分支，新分支独立对话
- [ ] Steer 模式：AI 流式输出时可插入引导消息
- [ ] 模型选择器展示当前模型，点击展开可用模型列表
- [ ] 切换模型后立即生效（不重启会话）
- [ ] 子代理活动以卡片形式展示（生命周期、进度、事件）
- [ ] tRPC API 集成测试覆盖图片发送/分支/steer/模型切换
- [ ] UI 组件测试覆盖模型选择器和图片输入

### Blocked by

- Issue #10 (AI 对话与事件流)

---

## Issue #13: 后台任务面板

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

右栏底部后台任务面板，统一管理仿真任务和 AI 任务。展示任务列表（名称、类型、状态、进度），支持查看任务详情和取消任务。仿真完成后自动刷新对应用例状态。

端到端路径：仿真启动/AI 会话创建 → 注册到后台任务管理器 → tRPC `task.list` 返回任务列表 → 渲染端任务面板渲染 → 任务状态变化通过事件推送 → 用户点击"取消" → tRPC `task.cancel` → 终止任务 → 仿真完成后触发用例状态刷新事件。

### Acceptance criteria

- [ ] 右栏底部展示后台任务面板（可展开/收缩）
- [ ] 任务列表展示：任务名称、类型（仿真/AI）、状态（running/done/failed/cancelled）、进度
- [ ] 仿真任务和 AI 会话任务统一展示
- [ ] 支持取消正在运行的任务
- [ ] 仿真完成后自动刷新左栏用例状态
- [ ] tRPC 有 `task.list` / `task.cancel` / `task.getDetail` procedure
- [ ] 任务状态变化通过事件推送到渲染端
- [ ] tRPC API 集成测试覆盖任务列表/取消/状态更新

### Blocked by

- Issue #6 (仿真执行)
- Issue #10 (AI 对话与事件流)

---

## Issue #14: 环境搭建向导

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

环境搭建向导：自动检测已安装的 EDA 工具（VCS/Xcelium/Verilator），配置环境变量（PATH、LICENSE_FILE 等），向导 UI 引导用户完成环境配置。

端到端路径：用户首次打开项目或点击"配置环境" → tRPC `env.detectTools` 扫描 PATH 中的 EDA 工具 → 返回检测结果 → 向导 UI 展示检测到的工具 → 用户确认/手动指定路径 → 配置环境变量 → tRPC `env.saveConfig` 持久化到 .socverify/env.json → 仿真启动时使用配置的环境变量。

### Acceptance criteria

- [ ] 自动检测 PATH 中的常见 EDA 工具（vcs/xrun/verilator 等）
- [ ] 检测结果展示工具名称、版本、路径
- [ ] 支持手动指定工具路径（覆盖自动检测）
- [ ] 环境变量配置（PATH 追加、LICENSE_FILE 等）
- [ ] 向导 UI 分步引导（检测 → 确认 → 环境变量 → 完成）
- [ ] 配置存储到 `.socverify/env.json`
- [ ] 仿真启动时使用配置的环境变量
- [ ] tRPC 有 `env.detectTools` / `env.saveConfig` / `env.getConfig` procedure
- [ ] tRPC API 集成测试覆盖工具检测和配置保存

### Blocked by

- Issue #2 (插件系统核心)

---

## Issue #15: 覆盖率分析

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

集成 CoverageParserPlugin，实现 `get_coverage` Host Tool 和 `cov:///` URI handler 的真实逻辑。覆盖率概览展示四种类型（行/翻转/功能/断言），按子系统查看覆盖率分布。

端到端路径：仿真完成 → 覆盖率数据生成 → CoverageParserPlugin.parse(projectRoot, runId) 返回 CoverageData → `get_coverage` Host Tool 返回真实数据 → `cov:///` URI handler 返回覆盖率详情 → tRPC `coverage.getOverview` / `coverage.getBySubsys` → 渲染端覆盖率面板渲染。

### Acceptance criteria

- [ ] `get_coverage` Host Tool 调用 CoverageParserPlugin 返回真实覆盖率数据
- [ ] `cov:///` URI handler 返回覆盖率详情（不再是空 JSON）
- [ ] 覆盖率概览展示四种类型（行/翻转/功能/断言）的百分比
- [ ] 按子系统查看覆盖率分布（表格或柱状图）
- [ ] 无 coverage-parser 插件时返回明确提示
- [ ] tRPC 有 `coverage.getOverview` / `coverage.getBySubsys` / `coverage.getDetail` procedure
- [ ] 覆盖率数据缓存到 `.socverify/coverage/` 目录
- [ ] 插件契约测试覆盖 CoverageParserPlugin 接口
- [ ] tRPC API 集成测试覆盖率获取

### Blocked by

- Issue #6 (仿真执行)

---

## Issue #16: 覆盖率可视化与导出

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

覆盖率趋势图（随时间/仿真运行变化），下钻查看未覆盖的代码行/信号，覆盖率报告导出（HTML/JSON）。

端到端路径：用户在覆盖率面板点击"趋势" → tRPC `coverage.getTrend` 返回历史覆盖率数据 → 渲染端趋势图（折线图）→ 用户点击某次运行 → 下钻到未覆盖项列表 → 用户点击"导出" → tRPC `coverage.exportReport` → 生成 HTML/JSON 报告 → 保存到文件。

### Acceptance criteria

- [ ] 覆盖率趋势图展示四种覆盖率类型随时间变化
- [ ] 趋势图支持选择时间范围（最近 N 次运行）
- [ ] 下钻查看未覆盖项（文件/行号/信号名）
- [ ] 支持导出覆盖率报告（HTML 格式，含图表；JSON 格式，含原始数据）
- [ ] 导出报告保存到用户选择的路径
- [ ] tRPC 有 `coverage.getTrend` / `coverage.getUncovered` / `coverage.exportReport` procedure
- [ ] UI 组件测试覆盖趋势图和导出交互
- [ ] tRPC API 集成测试覆盖趋势获取和报告导出

### Blocked by

- Issue #15 (覆盖率分析)

---

## Issue #17: 回归套件管理

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

创建/编辑/删除回归套件（选择一组用例 + 运行选项），批量仿真调度。回归套件配置存储到 `.socverify/regressions/`。

端到端路径：用户点击"新建回归" → 选择用例（从用例树勾选）→ 配置运行选项 → 命名 → tRPC `regression.create` → 存储到 .socverify/regressions/<name>.json → 回归列表展示 → 用户点击"运行" → tRPC `regression.run` → 批量调用 SimulationRunnerPlugin.run() → 任务注册到后台任务面板。

### Acceptance criteria

- [ ] 创建回归套件：命名 + 选择用例 + 配置选项
- [ ] 编辑/删除已有回归套件
- [ ] 回归套件存储到 `.socverify/regressions/<name>.json`
- [ ] 运行回归套件：批量启动所有用例的仿真
- [ ] 回归运行注册到后台任务面板
- [ ] tRPC 有 `regression.create` / `regression.update` / `regression.delete` / `regression.list` / `regression.run` procedure
- [ ] 回归运行支持并发控制（不超时 SessionManager 并发上限）
- [ ] tRPC API 集成测试覆盖回归套件 CRUD 和运行

### Blocked by

- Issue #6 (仿真执行)

---

## Issue #18: 回归结果与对比

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

回归运行结果摘要（通过率、失败列表、耗时），两次回归运行对比（新增失败、修复用例）。

端到端路径：回归运行完成 → tRPC `regression.getResult` 返回摘要 → 渲染端结果面板展示 → 用户选择两次运行 → tRPC `regression.compareRuns` → 渲染端对比视图（新增失败/修复/未变化）。

### Acceptance criteria

- [ ] 回归结果摘要：通过率、失败用例列表、总耗时
- [ ] 失败用例可点击查看详情（编译错误/仿真输出）
- [ ] 两次回归运行对比：新增失败、修复的用例、状态未变化的用例
- [ ] 对比结果以差异视图展示（颜色区分新增/修复/不变）
- [ ] tRPC 有 `regression.getResult` / `regression.compareRuns` / `regression.getHistory` procedure
- [ ] tRPC API 集成测试覆盖结果获取和对比

### Blocked by

- Issue #17 (回归套件管理)

---

## Issue #19: Dashboard

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

项目 Dashboard 展示整体状态：用例通过率、覆盖率趋势、近期回归结果。支持可拖拽布局，自定义指标卡片。

端到端路径：用户切换到 Dashboard 视图 → tRPC `dashboard.getMetrics` 聚合数据（通过率/覆盖率/回归）→ 渲染端可拖拽布局（react-grid-layout）→ 指标卡片渲染 → 用户拖拽调整布局 → tRPC `dashboard.saveLayout` 持久化。

### Acceptance criteria

- [ ] Dashboard 展示项目整体状态（用例通过率、覆盖率趋势、近期回归）
- [ ] 支持可拖拽布局（react-grid-layout）
- [ ] 指标卡片可自定义（添加/删除/排序）
- [ ] 布局持久化到 userData
- [ ] tRPC 有 `dashboard.getMetrics` / `dashboard.saveLayout` / `dashboard.getLayout` procedure
- [ ] 指标卡片包含：用例通过率饼图、覆盖率趋势线、回归历史时间线
- [ ] UI 组件测试覆盖 Dashboard 渲染和拖拽交互
- [ ] tRPC API 集成测试覆盖指标聚合

### Blocked by

- Issue #4 (用例发现与过滤)
- Issue #6 (仿真执行)
- Issue #15 (覆盖率分析)

---

## Issue #20: TO 检查清单

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

TO（Tape-Out）就绪检查清单：覆盖率门槛、回归通过率、签核状态。支持标记检查项状态（通过/待办/阻塞），导出 TO 就绪报告。

端到端路径：用户打开 TO 检查清单 → tRPC `to.getChecklist` 返回检查项列表 → 渲染端清单展示 → 每项检查自动评估（覆盖率是否达标/回归是否通过）→ 用户手动标记签核项 → tRPC `to.updateItem` → 用户点击"导出报告" → tRPC `to.exportReport` → 生成报告文件。

### Acceptance criteria

- [ ] TO 检查清单展示所有检查项（覆盖率门槛、回归通过率、签核状态）
- [ ] 覆盖率/回归项自动评估是否达标（基于 Dashboard 数据）
- [ ] 签核项支持手动标记状态（通过/待办/阻塞）
- [ ] 检查清单存储到 `.socverify/to-checklist.json`，支持团队共享
- [ ] 导出 TO 就绪报告（HTML/PDF 格式，含各项状态和详情）
- [ ] tRPC 有 `to.getChecklist` / `to.updateItem` / `to.exportReport` procedure
- [ ] tRPC API 集成测试覆盖检查清单获取/更新/导出

### Blocked by

- Issue #19 (Dashboard)

---

## Issue #21: 凭据管理

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

LLM API 凭据管理：使用 Electron `safeStorage` API 加密存储 API key，支持多 provider 凭据，设置 UI 管理凭据。

端到端路径：用户打开设置 → 凭据管理 → tRPC `settings.getCredentials` 返回 provider 列表（key 已脱敏）→ 用户添加/编辑凭据 → tRPC `settings.setCredential` → safeStorage 加密存储 → omp 会话启动时注入凭据到环境变量。

### Acceptance criteria

- [ ] 使用 Electron `safeStorage` API 加密存储 API key
- [ ] 支持多个 LLM provider 的凭据（provider ID + API key + endpoint）
- [ ] 凭据列表展示时 API key 脱敏（仅显示前 4 位 + ***）
- [ ] 添加/编辑/删除凭据
- [ ] omp 会话启动时自动注入对应 provider 的凭据
- [ ] tRPC 有 `settings.getCredentials` / `settings.setCredential` / `settings.deleteCredential` procedure
- [ ] 设置 UI 凭据管理面板
- [ ] tRPC API 集成测试覆盖凭据 CRUD

### Blocked by

None — can start immediately.

---

## Issue #22: Skill 与 MCP 管理

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

omp skill 安装/卸载管理，MCP 服务器配置管理，项目级 AI 系统提示词配置。设置 UI 管理这些配置。

端到端路径：用户打开设置 → Skill 管理 → tRPC `settings.listSkills` 返回已安装 skill 列表 → 用户安装新 skill → tRPC `settings.installSkill` → omp skill 管理机制安装 → 用户配置 MCP 服务器 → tRPC `settings.setMcpConfig` → omp extension 机制加载 → 用户编辑项目 AI 系统提示词 → tRPC `settings.setSystemPrompt` → 存储到 .socverify/。

### Acceptance criteria

- [ ] 展示已安装 omp skill 列表（名称、描述、版本）
- [ ] 支持安装/卸载 skill
- [ ] MCP 服务器配置（名称、命令、参数、环境变量）
- [ ] MCP 服务器状态展示（连接/断开）
- [ ] 项目级 AI 系统提示词编辑
- [ ] 系统提示词存储到 `.socverify/system-prompt.md`
- [ ] tRPC 有 `settings.listSkills` / `settings.installSkill` / `settings.uninstallSkill` / `settings.listMcpServers` / `settings.setMcpConfig` / `settings.getSystemPrompt` / `settings.setSystemPrompt` procedure
- [ ] tRPC API 集成测试覆盖 skill/MCP/提示词管理

### Blocked by

- Issue #21 (凭据管理)

---

## Issue #23: 全局体验打磨

### Parent

[PRD: SoC Verify M2-M7](./prd-m2-m7.md)

### What to build

全局搜索（用例/文件/日志/AI 对话）、命令面板（Ctrl+Shift+P）、深色/浅色主题切换、错误提示优化、国际化（中/英）、性能优化。

端到端路径：
- 搜索：Ctrl+F → 全局搜索面板 → 输入关键词 → tRPC `search.global` → 搜索用例/文件/日志/对话 → 结果列表展示 → 点击跳转
- 命令面板：Ctrl+Shift+P → 命令列表 → 搜索/选择 → 执行对应操作
- 主题：设置 → 主题切换 → CSS 变量切换 → 全局重渲染
- i18n：i18next 集成 → 语言切换 → 全部文案翻译
- 错误提示：全局错误边界 → toast 通知 → 恢复建议

### Acceptance criteria

- [ ] 全局搜索（Ctrl+F）：搜索用例/文件/日志/AI 对话，结果分类展示，点击跳转
- [ ] 命令面板（Ctrl+Shift+P）：列出所有可用操作，搜索/选择/执行
- [ ] 深色/浅色主题切换，记住用户选择
- [ ] 所有错误展示有意义的提示和恢复建议（toast 通知）
- [ ] 国际化支持中/英文，可通过设置切换
- [ ] 操作响应延迟 < 100ms（文件树加载、会话切换等）
- [ ] UI 组件测试覆盖搜索面板和命令面板
- [ ] tRPC API 集成测试覆盖全局搜索

### Blocked by

- 大部分功能完成后进行（Issue #4, #6, #10, #15 至少完成）
