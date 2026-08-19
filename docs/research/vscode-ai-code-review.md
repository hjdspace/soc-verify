# VS Code AI Code Review 实现考察

## 范围与版本

本文考察 `microsoft/vscode` 仓库在 commit [`5b7b8b53877c42d9f12dabf49bccb131a14451d7`](https://github.com/microsoft/vscode/tree/5b7b8b53877c42d9f12dabf49bccb131a14451d7) 中的 Chat Editing 实现。这里的 Chat Editing 是 Copilot/Agent 将编辑应用到工作区后，用户逐个 hunk 或逐个文件确认的 code review 流程。

## 关键实现

### 1. Review 状态属于编辑 session/file entry，不属于某个页面

每个修改文件由 `IModifiedFileEntry` 表示，状态是 `Modified`、`Accepted` 或 `Rejected`；文本文件的 `changesCount` 直接映射当前 diff 的 `changes.length`，所以用户处理一个 hunk 后导航计数会立即更新。文件 entry 会按 `IEditorPane` 缓存 editor integration，但该 integration 必须能适应 pane 后续切换的 editor input。

- 状态枚举与 hunk 接口：[`chatEditingService.ts#L335-L347`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/common/editing/chatEditingService.ts#L335-L347)
- `changesCount` 由动态 diff 驱动：[`chatEditingModifiedDocumentEntry.ts#L48-L63`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingModifiedDocumentEntry.ts#L48-L63)
- integration 按 pane 缓存，并明确要求处理 pane input 改变：[`chatEditingModifiedFileEntry.ts#L328-L345`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingModifiedFileEntry.ts#L328-L345)

### 2. 每个 hunk 的按钮是 editor overlay widget，不是普通 diff 文本

`ChatEditingCodeEditorIntegration._updateDiffRendering` 遍历 `diff.changes`。当 `reviewMode || diffMode` 为真时，它为每个 hunk 创建/复用 `DiffHunkWidget`，将 widget 放在 hunk 起始行旁边，并用 `MenuId.ChatEditingEditorHunk` 创建 toolbar。toolbar 的 `arg` 是当前 widget，因此 Keep/Undo 命令可以精确操作该 hunk；光标、鼠标 hover 和滚动会重新计算哪个 widget 显示。

- 根据每个 diff change 创建 widget：[`chatEditingCodeEditorIntegration.ts#L348-L469`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingCodeEditorIntegration.ts#L348-L469)
- hunk toolbar 将 widget 作为 command 参数：[`chatEditingCodeEditorIntegration.ts#L738-L790`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingCodeEditorIntegration.ts#L738-L790)
- hover/光标时只显示当前 hunk widget：[`chatEditingCodeEditorIntegration.ts#L486-L557`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingCodeEditorIntegration.ts#L486-L557)
- Keep/Undo hunk 调用 `acceptNearestChange`/`rejectNearestChange`，完成后可导航：[`chatEditingCodeEditorIntegration.ts#L663-L677`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingCodeEditorIntegration.ts#L663-L677)

### 3. Review mode 是按钮出现的前置条件

`ReviewChangesAction` 调用 `entry.enableReviewModeUntilSettled()`。该临时 flag 与自动接受配置合并成 `entry.reviewMode`；entry 一旦进入 Accepted/Rejected，就清理临时 review mode。integration 的 observable render loop 读取这个值；若为 false，hunk widget 和 review-only 的原始内容 view zone 不会渲染。

- review mode 的生命周期：[`chatEditingModifiedFileEntry.ts#L130-L140`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingModifiedFileEntry.ts#L130-L140) 与 [`chatEditingModifiedFileEntry.ts#L196-L215`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingModifiedFileEntry.ts#L196-L215)
- Review 命令只打开 entry 的 review mode：[`chatEditingEditorActions.ts#L363-L381`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingEditorActions.ts#L363-L381)
- integration 的 observable render loop 读取 review mode：[`chatEditingCodeEditorIntegration.ts#L183-L202`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingCodeEditorIntegration.ts#L183-L202)

### 4. “Review next file” 先找 entry，再打开真实文件并 reveal

Next/Previous action 先在当前 integration 中尝试下一个 hunk；当前文件没有下一个 hunk 时，遍历 `session.entries`，跳过非 `Modified` entry，调用 `editorService.openEditor({ resource: newEntry.modifiedURI })`，然后立刻通过 `newEntry.getEditorIntegration(pane).reveal(next)` 定位新文件的第一个/最后一个 change。这个顺序保证新页面拿到真实 entry，而不是复用旧文件的 toolbar 或 diff model。

- 文件间导航：[`chatEditingEditorActions.ts#L114-L174`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingEditorActions.ts#L114-L174)
- hunk resolve 后在没有剩余 change 时自动跳到下一文件：[`chatEditingEditorActions.ts#L273-L287`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingEditorActions.ts#L273-L287)

### 5. 文件级和全部操作挂在不同 toolbar，均由实时 context key 控制

VS Code 同时提供三层操作：

1. 普通编辑器内容 toolbar：当前文件 Keep/Undo，以及 session 级 `Keep All Chat Edits`。
2. 每个 hunk 的 overlay toolbar：Keep this Change / Undo this Change。
3. MultiDiff 编辑器：当前文件 Keep/Undo 与标题栏 Keep All Edits/Undo All Edits。

文件级按钮的 menu 条件要求当前资源属于 Chat Editing MultiDiff，并且不在 `decidedChatEditingResource` 中；会话级按钮要求 `hasUndecidedChatEditingResource`。这些 context key 从当前 session 的 entry state 派生，entry 状态改变后自动重新计算，因此切换文件或处理最后一个 hunk 后按钮会出现/消失，而不是依赖一次性初始化。

- hunk/文件/全部 action 定义及 menu 条件：[`chatEditingEditorActions.ts#L176-L225`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingEditorActions.ts#L176-L225) 与 [`chatEditingEditorActions.ts#L384-L457`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingEditorActions.ts#L384-L457)
- MultiDiff 当前文件 Keep/Undo 与 Chat Editing toolbar action：[`chatEditingActions.ts#L144-L192`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingActions.ts#L144-L192)
- 全部 Keep/Undo：[`chatEditingActions.ts#L194-L255`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingActions.ts#L194-L255)
- context key 由 entry state 派生：[`chatWidget.ts#L651-L676`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts#L651-L676)

### 6. 状态转换先做 I/O，再原子更新 UI 状态

单文件 accept/reject 通过 `acceptDeferred`/`rejectDeferred` 执行实际编辑或撤销，之后在 transaction 中写入 `Accepted`/`Rejected`。session 级操作会过滤掉正在流式修改或已经决策的 entry，并并行执行 I/O，最后在一次 transaction 中提交所有状态。这避免了按钮已经消失但文件仍未完成写入的中间状态。

- entry 的 deferred 状态转换：[`chatEditingModifiedFileEntry.ts#L221-L269`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingModifiedFileEntry.ts#L221-L269)
- session 的并行 I/O 与原子提交：[`chatEditingSession.ts#L425-L464`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingSession.ts#L425-L464)

### 7. MultiDiff 页面是 session 的派生资源，不是一次性快照

`getMultiDiffSourceUri` 将 session resource 编入自定义 URI；resolver 根据 URI 找回活动 session，`resources` observable 再从当前 entries 生成 MultiDiff 项。因而文件增删、accept/reject 和 hunk 数变化都能反映到页面。MultiDiff 标题栏 action 从该 URI 解出 session，再调用同一个 `session.accept()`/`session.reject()`。

- session URI 编解码：[`chatEditingService.ts#L458-L500`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/common/editing/chatEditingService.ts#L458-L500)
- MultiDiff resources 从 observable entries 派生：[`chatEditingServiceImpl.ts#L448-L516`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingServiceImpl.ts#L448-L516)
- MultiDiff 标题栏 action 解析 session 后执行全量操作：[`chatEditingEditorActions.ts#L412-L457`](https://github.com/microsoft/vscode/blob/5b7b8b53877c42d9f12dabf49bccb131a14451d7/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingEditorActions.ts#L412-L457)

## 对当前桌面问题的直接启示

“点击 Review next file 后，中间代码页没有 hunk 确认/拒绝和全部按钮”通常不是按钮文案问题，而是以下生命周期断点之一：

1. 切换文件后仍使用旧文件的 integration/diff model，导致新文件没有按新 entry 的 `diff.changes` 创建 overlay widgets。
2. 新 entry 没有被置于 review mode，render loop 中 `reviewMode || diffMode` 为假，于是 hunk widget 从未创建。
3. toolbar 只在首次打开页面时创建，未随 active URI/session entry 重新绑定；因此 context key 和 command 参数仍指向旧文件。
4. “全部接受/拒绝”只渲染在聊天面板或 MultiDiff 标题栏，而中间的普通代码编辑器没有独立的文件级 overlay toolbar。

建议按 VS Code 的边界修复：

- 以 session/entry 作为唯一 review 状态源；切换文件后重新解析当前 URI 对应 entry。
- 对新文件确保先启用 review mode，再基于当前 diff hunks 创建/重建 hunk controls；旧 integration 的 decorations/widgets 要清理。
- `Review next file` 的打开操作完成后，获取新 pane 的 integration 并显式 reveal；不要复用旧页面节点或旧 hunk 索引。
- 将 hunk 操作和文件/全量操作分成不同作用域；文件/全量按钮的可见性由当前 session 未决 entry 数实时驱动，accept/reject 成功后再更新状态。
- 所有异步 accept/reject 在文件写入完成后再改变状态，并在一次状态更新中刷新按钮和导航计数。

