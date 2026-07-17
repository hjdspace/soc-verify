# SoC Verify

<p align="center">
  <strong>AI Agent 驱动的 SoC 验证一站式管理平台</strong>
</p>

<p align="center">
  从项目 Kickoff 到 Tape-Out，所有验证工作——项目管理、仿真执行、覆盖率分析、回归测试、AI 辅助验证——尽在单一桌面应用中完成。
</p>

<p align="center">
  <a href="https://github.com/hjdspace/soc-verify/releases"><img src="https://img.shields.io/github/v/release/hjdspace/soc-verify?style=flat-square&logo=github" alt="Release"></a>
  <a href="https://github.com/hjdspace/soc-verify/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/hjdspace/soc-verify/stargazers"><img src="https://img.shields.io/github/stars/hjdspace/soc-verify?style=flat-square&logo=github" alt="Stars"></a>
</p>

---

## 概述

**SoC Verify** 是一款 Electron 桌面应用，面向 SoC 验证工程师，覆盖从项目启动到流片的完整验证周期。核心 AI 能力由 [oh-my-pi (omp)](./engine/oh-my-pi/) 引擎提供，普通开发运行优先使用 GitHub Release 中的预编译 runner，只有重编 runner 时才需要初始化 engine submodule。

平台采用插件化架构，EDA 工具集成（仿真器、覆盖率工具等）全部通过插件实现，平台本身提供插件接口和运行框架，不绑定特定 EDA 厂商。

### 核心能力

| 能力域 | 说明 |
|--------|------|
| **项目管理** | 多项目打开/切换、文件树浏览、文件编辑器、项目状态持久化与恢复、源码控制 |
| **插件系统** | 5 种插件类型（子系统发现 / 用例解析 / 仿真执行 / 覆盖率解析 / 选项 Schema），npm 包分发；内置 Unisoc 参考插件集 |
| **仿真执行** | SimulationManager 管理仿真生命周期，编译错误解析，运行历史记录与对比 |
| **终端集成** | node-pty + xterm.js 多标签终端，支持 EDA 工具交互与仿真直连执行 |
| **错误分析** | 仿真失败自动触发 AI 错误分析，编译错误自动修复重试（最大 3 次），仿真错误给出建议 |
| **Diff Review** | AI Agent 代码改动的逐块审阅系统，接受/拒绝每个 hunk，支持 overwritten hunk 检测 |
| **覆盖率分析** | CoverageManager 多维度覆盖率（行 / Toggle / 功能 / 断言），趋势可视化，HTML/JSON 导出 |
| **回归测试** | 回归套件管理、批量执行、结果汇总 |
| **AI Agent** | 多会话管理、流式消息、Markdown 渲染、工具卡片、技能发现、上下文文件管理、OpenAI 兼容代理 |
| **环境配置** | EDA 工具自动检测、环境变量配置向导 |
| **Dashboard** | 项目仿真与覆盖率指标全景视图 |
| **TO 检查清单** | 流片前检查项管理，自动评估与报告导出 |
| **凭据管理** | API 密钥安全存储、自定义接口地址 |
| **命令面板** | 快捷键触发，快速操作 |

## 技术栈

| 层 | 技术 | 版本 |
|---|---|---|
| 运行时 | Electron | 43 |
| 构建 | electron-vite | 5 |
| 前端框架 | React | 19 |
| 语言 | TypeScript | 6 |
| 样式 | Tailwind CSS v4 + shadcn/ui (new-york) | 4.3 |
| 状态管理 | Zustand | 5 |
| RPC | electron-trpc (tRPC) | 0.7.1 |
| 终端 | node-pty + xterm.js | 1.1 / 6.0 |
| 代码编辑器 | CodeMirror | 4.25 |
| Markdown | react-markdown + remark-gfm | 10.1 / 4.0 |
| AI 引擎 | oh-my-pi (omp) | 预编译 runner + git submodule 开发回退 |
| 测试 | Vitest | 4 |
| 图标 | lucide-react | 1.24 |

## 项目结构

```
soc-verify/
├── src/
│   ├── main/                          # Electron 主进程 (ESM → CJS)
│   │   ├── index.ts                   # 应用入口
│   │   ├── ipc/router.ts              # tRPC router（~14 个子路由）
│   │   ├── agent/                     # AI Agent 引擎集成
│   │   │   ├── agent-client.ts        # omp RPC 客户端
│   │   │   ├── openai-compatible.ts   # OpenAI 兼容代理
│   │   │   ├── session-manager.ts     # 会话管理（并发上限 10）
│   │   │   ├── session-persistence.ts # 会话持久化
│   │   │   ├── skill-discovery.ts     # 技能发现（SKILL.md 扫描）
│   │   │   └── paths.ts               # omp/bun 路径解析
│   │   ├── host/                      # Host Tools / URI 注册中心
│   │   │   ├── host-tools.ts          # 工具注册中心
│   │   │   ├── host-uris.ts           # URI scheme handler
│   │   │   ├── discovery.ts           # 子系统/用例发现接口
│   │   │   └── plugin-discovery.ts    # 插件驱动适配层
│   │   ├── project/project-manager.ts # 项目管理
│   │   ├── plugins/loader.ts          # 插件加载器
│   │   ├── simulation/                # 仿真管理
│   │   │   ├── simulation-manager.ts  # 仿真生命周期
│   │   │   ├── simulation-registry.ts # 运行历史与详情
│   │   │   ├── log-analyzer.ts        # 编译/仿真日志解析
│   │   │   ├── error-analysis-coordinator.ts  # 自动错误分析
│   │   │   ├── sim-terminal-linker.ts # 仿真→终端关联
│   │   │   └── sim-presets.ts         # 仿真预设管理
│   │   ├── diff/                      # Diff Review 引擎
│   │   │   ├── diff-engine.ts         # Hunk 解析/接受/拒绝/overwritten 检测
│   │   │   └── review-queue.ts        # 全局待审阅队列
│   │   ├── coverage/                  # 覆盖率管理
│   │   ├── regression/                # 回归测试管理
│   │   ├── terminal/                  # PTY 终端管理
│   │   ├── env/                       # 环境配置管理
│   │   ├── credentials/               # 凭据管理
│   │   ├── scm/                       # 源码控制服务
│   │   └── ipc/electron-trpc-bridge.ts# tRPC ↔ Electron 桥接
│   ├── preload/                       # Preload 脚本 (CJS)
│   │   └── index.ts                   # contextBridge：tRPC + windowControls
│   ├── renderer/                      # 渲染进程 (React SPA)
│   │   └── src/
│   │       ├── App.tsx                # 根组件
│   │       ├── components/            # UI 组件
│   │       │   ├── layout/            # 布局组件
│   │       │   │   ├── AppShell.tsx   # 三栏 + TitleBar + OptionDock
│   │       │   │   ├── LeftRail.tsx   # 左栏：文件树 / 用例树 / Dashboard
│   │       │   │   ├── CenterArea.tsx # 中栏：终端 / AI产物 / 文件 / DiffReview
│   │       │   │   ├── RightPanel.tsx # 右栏：AI Agent 会话
│   │       │   │   ├── ResizeHandle.tsx # 面板宽度拖拽调节
│   │       │   │   └── OptionDock.tsx # 底部仿真选项浮窗
│   │       │   ├── coverage/          # 覆盖率面板
│   │       │   ├── dashboard/         # 仪表盘
│   │       │   ├── env/               # 环境向导
│   │       │   ├── regression/        # 回归面板
│   │       │   ├── terminal/          # 终端视图
│   │       │   ├── to/                # TO 检查清单
│   │       │   ├── diff-review/       # Diff Review 组件
│   │       │   ├── source-control/    # 源码控制组件
│   │       │   └── ui/                # shadcn/ui 组件
│   │       ├── stores/                # Zustand stores（16 个）
│   │       │   ├── ui.ts              # 面板折叠 / 宽度 / 设置面板
│   │       │   ├── theme.ts           # 主题状态
│   │       │   ├── session.ts         # AI 会话管理
│   │       │   ├── project.ts         # 项目状态
│   │       │   ├── simulation.ts      # 仿真状态
│   │       │   ├── terminal.ts        # 终端状态
│   │       │   ├── diff-review.ts     # Diff Review 队列
│   │       │   ├── coverage.ts        # 覆盖率数据
│   │       │   ├── regression.ts      # 回归状态
│   │       │   ├── dashboard.ts       # 仪表盘数据
│   │       │   ├── to-checklist.ts    # TO 检查清单
│   │       │   ├── task.ts            # 后台任务面板
│   │       │   ├── settings.ts        # 应用设置
│   │       │   ├── env.ts             # 环境配置
│   │       │   ├── toast.ts           # 消息提示
│   │       │   └── source-control.ts  # 源码控制状态
│   │       ├── lib/                   # tRPC 客户端、工具函数
│   │       └── styles/globals.css     # 全局样式 + 6 套主题
│   └── shared/                        # 主↔渲染共享类型
│       ├── types.ts                   # 通用类型定义
│       └── plugin-types.ts            # 插件接口契约（5 种 PluginKind）
├── engine/oh-my-pi/                   # omp 引擎 (git submodule，仅重编 runner 需要)
├── plugins/                           # 内置插件
│   ├── unisoc-subsys-discoverer/      # Unisoc 子系统发现
│   ├── unisoc-case-parser/            # Unisoc 用例解析
│   ├── unisoc-simulation-runner/      # Unisoc 仿真执行
│   └── unisoc-sim-option-schema/      # Unisoc 仿真选项 Schema
├── tests/                             # Vitest 测试（~30 个测试文件）
├── docs/                              # PRD、issues、ADR 文档
├── resources/binaries/                # omp/bun 预编译二进制
├── electron.vite.config.ts            # 三进程构建配置
├── electron-builder.yml               # 打包配置
└── package.json
```

## 架构设计

### 三进程模型

| 进程 | 目录 | 构建产物 | 职责 |
|------|------|----------|------|
| 主进程 | `src/main/` | CJS | 窗口管理、omp 子进程、tRPC router、IPC |
| Preload | `src/preload/` | CJS | contextBridge：tRPC 桥接 + 窗口控制 |
| 渲染进程 | `src/renderer/` | ESM | React SPA，通过 tRPC proxy 调用主进程 API |

### tRPC API

| 路由 | Procedures | 说明 |
|------|-----------|------|
| `system` | 1 | Agent 运行时解析 |
| `ping` / `version` / `scm` | 4 | 健康检查、版本信息、源码控制状态/提交/推送 |
| `project` | 18 | 项目 CRUD、文件树、文件读写、子系统/用例发现、插件管理、搜索 |
| `session` | 20+ | AI 会话创建/发送/中止/销毁、模型切换、技能发现、事件流、历史管理 |
| `simulation` | 12 | 仿真运行/状态/编译错误/中止/历史/详情/对比/终端仿真 |
| `terminal` | 7 | 终端创建/写入/调整大小/销毁/列表/输出缓冲 |
| `env` | 4 | EDA 工具检测、环境变量配置 |
| `coverage` | 7 | 覆盖率总览/分子系统/趋势/导出 |
| `regression` | 5 | 回归套件创建/列表/执行/取消/结果 |
| `dashboard` | 2 | 项目指标总览 |
| `to` | 4 | TO 检查清单管理 |
| `settings` | 10+ | 凭据管理、应用设置、MCP 配置、系统 Prompt |
| `search` | 1 | 全局搜索（仿真历史 / 回归套件） |
| `diff-review` | 2 | Diff 获取、拒绝应用 |
| `errorAnalysis` | 6 | 错误分析会话管理、日志读取 |

### 关键机制

**无边框窗口** — `frame: false` + 自定义 TitleBar（拖拽区域、面板折叠、主题切换、窗口控制）。

**主题系统** — 6 套主题通过 CSS 变量 + `data-theme` 属性实现，选择持久化到 `localStorage`。

**omp 集成** — AI Agent 通过 `socverify-runner` JSONL 子进程通信，`SessionManager` 管理多会话（并发上限 10），支持预编译 runner 和 Bun + engine submodule 两种启动方式，同时可对接第三方 OpenAI 兼容 LLM 服务。

**插件系统** — 5 种 `PluginKind`（case-parser / subsys-discoverer / coverage-parser / simulation-runner / sim-option-schema），以 npm 包形式分发，通过 `PluginLoader` 从 `node_modules` 或本地路径加载。内置 4 个 Unisoc 参考插件。

**Diff Review** — AI Agent 代码改动逐块审阅：hunk accept/reject、before reconstruction 重建修改前状态、overwritten hunk 检测、全局 Review Queue 跨会话聚合。

**自动错误分析** — 仿真失败自动触发 AI 分析：compile_error 自动修复并重试（最大 3 次），sim_error 仅给建议。

## 开发

### 环境要求

- Node.js 22+
- npm 10+
- Windows 10/11（主要平台），macOS / Linux 理论支持

### 快速开始

```sh
# 安装依赖（自动下载预编译 runner）
npm install

# 启动开发模式
npm run dev
```

`npm install` 会自动尝试从 GitHub Release 下载当前平台的 `socverify-runner` 到 `resources/binaries/`。只有需要本地重编 runner 时，才执行：

```sh
git submodule update --init --recursive
cd engine/oh-my-pi && bun install
cd ../..
npm run build:runner
```

### 开发命令

```sh
npm run dev          # 启动开发模式（electron-vite dev）
npm run build        # 构建产物（main + preload + renderer）
npm run preview      # 构建后预览
npm run lint         # ESLint 检查
npm run test         # 运行 Vitest 测试
npm run test:watch   # 测试监听模式
npm run typecheck    # TypeScript 类型检查
npm run package:win  # 打包 Windows NSIS 安装包
npm run package:linux # 打包 Linux AppImage
```

### 修改后验证

每次修改代码后，依次执行以下三条命令，全部通过才算完成：

```sh
npm run build        # 编译成功
npm run typecheck    # 类型检查通过
npm run test         # 测试通过
```

## 打包

打包脚本会强制检查 `resources/binaries/` 中存在预编译 runner，避免生成没有 AI Agent 的安装包：

```sh
npm run package:win    # Windows NSIS 安装包
npm run package:linux  # Linux AppImage
```

打包配置见 `electron-builder.yml`。Windows 打包使用 `compression: store` 优先减少本地打包时间，代价是安装包体积会更大。

## 布局

经典三栏 + 底部仿真选项浮窗：

```
┌──────────────────────────────────────────────────────┐
│                    TitleBar                           │
├──────────┬───────────────────────────┬───────────────┤
│          │                           │               │
│  LeftRail│      CenterArea           │  RightPanel   │
│          │                           │               │
│ 文件树    │  终端 / AI产物 / 文件编辑  │  AI Agent 会话 │
│ 用例树    │                           │  后台任务      │
│ Dashboard│                           │               │
│          │                           │               │
├──────────┴───────────────────────────┴───────────────┤
│                  OptionDock (仿真选项浮窗)             │
└──────────────────────────────────────────────────────┘
```

## 里程碑

| 里程碑 | 状态 | 内容 |
|--------|------|------|
| M0 | ✅ 完成 | 项目脚手架（Electron 43 + React 19 + TS 6 + Tailwind v4 + shadcn/ui） |
| M1 | ✅ 完成 | omp RPC 核心（JSONL 客户端、会话管理、Host Tools/URI） |
| M2 | ✅ 完成 | 项目管理 / 插件系统 / 子系统发现 / AI Chat UI |
| M3 | ✅ 完成 | 仿真执行 / 仿真选项 UI / 终端集成 |
| M4 | ✅ 完成 | AI 多会话 / 流式消息 / 高级功能 / 任务管理 |
| M5 | ✅ 完成 | 环境配置向导 / 覆盖率分析 / 覆盖率可视化 |
| M6 | ✅ 完成 | 仪表盘 / TO 检查清单 / 回归测试 |
| M7 | ✅ 完成 | 技能发现 / 会话持久化 / 凭据管理 / 源码控制 / 打磨 |
| M8 | ✅ 完成 | Diff Review 系统 / 自动错误分析 / 终端仿真执行 / Unisoc 插件集 |

## 文档

- [PRD (M2-M7)](./docs/prd-m2-m7.md) — 产品需求文档
- [Issues (M2-M7)](./docs/issues-m2-m7.md) — 23 个垂直切片 Issue
- [CHANGELOG](./CHANGELOG.md) — 变更日志
- [Release Notes](./release-notes/) — 各版本发布说明
- [CONTEXT.md](./CONTEXT.md) — 领域术语与统一语言
- [AGENTS.md](./AGENTS.md) — AI 编码助手项目指南

## 贡献

欢迎提交 Issue 和 Pull Request。

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交改动 (`git commit -m 'feat: add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 提交 Pull Request

**开发规范：**
- TypeScript strict 模式，不使用 `any`
- 优先使用 `type` 而非 `interface`
- 函数式风格优先，避免 class
- 文件命名：kebab-case（非组件）/ PascalCase（React 组件）
- 修改后必须通过 `build` + `typecheck` + `test` 三项验证

## License

MIT License — © 2026 hjdspace
