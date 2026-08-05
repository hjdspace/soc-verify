# Issues：内置网页工作区与 WebContentsView 迁移

> **Parent PRD**: [PRD: 内置网页工作区](./prd-in-app-browser.md)
>
> **Parent ADR**: [ADR 0016: WebContentsView Surface](./adr/0016-webcontentsview-surfaces.md)
>
> **Glossary**: [术语表](./adr/glossary.md)
>
> 以下 Issue 按依赖顺序排列，采用可独立验证的垂直切片。最终不得保留 `<webview>` 双轨实现。

---

## Issue #1：View Manager 核心与 Surface 协议 ✅

### What to build

在主进程建立统一 View Manager，定义 Browser/Document Surface 描述、生命周期、事件和声明式同步 seam。Renderer 不直接访问 `WebContentsView` 或 `webContents`。

### Acceptance criteria

- [x] View Manager 支持 create/update/show/hide/destroy 的幂等同步。
- [x] Surface ID 在应用窗口内唯一，重复声明不重复创建 View。
- [x] 主进程统一发出 URL、title、loading、failure、crash 事件。
- [x] 单个 Surface 崩溃不会关闭应用或其他 Surface。
- [x] Surface 销毁时解除全部 listener 并销毁 webContents。
- [x] View Manager 有独立单测，覆盖重复声明、销毁、事件清理和异常路径。
- [x] `npm run typecheck && npm run test` 通过。

### Blocked by

None.

---

## Issue #2：bounds、可见性与 Overlay 同步 ✅

### What to build

Renderer 提供 Surface 容器，使用 ResizeObserver 测量相对 BrowserWindow 的 bounds；主进程校验并设置 WebContentsView bounds。建立统一 overlay 隐藏/恢复机制。

### Acceptance criteria

- [x] CenterArea 左右栏拖拽、折叠、底部面板变化时 bounds 正确更新。
- [x] 窗口最大化、还原、移动和 DPI 缩放后不发生明显偏移。
- [x] 非活动 Surface 不显示且不遮挡 React UI。
- [x] 设置、命令面板、向导和下拉菜单打开时活动 View 隐藏，关闭后恢复。
- [x] 高频 ResizeObserver 更新被合并，避免 IPC 风暴。
- [x] 0/负数/越界 bounds 被主进程拒绝或裁剪。

### Blocked by

- Issue #1

---

## Issue #3：迁移 Office HTML 为 Document Surface ✅

### What to build

将 HtmlPreview 从 `<webview>` 迁移到 Document Surface。保留 officecli `viewHtml`、file source、加载/错误 UI 和现有视口填充 CSS 注入。

### Acceptance criteria

- [x] `.docx/.pptx` HTML 模式不再渲染 `<webview>`。
- [x] officecli 生成 HTML 后由 Document Surface 加载。
- [x] View Manager 在页面就绪后注入视口填充 CSS。
- [x] 模式切换或标签关闭立即销毁对应 Surface。
- [x] file source 只接受文档协调器产出的授权路径。
- [x] officecli 不可用时的降级提示保持不变。
- [x] 现有 Screenshots/PDF/XLSX 行为不回归。

### Blocked by

- Issue #2

---

## Issue #4：迁移 Office Watch 与生命周期协调 ✅

### What to build

建立 Document Surface 协调器：启动 officecli Watch，创建 local-server source，销毁时停止 Watch。覆盖模式切换、标签关闭、窗口关闭、启动竞态和错误清理。

### Acceptance criteria

- [x] Watch 模式不再渲染 `<webview>`。
- [x] 进入 Watch 后启动服务并加载 localhost URL。
- [x] 离开 Watch、关闭标签、关闭窗口和应用退出都会停止服务。
- [x] 启动尚未完成时切走，成功返回后也会立即停止，不能泄漏进程。
- [x] Watch 启动失败显示错误占位，不遗留 Surface。
- [x] 热更新行为与现状一致。
- [x] 测试覆盖取消竞态和重复销毁。

### Blocked by

- Issue #3

---

## Issue #5：删除 `<webview>` 基础设施 ✅

### What to build

完成 Office 回归后删除旧承载方式，确保应用只使用 WebContentsView。

### Acceptance criteria

- [x] 删除 BrowserWindow 的 `webviewTag: true`。
- [x] 删除 renderer `env.d.ts` 中 JSX `<webview>` 和 WebviewAttributes 声明。
- [x] 删除或重写旧 HtmlPreview/WatchPreview 的 webview 事件代码。
- [x] 全仓无业务 `<webview>` 标签和 `persist:office-preview` 依赖。
- [x] 构建、类型检查和 Office 预览测试通过。

### Blocked by

- Issue #4

---

## Issue #6：Browser Surface、导航条和新标签首页 ✅

### What to build

新增 browser destination、全局 browser store、新标签首页和始终可见的导航控制条。地址栏仅接受 http/https。

### Acceptance criteria

- [x] 中栏“+”菜单可新建网页标签。
- [x] 新标签首页显示地址输入、常用书签占位和分组入口。
- [x] 提交 URL 后立即创建 Browser Surface 并加载。
- [x] 后退、前进、刷新、加载状态和系统浏览器打开可用。
- [x] URL、title、canGoBack/canGoForward、loading 状态由主进程事件更新。
- [x] 非 http/https 地址栏输入被拒绝并明确提示。
- [x] 相同标准化 URL 复用已有标签。

### Blocked by

- Issue #5

---

## Issue #7：全局网页标签持久化与资源策略 ✅

### What to build

网页标签独立于项目状态保存到主进程用户级 browser data 文件；支持重启恢复、顺序、激活项和 12 标签软上限。

### Acceptance criteria

- [x] 切换/关闭项目不会关闭网页标签。
- [x] 应用重启恢复 URL、标题、顺序和最后激活项并重新加载。
- [x] 变更采用防抖保存，退出前同步刷盘。
- [x] 文件写入采用版本化和原子替换，损坏时可回退为空状态并提示。
- [x] 超过 12 个网页标签提示，不自动关闭或卸载后台页。
- [x] 单个 View 崩溃显示 React 错误页和手动重载。

### Blocked by

- Issue #6

---

## Issue #8：书签、常用网页和数据管理 ✅

### What to build

实现全局书签 CRUD、单层分组、组内排序、常用标记、新标签首页投影和 JSON 导入导出。

### Acceptance criteria

- [x] 可新增、编辑、删除书签和分组。
- [x] 可调整组内顺序并标记常用。
- [x] 收藏当前页使用主进程事件提供的当前 URL/title。
- [x] 常用项显示在新标签首页，不维护第二套 URL 数据。
- [x] JSON 导入校验版本、字段、URL 协议和重复项。
- [x] JSON 导出可恢复全部书签、分组、排序和常用状态。
- [x] 设置中可清理 Browser session Cookie、缓存和站点数据。

### Blocked by

- Issue #7

---

## Issue #9：新窗口、SSO/OAuth/MFA 与证书策略 ✅

### What to build

统一处理 `window.open`。普通业务窗口进入新网页标签；认证流程使用保留 opener 的受控临时浮层。实现证书风险页和单次继续。

### Acceptance criteria

- [x] 普通 target=_blank/window.open 打开新网页标签。
- [x] 认证弹窗使用同一 Browser session 并保留 opener。
- [x] 认证完成/窗口关闭后浮层被销毁，不残留 workbench 标签。
- [x] 覆盖至少一种重定向 SSO、一种 OAuth popup 和一种 MFA 流程。
- [x] 证书错误默认阻止并显示风险信息。
- [x] 用户只能对当前访问单次继续，不写入永久信任。
- [x] 非 http/https/file 授权 source 被拒绝或安全地交给系统处理。

### Blocked by

- Issue #6

---

## Issue #10：下载、上传、权限与剪贴板 ✅

### What to build

在 Browser session 上统一配置下载、文件选择和权限处理。

### Acceptance criteria

- [x] 下载弹出系统保存对话框并提示开始、完成和失败。
- [x] 取消保存不会留下半成品或错误提示。
- [x] 文件上传只能由用户手势触发系统文件选择器。
- [x] 摄像头、麦克风、通知、地理位置和自动播放默认拒绝并提示。
- [x] 剪贴板只允许用户手势触发的读写。
- [x] Browser Surface 无 Node integration 和 Electron 权限。
- [x] Document session 与 Browser session 权限/数据隔离。

### Blocked by

- Issue #6

---

## Issue #11：页面查找、快捷键与业务链接接管

### What to build

增加 Ctrl+F 查找条和基础浏览器快捷键，并为回归/CQP/插件业务区域提供统一 `openInBrowser(url)` seam。

### Acceptance criteria

- [ ] Ctrl+F 显示查找条，支持上一项、下一项、匹配数和关闭。
- [ ] Ctrl+L、Ctrl+R/F5、Alt+Left/Right、Ctrl+D 在 Browser Surface 激活时生效。
- [ ] Ctrl+W 继续走 workbench 关闭标签逻辑。
- [ ] 回归、CQP、插件业务区域链接默认进入 Browser Surface。
- [ ] 聊天 Markdown、帮助和设置链接继续使用系统浏览器。
- [ ] 业务调用方不直接操作 View Manager，只调用统一 URL 打开 seam。

### Blocked by

- Issue #6
- Issue #8

---

## Issue #12：跨平台验收、性能与文档收尾

### What to build

完成 Windows 详细验收、Linux 基础回归、性能观察、旧文档修订和发布准备。

### Acceptance criteria

- [ ] Windows 覆盖 bounds、DPI、最大化、SSO、下载、上传、证书、权限和 Office 迁移。
- [ ] Linux 构建、类型检查、单测和基础 http/https、bounds、Office HTML/Watch 回归通过。
- [ ] 12 个后台网页标签下记录内存和 CPU 基线，无失控增长或后台高占用。
- [ ] 应用退出无孤儿 WebContentsView、认证窗口或 officecli Watch 进程。
- [ ] ADR 0015、officecli PRD/Issues 和 glossary 中旧 webview 描述更新为 WebContentsView 实施结果。
- [ ] `npm run build && npm run typecheck && npm run lint && npm run test` 全部通过。

### Blocked by

- Issue #7
- Issue #8
- Issue #9
- Issue #10
- Issue #11
