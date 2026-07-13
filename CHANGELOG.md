# Changelog

本文件记录 SoC Verify 项目的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
