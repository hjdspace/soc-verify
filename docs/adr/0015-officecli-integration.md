# ADR 0015: officecli 集成——Office 文档预览、编辑与 AI 生成

## 状态

Implemented（8 个 Issue 全部交付）

> 实施记录见 [docs/issues-officecli-integration.md](../issues-officecli-integration.md)，覆盖 Issue #1 ~ #8 的完整垂直切片。
>
> 已交付能力：
> - **Issue #1**：二进制打包与下载脚本 + 路径解析（`scripts/download-officecli.mjs` + `src/main/officecli/binary.ts`）
> - **Issue #2**：officecli 主进程服务（`executor.ts` + `service.ts` + `types.ts`）+ tRPC document router
> - **Issue #3**：前端预览组件（`HtmlPreview` / `ScreenshotsPreview` / `WatchPreview` / `OfficeDocumentView`）
> - **Issue #4**：PDF 预览（`PdfPreview.tsx`，react-pdf）
> - **Issue #5**：xlsx 原地编辑（`XlsxEditor.tsx`，Fortune-sheet + exceljs + 自动保存）
> - **Issue #6**：AI 文档创建工具（`create_docx` / `create_xlsx` / `create_pptx` / `create_pdf` / `read_document`）+ SKILL.md
> - **Issue #7**：AI 编辑 xlsx（`append_xlsx_row` / `update_xlsx_cell`）+ flush 机制 + 文件变更同步
> - **Issue #8**：错误降级完善 + 应用生命周期集成（`cleanupOfficeCli` / `cleanupEditorRegistry`）+ `document.downloadBinary` + 文档完善

## 背景

SoC Verify 平台需要在验证周期内产出并消费多种 Office 文档：验证计划表（xlsx）、覆盖率报告（docx/pptx）、回归报告（xlsx）、TO 检查清单（xlsx）等。当前平台在这些维度完全空白：

- **文档处理**：`package.json` 无任何 Office 文档解析/生成库（xlsx、docx、pdfjs-dist 等）
- **文档预览**：`FileEditor` 仅支持文本 + Markdown/HTML 预览，无法预览 .docx/.xlsx/.pptx/.pdf
- **AI 文档能力**：HostToolsRegistry 注册的 7 个默认工具 + 6 个条件工具均与文档无关
- **二进制打包**：已有成熟模式（`resources/binaries/` + extraResources + asarUnpack + `agent/paths.ts` 双模式解析），可直接复用

参考实现为 SpaceCode（`D:\AI\SpaceCode`，Electron + Vue 3），其 officecli 集成已上线验证。但 soc-verify 与 SpaceCode 有三处关键差异：
1. **前端框架**：soc-verify 用 React 19，SpaceCode 用 Vue 3
2. **IPC**：soc-verify 用 electron-trpc 0.7.1（类型安全），SpaceCode 用原生 `ipcMain.handle`
3. **编辑需求**：soc-verify 需要 xlsx 原地编辑，SpaceCode 完全只读

此外，`engine/oh-my-pi` 子模块内部的 markit 转换器（xlsx.ts/docx.ts）受 AGENTS.md 约束 1「不修改 omp 引擎源码」限制，无法直接复用。

## 决策

经 7 轮 grilling 确认 28 项子决策，按 8 个主题组织如下。

### 主题 1：二进制打包与版本管理

**1.1 按平台打包当前平台二进制**

electron-builder 已按平台分别构建（`package:win`/`linux`/`mac`）。每次构建只含当前平台的 officecli 二进制（如 `officecli-win-x64.exe`、`officecli-linux-x64`），放入 `resources/binaries/`。现有 `electron-builder.yml` 的 `extraResources` 配置（`from: resources/binaries` + `filter: ["**/*", "!README.md"]`）和 `asarUnpack: resources/binaries/**` **无需修改**，新二进制自动跟随解包。

**1.2 固定版本**

在 `package.json` 或 `.officecli-version` 中固定 officecli 版本号，下载脚本拉取指定版本。升级需手动改版本号，保证构建可重现，避免上游破坏。

**1.3 移植 SpaceCode 下载脚本**

移植 `D:\AI\SpaceCode\scripts\download-officecli.mjs`（194 行）到 `d:\AI\soc-verify\scripts\download-officecli.mjs`，从 GitHub Releases（`https://github.com/iOfficeAI/OfficeCLI/releases`）拉取固定版本到 `resources/binaries/`。`package.json` 新增：
- `"download:officecli": "node scripts/download-officecli.mjs"` 独立命令
- `"prebuild:officecli": "node scripts/download-officecli.mjs"` 在 `package:win`/`linux`/`mac` 前置执行

下载失败时**不阻断构建**，只打印警告（与 SpaceCode 一致），运行时降级处理。支持 `--force` 重新下载。

### 主题 2：officecli 主进程服务

**2.1 独立目录 `src/main/officecli/`**

```
src/main/officecli/
├── binary.ts       # 二进制路径解析（仿 agent/paths.ts 的 resolveBunPath）
├── executor.ts     # 子进程封装（spawn + 超时 + 进程树 kill）
├── service.ts      # 高级 API：viewHtml/viewScreenshot/watchStart/watchStop
└── types.ts        # 类型定义
```

与 `src/main/agent/`、`src/main/host/` 同级。职责单一，易于测试。

**2.2 优雅降级 + 提示**

officecli 二进制不可用时：
- 预览面板显示「officecli 未安装」提示 + 下载按钮（仅开发模式可见，内网环境隐藏）
- AI 工具调用返回明确的 `OfficeCLI not available` 错误，AI 可据此告知用户
- **不崩溃**，用户仍可使用其他功能
- **Fortune-sheet 编辑不依赖 officecli**，xlsx 编辑仍可用（exceljs 纯 Node 实现）

### 主题 3：AI 调用链路（两者结合）

**3.1 HostTools 注册 + PATH 注入**

- **高频操作**走 HostTools 注册（类型安全、参数校验、统一错误处理）
- **低频/高级操作**走 PATH 注入 + omp 的 Bash 工具直接调用 `officecli xxx`

**3.2 HostTools 注册的工具**

通过 `HostToolsRegistry.registerCustom()` 注册以下工具（参考 `src/main/host/host-tools.ts` 第 706-708 行的公开 API）：

| 工具名 | 实现 | 参数 | 返回 |
| --- | --- | --- | --- |
| `create_docx` | officecli | `content: string`（Markdown）, `outputPath?: string` | 文件路径 |
| `create_xlsx` | officecli | `sheets: {name: string, data: any[][]}[]`, `outputPath?: string` | 文件路径 |
| `create_pptx` | officecli | `slides: {title: string, content: string}[]`, `outputPath?: string` | 文件路径 |
| `create_pdf` | officecli | `content: string`（Markdown）, `outputPath?: string` | 文件路径 |
| `read_document` | officecli | `path: string` | 结构化内容（文本/表格数据） |
| `append_xlsx_row` | exceljs | `path: string`, `sheet: string`, `rows: any[][]` | 修改后的行数 |
| `update_xlsx_cell` | exceljs | `path: string`, `sheet: string`, `row: number`, `col: number`, `value: any` | 修改后的值 |

`create_*` 系列默认输出到 `<project>/docs/`，AI 可通过 `outputPath` 参数指定其他路径。

**3.3 工具参数格式：Markdown / 二维数组**

- `create_docx` / `create_pdf`：`content` 为 Markdown 字符串，officecli 负责 Markdown → docx/pdf 转换
- `create_xlsx`：`sheets` 为 `{name, data}` 数组，`data` 为二维数组（行列）
- `create_pptx`：`slides` 为 `{title, content}` 数组，`content` 为 Markdown
- 与 officecli CLI 能力对齐，AI 易生成

**3.4 PATH 注入：复制到用户目录 + 注入 PATH**

参考 SpaceCode `electron/sessionProcess.ts` 第 1362-1398 行：
1. 启动 omp 子进程前，**同步**复制 `resources/binaries/officecli-{platform}-{arch}[.exe]` 到 `~/.officecli/bin/officecli[.exe]`
2. 若已存在则跳过，若平台非 Windows 则 `chmod 0o755`
3. 将 `~/.officecli/bin` 注入到 omp 子进程 `env.PATH` 前面
4. 确保第一次 Bash 工具调用前二进制已就位（同步复制，不依赖异步）

需在 soc-verify 的 `src/main/agent/session-manager.ts`（或等效文件）中找到 omp 子进程启动入口，注入 env。

**3.5 SKILL.md 内置 skills 目录**

在 `resources/built-in-extension/skills/` 下新增四个技能包（与现有 `soc-env-gen`、`soc-verify-plugin-development` 同级）：
- `officecli-docx/SKILL.md`
- `officecli-xlsx/SKILL.md`
- `officecli-pptx/SKILL.md`
- `officecli-pdf/SKILL.md`

内容参考 SpaceCode `skills-lib/{docx,pptx,xlsx,pdf}/SKILL.md`，但调整为 SoC 验证场景（如验证计划表模板、覆盖率报告模板、回归报告模板）。

### 主题 4：前端预览

**4.1 预览模式：HTML + Screenshots + Watch + PDF(pdfjs-dist)**

| 文件类型 | 默认模式 | 可选模式 |
| --- | --- | --- |
| `.docx` | HTML | HTML, Screenshots, Watch |
| `.pptx` | HTML | HTML, Screenshots, Watch |
| `.xlsx` | Edit（Fortune-sheet） | Edit, HTML, Screenshots |
| `.pdf` | pdfjs-dist | pdfjs-dist |

**4.2 预览容器：webview**

- 在 `BrowserWindow` 配置中启用 `webviewTag: true`
- webview 使用 `partition="persist:office-preview"` 隔离 cookie/storage
- **不修改 index.html 的 CSP**（`default-src 'self'`）——webview 是独立进程，不受渲染进程 CSP 限制
- HTML 模式：`webview src="file:///path/to/output.html"`
- Watch 模式：`webview src="http://localhost:PORT"`
- Screenshots 模式：`<img>` 标签（需 `readImageAsDataURL` 绕过 file:// CORS）

**4.3 PDF 预览：react-pdf**

- 使用 `react-pdf`（pdfjs-dist 的 React 封装，API 友好 `<Document><Page />`）
- worker 文件本地加载（不走 CDN，符合内网约束），通过 `options.workerSrc` 指向 `node_modules/pdfjs-dist/build/pdf.worker.min.mjs`
- 与 React 19 兼容性需在实施时验证

**4.4 Watch 模式仅用于 docx/pptx**

- xlsx 用 Fortune-sheet 编辑，不走 Watch
- PDF 用 react-pdf，不走 Watch
- docx/pptx 用 Watch 实现实时刷新（officecli `watch` 子命令启动本地 HTTP 服务器，默认端口 26315）
- Watch 进程生命周期管理：在 `officecli/service.ts` 中维护 `watchProcesses: Map<string, OfficeCliWatchHandle>`，应用退出时统一清理（参考 SpaceCode `cleanupOfficeCli`）

### 主题 5：xlsx 原地编辑

**5.1 仅 xlsx 原地编辑**

- xlsx：Fortune-sheet 原地编辑
- docx/pptx/pdf：纯只读预览（officecli 转 HTML/PNG）

**5.2 表格库：Fortune-sheet**

- Fortune-sheet 是 Luckysheet 的社区 fork，用 React + TypeScript 重写
- 与 soc-verify 的 React 19 + TS 7 技术栈契合
- 支持公式、图表、条件格式
- 安装 `@fortune-sheet/react` + `@fortune-sheet/core`

**5.3 xlsx 读写库：exceljs**

- Fortune-sheet 自身不直接读写 xlsx 文件，需搭配 exceljs
- exceljs 功能全面（样式、公式、图表、合并单元格、数据验证），与 Fortune-sheet 数据模型映射清晰
- 安装 `exceljs`

**5.4 自动保存（防抖）**

- Fortune-sheet 的 `onChange` 回调防抖（2 秒）后，渲染端用 exceljs 将工作簿数据序列化为 xlsx
- 通过 tRPC `document.saveXlsx` procedure 传递给主进程写回文件
- 用户无感知，不会丢数据

**5.5 职责边界：officecli 负责创建，exceljs 负责编辑**

- `create_xlsx`（HostTools）：officecli 生成新 xlsx 文件
- `append_xlsx_row` / `update_xlsx_cell`（HostTools）：exceljs 修改现有 xlsx 文件
- Fortune-sheet 持久化：exceljs 写回文件
- 注意：officecli 创建的 xlsx 可能包含 officecli 特有的样式/图表，exceljs 修改时需尽量保留（exceljs 对样式/公式的兼容性较好，图表可能丢失——在 SKILL.md 中提示 AI）

### 主题 6：CenterArea 集成

**6.1 新增 `office-document` destination 类型**

在 `useWorkbenchStore` 的 `destination` 联合类型中新增：

```typescript
type OfficeDocumentDestination = {
  type: 'office-document'
  filePath: string
  mode: 'preview' | 'edit'  // preview=webview/react-pdf, edit=Fortune-sheet
  previewMode?: 'html' | 'screenshots' | 'watch'  // 仅 preview 模式有效
}
```

文件扩展名自动判断：
- `.xlsx` → 默认 `mode: 'edit'`（用户可切换为 preview）
- `.docx`/`.pptx` → `mode: 'preview'`，`previewMode` 默认 'html'
- `.pdf` → `mode: 'preview'`，用 react-pdf 渲染（不走 previewMode）

在 `CenterArea.tsx` 渲染分发中新增分支，复用现有 tab 机制（图标 + 标题 + 关闭按钮）。

**6.2 文档存储位置：`<project>/docs/`**

- AI 通过 `create_*` 创建的文档默认存到 `<project>/docs/`
- 与 SoC 验证场景契合（验证计划、覆盖率报告属项目产物）
- AI 可通过 `outputPath` 参数指定其他路径
- 若 `<project>/docs/` 不存在，主进程自动创建

### 主题 7：文件变更同步

**7.1 AI 修改后重载文件**

AI 通过 HostTools 修改 xlsx 文件后，前端 Fortune-sheet 重新读取文件并重载。

**7.2 AI 修改前先 flush 前端**

AI 调用 `append_xlsx_row` / `update_xlsx_cell` 等 HostTools 前：
1. 主进程检查目标文件是否在前端被编辑（通过 `document.documentEditors: Map<string, BrowserWindow>` 追踪）
2. 若是，主进程通过 IPC 事件 `document:flush-request` 通知渲染端立即 flush Fortune-sheet 状态到文件
3. 渲染端 flush 完成后回复 `document:flush-done`
4. 主进程收到回复后继续执行 AI 修改
5. **3 秒超时**：超时后主进程直接进行修改（可能丢失前端未保存状态），并记录警告日志

**7.3 文件变更监听：主进程主动通知**

不引入 chokidar。AI 修改文件后：
1. 主进程通过 IPC 事件 `document:file-changed` 通知所有 BrowserWindow
2. 渲染端收到事件后，若该文件在当前打开的 destination 中，触发重载
3. 不感知外部工具修改（用户手动编辑文件不会自动刷新，需手动点击刷新按钮）

**7.4 flush 与重载的完整流程**

```
AI 调用 append_xlsx_row(path, ...)
  ↓
主进程：检查 path 是否在前端编辑中
  ↓ 是
主进程：发 document:flush-request(path) 到渲染端
  ↓
渲染端：Fortune-sheet 防抖立即触发，exceljs 序列化为 xlsx
渲染端：通过 tRPC document.saveXlsx 写回文件
渲染端：回复 document:flush-done(path)
  ↓
主进程：收到 flush-done（或 3 秒超时）
主进程：用 exceljs 读取文件、修改、写回
  ↓
主进程：发 document:file-changed(path) 通知渲染端
  ↓
渲染端：重载 Fortune-sheet（重新读取文件）
```

### 主题 8：测试策略

**8.1 mock 子进程 + 组件测试**

- **officecli 服务层**：测试时 mock `child_process.spawn`，返回固定 stdout。覆盖 `viewHtml`、`viewScreenshot`、`watchStart` 等高级 API
- **tRPC document router**：端到端测试，mock officecli 服务层
- **Fortune-sheet 组件**：`@testing-library/react` 测试渲染和交互
- **exceljs 读写**：用真实文件测试（创建临时 xlsx，修改，验证）
- **HostTools**：测试工具注册和调用，mock officecli/exceljs
- 不追求 officecli 二进制本身的测试（外部依赖）
- 核心模块覆盖率 > 80%（AGENTS.md 要求）

## 结果

### 架构收益

1. **前端零解析**（除 xlsx 编辑外）：docx/pptx/pdf 预览全部外包给 officecli/react-pdf，避免引入大量前端库
2. **职责清晰**：officecli 负责创建与预览渲染，exceljs 负责编辑，Fortune-sheet 负责交互，react-pdf 负责 PDF 预览
3. **类型安全**：AI 调用走 HostTools（inline input validator），前端走 tRPC，全链路类型推导
4. **内网友好**：二进制随包打包，无外网依赖；officecli 不可用时优雅降级
5. **复用现有架构**：二进制打包模式（resources/binaries/）、router 模块化、destination 机制、HostTools 注册 API 全部复用

### 新增依赖

| 依赖 | 用途 | 位置 |
| --- | --- | --- |
| `@fortune-sheet/react` + `@fortune-sheet/core` | xlsx 原地编辑 | renderer |
| `exceljs` | xlsx 读写 | main + renderer |
| `react-pdf` | PDF 预览 | renderer |
| `pdfjs-dist` | react-pdf 依赖 | renderer（间接） |

### 新增文件

**主进程**：
- `src/main/officecli/binary.ts` —— 二进制路径解析
- `src/main/officecli/executor.ts` —— 子进程封装
- `src/main/officecli/service.ts` —— 高级 API
- `src/main/officecli/types.ts` —— 类型定义
- `src/main/ipc/routers/document-router.ts` —— tRPC document 子路由
- `src/main/document/fortune-sheet-bridge.ts` —— Fortune-sheet 数据与 exceljs 转换
- `src/main/document/xlsx-editor.ts` —— exceljs 细粒度编辑（append_row/update_cell）

**渲染进程**：
- `src/renderer/src/components/office/OfficeDocumentView.tsx` —— 容器组件（根据 mode 分发）
- `src/renderer/src/components/office/HtmlPreview.tsx` —— webview HTML 预览
- `src/renderer/src/components/office/ScreenshotsPreview.tsx` —— PNG 截图预览
- `src/renderer/src/components/office/WatchPreview.tsx` —— webview Watch 预览
- `src/renderer/src/components/office/PdfPreview.tsx` —— react-pdf 预览
- `src/renderer/src/components/office/XlsxEditor.tsx` —— Fortune-sheet 编辑器
- `src/renderer/src/stores/office.ts` —— office 文档状态（打开的文件、编辑器状态、flush 状态）

**构建与脚本**：
- `scripts/download-officecli.mjs` —— 二进制下载脚本

**技能文档**：
- `resources/built-in-extension/skills/officecli-docx/SKILL.md`
- `resources/built-in-extension/skills/officecli-xlsx/SKILL.md`
- `resources/built-in-extension/skills/officecli-pptx/SKILL.md`
- `resources/built-in-extension/skills/officecli-pdf/SKILL.md`

**测试**：
- `tests/officecli/binary.test.ts` —— 路径解析
- `tests/officecli/executor.test.ts` —— 子进程封装（mock spawn）
- `tests/officecli/service.test.ts` —— 高级 API
- `tests/document-router.test.ts` —— tRPC 集成
- `tests/xlsx-editor.test.ts` —— exceljs 细粒度编辑
- `tests/components/OfficeDocumentView.test.tsx` —— 组件渲染

### 修改的现有文件

- `package.json` —— 新增依赖 + download:officecli/prebuild:officecli 脚本
- `src/main/ipc/router.ts` —— 注册 `document: documentRouter`
- `src/main/index.ts` —— BrowserWindow 启用 `webviewTag: true`；注册 officecli IPC；应用退出时 `cleanupOfficeCli`
- `src/main/host/host-tools.ts` —— 在 `registerDefaults` 或单独方法中注册 7 个新工具
- `src/main/agent/session-manager.ts`（或等效文件）—— omp 子进程启动前注入 PATH
- `src/renderer/src/components/layout/CenterArea.tsx` —— 新增 `office-document` 分支
- `src/renderer/src/stores/workbench.ts`（或等效 store）—— `destination` 联合类型新增 `office-document`
- `src/renderer/src/lib/trpc.ts` —— 无需修改（自动推导）

## 阶段路线图

| 阶段 | 交付物 | 依赖 |
| --- | --- | --- |
| 1. 二进制打包与下载脚本 | `scripts/download-officecli.mjs`、`src/main/officecli/binary.ts`、`package.json` 脚本 | 无 |
| 2. officecli 主进程服务 | `executor.ts`、`service.ts`、`types.ts` | 阶段 1 |
| 3. tRPC document router | `document-router.ts`、router 注册 | 阶段 2 |
| 4. 前端预览组件 | `HtmlPreview`、`ScreenshotsPreview`、`WatchPreview`、`PdfPreview`、`OfficeDocumentView` | 阶段 3 |
| 5. CenterArea 集成 | destination 类型、CenterArea 分支、workbench store | 阶段 4 |
| 6. xlsx 原地编辑 | `XlsxEditor`（Fortune-sheet）、`fortune-sheet-bridge`、`xlsx-editor`、自动保存 | 阶段 5 |
| 7. AI 调用链路 | HostTools 注册、PATH 注入、SKILL.md | 阶段 2 |
| 8. 文件变更同步 | flush 机制、file-changed 事件、重载逻辑 | 阶段 6 + 7 |
| 9. 错误降级与测试 | 降级 UI、测试用例 | 全部 |

每个阶段都产生可运行的功能，遵循垂直切片原则（参考 ADR 0014）。

## 考虑的替代方案

### 编辑语义
- **AI 重新生成**（SpaceCode 方案）：前端纯只读，AI 重新生成整个文件。简单但交互体验差，不符合"中间页面支持编辑"需求。
- **officecli 命令式编辑**：officecli CLI 主要面向生成而非细粒度编辑，命令粒度不够。
- **前端原地编辑**（选中）：交互体验最好，需引入前端编辑库，与 SpaceCode「前端零解析」相悖，但符合需求。

### AI 调用方式
- **纯 HostTools**：类型安全但失去灵活性，AI 无法使用 officecli 高级命令。
- **纯 PATH 注入**（SpaceCode 方案）：灵活但失去类型安全，且需确认 omp 是否有 Bash 工具。
- **两者结合**（选中）：高频操作走 HostTools，低频操作走 PATH+Bash。

### 预览容器
- **iframe + srcDoc**：受父页面 CSP 限制，无法加载 file:// 和 http://localhost（Watch 模式不可用）。
- **直接注入 HTML**：丧失脚本能力，大文件性能差。
- **自定义 Protocol**：可绕过 CSP 但需注册协议，复杂度中。
- **webview**（选中）：独立进程，不受渲染进程 CSP 限制，SpaceCode 验证可行。

### xlsx 读写库
- **SheetJS Community**：免费但部分高级功能（图表）需 Pro 版。
- **依赖 Fortune-sheet 生态**：Fortune-sheet 主要输出 JSON，xlsx 读写仍需第三方库。
- **officecli 负责 xlsx 读写**：避免前端引入库，但依赖 officecli CLI 能力，数据传输开销大。
- **exceljs**（选中）：功能全面，与 Fortune-sheet 数据模型映射清晰，社区活跃。

### 文件变更监听
- **chokidar 监听 docs/**：能感知外部修改，但增加依赖和复杂度。
- **依赖 Watch 模式**：仅适用于 docx/pptx，xlsx 不适用。
- **主进程主动通知**（选中）：简单直接，不感知外部修改（可接受）。
