# ADR 0016: 统一使用 WebContentsView 承载网页与文档 Surface

## 状态

Accepted（需求基线已确认，待实施）

## 背景

SoC Verify 需要增加内置网页查看能力，主要用于回归网页和 CQP 网页，同时继续在中栏预览 Office HTML/Watch 页面。当前 HTML/Watch 预览依赖 Electron `<webview>`，而新能力需要更强的主进程生命周期控制、窗口弹窗处理、下载/上传、权限拦截和布局同步能力。

当前应用已有统一的 CenterArea workbench 标签体系、无边框 BrowserWindow、动态左右栏和底部面板。`<webview>` 方案会把视图生命周期和事件处理分散到 Renderer；`WebContentsView` 则可以由主进程统一管理，但要求额外处理原生视图 bounds 与 React DOM 布局同步。

## 决策

### 1. 统一的主进程 View Manager

新增主进程 `View Manager`，统一创建、销毁、挂载、隐藏、导航、bounds、事件、下载、权限、证书、弹窗和崩溃状态。Renderer 不直接持有 `WebContentsView`，只通过声明式 Surface 描述与其同步。

View Manager 的外部接口保持小而稳定，至少支持：

- 声明/更新 Surface：`id`、`kind`、`source`、`visible`、`bounds`
- 销毁 Surface
- 导航控制：后退、前进、刷新、加载 URL、停止加载
- 页面能力：查找、停止查找、打开系统浏览器
- 统一查询/事件流：标题、URL、加载状态、失败、崩溃、弹窗、下载

具体 IPC 名称和内部数据结构在实现时确定，但不允许业务组件直接调用 Electron `webContents`。

### 2. Surface 类型

统一承载模型分为两类：

- **Browser Surface**：任意 `http/https` 网页，支持地址栏、导航、收藏、基础查找和网页标签能力。
- **Document Surface**：Office HTML/Watch 预览。source 分为 `local-file` 和 `local-server`，由文档协调器负责 officecli 生成、Watch 启停和错误处理。

Screenshots、PDF、Fortune-sheet XLSX 编辑器不强制迁移为 WebContentsView；它们仍使用现有 React/图片/PDF/表格实现。此 ADR 只替换现有 HTML 与 Watch 的 `<webview>` 承载层。

### 3. 每个打开标签一个原生视图

每个打开的 Browser Surface 或 Document Surface 持有一个独立 `WebContentsView`。切换标签时只挂载活动视图并隐藏其他视图，保留网页的滚动、表单、WebSocket 和 SSO 状态。

Browser Surface 默认保活，网页标签软上限为 12 个；超过上限只提示用户，不自动销毁。Document Surface 在切换离开 HTML/Watch、切换预览模式或关闭标签时立即销毁；Watch 同时停止对应服务。

### 4. Renderer 测量，主进程设置 bounds

Renderer 为每个 Surface 提供 DOM 容器，使用 `ResizeObserver` 测量相对 BrowserWindow 的位置与尺寸，并通过 IPC 上报。View Manager 负责校验 bounds 并调用 `WebContentsView.setBounds()`。

主进程不复制 CenterArea 的左右栏、底部面板和折叠规则，以避免布局逻辑漂移。Browser Surface 的导航控制条始终由 React 渲染，原生视图只覆盖控制条以下区域；Document Surface 的模式切换栏同样由 React 渲染。

应用级覆盖层（设置、命令面板、向导、下拉菜单等）打开时，Renderer 通知 View Manager 临时隐藏活动原生视图；覆盖层关闭后恢复视图并重新同步 bounds。不能依赖 DOM z-index 让 React 覆盖层可靠地盖住 WebContentsView。

### 5. Session 隔离

- Browser Surface 使用专属持久化 session/partition，共享 Cookie、LocalStorage 和 SSO 登录态；不读取系统浏览器的 Cookie。
- Document Surface 使用隔离的非持久化 session，不继承浏览器 Cookie、缓存或站点权限。
- 浏览器数据清理入口放在设置中，支持清理 Browser session 的 Cookie、缓存和站点数据。

### 6. 导航和安全策略

- Browser Surface 主框架仅允许 `http`/`https`。
- 地址栏只接受 `http`/`https`；不能通过地址栏输入任意 `file://`。
- `file://` 仅在用户通过文件选择器主动选择，或业务入口明确指定本地报告时创建受限 Document/Local Report Surface。
- 普通 `window.open`/`target=_blank` 创建新的 Browser Surface 标签。
- SSO/OAuth/MFA 认证弹窗使用应用内受控临时浮层，保留必要的 opener 关系；认证结束后自动关闭或回到来源页面，不占用永久网页标签。
- 非 Web 协议默认拒绝或交给系统处理，不允许网页获得 Node/Electron 权限。
- 证书错误默认阻止，仅允许用户在明确风险页中单次继续，不记忆永久信任。
- 摄像头、麦克风、通知、地理位置、自动播放等敏感权限默认拒绝并提示。
- 剪贴板仅允许用户手势触发的读写；禁止后台脚本静默读取。
- 文件上传仅允许用户主动操作系统文件选择器；网页不能静默读取本地文件。
- 下载使用系统保存对话框，首期不建设独立下载管理器。
- 代理复用 Electron/系统默认网络配置，首期不提供独立代理编辑器。

### 7. Workbench 与持久化

网页仍融入现有 CenterArea，采用“一网页一中栏标签”模型。网页标签属于全局应用状态，不随项目切换关闭；相同 URL 经标准化后复用已有网页标签并激活。网页标签恢复 URL、标题、顺序和最后激活项，页面内容重启后重新加载。

URL、标题、加载状态、重定向和失败状态以主进程 `webContents` 事件为事实来源，Renderer store 只保存投影。全局网页标签和书签由主进程用户级 browser settings/data 文件持久化，不写入项目状态文件，也不以 Renderer `localStorage` 作为权威来源。

状态采用变更防抖保存，应用退出前由主进程完成最后一次同步刷盘。书签为全局数据，支持单层分组、组内排序和常用标记，并提供 JSON 导入/导出。

### 8. Office 迁移策略

同一分支分阶段完成：

1. 建立 View Manager、Surface 描述、bounds 同步和事件桥接。
2. 将 HtmlPreview 和 WatchPreview 迁移为 Document Surface；保留 officecli 生成 HTML、Watch 启停、HTML CSS 注入和文件变更语义。
3. Windows 首验、Linux 构建与基础回归。
4. 确认稳定后删除 `webviewTag`、`env.d.ts` 中的 `<webview>` 声明和旧 HTML/Watch 组件实现。
5. 接入 Browser Surface、浏览器工具条、标签恢复、书签和业务链接接管。

最终不保留 Webview 与 WebContentsView 双轨实现。

## 结果

### 正面结果

- Browser、Office HTML、Office Watch 共享统一的原生视图生命周期和安全策略。
- CenterArea 继续只处理逻辑标签与业务 destination，不感知 Electron 原生视图细节。
- 主进程可以集中处理弹窗、下载、权限、证书和崩溃，避免各页面重复实现。
- Browser Surface 能保留登录态和后台页面状态，适合回归/CQP 长时间查看。
- 未来若需要替换底层承载方式，调用方只依赖 Surface seam。

### 代价与风险

- `WebContentsView` 不能可靠地被 DOM z-index 覆盖，所有应用级 overlay 必须接入统一隐藏/恢复策略。
- bounds 同步依赖 BrowserWindow 坐标测量，必须覆盖窗口移动、缩放、最大化、左右栏拖拽和底部面板变化。
- 每标签独立 webContents 会增加内存；12 个标签软上限只提示，不自动治理。
- SSO 临时浮层、证书单次继续、下载保存对话框和文件上传都需要跨平台人工验收。
- 旧 Office ADR/Glossary 中关于 webview 的描述在迁移完成后必须更新。

## 未决实施细节

- View Manager 的具体 IPC 协议和 Surface diff 算法。
- Browser settings/data 文件的具体位置、版本号、损坏恢复和原子写入格式。
- SSO 弹窗完成判定：按 URL、窗口关闭、renderer 消息或业务站点回调组合判断。
- Windows/Linux 下窗口坐标、DPI 缩放和 BrowserWindow 移动后的 bounds 测量方式。
- 认证临时浮层的尺寸、位置、关闭条件和用户可见标题。

## 参考

- [ADR 0015: officecli 集成](./0015-officecli-integration.md)
- [PRD: 内置网页工作区](../prd-in-app-browser.md)
- [Issues: 内置网页工作区](../issues-in-app-browser.md)
