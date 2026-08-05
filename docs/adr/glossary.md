# 术语表（Glossary）

本术语表记录 SoC Verify 项目中 officecli 集成、内置网页工作区和 WebContentsView 统一承载相关的核心术语，供 ADR 0015、ADR 0016 及后续实施参考。

## 内置网页与原生视图

### WebContentsView
Electron 主进程可管理的原生网页视图。它拥有独立的 webContents，可加载网页并接收导航、标题、加载、下载、权限、弹窗和崩溃事件；不能可靠地被普通 Renderer DOM 的 z-index 覆盖，因此需要显式的 bounds 和可见性同步。

### View Manager
主进程中的深模块，统一负责 WebContentsView 的创建、销毁、挂载、隐藏、bounds、导航、事件、下载、权限、证书、弹窗和崩溃状态。业务模块通过 Surface seam 使用它，不直接操作 webContents。

### Surface
对一个可嵌入工作区内容的逻辑描述，包括唯一 id、kind、source、可见性和 bounds。Renderer 以声明式 Surface 描述驱动 View Manager；Surface 是逻辑状态与原生视图之间的 seam。

### Browser Surface
承载任意 http/https 网页的 Surface。它拥有地址栏、后退、前进、刷新、收藏、查找和系统浏览器打开等基础浏览能力，使用专属持久化 Browser session。

### Document Surface
承载 Office HTML/Watch 预览的 Surface。source 可为 local-file 或 local-server，由 Document Surface 协调器负责 officecli 生成、Watch 启停、CSS 注入和错误清理。使用隔离的非持久化 session。

### Browser session
Browser Surface 共享的专属持久化 Electron session/partition，保存 Cookie、LocalStorage 和 SSO 登录态；不复用系统浏览器 Cookie，也不与 Document Surface 共享。

### Document session
Document Surface 使用的隔离、非持久化 Electron session。其目的不是保存网页登录态，而是避免本地文档或 Watch 服务继承 Browser session 的 Cookie、缓存和站点权限。

### Surface seam
Renderer 的逻辑标签/声明式 Surface 描述与主进程 View Manager 之间的调用 seam。调用方只需声明所需内容和显示区域，不需要知道 WebContentsView 的创建顺序、事件清理或销毁细节。

### Bounds 同步
Renderer 使用 ResizeObserver 测量 DOM 容器相对 BrowserWindow 的坐标和尺寸，上报给主进程，由 View Manager 校验后调用 WebContentsView.setBounds()。用于适配 CenterArea 的栏宽拖拽、折叠、底部面板和窗口状态变化。

### Overlay 隐藏策略
由于 WebContentsView 不能可靠地被 Renderer DOM 覆盖，应用级设置、命令面板、向导和菜单打开时临时隐藏活动原生视图；Overlay 关闭后恢复并重新同步 bounds。

### 认证临时浮层
为 SSO/OAuth/MFA 使用的受控临时网页窗口。它保留来源页面需要的 opener 关系和 Browser session，但不创建永久 workbench 网页标签；认证完成或关闭后销毁。

### Browser data
主进程用户级 browser settings/data 文件，保存全局网页标签、书签、分组、排序和常用标记。采用版本化、变更防抖保存和退出前刷盘；不是项目状态文件，也不是 Renderer localStorage 权威源。

### 书签与常用标记
书签是全局网页条目，包含名称、URL、分组和排序。常用网页不是第二套数据，而是书签条目的常用标记投影，显示在新标签首页和快捷入口。

### Local Report Surface
由用户选择文件或业务入口明确创建的本地报告 Surface。允许加载受限 file:// 内容，但地址栏不能直接输入任意 file:// 路径。

## officecli 集成相关

### officecli
外部命令行二进制工具（来源：`https://github.com/iOfficeAI/OfficeCLI/releases`），负责 Office 文档的创建、转换与预览渲染。在 SoC Verify 中作为平台内置二进制打包，不走前端解析。

### officecli 子命令
- `officecli --version` —— 版本检查
- `officecli install` —— 安装到 `~/.officecli/bin/`
- `officecli view <file> html [-o <dir>]` —— 渲染为 HTML（输出目录，可选）
- `officecli view <file> screenshot -o <file> [--page N]` —— 渲染为 PNG（输出文件路径，必传）
- `officecli watch <file> [--port N]` —— 启动本地 HTTP 服务器实时预览（默认端口 26315）

### 二进制路径解析（resolveOfficecliPath）
三级回退策略（参考 SpaceCode `officeCliService.ts` 第 92-127 行）：
1. 内置二进制（dev: `resources/binaries/`，pack: `process.resourcesPath/binaries/`）
2. 用户级安装（`~/.officecli/bin/officecli`）
3. 系统 PATH（仅开发模式）

### PATH 注入
启动 omp 子进程前，同步复制 officecli 二进制到 `~/.officecli/bin/` 并将该目录注入到子进程 `env.PATH` 前面，确保 omp 的 Bash 工具能直接 `officecli xxx`。参考 SpaceCode `sessionProcess.ts` 第 1362-1398 行。

### 下载脚本（download-officecli.mjs）
从 GitHub Releases 拉取固定版本 officecli 二进制到 `resources/binaries/` 的 Node 脚本。失败时不阻断构建，只打印警告。支持 `--force` 重新下载。

## 预览模式

### HTML 模式（html）
`officecli view <file> html` 将文档转为 HTML。当前迁移目标由 Document Surface 使用 WebContentsView 加载 `file://` URL；历史 `<webview>` 实现仅保留在 ADR 0015 的原始记录中。所有 Office 文件类型通用。

### Screenshots 模式（screenshots）
`officecli view <file> screenshot` 将文档转为 PNG 图片（每页一张），前端用 `<img>` 展示。需 `readImageAsDataURL` 将图片转为 base64 data URL 以绕过 file:// CORS 限制。

### Watch 模式（watch）
`officecli watch <file>` 启动本地 HTTP 服务器（默认端口 26315），Document Surface 使用 WebContentsView 加载 `http://localhost:PORT`。officecli 内部通过 WebSocket 推送文件变更刷新。Watch 的启动/停止由 Document Surface 协调器负责；仅用于 docx/pptx（xlsx 用 Fortune-sheet 编辑，PDF 用 react-pdf）。

### readImageAsDataURL
主进程读取图片文件并转为 base64 data URL 的能力，用于绕过开发模式下 webview 的 `file://` CORS 限制。参考 SpaceCode `officeCliService.ts`。

## xlsx 编辑相关

### Fortune-sheet
Luckysheet 的社区 fork，用 React + TypeScript 重写。提供电子表格的交互编辑能力（公式、图表、条件格式）。在 SoC Verify 中仅用于 xlsx 原地编辑。npm 包：`@fortune-sheet/react` + `@fortune-sheet/core`。

### exceljs
Node.js 的 xlsx 读写库，支持样式、公式、图表、合并单元格、数据验证。在 SoC Verify 中用于：
- Fortune-sheet 持久化（前端编辑状态 → xlsx 文件）
- AI 细粒度编辑（`append_xlsx_row` / `update_xlsx_cell` HostTools）

### 职责边界（officecli vs exceljs）
- **officecli**：负责 xlsx 的**创建**（`create_xlsx` HostTools，从二维数组生成新文件）
- **exceljs**：负责 xlsx 的**编辑**（细粒度修改现有文件 + Fortune-sheet 持久化）
- officecli 创建的 xlsx 可能包含 officecli 特有样式/图表，exceljs 修改时尽量保留（图表可能丢失）

### 自动保存（防抖）
Fortune-sheet 的 `onChange` 回调防抖 2 秒后触发 exceljs 序列化为 xlsx 并写回文件。用户无感知，避免数据丢失。

### flush 机制
AI 调用细粒度编辑 HostTools 前，主进程通过 IPC 事件 `document:flush-request` 通知渲染端立即 flush Fortune-sheet 的未保存状态到文件，渲染端完成后回复 `document:flush-done`。3 秒超时后强制继续（可能丢失前端未保存状态）。

### 文件变更通知
AI 修改文件后，主进程通过 IPC 事件 `document:file-changed` 主动通知所有 BrowserWindow，渲染端据此重载。不引入 chokidar，不感知外部工具修改。

## AI 调用链路

### HostTools（HostToolsRegistry）
soc-verify 主进程的 Host Tools 注册中心（`src/main/host/host-tools.ts`），向 omp Agent 暴露工具能力。通过 `registerCustom(name, description, parameters, handler)` 公开 API 注册新工具。officecli 集成新增 7 个工具：`create_docx`、`create_xlsx`、`create_pptx`、`create_pdf`、`read_document`、`append_xlsx_row`、`update_xlsx_cell`。

### SKILL.md
教 AI 如何调用 officecli 的技能文档，放在 `resources/built-in-extension/skills/officecli-{docx,xlsx,pptx,pdf}/SKILL.md`。与现有 `soc-env-gen`、`soc-verify-plugin-development` 同级。内容参考 SpaceCode `skills-lib/`，调整为 SoC 验证场景。

### 两者结合（AI 调用方式）
- **高频操作**走 HostTools 注册（类型安全、参数校验）
- **低频/高级操作**走 PATH 注入 + omp 的 Bash 工具直接调用 `officecli xxx`

## 前端集成

### destination（office-document）
CenterArea 的工作区目标类型。新增 `office-document` 类型：
```typescript
type OfficeDocumentDestination = {
  type: 'office-document'
  filePath: string
  mode: 'preview' | 'edit'  // preview=webview/react-pdf, edit=Fortune-sheet
  previewMode?: 'html' | 'screenshots' | 'watch'  // 仅 preview 模式有效
}
```

### webview（历史预览容器）
ADR 0015 原始 Office HTML/Watch 实现使用的 Electron `<webview>` 标签，需要 `webviewTag: true` 和 `persist:office-preview`。ADR 0016 已决定迁移到 WebContentsView；迁移完成后删除该标签、配置和类型声明，不保留双轨实现。

### react-pdf
pdfjs-dist 的 React 封装，API 友好（`<Document><Page />`）。worker 本地加载（不走 CDN，符合内网约束）。仅用于 PDF 预览。

### 优雅降级
officecli 二进制不可用时：
- 预览面板显示「officecli 未安装」提示 + 下载按钮（仅开发模式）
- AI 工具调用返回明确错误
- 不崩溃，Fortune-sheet 编辑仍可用（exceljs 纯 Node 实现）

## SoC 验证场景文档

| 文档类型 | 典型格式 | 产出方 | 用途 |
| --- | --- | --- | --- |
| 验证计划表 | xlsx | AI 创建 / 工程师编辑 | 子系统验证项、用例清单、签字栏 |
| 覆盖率报告 | docx / pptx | AI 创建 | 阶段覆盖率总结、趋势图、风险评估 |
| 回归报告 | xlsx | AI 创建 / 工程师编辑 | 回归套件运行结果、pass/fail 统计 |
| TO 检查清单 | xlsx | AI 创建 / 工程师编辑 | Tape-Out 前的验证项确认 |

所有 AI 创建的文档默认存到 `<project>/docs/`。

## 参考实现

### SpaceCode
`D:\AI\SpaceCode`，Electron + Vue 3 桌面应用，已上线 officecli 集成。soc-verify 的 officecli 集成参考其实现，但有三处关键差异：
1. 前端框架：soc-verify 用 React 19，SpaceCode 用 Vue 3
2. IPC：soc-verify 用 electron-trpc（类型安全），SpaceCode 用原生 `ipcMain.handle`
3. 编辑需求：soc-verify 需要 xlsx 原地编辑，SpaceCode 完全只读

### 关键参考文件（SpaceCode）
- `D:\AI\SpaceCode\electron\officeCliService.ts` —— officecli 服务封装（656 行，核心）
- `D:\AI\SpaceCode\electron\sessionProcess.ts` 第 1362-1398 行 —— PATH 注入
- `D:\AI\SpaceCode\scripts\download-officecli.mjs` —— 下载脚本
- `D:\AI\SpaceCode\src\components\work\PreviewPanel.vue` —— 预览组件
- `D:\AI\SpaceCode\skills-lib\{docx,pptx,xlsx,pdf}\SKILL.md` —— 技能文档
