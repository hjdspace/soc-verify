# CLAUDE.md — SoC Verify 项目指南

> 本文件为 AI 编码助手（Claude / Cursor / Codex 等）提供项目上下文和开发规范。

## 项目概述

**SoC Verify** 是 AI Agent 驱动的 SoC 验证一站式管理平台。SoC 验证工程师从项目 kickoff 到 TO（Tape-Out）的整个周期中，所有验证工作（项目管理、仿真执行、覆盖率分析、回归测试、AI 辅助验证）都能在此单一 Electron 应用中完成。

核心 AI 能力由 [oh-my-pi (omp)](./engine/oh-my-pi/) 提供——一个 Rust + TypeScript 实现的 AI Agent RPC 引擎，作为 git submodule 内嵌。

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
| AI 引擎 | oh-my-pi (omp) | git submodule |
| 测试 | Vitest | 4 |
| 图标 | lucide-react | 1.24 |

## 项目结构

```
soc-verify/
├── src/
│   ├── main/                      # Electron 主进程 (ESM → CJS output)
│   │   ├── index.ts               # 应用入口：窗口创建、IPC 注册
│   │   ├── ipc/router.ts          # tRPC router（所有后端 API 入口）
│   │   ├── omp/                   # omp RPC 客户端
│   │   │   ├── rpc-client.ts      # JSONL 协议客户端
│   │   │   ├── session-manager.ts # 会话管理（并发上限 10）
│   │   │   ├── host-tools.ts      # Host Tools 注册中心
│   │   │   ├── host-uris.ts       # Host URI scheme handler
│   │   │   ├── discovery.ts       # 子系统/用例发现接口
│   │   │   ├── paths.ts           # omp/bun 路径解析
│   │   │   └── types.ts           # omp 类型定义
│   │   └── plugins/loader.ts      # 插件加载器
│   ├── preload/                   # Preload 脚本 (CJS output)
│   │   └── index.ts               # contextBridge：tRPC + windowControls
│   ├── renderer/                  # 渲染进程 (React)
│   │   ├── src/
│   │   │   ├── App.tsx            # 根组件（主题初始化）
│   │   │   ├── main.tsx           # React 入口
│   │   │   ├── components/
│   │   │   │   ├── layout/        # 布局组件
│   │   │   │   │   ├── AppShell.tsx    # 三栏 + TitleBar + OptionDock
│   │   │   │   │   ├── TitleBar.tsx    # 自定义无边框标题栏
│   │   │   │   │   ├── LeftRail.tsx    # 左栏：项目/用例树
│   │   │   │   │   ├── CenterArea.tsx  # 中栏：终端/AI产物/文件
│   │   │   │   │   ├── RightPanel.tsx  # 右栏：AI Agent 会话
│   │   │   │   │   └── OptionDock.tsx  # 底部：仿真选项浮窗
│   │   │   │   └── ui/            # shadcn/ui 组件
│   │   │   ├── stores/
│   │   │   │   ├── ui.ts          # UI 状态（面板折叠、设置面板）
│   │   │   │   └── theme.ts       # 主题状态（多套主题切换）
│   │   │   ├── lib/
│   │   │   │   ├── trpc.ts        # tRPC 客户端代理
│   │   │   │   └── utils.ts       # cn() 工具函数
│   │   │   └── styles/globals.css # 全局样式 + 6 套主题 CSS 变量
│   │   └── index.html
│   └── shared/                    # 主↔渲染共享类型
│       ├── types.ts               # AppVersionInfo 等通用类型
│       └── plugin-types.ts        # 插件接口契约（5 种 PluginKind）
├── engine/oh-my-pi/               # omp 引擎 (git submodule)
├── docs/                          # PRD、issues 文档
├── tests/                         # Vitest 测试
├── electron.vite.config.ts        # electron-vite 配置（3 进程构建）
├── electron-builder.yml           # 打包配置
├── components.json                # shadcn/ui 配置
└── package.json
```

## 开发命令

```sh
npm install          # 安装依赖
npm run dev          # 启动开发模式（electron-vite dev）
npm run build        # 构建产物
npm run lint         # ESLint 检查
npm run test         # 运行 Vitest 测试
npm run test:watch   # 测试监听模式
npm run typecheck    # TypeScript 类型检查（main + renderer）
npm run package:win  # 打包 Windows 应用
```

## 架构设计

### 三进程模型

Electron 应用分三个进程，由 `electron.vite.config.ts` 分别构建：

1. **主进程** (`src/main/`)：ESM 源码 → CJS 输出。负责窗口管理、omp 子进程管理、tRPC router、IPC
2. **Preload** (`src/preload/`)：CJS 输出。通过 `contextBridge` 暴露 `electron-trpc` 桥接和 `windowControls` API
3. **渲染进程** (`src/renderer/`)：React SPA。通过 tRPC proxy 调用主进程 API

### IPC 通信

- **tRPC (electron-trpc)**：所有业务 API 通过 tRPC router 暴露，类型安全
  - 主进程 `router` 定义在 `src/main/ipc/router.ts`
  - 渲染端通过 `src/renderer/src/lib/trpc.ts` 的 `trpc` proxy 调用
  - 子路由：`ping` / `version` / `system` / `session`（后续 M2+ 增加 `project` / `settings` 等）
- **原生 IPC**：窗口控制（最小化/最大化/关闭）通过 `ipcMain.on` / `ipcRenderer.send` 直接通信
  - Preload 暴露 `window.windowControls` API
  - 仅用于窗口操作，不用于业务逻辑

### 无边框窗口

应用使用 `frame: false` 实现无边框窗口，自定义 `TitleBar` 组件提供：
- 可拖拽区域（`-webkit-app-region: drag`）
- 左栏/右栏折叠切换按钮（始终可见，即使面板已折叠）
- 主题切换下拉菜单
- 窗口控制按钮（最小化/最大化-还原/关闭）
- 最大化状态实时同步（通过 `window:maximize-changed` 事件）

### 主题系统

支持 6 套主题，通过 CSS 变量 + `data-theme` 属性实现：

| 主题 ID | 名称 | 模式 | 说明 |
|---------|------|------|------|
| `light` | 浅色 | light | 干净明亮的浅色主题 |
| `dark` | 深色 | dark | 经典深色主题，高对比度 |
| `midnight` | 午夜蓝 | dark | 深蓝色调，长时间使用不伤眼 |
| `carbon` | 碳灰 | dark | 工业风碳灰色，冷色调 |
| `nord` | 极地 | dark | Nord 极地配色，蓝灰冷色 |
| `solarized-light` | Solarized 浅 | light | 暖色调浅色主题 |

- 主题定义在 `src/renderer/src/styles/globals.css` 的 `[data-theme="<id>"]` 选择器中
- 主题状态管理在 `src/renderer/src/stores/theme.ts`（Zustand）
- 选择持久化到 `localStorage`（key: `socverify:theme`）
- 每个主题定义完整的语义色变量：`--background` / `--foreground` / `--primary` / `--secondary` / `--muted` / `--accent` / `--destructive` / `--border` / `--titlebar` / `--sidebar` 等

### omp 集成

- omp 以 `--mode rpc` 启动，通过 JSONL 协议通信
- `SessionManager` 管理多个 omp 会话（并发上限 10）
- `HostToolsRegistry` 注册 7 个 Host Tools（list_subsys / list_cases / run_simulation / get_run_status / get_compile_errors / get_coverage / read_file）
- `HostUriRegistry` 处理 3 种 URI scheme（`case:///` / `log:///` / `cov:///`）
- 开发时用 Bun 直接运行 `engine/oh-my-pi/packages/coding-agent/src/cli.ts --mode rpc`

### 插件系统

5 种 `PluginKind`，接口契约定义在 `src/shared/plugin-types.ts`：

| Kind | 接口 | 职责 |
|------|------|------|
| `case-parser` | `CaseParserPlugin` | 解析子系统下的验证用例 |
| `subsys-discoverer` | `SubsysDiscoveryPlugin` | 发现项目中的子系统 |
| `coverage-parser` | `CoverageParserPlugin` | 解析覆盖率数据 |
| `simulation-runner` | `SimulationRunnerPlugin` | 执行仿真 |
| `sim-option-schema` | `SimOptionSchemaProvider` | 提供仿真选项 schema |

插件以 npm 包形式分发，通过 `PluginLoader` 从 `node_modules` 或本地路径加载。

## 编码规范

### 通用

- TypeScript strict 模式，不使用 `any`（除非有明确注释说明原因）
- 优先使用 `type` 而非 `interface`（除非需要 declaration merging）
- 函数式风格优先，避免 class（React 组件用函数 + Hooks）
- 文件命名：kebab-case 用于非组件文件，PascalCase 用于 React 组件文件

### React 组件

- 使用函数组件 + Hooks
- Zustand store 选择器：`useStore((s) => s.field)` 避免不必要的重渲染
- 样式使用 Tailwind utility classes + `cn()` 工具函数
- shadcn/ui 组件放在 `src/renderer/src/components/ui/`
- 业务组件放在 `src/renderer/src/components/` 对应子目录

### CSS / 样式

- 使用 Tailwind v4（`@import "tailwindcss"` + `@theme` block）
- 语义色通过 CSS 变量（HSL 格式），不直接使用 hex 值
- 组件中使用 `bg-background` / `text-foreground` / `border-border` 等语义类名
- 新增主题只需在 `globals.css` 中添加 `[data-theme="<id>"]` block + 在 `theme.ts` 的 `THEMES` 数组中注册

### 主进程

- ESM 模块（`"type": "module"`），但输出为 CJS（electron-vite 配置）
- tRPC procedure 使用 inline input validator（非 zod），保持轻量
- IPC handler 注册在 `createWindow` 后，绑定到具体 `BrowserWindow` 实例

### 测试

- 测试框架：Vitest
- 3 个测试缝：
  1. **tRPC API 集成缝**（主缝）：端到端测试 tRPC router，mock omp 子进程和文件系统
  2. **插件契约缝**：测试插件接口合规性
  3. **UI 组件缝**：`@testing-library/react` 测试组件渲染和交互
- 测试命名描述行为意图，不验证内部实现
- 核心模块覆盖率 > 80%，UI 组件 > 60%

## 重要约束

1. **不修改 omp 引擎源码**：`engine/oh-my-pi/` 是 git submodule，只使用其 RPC API
2. **单用户桌面应用**：不提供 Web 版本、移动端、多用户协作
3. **EDA 工具集成由插件实现**：平台只提供插件接口和运行框架
4. **Electron 主进程 ESM**：`"type": "module"`，`lib: ["ES2024"]`
5. **electron-trpc 0.7.1 CJS 输出**：绕过 ESM 不兼容问题
6. **CSP 策略**：`index.html` 中设置了严格 CSP（`default-src 'self'`）

## 里程碑

| 里程碑 | 状态 | 内容 |
|--------|------|------|
| M0 | ✅ 完成 | 项目脚手架 |
| M1 | ✅ 完成 | omp RPC 核心（JSONL 客户端、会话管理、Host Tools/URI 骨架） |
| M2 | 📋 计划 | 项目管理 / 存储 / 发现 / 插件系统 |
| M3 | 📋 计划 | 仿真执行 / 终端集成 |
| M4 | 📋 计划 | AI 辅助验证核心流 |
| M5 | 📋 计划 | 环境搭建 / 覆盖率分析 |
| M6 | 📋 计划 | 回归 / Dashboard / TO 检查 |
| M7 | 📋 计划 | MCP/Skill 管理 / 凭据 / 打磨 |

详见 `docs/prd-m2-m7.md` 和 `docs/issues-m2-m7.md`。

## 常见任务

### 添加新的 tRPC API

1. 在 `src/main/ipc/router.ts` 的 `router` 中添加 procedure
2. 渲染端通过 `trpc.xxx.xxx.query/mutate()` 调用
3. 类型自动推导，无需手动同步

### 添加新主题

1. 在 `src/renderer/src/styles/globals.css` 中添加 `[data-theme="<id>"]` block，定义所有 CSS 变量
2. 在 `src/renderer/src/stores/theme.ts` 的 `THEMES` 数组中添加 `ThemeDefinition`
3. 完成——TitleBar 的主题下拉菜单会自动显示新主题

### 添加 shadcn/ui 组件

```sh
npx shadcn@latest add <component-name>
```

配置已在 `components.json` 中设定（new-york style, lucide icons）。

### 添加新 UI 布局组件

1. 在 `src/renderer/src/components/layout/` 创建组件文件
2. 在 `AppShell.tsx` 中集成
3. 面板折叠状态通过 `useUiStore` 管理
