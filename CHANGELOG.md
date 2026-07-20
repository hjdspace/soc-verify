# Changelog

本文件记录 SoC Verify 项目的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
