# SoC Verify

<p align="center">
  <strong>AI Agent 驱动的 SoC 验证一站式管理平台</strong>
</p>

<p align="center">
  从项目 Kickoff 到 Tape-Out，所有验证工作——项目管理、仿真执行、覆盖率分析、回归测试、AI 辅助验证——尽在单一桌面应用中完成。
</p>

---

## 概述

**SoC Verify** 是一款 Electron 桌面应用，面向 SoC 验证工程师，覆盖从项目启动到流片的完整验证周期。核心 AI 能力由 [oh-my-pi (omp)](./engine/oh-my-pi/) 引擎提供，普通开发运行优先使用 GitHub Release 中的预编译 runner，只有重编 runner 时才需要初始化 engine submodule。

平台采用插件化架构，EDA 工具集成（仿真器、覆盖率工具等）全部通过插件实现，平台本身提供插件接口和运行框架，不绑定特定 EDA 厂商。

### 核心能力

| 能力域 | 说明 |
|--------|------|
| **项目管理** | 多项目打开/切换、文件树浏览、文件编辑器、项目状态持久化与恢复 |
| **插件系统** | 5 种插件类型（子系统发现 / 用例解析 / 仿真执行 / 覆盖率解析 / 选项 Schema），npm 包分发 |
| **仿真执行** | SimulationManager 管理仿真生命周期，编译错误解析，运行历史记录与对比 |
| **终端集成** | node-pty + xterm.js 多标签终端，嵌入 EDA 工具交互 |
| **覆盖率分析** | CoverageManager 多维度覆盖率（行 / Toggle / 功能 / 断言），趋势可视化，HTML/JSON 导出 |
| **回归测试** | 回归套件管理、批量执行、结果汇总 |
| **AI Agent** | 多会话管理、流式消息、Markdown 渲染、工具卡片、技能发现、上下文文件管理 |
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
| 语言 | TypeScript | 7 |
| 样式 | Tailwind CSS v4 + shadcn/ui (new-york) | 4.3 |
| 状态管理 | Zustand | 5 |
| IPC | electron-trpc | 0.7.1 |
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
│   │   ├── ipc/router.ts              # tRPC router（14 个子路由）
│   │   ├── agent/                     # AI Agent 引擎集成
│   │   │   ├── agent-client.ts        # omp RPC 客户端
│   │   │   ├── openai-compatible.ts   # OpenAI 兼容代理
│   │   │   ├── session-manager.ts     # 会话管理（并发上限 10）
│   │   │   ├── session-persistence.ts # 会话持久化
│   │   │   ├── skill-discovery.ts     # 技能发现（SKILL.md 扫描）
│   │   │   └── paths.ts               # omp/bun 路径解析
│   │   ├── host/                      # Host Tools / URI 注册中心
│   │   ├── project/project-manager.ts # 项目管理
│   │   ├── plugins/loader.ts          # 插件加载器
│   │   ├── simulation/                # 仿真管理
│   │   ├── coverage/                  # 覆盖率管理
│   │   ├── regression/                # 回归测试管理
│   │   ├── terminal/                  # PTY 终端管理
│   │   ├── env/                       # 环境配置管理
│   │   ├── credentials/               # 凭据管理
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
│   │       │   │   ├── CenterArea.tsx # 中栏：终端 / AI产物 / 文件
│   │       │   │   ├── RightPanel.tsx # 右栏：AI Agent 会话
│   │       │   │   └── ...
│   │       │   ├── coverage/          # 覆盖率面板
│   │       │   ├── dashboard/         # 仪表盘
│   │       │   ├── env/               # 环境向导
│   │       │   ├── regression/        # 回归面板
│   │       │   ├── terminal/          # 终端视图
│   │       │   ├── to/                # TO 检查清单
│   │       │   └── ui/                # shadcn/ui 组件
│   │       ├── stores/                # Zustand stores（14 个）
│   │       ├── lib/                   # tRPC 客户端、工具函数
│   │       └── styles/globals.css     # 全局样式 + 6 套主题
│   └── shared/                        # 主↔渲染共享类型
│       ├── types.ts                   # 通用类型定义
│       └── plugin-types.ts            # 插件接口契约（5 种 PluginKind）
├── engine/oh-my-pi/                   # omp 引擎 (git submodule，仅重编 runner 需要)
├── plugins/                           # 内置插件
│   └── unisoc-subsys-discoverer/      # Unisoc 子系统发现插件
├── tests/                             # Vitest 测试
├── docs/                              # PRD、issues 文档
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

### tRPC API（14 个子路由）

| 路由 | 说明 |
|------|------|
| `ping` / `version` / `system` | 健康检查、版本信息、Agent 运行时解析 |
| `project` | 项目打开/关闭、文件树、文件读写、子系统/用例发现、插件管理、搜索 |
| `session` | AI 会话创建/发送/中止/销毁、模型切换、技能发现、事件流 |
| `simulation` | 仿真运行/状态/编译错误/中止/历史/详情/对比 |
| `terminal` | 终端创建/写入/调整大小/销毁/列表 |
| `env` | EDA 工具检测、环境变量配置 |
| `coverage` | 覆盖率总览/分子系统/趋势/导出 |
| `regression` | 回归套件创建/执行/结果 |
| `dashboard` | 项目指标总览 |
| `to` | TO 检查清单管理 |
| `settings` | 凭据管理、应用设置 |
| `search` | 项目文件搜索 |

### 无边框窗口

应用使用 `frame: false` 实现无边框窗口，自定义 TitleBar 提供：
- 可拖拽区域（`-webkit-app-region: drag`）
- 左/右栏折叠切换
- 6 套主题切换
- 窗口控制（最小化 / 最大化-还原 / 关闭）

### 主题系统

支持 6 套主题，通过 CSS 变量 + `data-theme` 属性实现：

| 主题 | 模式 | 说明 |
|------|------|------|
| `light` | light | 干净明亮的浅色主题 |
| `dark` | dark | 经典深色主题，高对比度 |
| `midnight` | dark | 深蓝色调，长时间使用不伤眼 |
| `carbon` | dark | 工业风碳灰色，冷色调 |
| `nord` | dark | Nord 极地配色，蓝灰冷色 |
| `solarized-light` | light | 暖色调浅色主题 |

### omp 集成

- AI Agent 通过 `socverify-runner` JSONL 子进程通信
- `SessionManager` 管理多个 omp 会话（并发上限 10）
- 支持预编译 runner 和 Bun + engine submodule 两种启动方式
- `HostToolsRegistry` 注册 7 个 Host Tools（list_subsys / list_cases / run_simulation / get_run_status / get_compile_errors / get_coverage / read_file）
- `HostUriRegistry` 处理 3 种 URI scheme（`case:///` / `log:///` / `cov:///`）
- 支持 OpenAI 兼容代理，可对接第三方 LLM 服务

### 插件系统

5 种 `PluginKind`，接口契约定义在 `src/shared/plugin-types.ts`：

| Kind | 接口 | 职责 |
|------|------|------|
| `case-parser` | `CaseParserPlugin` | 解析子系统下的验证用例 |
| `subsys-discoverer` | `SubsysDiscoveryPlugin` | 发现项目中的子系统 |
| `coverage-parser` | `CoverageParserPlugin` | 解析覆盖率数据 |
| `simulation-runner` | `SimulationRunnerPlugin` | 执行仿真 |
| `sim-option-schema` | `SimOptionSchemaProvider` | 提供仿真选项 schema |

插件以 npm 包形式分发，通过 `PluginLoader` 从 `node_modules` 或本地路径加载。内置 `unisoc-subsys-discoverer` 插件作为参考实现。

## 开发

### 环境要求

- Node.js 22+
- npm 10+
- Windows 10/11（主要平台），macOS / Linux 理论支持

### 快速开始

```sh
# 安装依赖
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
npm run lint         # ESLint 检查
npm run test         # 运行 Vitest 测试
npm run test:watch   # 测试监听模式
npm run typecheck    # TypeScript 类型检查
npm run package:win  # 打包 Windows 应用
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
| M0 | ✅ 完成 | 项目脚手架 |
| M1 | ✅ 完成 | omp RPC 核心（JSONL 客户端、会话管理、Host Tools/URI） |
| M2 | ✅ 完成 | 项目管理 / 插件系统 / 子系统发现 / AI Chat UI |
| M3 | ✅ 完成 | 仿真执行 / 仿真选项 UI / 终端集成 |
| M4 | ✅ 完成 | AI 多会话 / 流式消息 / 高级功能 / 任务管理 |
| M5 | ✅ 完成 | 环境配置向导 / 覆盖率分析 / 覆盖率可视化 |
| M6 | ✅ 完成 | 仪表盘 / TO 检查清单 / 回归测试 |
| M7 | 🔧 进行中 | 技能发现 / 会话持久化 / 凭据管理 / 打磨 |

## 文档

- [PRD (M2-M7)](./docs/prd-m2-m7.md) — 产品需求文档
- [Issues (M2-M7)](./docs/issues-m2-m7.md) — 23 个垂直切片 Issue
- [CHANGELOG](./CHANGELOG.md) — 变更日志
- [Release Notes](./release-notes/) — 各版本发布说明

## License

Private — © 2026 SoC Verify Team
