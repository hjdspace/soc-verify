# PRD: officecli 集成 — Office 文档预览、编辑与 AI 生成

> **Parent ADR**: [ADR 0015: officecli 集成](./adr/0015-officecli-integration.md)
>
> **Glossary**: [术语表](./adr/glossary.md)
>
> **Issues**: [Issues: officecli 集成](./issues-officecli-integration.md)

## Problem Statement

SoC Verify 平台需要在验证周期内产出并消费多种 Office 文档：验证计划表（xlsx）、覆盖率报告（docx/pptx）、回归报告（xlsx）、TO 检查清单（xlsx）等。当前平台在这些维度完全空白，验证工程师面临以下痛点：

1. **文档预览割裂**：当前 `FileEditor` 仅支持文本 + Markdown/HTML 预览，无法在平台内预览 .docx/.xlsx/.pptx/.pdf。工程师需要在外部工具（WPS/Office/PDF 阅读器）中查看这些文档，破坏了"单一桌面应用完成全流程"的体验。

2. **文档编辑能力缺失**：验证计划表、回归报告等 xlsx 文件无法在平台内编辑。工程师需要在外部工具中修改后回到平台继续工作，上下文切换成本高。

3. **AI 无法生成结构化文档**：AI Agent 当前只能产出 Markdown 文本，无法生成验证计划表、覆盖率报告等结构化 Office 文档。AI 的能力被限制在文本生成，无法承担验证周期内的文档产出工作。

4. **内网环境约束**：SoC 验证工程师可能在内网 Linux 环境工作，无法依赖在线文档服务或 CDN 资源。所有文档处理能力必须离线可用，二进制依赖必须随包打包。

5. **无统一文档管理**：AI 创建的文档散落各处，缺乏统一存储位置。验证周期内的产物（验证计划、覆盖率报告、回归报告）需要与项目绑定，便于追溯。

## Solution

集成 officecli 外部二进制作为 Office 文档的处理引擎，结合前端编辑库（Fortune-sheet + exceljs）和 PDF 预览库（react-pdf），在 SoC Verify 平台内提供完整的 Office 文档预览、编辑与 AI 生成能力。参考实现为 SpaceCode（`D:\AI\SpaceCode`，已上线验证），但针对 soc-verify 的 React 19 + electron-trpc + xlsx 原地编辑需求进行调整。

**二进制打包**：officecli 二进制按平台打包到 `resources/binaries/`，复用现有 extraResources + asarUnpack 机制。下载脚本从 GitHub Releases 拉取固定版本，失败时不阻断构建。运行时三级回退（内置 → 用户安装 → PATH）。

**主进程服务**：`src/main/officecli/` 独立目录封装二进制路径解析、子进程调用（spawn + 超时 + 进程树 kill）、高级 API（viewHtml/viewScreenshot/watchStart/watchStop）。officecli 不可用时优雅降级，不崩溃。

**AI 调用链路**：两者结合——高频操作（create/read/append/update）走 HostTools 注册（类型安全），低频/高级操作走 PATH 注入 + omp 的 Bash 工具。7 个新 HostTools：create_docx/xlsx/pptx/pdf、read_document、append_xlsx_row、update_xlsx_cell。SKILL.md 内置 skills 目录教 AI 何时调用。

**前端预览**：webview 容器（独立进程，不受 CSP 限制）加载 officecli 生成的 HTML 或 Watch 服务的 HTTP URL。PDF 用 react-pdf（pdfjs-dist 的 React 封装，worker 本地加载）。四种预览模式：HTML、Screenshots（PNG）、Watch（实时刷新，仅 docx/pptx）、pdfjs-dist（仅 PDF）。

**xlsx 原地编辑**：Fortune-sheet（Luckysheet 的 React fork）提供交互编辑，exceljs 负责读写 xlsx 文件。自动保存防抖 2 秒。职责边界：officecli 负责创建，exceljs 负责编辑。

**CenterArea 集成**：新增 `office-document` destination 类型，支持 preview/edit 两种模式。文件扩展名自动判断默认模式（.xlsx → edit，其他 → preview）。

**文件变更同步**：AI 修改 xlsx 前先 flush 前端 Fortune-sheet 状态（3 秒超时强制继续），修改后主进程主动通知渲染端重载。不引入 chokidar。

**文档存储**：AI 创建的文档默认存到 `<project>/docs/`，与项目绑定。

## User Stories

### 二进制打包与基础管道

1. 作为 SoC 验证工程师，我希望平台开箱即用包含 officecli 二进制，这样我在内网无网环境也能预览和创建 Office 文档。
2. 作为 SoC 验证工程师，我希望平台在不同操作系统（Windows/Linux）上都能运行，这样我不受操作系统限制。
3. 作为项目构建者，我希望下载脚本在构建前自动拉取 officecli 二进制，这样我不需要手动管理二进制文件。
4. 作为项目构建者，我希望下载失败时不阻断构建，这样 CI 流水线不会因网络问题中断。
5. 作为项目构建者，我希望 officecli 版本固定，这样构建可重现，避免上游破坏。
6. 作为项目构建者，我希望支持 `--force` 重新下载二进制，这样我能强制升级版本。

### officecli 主进程服务

7. 作为 SoC 验证工程师，我希望 officecli 不可用时平台仍能正常使用其他功能，这样单个组件故障不影响整体可用性。
8. 作为 SoC 验证工程师，我希望 officecli 不可用时看到明确的提示，这样我知道为何无法预览文档。
9. 作为 SoC 验证工程师，我希望在开发模式下能一键下载 officecli 二进制，这样我不需要手动到 GitHub 下载。
10. 作为 AI Agent，我希望主进程提供统一的 officecli 调用接口，这样我不需要关心二进制路径解析和子进程管理。
11. 作为 AI Agent，我希望 officecli 调用有超时保护，这样卡死的子进程不会阻塞我的工作。

### 前端预览（docx/pptx）

12. 作为 SoC 验证工程师，我希望在平台中栏直接预览 .docx 文件，这样我不需要切换到外部工具。
13. 作为 SoC 验证工程师，我希望在平台中栏直接预览 .pptx 文件，这样我能查看覆盖率报告幻灯片。
14. 作为 SoC 验证工程师，我希望预览模式可在 HTML/Screenshots/Watch 间切换，这样我能根据需要选择最合适的预览方式。
15. 作为 SoC 验证工程师，我希望 Watch 模式实时刷新文档变更，这样 AI 重新生成文档时我能立即看到结果。
16. 作为 SoC 验证工程师，我希望 Screenshots 模式按页展示 PNG 截图，这样我能快速浏览多页文档。
17. 作为 SoC 验证工程师，我希望预览的 Office 文档作为 tab 打开，这样我能同时打开多个文档对比。
18. 作为 SoC 验证工程师，我希望预览 tab 有清晰的图标和标题，这样我能快速识别文档类型和文件名。

### 前端预览（PDF）

19. 作为 SoC 验证工程师，我希望在平台中栏直接预览 .pdf 文件，这样我不需要独立的 PDF 阅读器。
20. 作为 SoC 验证工程师，我希望 PDF 预览支持缩放和翻页，这样我能阅读大型 PDF 文档。
21. 作为 SoC 验证工程师，我希望 PDF 预览不依赖网络，这样我在内网环境也能使用。

### xlsx 原地编辑

22. 作为 SoC 验证工程师，我希望在平台中栏直接编辑 .xlsx 文件，这样我能修改验证计划表和回归报告。
23. 作为 SoC 验证工程师，我希望编辑器支持公式计算，这样我能使用 Excel 公式汇总数据。
24. 作为 SoC 验证工程师，我希望编辑器支持条件格式，这样我能用颜色标记 pass/fail 状态。
25. 作为 SoC 验证工程师，我希望编辑内容自动保存，这样我不用担心丢失修改。
26. 作为 SoC 验证工程师，我希望 xlsx 也能以只读模式预览，这样我能在不修改的情况下查看内容。
27. 作为 SoC 验证工程师，我希望编辑器与 AI 修改同步，这样 AI 更新表格后我能立即看到最新数据。

### AI 创建文档

28. 作为 SoC 验证工程师，我希望 AI 能根据我的描述生成验证计划表（xlsx），这样我不需要手动搭建表格结构。
29. 作为 SoC 验证工程师，我希望 AI 能生成覆盖率报告（docx），这样我能快速产出阶段性总结。
30. 作为 SoC 验证工程师，我希望 AI 能生成汇报幻灯片（pptx），这样我能向团队展示验证进度。
31. 作为 SoC 验证工程师，我希望 AI 能将 Markdown 内容转为 PDF，这样我能产出可分发的只读文档。
32. 作为 SoC 验证工程师，我希望 AI 创建的文档默认存到项目 docs/ 目录，这样我能方便地找到所有 AI 产物。
33. 作为 SoC 验证工程师，我希望 AI 能指定文档输出路径，这样我能按项目结构组织文档。
34. 作为 AI Agent，我希望有类型安全的工具接口创建文档，这样我生成的参数能被校验。
35. 作为 AI Agent，我希望工具描述清晰说明参数格式，这样我知道如何传入 Markdown 或二维数组。

### AI 读取与编辑文档

36. 作为 AI Agent，我希望能读取现有 Office 文档的结构化内容，这样我能基于现有文档做修改。
37. 作为 AI Agent，我希望能在现有 xlsx 末尾追加行，这样我能增量更新回归报告而不重新生成整表。
38. 作为 AI Agent，我希望能更新 xlsx 的特定单元格，这样我能精确修改某个测试项的状态。
39. 作为 SoC 验证工程师，我希望 AI 修改 xlsx 时保留我未保存的编辑，这样我不会因 AI 操作丢失数据。
40. 作为 SoC 验证工程师，我希望 AI 修改后前端自动刷新，这样我能立即看到 AI 的修改结果。

### AI 高级调用

41. 作为 AI Agent，我希望能在 omp 的 Bash 工具中直接调用 officecli 高级命令，这样我能使用 officecli 的全部能力。
42. 作为 AI Agent，我希望有 SKILL.md 文档教我何时用 officecli，这样我能选择合适的工具。

### CenterArea 集成

43. 作为 SoC 验证工程师，我希望在文件树点击 .xlsx/.docx/.pptx/.pdf 文件时自动在中栏打开预览或编辑，这样我不需要额外的操作步骤。
44. 作为 SoC 验证工程师，我希望 xlsx 默认进入编辑模式，其他类型默认进入预览模式，这样符合我的使用习惯。
45. 作为 SoC 验证工程师，我希望能在预览和编辑模式间手动切换，这样我能根据需要选择。
46. 作为 SoC 验证工程师，我希望 office 文档 tab 与其他 tab（终端、覆盖率等）共存，这样我能同时进行多项工作。

## Implementation Decisions

### 二进制打包与版本管理

- 按平台打包当前平台二进制（如 `officecli-win-x64.exe`、`officecli-linux-x64`），放入 `resources/binaries/`
- 复用现有 `electron-builder.yml` 的 extraResources + asarUnpack 配置，无需修改
- 固定 officecli 版本号（在 `package.json` 或 `.officecli-version` 中），升级需手动改版本号
- 移植 SpaceCode 下载脚本到 `scripts/download-officecli.mjs`，从 GitHub Releases 拉取
- `package.json` 新增 `download:officecli` 独立命令和 `prebuild:officecli` 前置钩子
- 下载失败时不阻断构建，只打印警告，运行时降级处理

### officecli 主进程服务

- 新增独立目录 `src/main/officecli/`，与 `src/main/agent/`、`src/main/host/` 同级
- 模块划分：binary.ts（路径解析）、executor.ts（子进程封装）、service.ts（高级 API）、types.ts（类型）
- 路径解析采用三级回退：内置二进制 → 用户级安装（`~/.officecli/bin/`）→ 系统 PATH（仅开发模式）
- 子进程调用使用 `child_process.spawn`（非 exec），`shell: false` 避免 shell 注入
- 超时机制：默认 30 秒，超时触发跨平台进程树 kill（Windows 用 `taskkill /T /F`，Unix 用进程组 SIGTERM）
- 优雅降级：officecli 不可用时预览面板显示提示，AI 工具返回明确错误，不崩溃，Fortune-sheet 编辑仍可用

### AI 调用链路（两者结合）

- **高频操作**走 HostTools 注册：通过 `HostToolsRegistry.registerCustom()` 注册 7 个工具
- **低频/高级操作**走 PATH 注入 + omp Bash 工具：启动 omp 子进程前同步复制二进制到 `~/.officecli/bin/`，注入 PATH
- 工具参数格式：create_docx/create_pdf 接收 Markdown 字符串；create_xlsx 接收 `{name, data}` 二维数组；create_pptx 接收 `{title, content}` 数组
- 7 个 HostTools：
  - `create_docx(content: string, outputPath?: string)` → 文件路径
  - `create_xlsx(sheets: {name: string, data: any[][]}[], outputPath?: string)` → 文件路径
  - `create_pptx(slides: {title: string, content: string}[], outputPath?: string)` → 文件路径
  - `create_pdf(content: string, outputPath?: string)` → 文件路径
  - `read_document(path: string)` → 结构化内容
  - `append_xlsx_row(path: string, sheet: string, rows: any[][])` → 修改后的行数
  - `update_xlsx_cell(path: string, sheet: string, row: number, col: number, value: any)` → 修改后的值
- `create_*` 系列默认输出到 `<project>/docs/`，AI 可通过 `outputPath` 参数指定其他路径
- SKILL.md 放 `resources/built-in-extension/skills/officecli-{docx,xlsx,pptx,pdf}/SKILL.md`，与现有 soc-env-gen、soc-verify-plugin-development 同级

### 前端预览

- 预览模式矩阵：
  - `.docx`/`.pptx`：HTML（默认）、Screenshots、Watch
  - `.xlsx`：Edit（Fortune-sheet，默认）、HTML、Screenshots
  - `.pdf`：pdfjs-dist（react-pdf）
- 预览容器：Electron `<webview>` 标签，启用 `webviewTag: true`，使用 `partition="persist:office-preview"` 隔离
- 不修改 index.html 的 CSP（`default-src 'self'`）——webview 是独立进程，不受渲染进程 CSP 限制
- HTML 模式：webview 加载 `file:///path/to/output.html`
- Watch 模式：webview 加载 `http://localhost:PORT`（officecli watch 启动本地 HTTP 服务器，默认端口 26315）
- Screenshots 模式：`<img>` 标签，需 `readImageAsDataURL` 将 PNG 转为 base64 data URL 绕过 file:// CORS
- PDF 预览：react-pdf（`<Document><Page />`），worker 本地加载（`node_modules/pdfjs-dist/build/pdf.worker.min.mjs`），不走 CDN
- Watch 进程生命周期：在 `officecli/service.ts` 中维护 `watchProcesses: Map<string, OfficeCliWatchHandle>`，应用退出时统一清理

### xlsx 原地编辑

- 仅 xlsx 原地编辑，docx/pptx/pdf 纯只读预览
- 表格库：Fortune-sheet（Luckysheet 的社区 fork，React + TypeScript 重写），安装 `@fortune-sheet/react` + `@fortune-sheet/core`
- xlsx 读写库：exceljs，安装 `exceljs`
- 自动保存：Fortune-sheet `onChange` 回调防抖 2 秒，渲染端用 exceljs 序列化为 xlsx，通过 tRPC `document.saveXlsx` 写回文件
- 职责边界：officecli 负责 xlsx 创建（`create_xlsx`），exceljs 负责 xlsx 编辑（细粒度修改 + Fortune-sheet 持久化）
- officecli 创建的 xlsx 可能包含特有样式/图表，exceljs 修改时尽量保留（图表可能丢失——在 SKILL.md 中提示 AI）

### CenterArea 集成

- 新增 `office-document` destination 类型：

```typescript
type OfficeDocumentDestination = {
  type: 'office-document'
  filePath: string
  mode: 'preview' | 'edit'
  previewMode?: 'html' | 'screenshots' | 'watch'
}
```

- 文件扩展名自动判断默认模式：.xlsx → edit，.docx/.pptx → preview（previewMode 默认 html），.pdf → preview（用 react-pdf）
- 在 CenterArea.tsx 渲染分发中新增分支，复用现有 tab 机制（图标 + 标题 + 关闭按钮）
- 文档存储位置：`<project>/docs/`，AI 通过 `outputPath` 参数可指定其他路径，主进程自动创建目录

### 文件变更同步

- AI 修改后重载文件：AI 通过 HostTools 修改 xlsx 后，前端 Fortune-sheet 重新读取文件并重载
- AI 修改前先 flush 前端：
  1. 主进程通过 `document.documentEditors: Map<string, BrowserWindow>` 追踪哪些文件在前端被编辑
  2. AI 调用 `append_xlsx_row`/`update_xlsx_cell` 前，主进程检查目标文件是否在前端编辑中
  3. 若是，发 IPC 事件 `document:flush-request(path)` 通知渲染端立即 flush
  4. 渲染端 flush 完成后回复 `document:flush-done(path)`
  5. 主进程收到回复（或 3 秒超时）后继续执行 AI 修改
  6. 超时后强制继续，可能丢失前端未保存状态，记录警告日志
- 文件变更监听：不引入 chokidar，主进程通过 IPC 事件 `document:file-changed` 主动通知所有 BrowserWindow
- 不感知外部工具修改（用户手动编辑文件不会自动刷新，需手动点击刷新按钮）

### tRPC document router

- 新增 `src/main/ipc/routers/document-router.ts`，在 router.ts 中注册为 `document: documentRouter`
- 关键 procedure：
  - `document.viewHtml(filePath)` → 返回 HTML 文件路径
  - `document.viewScreenshot(filePath, page?)` → 返回 PNG 路径数组
  - `document.watchStart(filePath)` → 返回 `{ id, port, url }`
  - `document.watchStop(watchId)` → 返回 boolean
  - `document.readImageAsDataURL(filePath)` → 返回 base64 data URL
  - `document.saveXlsx(filePath, data)` → 返回 boolean（前端 Fortune-sheet 持久化）
  - `document.checkInstalled()` → 返回 boolean（officecli 是否可用）
  - `document.downloadBinary()` → 返回 `{ success, path?, error? }`（仅开发模式）
- 使用 inline input validator（非 zod），遵循项目约定
- 复用 router-context.ts 的 `t`、`TRPCError`、`requireProject` 基础设施

### BrowserWindow 配置修改

- 在 `src/main/index.ts` 的 BrowserWindow 配置中启用 `webviewTag: true`
- 注册 officecli IPC handlers（document router 已通过 tRPC 暴露，flush/file-changed 事件用原生 ipcMain.on/ipcRenderer.send）
- 应用退出时调用 `cleanupOfficeCli()` 清理 watch 进程

### omp 子进程 PATH 注入

- 在 `src/main/agent/session-manager.ts`（或等效文件）中找到 omp 子进程启动入口
- 启动前同步复制 `resources/binaries/officecli-{platform}-{arch}[.exe]` 到 `~/.officecli/bin/officecli[.exe]`
- 若已存在则跳过，若平台非 Windows 则 `chmod 0o755`
- 将 `~/.officecli/bin` 注入到 omp 子进程 `env.PATH` 前面
- 确保第一次 Bash 工具调用前二进制已就位（同步复制，不依赖异步）

## Testing Decisions

### 测试缝选择

采用 **tRPC 主缝 + UI 组件缝**，与 AGENTS.md 现有 3 个测试缝一致，不新增缝。

**tRPC API 集成缝（主缝）**：
- 端到端测试 document router，mock officecli 子进程（`child_process.spawn`）和 exceljs
- 覆盖所有 procedure：viewHtml、viewScreenshot、watchStart/Stop、saveXlsx、checkInstalled
- 覆盖 HostTools 调用：create_*、read_document、append_xlsx_row、update_xlsx_cell
- 覆盖 flush 机制：模拟前端编辑状态、AI 修改触发 flush、超时处理
- 参考先例：`tests/timing-violation-router.test.ts`、`tests/project-router.test.ts`

**UI 组件缝**：
- `@testing-library/react` 测试 Fortune-sheet 渲染与交互
- 测试 OfficeDocumentView 根据 mode 分发到正确子组件
- 测试预览组件的错误状态（officecli 不可用时显示提示）
- 参考先例：`tests/components/` 下现有组件测试

### 测试原则

- 只测外部行为，不验证内部实现细节
- officecli 服务层测试时 mock `child_process.spawn`，返回固定 stdout
- exceljs 读写用真实文件测试（创建临时 xlsx，修改，验证）
- 不追求 officecli 二进制本身的测试（外部依赖）
- 核心模块覆盖率 > 80%（AGENTS.md 要求）
- UI 组件覆盖率 > 60%（AGENTS.md 要求）

### 测试用例清单

- `tests/officecli/binary.test.ts` —— 路径解析（三级回退）
- `tests/document-router.test.ts` —— tRPC 集成（mock officecli 服务层）
- `tests/document-host-tools.test.ts` —— HostTools 注册与调用（mock officecli/exceljs）
- `tests/document-flush.test.ts` —— flush 机制（前端编辑状态、AI 修改、超时）
- `tests/xlsx-editor.test.ts` —— exceljs 细粒度编辑（真实文件）
- `tests/components/OfficeDocumentView.test.tsx` —— 容器组件分发
- `tests/components/XlsxEditor.test.tsx` —— Fortune-sheet 渲染与交互
- `tests/components/HtmlPreview.test.tsx` —— webview HTML 预览
- `tests/components/PdfPreview.test.tsx` —— react-pdf 预览

## Out of Scope

- **docx/pptx 原地编辑**：仅 xlsx 支持原地编辑，docx/pptx 纯只读预览。富文本编辑器集成复杂度高，本期不做。
- **officecli 二进制本身的测试**：officecli 是外部二进制依赖，不测试其内部实现。
- **外部工具修改感知**：用户用外部工具（如 WPS）修改文件后，平台不自动刷新。需手动点击刷新按钮。
- **多用户协作**：单用户桌面应用，不提供多人同时编辑同一文档的能力。
- **文档版本管理**：不提供文档历史版本、diff 对比等功能。AI 修改后直接覆盖原文件。
- **officecli 在线升级**：officecli 版本固定，不支持应用内自动升级。升级需修改版本号重新构建。
- **macOS 支持**：officecli 二进制主要支持 Windows/Linux，macOS 支持作为后续工作。
- **omp 引擎 markit 转换器复用**：`engine/oh-my-pi` 子模块内的 markit 转换器受 AGENTS.md 约束 1「不修改 omp 引擎源码」限制，不复用。
- **文档模板系统**：不提供文档模板管理。SKILL.md 中会有示例，但不是模板系统。
- **文档权限控制**：不提供文档读写权限管理。所有文档对当前用户可读写。

## Further Notes

### 参考实现

SpaceCode（`D:\AI\SpaceCode`，Electron + Vue 3）已上线 officecli 集成，是本 spec 的主要参考。关键差异：
1. 前端框架：soc-verify 用 React 19，SpaceCode 用 Vue 3
2. IPC：soc-verify 用 electron-trpc（类型安全），SpaceCode 用原生 `ipcMain.handle`
3. 编辑需求：soc-verify 需要 xlsx 原地编辑，SpaceCode 完全只读

### SpaceCode 关键参考文件

- `D:\AI\SpaceCode\electron\officeCliService.ts` —— officecli 服务封装（656 行，核心）
- `D:\AI\SpaceCode\electron\sessionProcess.ts` 第 1362-1398 行 —— PATH 注入
- `D:\AI\SpaceCode\scripts\download-officecli.mjs` —— 下载脚本
- `D:\AI\SpaceCode\src\components\work\PreviewPanel.vue` —— 预览组件
- `D:\AI\SpaceCode\skills-lib\{docx,pptx,xlsx,pdf}\SKILL.md` —— 技能文档

### officecli CLI 接口

- `officecli --version` —— 版本检查
- `officecli install` —— 安装到 `~/.officecli/bin/`
- `officecli view <file> html [-o <dir>]` —— 渲染为 HTML（输出目录，可选）
- `officecli view <file> screenshot -o <file> [--page N]` —— 渲染为 PNG（输出文件路径，必传）
- `officecli watch <file> [--port N]` —— 启动本地 HTTP 服务器实时预览（默认端口 26315）

### 与现有 ADR 的关系

- **ADR 0010（插件扩展宿主）**：officecli 不是插件，是平台内置二进制。不通过 PluginLoader 加载。
- **ADR 0014（垂直切片阶段）**：本 spec 的 issues 遵循垂直切片原则，每个 issue 贯穿所有层。
- **ADR 0015（officecli 集成）**：本 spec 的设计决策记录在 ADR 0015 中。

### 内网友好性

所有设计考虑内网无网环境：
- officecli 二进制随包打包，不依赖运行时下载（开发模式除外）
- react-pdf worker 本地加载，不走 CDN
- 无外部 API 调用（不调用在线文档转换服务）
- 优雅降级：officecli 不可用时仍可使用其他功能

### 性能考虑

- officecli 子进程调用有 30 秒超时，避免卡死
- Fortune-sheet 自动保存防抖 2 秒，避免频繁写文件
- Watch 模式仅用于 docx/pptx，减少端口占用
- Screenshots 模式图片转 base64 data URL，避免 file:// CORS 问题
- 大型 xlsx 文件编辑性能依赖 Fortune-sheet 自身的虚拟滚动能力
