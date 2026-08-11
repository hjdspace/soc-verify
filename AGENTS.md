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

每次修改代码后，依次执行四条命令，全部通过才算完成：

```sh
npm run build        # 编译（main + preload + renderer）
npm run typecheck    # 类型检查（tsconfig.node + tsconfig.web）
npm run test         # Vitest 全部测试
npm run lint         # ESLint
```

任一失败则修复后重新执行全部四条。

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

## 架构参考

以下详情按需查阅源码或文档，不必每次加载：

- **officecli 集成**：[ADR 0015](./docs/adr/0015-officecli-integration.md) — Office 文档预览/创建/编辑，职责分层、二进制路径解析（三级回退）、xlsx flush 机制、错误降级
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
