# PRD：内置网页工作区与 WebContentsView 统一承载

> **Parent ADR**: [ADR 0016: 统一使用 WebContentsView 承载网页与文档 Surface](./adr/0016-webcontentsview-surfaces.md)
>
> **Glossary**: [术语表](./adr/glossary.md)
>
> **Issues**: [Issues: 内置网页工作区](./issues-in-app-browser.md)

## 1. 目标

为 SoC Verify 增加内置网页工作区，支持回归网页、CQP 网页及其他常用 Web 页面查看，同时将现有 Office HTML/Watch 预览从 Electron `<webview>` 迁移到 `WebContentsView`。

目标不是构建完整 Chrome 替代品，而是在验证工程师已有的 CenterArea 工作区中提供可持续使用、可保存登录态、可与业务链接联动的网页 Surface。

## 2. 已确认范围

### 2.1 工作区与标签

- 网页融入现有 CenterArea。
- 一网页对应一个中栏 workbench 标签，不增加第二层网页标签栏。
- 网页标签属于全局应用状态，切换项目时继续保留。
- 打开网页标签时立即创建并开始加载 Browser Surface。
- 重复打开标准化后的相同 URL 时激活已有标签。
- 应用重启恢复全部网页标签的 URL、顺序和最后激活项，页面内容重新加载。
- 每个网页标签对应一个独立 `WebContentsView`，后台网页保活。
- 默认 12 个网页标签为软上限，超过时提示用户但不自动销毁。

### 2.2 浏览控制

Browser Surface 始终显示 React 导航控制条：

- 地址栏（仅接受 `http`/`https`）
- 后退、前进、刷新
- 当前页收藏/取消收藏
- 在系统浏览器打开
- 页面加载状态和协议提示
- 基础网页查找（Ctrl+F）

首期快捷键：Ctrl+L、Ctrl+R/F5、Alt+Left/Right、Ctrl+D；Ctrl+W 复用应用关闭标签命令。

### 2.3 书签与常用网页

- 书签为全局数据。
- 书签支持名称、URL、单层分组、组内排序、常用标记。
- “常用网页”不是第二套数据，而是书签条目的常用投影。
- 新标签首页提供地址输入、常用书签和按分组浏览。
- 中栏“+”菜单增加“新建网页”。
- 支持书签 JSON 导入与导出。

### 2.4 业务链接

- 回归、CQP、插件等业务区域中的 `http/https` 链接默认打开到内置网页标签。
- 聊天 Markdown、帮助和设置中的链接首期继续交给系统浏览器。
- 普通 `window.open`/`target=_blank` 创建新网页标签。
- SSO/OAuth/MFA 认证弹窗使用受控临时浮层，保留 opener 关系，完成后自动关闭或返回来源页。
- 首期不绑定回归/CQP 特定数据结构；业务模块只依赖“在内置浏览器打开 URL”的统一入口。

### 2.5 网络与安全

- Browser Surface 主框架只允许 http/https。
- file:// 只允许由用户主动选择或业务入口明确创建，不允许地址栏输入任意本地路径。
- 证书错误默认阻止，仅允许单次继续，不永久信任。
- 摄像头、麦克风、通知、地理位置、自动播放等敏感权限默认拒绝并提示。
- 剪贴板仅允许用户手势读写。
- 文件上传仅支持用户主动打开系统文件选择器。
- 网页下载调用系统保存对话框，提示开始/完成/失败。
- 复用 Electron/系统默认代理配置。
- 网页不启用 Node/Electron 权限。

### 2.6 文档预览迁移

- 新增主进程统一 View Manager。
- Office HTML 和 Watch 统一建模为 Document Surface。
- HTML source 为 local-file，Watch source 为 local-server。
- HTML 视口填充 CSS 由 View Manager 在页面就绪后注入。
- Watch 的启动、停止和清理由 Document Surface 协调器负责。
- 切换离开 HTML/Watch、切换预览模式或关闭文档标签时立即销毁对应 View；Watch 同时停止服务。
- Screenshots、PDF、Fortune-sheet XLSX 编辑器仍保留当前 React/图片/PDF/表格方案。
- 完成迁移后删除 webviewTag 和旧 webview 类型声明/组件。

### 2.7 布局与状态

- Browser Surface 顶部导航条和 Document 模式条由 React 渲染。
- WebContentsView 只占对应 DOM 容器下方区域。
- Renderer 使用 ResizeObserver 上报相对 BrowserWindow 的 bounds。
- View Manager 校验 bounds 并设置原生视图位置。
- 应用级 overlay 打开时隐藏活动原生视图，关闭后恢复并重新同步 bounds。
- URL、标题、加载、失败、崩溃等状态由主进程 webContents 事件驱动，Renderer store 保存投影。
- 单个 View 崩溃时显示标签内错误页和手动重载，不影响其他标签。

### 2.8 持久化

- Browser Surface 使用专属持久化 session，网页标签和书签使用主进程用户级 browser settings/data 文件。
- Document Surface 使用隔离非持久化 session。
- 标签、导航和书签变更采用防抖保存；应用退出前主进程同步刷盘。
- 设置提供清理 Browser session Cookie、缓存和站点数据入口。

## 3. 用户故事

1. 作为验证工程师，我希望从中栏“+”菜单打开网页，以便在不离开 SoC Verify 的情况下查看回归平台和 CQP。
2. 作为验证工程师，我希望网页拥有独立标签、地址栏和基本导航，以便并行查看多个结果页面。
3. 作为验证工程师，我希望登录态在应用重启后保留，以便减少企业 SSO/MFA 重复操作。
4. 作为验证工程师，我希望将页面收藏并按回归/CQP/文档分组，以便快速回到常用入口。
5. 作为验证工程师，我希望业务区域内的回归/CQP 链接自动打开到内置网页标签，以便保留工作上下文。
6. 作为验证工程师，我希望网页内部的新窗口打开成新标签，以便对比详情而不覆盖来源页。
7. 作为验证工程师，我希望 SSO/OAuth 登录弹窗在应用内正常工作，以便认证后的登录态回到内置网页。
8. 作为验证工程师，我希望下载报告时选择保存位置，以便明确管理回归产物。
9. 作为验证工程师，我希望上传日志时只能由自己选择文件，以便避免网页静默读取本地文件。
10. 作为验证工程师，我希望 HTML/Watch Office 预览继续可用，同时底层统一为 WebContentsView，以便减少两套原生网页承载实现。
11. 作为维护者，我希望原生视图生命周期、权限和 bounds 同步集中在主进程 View Manager，以便降低跨业务重复实现。

## 4. 非目标

首期不包含：

- 完整浏览历史、下载历史或下载管理器。
- Chrome/Edge 书签 HTML 格式兼容；只做约定的 JSON 格式。
- 多级收藏夹树、标签化书签和跨项目书签。
- 系统浏览器 Cookie 导入。
- 独立代理编辑器。
- 完整站点权限面板。
- 任意 file:// 地址栏访问。
- 自动发现或解析回归/CQP 业务数据生成详情 URL。
- macOS 首期完整验收。
- WebContentsView 与 webview 双轨长期保留。

## 5. 验收重点

### Windows

- 中栏左右栏宽度、底部面板、窗口移动、最大化和 DPI 缩放下，WebContentsView 与 DOM 容器保持一致。
- 网页前进、后退、刷新、重定向、标题更新、URL 更新和相同 URL 复用正确。
- 持久化登录态、SSO/OAuth/MFA 认证浮层、普通新窗口标签正确。
- 证书异常单次继续、敏感权限拒绝、上传、下载和系统浏览器打开正确。
- 书签 CRUD、分组排序、常用标记、JSON 导入导出和重启恢复正确。
- Office HTML/Watch 迁移后仍可预览；Watch 切换/关闭/退出无孤儿进程。
- 单 View 崩溃后错误占位和手动重载不影响其他标签。

### Linux

- 构建、类型检查和单元测试通过。
- 基础 http/https 加载、CenterArea 标签、bounds 同步和 Office HTML/Watch 预览回归通过。
- 进程、下载、证书和窗口行为记录平台差异。

## 6. 实施阶段

1. View Manager 核心与 Surface 类型
2. bounds/visibility/overlay 同步
3. Document Surface 迁移 HTML
4. Document Surface 迁移 Watch 与生命周期清理
5. 删除 webviewTag 与旧类型/组件
6. Browser Surface 基础加载与导航控制条
7. 全局网页标签、恢复与崩溃错误页
8. 书签、常用入口和 JSON 导入导出
9. 弹窗/SSO、下载/上传、权限/证书策略
10. 业务区域链接接管与基础查找/快捷键
11. Windows 人工验收、Linux 回归、性能与文档收尾
