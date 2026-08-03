# Issues: officecli 集成 — Tracer Bullet Vertical Slices

> **Parent PRD**: [docs/prd-officecli-integration.md](./prd-officecli-integration.md)
>
> **Parent ADR**: [docs/adr/0015-officecli-integration.md](./adr/0015-officecli-integration.md)
>
> **Glossary**: [docs/adr/glossary.md](./adr/glossary.md)
>
> 8 个垂直切片（tracer bullet），每个切片贯穿所有集成层（二进制 → 主进程服务 → tRPC API → 渲染端 UI → 测试），完成后可独立演示。
>
> Issues 按依赖顺序排列（blocker 在前）。
>
> **Triage label**: `ready-for-agent`

---

## Issue #1: 二进制打包与下载脚本 + 路径解析

### Parent

[PRD: officecli 集成](./prd-officecli-integration.md)

### Triage

`ready-for-agent`

### What to build

建立 officecli 集成的基础管道：下载脚本、二进制路径解析、package.json 构建钩子。移植 SpaceCode 的 `scripts/download-officecli.mjs`（194 行）到 soc-verify，从 GitHub Releases（`https://github.com/iOfficeAI/OfficeCLI/releases`）拉取固定版本到 `resources/binaries/`。下载脚本自动检测 `process.platform` 和 `process.arch`，下载对应平台二进制（如 `officecli-win-x64.exe`、`officecli-linux-x64`），已存在则跳过（除非 `--force`），下载完成后用 `spawnSync(targetPath, ['--version'])` 验证可执行。失败时不阻断构建，只打印警告。

新增 `src/main/officecli/binary.ts` 实现三级回退路径解析（参考 SpaceCode `officeCliService.ts` 第 92-127 行）：1）内置二进制（dev: `resources/binaries/`，pack: `process.resourcesPath/binaries/`）；2）用户级安装（`~/.officecli/bin/officecli`）；3）系统 PATH（仅开发模式）。仿照现有 `src/main/agent/paths.ts` 的 `resolveBunPath()` 实现风格，复用 `findInDir()`、`findInPath()`、`candidateNames()` 工具函数。

`package.json` 新增 `"download:officecli": "node scripts/download-officecli.mjs"` 独立命令和 `"prebuild:officecli": "node scripts/download-officecli.mjs"` 前置钩子（在 `package:win`/`linux`/`mac` 前执行）。固定 officecli 版本号（在 `package.json` 中新增 `officecliVersion` 字段或 `.officecli-version` 文件）。

端到端路径：开发者运行 `npm run download:officecli` → 脚本检测平台 → 从 GitHub Releases 下载固定版本到 `resources/binaries/officecli-{platform}-{arch}[.exe]` → 验证可执行 → 主进程 `resolveOfficecliPath()` 三级回退找到二进制。

### Acceptance criteria

- [ ] `scripts/download-officecli.mjs` 能从 GitHub Releases 下载固定版本 officecli 二进制到 `resources/binaries/`
- [ ] 下载脚本自动检测平台（win/linux/mac）和架构（x64/arm64），下载对应二进制
- [ ] 二进制已存在时跳过下载（除非 `--force`）
- [ ] 下载完成后用 `spawnSync(targetPath, ['--version'])` 验证可执行
- [ ] 下载失败时不阻断构建，只打印警告
- [ ] `package.json` 有 `download:officecli` 和 `prebuild:officecli` 脚本
- [ ] `package.json` 固定 officecli 版本号
- [ ] `src/main/officecli/binary.ts` 实现 `resolveOfficecliPath()` 三级回退
- [ ] 路径解析在开发模式（`resources/binaries/`）和生产模式（`process.resourcesPath/binaries/`）都能正确找到二进制
- [ ] `tests/officecli/binary.test.ts` 覆盖三级回退路径解析
- [ ] `npm run build && npm run typecheck && npm run test` 全部通过

### Blocked by

None — can start immediately.

---

## Issue #2: officecli 主进程服务 + tRPC document router（最小预览闭环）

### Parent

[PRD: officecli 集成](./prd-officecli-integration.md)

### Triage

`ready-for-agent`

### What to build

实现 officecli 子进程封装和 tRPC document router，建立最小预览闭环。新增 `src/main/officecli/executor.ts` 封装子进程调用：使用 `child_process.spawn`（非 exec），`shell: false` 避免 shell 注入；默认超时 30 秒，超时触发跨平台进程树 kill（Windows 用 `taskkill /T /F`，Unix 用进程组 SIGTERM）；stdout/stderr 累积为字符串返回；提供 `OfficeCliExecOptions`（args、cwd、timeout、env）和 `OfficeCliExecResult`（exitCode、stdout、stderr、duration）类型。

新增 `src/main/officecli/service.ts` 实现高级 API：`viewHtml(filePath, outputDir?)` 调用 `officecli view <file> html [-o <dir>]`；`viewScreenshot(filePath, outputDir, page?)` 调用 `officecli view <file> screenshot -o <file> [--page N]`；`watchStart(filePath, port?)` 调用 `officecli watch <file> [--port N]`，从 stdout 正则提取端口，维护 `watchProcesses: Map<string, OfficeCliWatchHandle>`；`watchStop(watchId)`、`watchStopAll()`、`cleanupOfficeCli()`；`readImageAsDataURL(filePath)` 主进程读图为 base64；`checkInstalled()` 检查二进制可用性；`getVersion()` 调用 `officecli --version`。

新增 `src/main/ipc/routers/document-router.ts`，在 `src/main/ipc/router.ts` 中注册为 `document: documentRouter`。procedure 包括：`document.viewHtml`、`document.viewScreenshot`、`document.watchStart`、`document.watchStop`、`document.readImageAsDataURL`、`document.checkInstalled`、`document.getVersion`。使用 inline input validator（非 zod），复用 router-context.ts 的 `t`、`TRPCError`。

officecli 不可用时 procedure 返回明确的 `OfficeCLI not available` 错误（TRPCError INTERNAL_SERVER_ERROR with cause），不抛未捕获异常。

端到端路径：tRPC `document.checkInstalled` → 主进程 `resolveOfficecliPath()` + `fs.existsSync` → 返回 boolean。tRPC `document.viewHtml(filePath)` → 主进程 `service.viewHtml()` → `executor.execOfficeCli({args: ['view', filePath, 'html']})` → 返回 HTML 文件路径。

### Acceptance criteria

- [ ] `src/main/officecli/executor.ts` 封装 spawn 子进程调用，支持超时和进程树 kill
- [ ] `src/main/officecli/service.ts` 实现 viewHtml/viewScreenshot/watchStart/watchStop/readImageAsDataURL/checkInstalled/getVersion
- [ ] Watch 进程在 `watchProcesses` Map 中追踪，`cleanupOfficeCli()` 能清理所有 watch 进程
- [ ] `src/main/ipc/routers/document-router.ts` 注册所有 procedure
- [ ] `src/main/ipc/router.ts` 注册 `document: documentRouter`
- [ ] officecli 不可用时 procedure 返回明确错误，不崩溃
- [ ] 跨平台进程树 kill：Windows 用 `taskkill /T /F`，Unix 用进程组 SIGTERM
- [ ] `tests/document-router.test.ts` 端到端测试 tRPC procedure（mock `child_process.spawn` 返回固定 stdout）
- [ ] 测试覆盖：viewHtml 成功/失败、watchStart 端口提取、checkInstalled true/false、officecli 不可用降级
- [ ] `npm run build && npm run typecheck && npm run test` 全部通过

### Blocked by

- Issue #1

---

## Issue #3: 前端 HTML/Screenshots/Watch 预览组件 + CenterArea 集成

### Parent

[PRD: officecli 集成](./prd-officecli-integration.md)

### Triage

`ready-for-agent`

### What to build

实现前端预览组件并在 CenterArea 集成。新增 `src/renderer/src/components/office/OfficeDocumentView.tsx` 容器组件，根据 destination 的 mode 和 previewMode 分发到子组件。新增 `HtmlPreview.tsx`（webview 加载 `file://` URL，`partition="persist:office-preview"`，加载完成后注入 CSS 让内容铺满视口）、`ScreenshotsPreview.tsx`（调用 `document.viewScreenshot` 获取 PNG 路径，再调用 `document.readImageAsDataURL` 转 base64，`<img>` 展示，支持点击放大）、`WatchPreview.tsx`（调用 `document.watchStart` 获取 `{id, url}`，webview 加载 `http://localhost:PORT`，卸载时调用 `document.watchStop`）。

在 BrowserWindow 配置中启用 `webviewTag: true`（修改 `src/main/index.ts`）。不修改 index.html 的 CSP（`default-src 'self'`）——webview 是独立进程，不受渲染进程 CSP 限制。

在 workbench store（`src/renderer/src/stores/workbench.ts` 或等效文件）的 destination 联合类型中新增 `OfficeDocumentDestination`：`{ type: 'office-document', filePath: string, mode: 'preview' | 'edit', previewMode?: 'html' | 'screenshots' | 'watch' }`。在 `CenterArea.tsx` 渲染分发中新增分支，复用现有 tab 机制（图标 + 标题 + 关闭按钮，图标用 `lucide-react` 的 `FileText`/`FileType`）。

文件扩展名自动判断默认模式：.xlsx → edit（本期仅占位，编辑能力在 Issue #5 实现），.docx/.pptx → preview（previewMode 默认 html），.pdf → preview（用 react-pdf，在 Issue #4 实现，本期显示"PDF 预览即将支持"占位）。预览模式切换栏（HTML/Screenshots/Watch 按钮组）仅对 .docx/.pptx 显示。

officecli 不可用时（`document.checkInstalled` 返回 false）预览面板显示"officecli 未安装"提示 + 下载按钮（仅开发模式可见，调用 `document.downloadBinary`，本期可简化为提示手动运行 `npm run download:officecli`）。

端到端路径：用户在文件树点击 .docx 文件 → workbench store 打开 `{type: 'office-document', filePath, mode: 'preview', previewMode: 'html'}` destination → CenterArea 渲染 OfficeDocumentView → HtmlPreview 调用 `document.viewHtml(filePath)` → webview 加载返回的 HTML 文件路径。

### Acceptance criteria

- [ ] `src/renderer/src/components/office/OfficeDocumentView.tsx` 根据 mode/previewMode 分发到子组件
- [ ] `HtmlPreview.tsx` 用 webview 加载 file:// URL，partition 隔离
- [ ] `ScreenshotsPreview.tsx` 用 img 展示 base64 data URL，支持点击放大
- [ ] `WatchPreview.tsx` 用 webview 加载 http://localhost:PORT，卸载时停止 watch
- [ ] BrowserWindow 配置启用 `webviewTag: true`
- [ ] workbench store 的 destination 联合类型新增 `office-document`
- [ ] CenterArea.tsx 新增 `office-document` 渲染分支
- [ ] 文件扩展名自动判断默认模式（.xlsx → edit，.docx/.pptx → preview html，.pdf → 占位）
- [ ] 预览模式切换栏仅对 .docx/.pptx 显示
- [ ] officecli 不可用时显示提示 + 下载按钮（仅开发模式）
- [ ] tab 有清晰图标和标题
- [ ] `tests/components/OfficeDocumentView.test.tsx` 测试容器组件分发
- [ ] `tests/components/HtmlPreview.test.tsx` 测试 webview 预览渲染
- [ ] `npm run build && npm run typecheck && npm run test` 全部通过

### Blocked by

- Issue #2

---

## Issue #4: PDF 预览（react-pdf）

### Parent

[PRD: officecli 集成](./prd-officecli-integration.md)

### Triage

`ready-for-agent`

### What to build

实现 PDF 预览能力，替换 Issue #3 的占位。安装 `react-pdf` 和 `pdfjs-dist`。新增 `src/renderer/src/components/office/PdfPreview.tsx`，使用 `<Document><Page />` 组件渲染 PDF。worker 本地加载（不走 CDN，符合内网约束），通过 `options.workerSrc` 指向 `node_modules/pdfjs-dist/build/pdf.worker.min.mjs`（构建时需确保 worker 文件被复制到输出目录，可能需要调整 electron.vite.config.ts 的静态资源处理）。

PdfPreview 支持缩放（zoom in/out 按钮 + 适应宽度）、翻页（上一页/下一页 + 页码显示）、加载状态（loading spinner）、错误状态（PDF 解析失败时显示提示）。PDF 文件路径通过 destination 的 filePath 传递，PdfPreview 直接读取 file:// URL（react-pdf 支持 `{ file: 'file:///path/to/file.pdf' }`）。

在 OfficeDocumentView 中，当文件扩展名为 .pdf 时分发到 PdfPreview（而非 webview 预览）。PDF 不显示预览模式切换栏（只用 react-pdf）。

验证 react-pdf 与 React 19 的兼容性。若不兼容，回退到 webview 加载 PDF（Electron 原生 PDF 查看器），并在 ADR 0015 中记录决策变更。

端到端路径：用户点击 .pdf 文件 → workbench store 打开 `{type: 'office-document', filePath, mode: 'preview'}` destination → CenterArea 渲染 OfficeDocumentView → PdfPreview 用 react-pdf 渲染 PDF。

### Acceptance criteria

- [ ] 安装 `react-pdf` 和 `pdfjs-dist` 依赖
- [ ] `src/renderer/src/components/office/PdfPreview.tsx` 用 react-pdf 渲染 PDF
- [ ] worker 本地加载（不走 CDN），路径正确
- [ ] 支持缩放（zoom in/out + 适应宽度）
- [ ] 支持翻页（上一页/下一页 + 页码显示）
- [ ] 加载状态显示 spinner
- [ ] 错误状态显示提示
- [ ] OfficeDocumentView 对 .pdf 文件分发到 PdfPreview
- [ ] PDF 不显示预览模式切换栏
- [ ] react-pdf 与 React 19 兼容（若不兼容，回退到 webview 并记录决策变更）
- [ ] `tests/components/PdfPreview.test.tsx` 测试渲染和交互
- [ ] `npm run build && npm run typecheck && npm run test` 全部通过

### Blocked by

- Issue #3

---

## Issue #5: xlsx 原地编辑（Fortune-sheet + exceljs + 自动保存）

### Parent

[PRD: officecli 集成](./prd-officecli-integration.md)

### Triage

`ready-for-agent`

### What to build

实现 xlsx 原地编辑能力。安装 `@fortune-sheet/react`、`@fortune-sheet/core`、`exceljs`。新增 `src/renderer/src/components/office/XlsxEditor.tsx`，用 Fortune-sheet 渲染电子表格。新增 `src/main/document/fortune-sheet-bridge.ts` 实现 Fortune-sheet 数据模型与 exceljs 工作簿的双向转换：`fortuneToExcel(workbookData)` 将 Fortune-sheet 的 JSON 数据转为 exceljs Workbook；`excelToFortune(workbook)` 将 exceljs Workbook 转为 Fortune-sheet 数据。

新增 `document.loadXlsx(filePath)` tRPC procedure：主进程用 exceljs 读取 xlsx 文件，通过 `fortune-sheet-bridge` 转为 Fortune-sheet 数据格式返回。新增 `document.saveXlsx(filePath, workbookData)` tRPC procedure：主进程接收 Fortune-sheet 数据，通过 `fortune-sheet-bridge` 转为 exceljs Workbook，写回 xlsx 文件。

自动保存机制：XlsxEditor 的 Fortune-sheet `onChange` 回调防抖 2 秒后，调用 `document.saveXlsx` 将当前工作簿数据写回文件。保存状态指示器（"保存中..."/"已保存"）。用户无感知，不会丢数据。

在 OfficeDocumentView 中，当 destination.mode === 'edit' 时分发到 XlsxEditor。用户可在预览和编辑模式间手动切换（工具栏按钮）。.xlsx 默认进入 edit 模式。

officecli 创建的 xlsx 可能包含特有样式/图表，exceljs 读取时尽量保留（图表可能丢失，在 SKILL.md 中提示 AI）。

端到端路径：用户点击 .xlsx 文件 → workbench store 打开 `{type: 'office-document', filePath, mode: 'edit'}` destination → CenterArea 渲染 OfficeDocumentView → XlsxEditor 调用 `document.loadXlsx(filePath)` → 主进程 exceljs 读取 + bridge 转换 → 返回 Fortune-sheet 数据 → 渲染编辑器 → 用户编辑 → 防抖 2 秒 → `document.saveXlsx` 写回文件。

### Acceptance criteria

- [ ] 安装 `@fortune-sheet/react`、`@fortune-sheet/core`、`exceljs` 依赖
- [ ] `src/renderer/src/components/office/XlsxEditor.tsx` 用 Fortune-sheet 渲染电子表格
- [ ] `src/main/document/fortune-sheet-bridge.ts` 实现 Fortune-sheet ↔ exceljs 双向转换
- [ ] `document.loadXlsx` tRPC procedure 用 exceljs 读取 + bridge 转换
- [ ] `document.saveXlsx` tRPC procedure 用 bridge 转换 + exceljs 写回
- [ ] 自动保存防抖 2 秒，用户无感知
- [ ] 保存状态指示器（"保存中..."/"已保存"）
- [ ] OfficeDocumentView 对 mode === 'edit' 分发到 XlsxEditor
- [ ] .xlsx 默认进入 edit 模式
- [ ] 用户可在预览/编辑模式间手动切换
- [ ] Fortune-sheet 支持公式、条件格式、合并单元格
- [ ] `tests/xlsx-editor.test.ts` 测试 exceljs 读写（真实文件）
- [ ] `tests/document-router.test.ts` 新增 loadXlsx/saveXlsx 测试
- [ ] `tests/components/XlsxEditor.test.tsx` 测试 Fortune-sheet 渲染与交互
- [ ] `npm run build && npm run typecheck && npm run test` 全部通过

### Blocked by

- Issue #3

---

## Issue #6: AI 创建文档（HostTools create_* 系列 + SKILL.md + PATH 注入）

### Parent

[PRD: officecli 集成](./prd-officecli-integration.md)

### Triage

`ready-for-agent`

### What to build

实现 AI 创建文档能力。在 `src/main/host/host-tools.ts` 中通过 `registerCustom()` 注册 5 个创建/读取工具：`create_docx`、`create_xlsx`、`create_pptx`、`create_pdf`、`read_document`。工具参数格式：create_docx/create_pdf 接收 Markdown 字符串 content；create_xlsx 接收 `{name, data}` 二维数组 sheets；create_pptx 接收 `{title, content}` slides；read_document 接收 path 返回结构化内容。

create_* 系列默认输出到 `<project>/docs/`，AI 可通过 outputPath 参数指定其他路径。若 `<project>/docs/` 不存在，主进程自动创建。工具调用 officecli CLI 生成文件（如 `officecli create docx --content ... --output ...`，具体命令需查阅 officecli 文档）。

新增 `src/main/agent/officecli-paths.ts` 或在 `session-manager.ts` 中实现 PATH 注入：启动 omp 子进程前，同步复制 `resources/binaries/officecli-{platform}-{arch}[.exe]` 到 `~/.officecli/bin/officecli[.exe]`（若已存在则跳过，非 Windows chmod 0o755），将 `~/.officecli/bin` 注入到 omp 子进程 `env.PATH` 前面。参考 SpaceCode `sessionProcess.ts` 第 1362-1398 行。

新增 4 个 SKILL.md 技能文档到 `resources/built-in-extension/skills/`：`officecli-docx/SKILL.md`、`officecli-xlsx/SKILL.md`、`officecli-pptx/SKILL.md`、`officecli-pdf/SKILL.md`。内容参考 SpaceCode `skills-lib/{docx,pptx,xlsx,pdf}/SKILL.md`，调整为 SoC 验证场景（如验证计划表模板、覆盖率报告模板、回归报告模板、TO 检查清单模板）。SKILL.md 中提示：officecli 创建的 xlsx 可能包含特有样式/图表，exceljs 修改时图表可能丢失。

端到端路径：AI Agent 调用 `create_docx(content: "# 验证计划\n...", outputPath?: "docs/verify-plan.docx")` HostTool → 主进程调用 officecli CLI 生成文件 → 返回文件路径 → AI 在会话中展示路径 → 用户点击路径在中栏打开预览。

### Acceptance criteria

- [ ] `src/main/host/host-tools.ts` 注册 create_docx/create_xlsx/create_pptx/create_pdf/read_document 5 个工具
- [ ] 工具参数格式正确（Markdown/二维数组）
- [ ] create_* 默认输出到 `<project>/docs/`，自动创建目录
- [ ] AI 可通过 outputPath 参数指定其他路径
- [ ] read_document 返回结构化内容
- [ ] PATH 注入：omp 子进程启动前同步复制二进制到 `~/.officecli/bin/`
- [ ] PATH 注入：`~/.officecli/bin` 注入到 omp 子进程 env.PATH 前面
- [ ] 4 个 SKILL.md 文档创建到 `resources/built-in-extension/skills/officecli-{docx,xlsx,pptx,pdf}/`
- [ ] SKILL.md 内容适配 SoC 验证场景
- [ ] SKILL.md 提示 officecli 创建的 xlsx 图表可能在 exceljs 修改时丢失
- [ ] `tests/document-host-tools.test.ts` 测试工具注册与调用（mock officecli）
- [ ] 测试覆盖：create_docx 成功/失败、create_xlsx 二维数组、read_document、默认输出路径、自定义 outputPath
- [ ] `npm run build && npm run typecheck && npm run test` 全部通过

### Blocked by

- Issue #2

---

## Issue #7: AI 编辑 xlsx + flush 机制 + 文件变更同步

### Parent

[PRD: officecli 集成](./prd-officecli-integration.md)

### Triage

`ready-for-agent`

### What to build

实现 AI 编辑 xlsx 的细粒度工具和前端同步机制。在 `src/main/host/host-tools.ts` 注册 2 个细粒度编辑工具：`append_xlsx_row(path, sheet, rows)` 和 `update_xlsx_cell(path, sheet, row, col, value)`。新增 `src/main/document/xlsx-editor.ts` 用 exceljs 实现细粒度编辑：`appendRows(filePath, sheetName, rows)` 读取 xlsx、追加行、写回；`updateCell(filePath, sheetName, row, col, value)` 读取 xlsx、更新单元格、写回。

flush 机制：主进程维护 `documentEditors: Map<string, BrowserWindow>` 追踪哪些文件在前端被编辑。AI 调用 append_xlsx_row/update_xlsx_cell 前，主进程检查目标文件是否在前端编辑中。若是，通过 IPC 事件 `document:flush-request(path)` 通知渲染端立即 flush Fortune-sheet 状态。渲染端 flush 完成后回复 `document:flush-done(path)`。主进程收到回复（或 3 秒超时）后继续执行 AI 修改。超时后强制继续，记录警告日志。

前端 flush 实现：XlsxEditor 监听 `document:flush-request` IPC 事件，立即触发 Fortune-sheet 防抖（取消待执行的防抖定时器，立即执行保存），通过 `document.saveXlsx` 写回文件后回复 `document:flush-done`。

文件变更同步：AI 修改文件后，主进程通过 IPC 事件 `document:file-changed(path)` 通知所有 BrowserWindow。渲染端收到事件后，若该文件在当前打开的 destination 中，触发重载（XlsxEditor 重新调用 `document.loadXlsx` 加载文件）。不引入 chokidar，不感知外部工具修改。

在 XlsxEditor 中注册/注销 documentEditors 追踪：组件 mount 时通过 tRPC `document.registerEditor(filePath)` 注册，unmount 时 `document.unregisterEditor(filePath)` 注销。

端到端路径：AI 调用 `append_xlsx_row(path, sheet, rows)` → 主进程检查 path 在 documentEditors 中 → 发 `document:flush-request` → 渲染端立即保存 → 回复 `document:flush-done` → 主进程用 exceljs 追加行 → 发 `document:file-changed` → 渲染端重载 Fortune-sheet。

### Acceptance criteria

- [ ] `src/main/host/host-tools.ts` 注册 append_xlsx_row/update_xlsx_cell 2 个工具
- [ ] `src/main/document/xlsx-editor.ts` 用 exceljs 实现细粒度编辑
- [ ] 主进程维护 `documentEditors: Map<string, BrowserWindow>` 追踪前端编辑状态
- [ ] `document.registerEditor`/`document.unregisterEditor` tRPC procedure
- [ ] XlsxEditor mount/unmount 时注册/注销
- [ ] AI 调用细粒度编辑工具前检查 documentEditors
- [ ] 若文件在前端编辑中，发 `document:flush-request` IPC 事件
- [ ] XlsxEditor 监听 flush-request，立即触发保存
- [ ] 渲染端 flush 完成后回复 `document:flush-done`
- [ ] 3 秒超时后强制继续，记录警告日志
- [ ] AI 修改后发 `document:file-changed` IPC 事件
- [ ] XlsxEditor 监听 file-changed，重新加载文件
- [ ] 不引入 chokidar
- [ ] `tests/document-flush.test.ts` 测试 flush 机制（前端编辑状态、AI 修改、超时）
- [ ] `tests/xlsx-editor.test.ts` 新增 appendRows/updateCell 测试（真实文件）
- [ ] `tests/document-host-tools.test.ts` 新增 append_xlsx_row/update_xlsx_cell 测试
- [ ] `npm run build && npm run typecheck && npm run test` 全部通过

### Blocked by

- Issue #5, Issue #6

---

## Issue #8: 错误降级完善 + 应用生命周期集成 + 文档完善

### Parent

[PRD: officecli 集成](./prd-officecli-integration.md)

### Triage

`ready-for-agent`

### What to build

完善错误降级、应用生命周期集成和文档。在 `src/main/index.ts` 中：应用启动时注册 officecli IPC handlers（document router 已通过 tRPC 暴露，flush/file-changed 事件用原生 `ipcMain.on`/`ipcRenderer.send`，需在 preload 中暴露 `officecli:flush-request`/`officecli:flush-done`/`officecli:file-changed` 事件监听器）；应用退出时（`before-quit` 事件）调用 `cleanupOfficeCli()` 清理所有 watch 进程。

错误降级完善：officecli 不可用时，所有 create_* HostTools 返回明确的 `OfficeCLI not available` 错误（AgentToolResult content 中包含错误信息），AI 可据此告知用户。预览组件显示"officecli 未安装"提示 + 下载按钮（仅开发模式可见，调用 `document.downloadBinary`）。Fortune-sheet 编辑不依赖 officecli，仍可用（exceljs 纯 Node 实现）。

`document.downloadBinary` tRPC procedure 实现：仅开发模式可用，调用下载脚本逻辑（或直接 `spawnSync('node', ['scripts/download-officecli.mjs'])`），返回 `{ success, path?, error? }`。生产模式返回错误"请通过应用安装包获取 officecli"。

下载进度反馈（可选）：开发模式下载时通过 IPC 事件 `officecli:download-progress` 推送进度（stage、message、percent），前端显示进度条。

文档完善：更新 AGENTS.md 中 officecli 集成相关章节（如新增 officecli 服务到项目结构说明、新增 officecli 相关开发命令）。更新 ADR 0015 的实现状态。确保所有 SKILL.md 文档完整准确。

端到端路径：应用启动 → 注册 IPC → 用户使用 officecli 功能 → 应用退出 → cleanupOfficeCli 清理 watch 进程。officecli 不可用时 → 预览显示提示 → AI 工具返回错误 → Fortune-sheet 编辑仍可用。

### Acceptance criteria

- [ ] `src/main/index.ts` 注册 officecli 相关 IPC handlers
- [ ] preload 暴露 `officecli:flush-request`/`officecli:flush-done`/`officecli:file-changed` 事件监听器
- [ ] 应用退出时（`before-quit`）调用 `cleanupOfficeCli()` 清理 watch 进程
- [ ] officecli 不可用时 create_* HostTools 返回明确错误
- [ ] officecli 不可用时预览组件显示提示 + 下载按钮（仅开发模式）
- [ ] Fortune-sheet 编辑不依赖 officecli，officecli 不可用时仍可用
- [ ] `document.downloadBinary` tRPC procedure 实现（仅开发模式）
- [ ] 生产模式 downloadBinary 返回明确错误
- [ ] 下载进度反馈（可选，IPC 事件推送）
- [ ] AGENTS.md 更新 officecli 集成相关章节
- [ ] ADR 0015 更新实现状态
- [ ] SKILL.md 文档完整准确
- [ ] `tests/document-router.test.ts` 新增 downloadBinary 测试
- [ ] `tests/document-router.test.ts` 新增 officecli 不可用降级测试
- [ ] `npm run build && npm run typecheck && npm run test` 全部通过

### Blocked by

- Issue #7

---

## 依赖关系图

```
Issue #1 (二进制打包)
  └─→ Issue #2 (主进程服务 + router)
        ├─→ Issue #3 (前端预览 + CenterArea)
        │     ├─→ Issue #4 (PDF 预览)
        │     └─→ Issue #5 (xlsx 编辑)
        │           └─→ Issue #7 (AI 编辑 + flush) ←─ Issue #6 (AI 创建)
        │                                      └─→ Issue #8 (降级 + 生命周期)
        └─→ Issue #6 (AI 创建 + SKILL.md + PATH 注入)
```

## 实施顺序建议

1. **Issue #1**（无依赖，可立即开始）
2. **Issue #2**（依赖 #1）
3. **Issue #3 + Issue #6** 可并行（都依赖 #2）
4. **Issue #4 + Issue #5** 可并行（都依赖 #3）
5. **Issue #7**（依赖 #5 + #6）
6. **Issue #8**（依赖 #7）

每个 issue 完成后必须执行 `npm run build && npm run typecheck && npm run test` 三条命令全部通过（AGENTS.md 要求）。
