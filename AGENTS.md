# AGENTS.md — SoC Verify 项目指南

**SoC Verify** — AI Agent 驱动的 SoC 验证一站式管理平台（Electron 桌面应用）。核心 AI 能力由 [oh-my-pi (omp)](./engine/oh-my-pi/) 提供（git submodule，不修改其源码）。

## 三进程模型

`electron.vite.config.ts` 分别构建三个进程：

| 进程 | 源码 | 输出 | 职责 |
|------|------|------|------|
| 主进程 | `src/main/` | CJS | 窗口管理、omp 子进程、tRPC router、原生 IPC |
| Preload | `src/preload/` | CJS | `contextBridge` 暴露 `electron-trpc` + `windowControls` + `eventBridge` |
| 渲染进程 | `src/renderer/` | ESM | React SPA，tRPC proxy 调用主进程 API |

业务 API 通过 tRPC router 暴露（`src/main/ipc/router.ts`，按领域拆分到 `src/main/ipc/routers/`）。事件流式通知通过原生 IPC（通道名见 `src/preload/index.ts` 的 `eventBridge`）。

## 修改后验证检查

每次修改代码后，执行**增量验证**，通过即可提交，无需跑全量测试：

```sh
npm run typecheck                 # 类型检查（tsconfig.node + tsconfig.web）
npm run lint                      # ESLint
npx vitest run tests/<相关目录>     # 仅运行改动相关的测试目录
```

- 测试范围按改动确定：改 `src/main/coverage/` → 跑 `tests/coverage/`；改 `src/renderer/src/components/coverage/` → 跑 `tests/ui/coverage*.test.tsx`，以此类推。
- 无测试文件的改动可跳过测试步骤，仅跑 typecheck + lint。
- 任一失败则修复后重新执行这三条。
- 提交前不再重复执行验证（修改时已验证通过）。

## 编码规范

- TypeScript strict，不用 `any`（除非有注释说明）
- 优先 `type` 而非 `interface`；函数式风格优先
- 文件命名：kebab-case（非组件）/ PascalCase（React 组件）
- Zustand 选择器：`useStore((s) => s.field)`
- 样式：Tailwind v4 + `cn()`；语义色用 CSS 变量（HSL），不直接用 hex
- 主进程：ESM 源码 → CJS 输出；tRPC procedure 用 inline validator（非 zod）
- 测试：Vitest；描述行为意图；核心覆盖率 > 80%，UI > 60%

## 硬约束

1. **不修改 omp 引擎源码**（`engine/oh-my-pi/` 是 git submodule，只用 RPC API）
2. **单用户桌面应用**（无 Web/移动端/多用户协作）
3. **EDA 工具集成由插件实现**（平台只提供接口和框架）
4. **Electron 主进程 ESM**（`"type": "module"`，`lib: ["ES2024"]`）
5. **electron-trpc 0.7.1 CJS 输出**（绕过 ESM 不兼容）
6. **CSP**：`index.html` 中 `default-src 'self'`

## 仿真状态判定（PASS/FAIL）

仿真 PASS/FAIL 判定有两条核心原则：

### 1. 退出码 ≠ 仿真状态

进程退出码为 0 只代表 `runsim` 脚本正常返回，**不等于仿真 PASS**。仿真可能失败但脚本仍 return 0（如 UVM objection 未设置、assert 失败但未触发 `$fatal`）。因此判定优先级为：

1. **`checkSimulationStatus()`** — 检查日志目录下 `sprd_log_pass.log` / `sprd_log_fail.log` 标志文件（最可靠）
2. **日志内容关键词匹配** — 匹配 `TEST PASSED` / `SPRD_PASSED` / `TEST FAILED` / `SPRD_FAILED` 等
3. **退出码** — 仅当以上都无法判定时，退出码 0 → `error`（不判 pass），非 0 → `fail`

### 2. 仿真日志目录不是 `cwd/log`

`cwd` 是**验证环境目录**（`$PROJ_ENV`，即 dv 代码树，如 `/proj/<ProjectName>/gitview/<用户名>/view/dv`），仿真产物实际在**仿真工作目录**（`$PROJ_WORK/<case_dir>/log/`，如 `/proj/<ProjectName>/gitview/<用户名>/view/work/<case_dir>/log/`）下。

关键环境变量：
- `$PROJ_DIR` — 项目根目录（如 `/proj/<ProjectName>/gitview/<用户名>/view`）
- `$PROJ_ENV` — 验证环境目录（dv 代码树，`$PROJ_DIR/dv`）
- `$PROJ_RTL` — 设计源码目录（de 代码树，`$PROJ_DIR/de`）
- `$PROJ_WORK` — 仿真工作目录（`$PROJ_DIR/work`）

解析日志路径必须用 `SimArtifactResolver`（`src/main/simulation/sim-artifact-resolver.ts`），其优先级为：命令 `cd` 前缀 → `$PROJ_WORK` → `cwd`。**不要**直接用 `join(cwd, 'log')`。

> **教训**：曾经把 `sim-terminal-linker.ts` 的 `resolveLogDir` 写成 `join(cwd, 'log')`，导致终端仿真完成后找不到 `sprd_log_pass.log`/`sprd_log_fail.log`，回退到退出码 0 误判为 PASS。修复方式是调用 `resolveSimArtifacts()` 获取正确的 `simLogPath`。
>
> **教训**：插件 `unisoc-simulation-runner` 的 `resolveCwd` 曾用 `$PROJ_ENV/work/{case_name}` 作为仿真目录，但 `$PROJ_ENV/work` 不一定等于 `$PROJ_WORK`（两者可能指向不同路径）。修复为直接使用 `$PROJ_WORK/{case_name}`。

## 架构参考

以下详情按需查阅源码或文档，不必每次加载：

- **officecli 集成**：[ADR 0015](./docs/adr/0015-officecli-integration.md) — Office 文档预览/创建/编辑，职责分层、二进制路径解析（三级回退）、xlsx flush 机制、错误降级
- **App Shell（Mission Control 布局）**：`src/renderer/src/components/layout/AppShell.tsx` — TitleBar + (NavRail | (ViewContainer + BottomPanel)) + StatusBar；五视图路由（总览/仿真/覆盖率/回归/workspace，`ui.activeView`，刷新持久化）；文件树/AI 会话为可呼出抽屉（FileDrawer/AiDrawer，切换视图自动关闭）；命令面板 Ctrl+K/Ctrl+P（分组：导航/动作/面板）；通知中心走 `webContents.send` + `eventBridge`。LeftRail 已退役，文件树/子系统在左抽屉，插件视图在 workspace
- **omp Host Tools**：`src/main/omp/host-tools.ts` — 7 默认验证工具 + 条件注册（coverage/case-stats）+ 7 文档工具
- **omp URI scheme**：`src/main/omp/host-uris.ts` — `case:///` / `log:///` / `cov:///`
- **插件系统**：`src/shared/plugin-types.ts` — 5 种 `PluginKind` 接口契约
- **主题系统**：`src/renderer/src/styles/globals.css` + `src/renderer/src/stores/theme.ts`
- **officecli 下载**：`npm run download:officecli`，版本固定在 `package.json` 的 `officecliVersion`；下载失败不阻断构建，运行时降级

## 常见任务

### 添加 tRPC API

`src/main/ipc/routers/<domain>-router.ts` 添加 procedure（新领域先在 `router.ts` 注册子路由）。渲染端 `trpc.<domain>.<procedure>.query/mutate()`，类型自动推导。

### 添加主题

`globals.css` 加 `[data-theme="<id>"]` block → `theme.ts` 的 `THEMES` 加 `ThemeDefinition`。

### 添加 officecli HostTool

`host-tools.ts` 的 `registerDefaults()` 中 `defineTool()` 注册。officecli 调用用 `execOfficeCli()` 捕获 `OfficeCliNotAvailableError`；xlsx 编辑在 `xlsx-editor.ts` 添加，handler 中调 `requestFlush(path)` + `notifyFileChanged(path)`。在 `tests/document-host-tools.test.ts` 添加测试并更新工具数量断言。

### 升级 officecli

改 `package.json` 的 `officecliVersion` → `npm run download:officecli -- --force` → 验证二进制 `--version` → 提交。

# Rules
 - 原型HTML UI在docs/prototypes目录生成
