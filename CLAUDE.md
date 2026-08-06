# AGENTS.md — SoC Verify 项目指南

> 本文件为 AI 编码助手（Codex / Cursor / Codex 等）提供项目上下文和开发规范。

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
│   │   ├── index.ts               # 应用入口：窗口创建、IPC 注册、生命周期清理
│   │   ├── ipc/
│   │   │   ├── router.ts          # tRPC router（所有后端 API 入口）
│   │   │   ├── router-context.ts  # tRPC builder + TRPCError re-export
│   │   │   └── routers/           # 按领域拆分的子路由
│   │   │       ├── document-router.ts   # officecli 文档预览/编辑/下载
│   │   │       ├── session-router.ts    # omp 会话
│   │   │       ├── project-router.ts    # 项目管理
│   │   │       ├── simulation-router.ts # 仿真执行
│   │   │       ├── coverage-router.ts   # 覆盖率分析
│   │   │       └── ...                  # 其他子路由
│   │   ├── omp/                   # omp RPC 客户端
│   │   │   ├── rpc-client.ts      # JSONL 协议客户端
│   │   │   ├── session-manager.ts # 会话管理（并发上限 10）
│   │   │   ├── host-tools.ts      # Host Tools 注册中心
│   │   │   ├── host-uris.ts       # Host URI scheme handler
│   │   │   ├── discovery.ts       # 子系统/用例发现接口
│   │   │   ├── paths.ts           # omp/bun 路径解析（findInDir/findInPath）
│   │   │   └── types.ts           # omp 类型定义
│   │   ├── officecli/             # officecli 集成（Office 文档预览/创建）
│   │   │   ├── binary.ts          # 二进制路径解析（三级回退：packaged→dev→PATH）
│   │   │   ├── executor.ts        # 子进程封装（spawn + 超时 + 进程树 kill）
│   │   │   ├── service.ts         # 高级 API（viewHtml/viewScreenshot/watchStart 等）
│   │   │   └── downloader.ts      # 开发模式下载（spawn 下载脚本 + 进度推送）
│   │   ├── document/              # Office 文档编辑（exceljs + Fortune-sheet）
│   │   │   ├── fortune-sheet-bridge.ts # Fortune-sheet 数据 ↔ exceljs Workbook 转换
│   │   │   ├── xlsx-editor.ts     # exceljs 细粒度编辑（appendRows/updateCell）
│   │   │   └── editor-registry.ts # 前端编辑状态追踪 + flush 机制 + file-changed 通知
│   │   ├── host/                  # Host Tools 实现
│   │   ├── plugins/loader.ts      # 插件加载器
│   │   └── ...                    # project / coverage / simulation / terminal 等
│   ├── preload/                   # Preload 脚本 (CJS output)
│   │   └── index.ts               # contextBridge：tRPC + windowControls + eventBridge
│   ├── renderer/                  # 渲染进程 (React)
│   │   ├── src/
│   │   │   ├── App.tsx            # 根组件（主题初始化）
│   │   │   ├── main.tsx           # React 入口
│   │   │   ├── components/
│   │   │   │   ├── layout/        # 布局组件
│   │   │   │   │   ├── AppShell.tsx    # 三栏 + TitleBar + OptionDock
│   │   │   │   │   ├── TitleBar.tsx    # 自定义无边框标题栏
│   │   │   │   │   ├── LeftRail.tsx    # 左栏：项目/用例树（可调节宽度）
│   │   │   │   │   ├── CenterArea.tsx  # 中栏：终端/AI产物/文件/Office 文档
│   │   │   │   │   ├── RightPanel.tsx  # 右栏：AI Agent 会话（可调节宽度）
│   │   │   │   │   ├── ResizeHandle.tsx # 面板宽度调节拖拽条
│   │   │   │   │   └── OptionDock.tsx  # 底部：仿真选项浮窗
│   │   │   │   ├── office/        # Office 文档预览/编辑组件
│   │   │   │   │   ├── OfficeDocumentView.tsx # 容器（根据 mode 分发）
│   │   │   │   │   ├── HtmlPreview.tsx         # webview HTML 预览
│   │   │   │   │   ├── ScreenshotsPreview.tsx  # PNG 截图预览
│   │   │   │   │   ├── WatchPreview.tsx        # webview Watch 模式预览
│   │   │   │   │   ├── PdfPreview.tsx          # react-pdf 预览
│   │   │   │   │   └── XlsxEditor.tsx          # Fortune-sheet xlsx 编辑器
│   │   │   │   └── ui/            # shadcn/ui 组件
│   │   │   ├── stores/
│   │   │   │   ├── ui.ts          # UI 状态（面板折叠、宽度调节、设置面板）
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
├── resources/
│   ├── binaries/                  # 打包二进制（officecli / omp agent）
│   └── built-in-extension/skills/ # 内置 skills（officecli-docx/xlsx/pptx/pdf 等）
├── scripts/
│   └── download-officecli.mjs     # officecli 二进制下载脚本
├── docs/                          # PRD、issues、ADR 文档
├── tests/                         # Vitest 测试
├── electron.vite.config.ts        # electron-vite 配置（3 进程构建）
├── electron-builder.yml           # 打包配置
├── components.json                # shadcn/ui 配置
└── package.json
```

## 开发命令

```sh
npm install                       # 安装依赖
npm run dev                       # 启动开发模式（electron-vite dev）
npm run build                     # 构建产物（main + preload + renderer 三进程构建）
npm run lint                      # ESLint 检查
npm run test                      # 运行 Vitest 测试
npm run test:watch                # 测试监听模式
npm run typecheck                 # TypeScript 类型检查（main + renderer）
npm run download:officecli        # 下载 officecli 二进制到 resources/binaries/
npm run package:win               # 打包 Windows 应用（前置自动下载 officecli）
npm run package:linux             # 打包 Linux 应用（前置自动下载 officecli）
```

> officecli 二进制由 `scripts/download-officecli.mjs` 从 GitHub Releases 拉取（版本固定在 `package.json` 的 `officecliVersion` 字段），下载失败不阻断构建，运行时降级处理。打包脚本（`package:win`/`linux`）会前置执行下载，确保产物内置二进制。

## 架构设计

### 三进程模型

Electron 应用分三个进程，由 `electron.vite.config.ts` 分别构建：

1. **主进程** (`src/main/`)：ESM 源码 → CJS 输出。负责窗口管理、omp 子进程管理、tRPC router、IPC
2. **Preload** (`src/preload/`)：CJS 输出。通过 `contextBridge` 暴露 `electron-trpc` 桥接和 `windowControls` API
3. **渲染进程** (`src/renderer/`)：React SPA。通过 tRPC proxy 调用主进程 API

### IPC 通信

- **tRPC (electron-trpc)**：所有业务 API 通过 tRPC router 暴露，类型安全
  - 主进程 `router` 定义在 `src/main/ipc/router.ts`，按领域拆分到 `src/main/ipc/routers/` 下
  - 渲染端通过 `src/renderer/src/lib/trpc.ts` 的 `trpc` proxy 调用
  - 子路由：`ping` / `version` / `system` / `session` / `project` / `simulation` / `coverage` / `document` / `terminal` / `scm` / `settings` / `env` / `dashboard` / `regression` / `violation` / `to` / `errorAnalysis` / `confirmation` / `search`
  - `document` 子路由（`document-router.ts`）：officecli 文档预览/编辑、`registerEditor`/`unregisterEditor`/`flushDone`/`downloadBinary` 等 procedure
- **原生 IPC**：事件流式通知（不适合 tRPC request/response 模型的场景）+ 窗口控制
  - Preload 暴露 `window.windowControls`（窗口最小化/最大化/关闭）和 `window.eventBridge`（事件监听器）API
  - 事件通道：
    - 窗口：`window:minimize` / `window:maximize` / `window:close` / `window:is-maximized` / `window:maximize-changed`
    - 项目：`filetree:update` / `project:opened` / `project:closed`
    - 会话：`session:event`
    - 仿真：`simulation:event`
    - 错误分析：`errorAnalysis:event`
    - 终端：`terminal:data` / `terminal:exit`
    - 文档（officecli 集成）：`document:flush-request`（主→渲染，要求立即保存）/ `document:flush-done`（渲染→主，保存完成）/ `document:file-changed`（主→渲染，文件被 AI 修改需重载）/ `officecli:download-progress`（主→渲染，开发模式下载进度推送）

### 无边框窗口

应用使用 `frame: false` 实现无边框窗口，自定义 `TitleBar` 组件提供：
- 可拖拽区域（`-webkit-app-region: drag`）
- 左栏/右栏折叠切换按钮（始终可见，即使面板已折叠）
- 主题切换下拉菜单
- 窗口控制按钮（最小化/最大化-还原/关闭）
- 最大化状态实时同步（通过 `window:maximize-changed` 事件）

### 主题系统

支持 4 套主题，通过 CSS 变量 + `data-theme` 属性实现：

- 主题定义在 `src/renderer/src/styles/globals.css` 的 `[data-theme="<id>"]` 选择器中
- 主题状态管理在 `src/renderer/src/stores/theme.ts`（Zustand）
- 选择持久化到 `localStorage`（key: `socverify:theme`）
- 每个主题定义完整的语义色变量：`--background` / `--foreground` / `--primary` / `--secondary` / `--muted` / `--accent` / `--destructive` / `--border` / `--titlebar` / `--sidebar` 等

### omp 集成

- omp 以 `--mode rpc` 启动，通过 JSONL 协议通信
- `SessionManager` 管理多个 omp 会话（并发上限 10）
- `HostToolsRegistry` 注册的 Host Tools：
  - 默认 7 个 SoC 验证工具：`list_subsys` / `list_cases` / `run_simulation` / `get_run_status` / `get_compile_errors` / `get_coverage` / `read_file`
  - 条件注册（依赖 CoverageManager）：`get_coverage_detail` / `get_coverage_uncovered` / `get_coverage_grade` / `get_coverage_csv`
  - 条件注册（依赖 CaseStatsService）：`get_case_stats` / `get_project_overview`
  - 文档工具 7 个（依赖 officecli/exceljs）：`create_docx` / `create_xlsx` / `create_pptx` / `create_pdf` / `read_document` / `append_xlsx_row` / `update_xlsx_cell`
- `HostUriRegistry` 处理 3 种 URI scheme（`case:///` / `log:///` / `cov:///`）
- 开发时用 Bun 直接运行 `engine/oh-my-pi/packages/coding-agent/src/cli.ts --mode rpc`

### officecli 集成

Office 文档（docx/xlsx/pptx/pdf）的预览、创建与编辑能力通过 [officecli](https://github.com/iOfficeAI/OfficeCLI) 提供。详见 [ADR 0015](./docs/adr/0015-officecli-integration.md)。

**职责分层**

| 层 | 技术 | 职责 |
|---|---|---|
| 二进制 | officecli（外部 CLI） | docx/pptx/pdf 预览渲染（HTML/PNG）、watch 模式、文档创建 |
| 主进程服务 | `src/main/officecli/` | 二进制路径解析、子进程封装、高级 API |
| 主进程编辑 | `src/main/document/`（exceljs + Fortune-sheet bridge） | xlsx 细粒度编辑、前端编辑状态追踪 + flush 机制 |
| tRPC | `document-router.ts` | `viewHtml` / `viewScreenshot` / `watchStart` / `loadXlsx` / `saveXlsx` / `registerEditor` / `flushDone` / `downloadBinary` 等 |
| 渲染端 | `src/renderer/src/components/office/` | `OfficeDocumentView`（容器）+ 5 个预览/编辑组件（Html/Screenshots/Watch/Pdf/Xlsx） |
| AI 工具 | HostTools | `create_docx` / `create_xlsx` / `create_pptx` / `create_pdf` / `read_document`（officecli）+ `append_xlsx_row` / `update_xlsx_cell`（exceljs） |

**二进制打包与路径解析**

- 二进制由 `scripts/download-officecli.mjs` 从 GitHub Releases 下载到 `resources/binaries/officecli-{platform}-{arch}[.exe]`
- `package.json` 的 `officecliVersion` 字段固定版本，升级需手动改版本号
- electron-builder 的 `extraResources` + `asarUnpack` 配置自动随包打包，无需修改配置
- 运行时由 `src/main/officecli/binary.ts` 的 `resolveOfficecliPath()` 三级回退：内置二进制（packaged → dev）→ 用户级安装（`~/.officecli/bin/`）→ 系统 PATH（仅开发模式）
- 路径解析工具函数 `findInDir` / `findInPath` 复用自 `src/main/agent/paths.ts`

**xlsx 编辑与 flush 机制**

- xlsx 编辑使用 Fortune-sheet（前端）+ exceljs（主进程），不依赖 officecli
- `XlsxEditor` mount 时通过 `document.registerEditor(filePath)` 注册前端编辑状态，unmount 时注销
- AI 调用 `append_xlsx_row` / `update_xlsx_cell` 前，主进程检查目标文件是否在前端编辑中
- 若在编辑中：主进程发 `document:flush-request` IPC 事件 → 前端立即保存 → 回复 `document:flush-done`（或 3 秒超时强制继续，记录警告日志）
- AI 修改完成后：主进程发 `document:file-changed` IPC 事件 → 前端重载 Fortune-sheet

**错误降级**

- officecli 不可用时：预览组件显示"officecli 未安装"提示 + 下载按钮（仅开发模式可见，调用 `document.downloadBinary`）
- `create_*` HostTools 返回明确的 `OfficeCLI not available` 错误，AI 可据此告知用户
- Fortune-sheet 编辑不依赖 officecli，仍可用（exceljs 纯 Node 实现）
- `document.downloadBinary` 仅开发模式可用，生产模式返回错误"请通过应用安装包获取 officecli"
- 开发模式下载时通过 `officecli:download-progress` IPC 事件推送进度（stage、message、percent）

**应用生命周期**

- `app.whenReady()` 中调用 `registerDocumentIpcHandlers()` 注册 `document:flush-done` IPC handler
- `before-quit` 事件中调用 `cleanupOfficeCli()`（清理所有 watch 进程）和 `cleanupEditorRegistry()`（清理 pending flush 和编辑器注册表）

**SKILL.md**

`resources/built-in-extension/skills/` 下内置 4 个 officecli skill 包（供 AI 调用 officecli CLI 高级能力）：`officecli-docx` / `officecli-xlsx` / `officecli-pptx` / `officecli-pdf`

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

## 修改后验证检查

**每次修改代码后，必须依次执行以下四条命令，全部通过才算完成：**

```sh
npm run build        # 1. 确认编译成功（main + preload + renderer 三进程构建）
npm run typecheck    # 2. 确认类型检查通过（tsconfig.node.json + tsconfig.web.json）
npm run test         # 3. 确认测试通过（Vitest 全部测试用例）
npm run lint         # 4. 确认代码规范通过（ESLint）
```

- 如果任一命令失败，必须修复后重新执行全部四条命令
- 不得跳过或忽略任何一条检查
- 修复 linter 报错后也需重新执行上述检查

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

## 常见任务

### 添加新的 tRPC API

1. 在对应的子路由文件（`src/main/ipc/routers/<domain>-router.ts`）中添加 procedure；若为新领域，先在 `router.ts` 中注册子路由
2. 渲染端通过 `trpc.<domain>.<procedure>.query/mutate()` 调用
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

### 升级 officecli 版本

1. 修改 `package.json` 的 `officecliVersion` 字段为新版本号（如 `v1.0.144`）
2. 运行 `npm run download:officecli -- --force` 强制重新下载
3. 验证 `resources/binaries/officecli-{platform}-{arch}[.exe]` 存在且 `--version` 输出正确
4. 提交 `package.json` 和二进制文件

### 添加新的 officecli HostTool

1. 在 `src/main/host/host-tools.ts` 的 `registerDefaults()` 中用 `defineTool()` 注册（参考 `create_docx` / `append_xlsx_row`）
2. 如涉及 officecli 调用：使用 `execOfficeCli()`，捕获 `OfficeCliNotAvailableError` 并返回明确错误
3. 如涉及 xlsx 细粒度编辑：在 `src/main/document/xlsx-editor.ts` 添加 exceljs 操作，并在工具 handler 中调用 `requestFlush(path)` + `notifyFileChanged(path)` 保证数据一致性
4. 在 `tests/document-host-tools.test.ts` 添加测试，更新工具数量断言

# Rules
 - 原型HTML UI在docs/prototypes目录生成
