# PRD：代码编辑器优化 — UI 美化 · 布局增强 · Vim 模式

> **Prototype**: [编辑器优化原型](./prototypes/editor-optimization.html)
>
> **Glossary**: [术语表](./adr/glossary.md)
>
> **Issues**: [Issues: 代码编辑器优化](./issues-editor-optimization.md)

## Problem Statement

SoC Verify 的文件编辑器基于 `@uiw/react-codemirror`（CodeMirror 6 内核），当前体验与 VSCode 相比存在明显差距：

1. **语法高亮不感知主题** — 编辑器主题仅 `dark`/`light` 二选一，CodeMirror 内置默认色不随项目 4 套主题（Drafting/Bench/Slate/Daylight）的 OKLCH 色彩体系变化，语法高亮在深色主题上对比度不足。

2. **布局信息密度低** — 工具栏仅显示完整文件路径字符串，无面包屑导航；无 minimap 缩略图，大文件（RTL 模块动辄上千行）导航困难；无底部状态栏（行列号、编码、语言标识、缩进大小），工程师缺少上下文反馈。

3. **缺少缩进指南线** — SystemVerilog/Verilog 代码嵌套深，无视觉缩进对齐参考，代码结构不直观。

4. **无 Vim 模式** — 大量 EDA 工程师有 Vim 使用习惯，当前编辑器只支持标准快捷键，无法切换到 Vim 键位。

## Solution

在现有 CodeMirror 6 基础上进行深度定制，不更换编辑器内核。分 4 个方向改进：

**语法高亮增强**：为 4 套主题各定制一套 `HighlightStyle`，通过 `@codemirror/language` 的 `syntaxHighlighting()` 注入，语法色使用 CSS 变量引用主题的 OKLCH 色值，切换主题时自动联动。

**布局组件新增**：
- 面包屑导航 — 将完整路径分段展示（`project › rtl › subsys › file.sv`），点击段可打开对应父目录
- 底部状态栏 — 显示行列号、编码（UTF-8）、换行符（LF/CRLF）、语言标识、缩进大小、保存状态
- 缩进指南线 — 通过 CodeMirror 6 `ViewPlugin` 自定义实现，或使用社区 `indentGuides` 方案
- 搜索替换面板 — `@codemirror/search` 已内置 `openSearchPanel`，绑定 `Ctrl+F`/`Ctrl+H` 快捷键即可

**Vim 模式集成**：使用 `@replit/codemirror-vim` 6.4.0（Replit 官方维护，peer dependencies 与项目已安装的 CodeMirror 6 包完全匹配），作为 CodeMirror extension 按需加载。在设置中添加 Vim 开关，持久化到 localStorage。Vim 状态栏（`NORMAL`/`INSERT`/`VISUAL` 模式标识）通过扩展的状态通知 API 渲染在编辑器底部。

**Minimap**：基于 CodeMirror 6 `ViewPlugin` 自定义实现简化的缩略行视图，侧边渲染，同步滚动，用 `requestAnimationFrame` 节流。大文件场景下限制采样行数保证性能。

## User Stories

1. 作为验证工程师，我希望编辑器的语法高亮颜色随主题切换自动变化，这样在 Bench（深色）主题和 Drafting（浅色）主题间切换时代码始终高对比度可读。

2. 作为验证工程师，我希望编辑器顶部有面包屑导航显示当前文件的路径层级（`my-chip › rtl › tb_subsys › alu_add.sv`），这样我能快速理解文件在项目中的位置。

3. 作为验证工程师，我希望点击面包屑的某一段可以打开对应的父目录（在左栏文件树中定位），这样我能快速导航到同目录的其他文件。

4. 作为验证工程师，我希望编辑器底部有状态栏显示当前光标行列号（`Ln 42, Col 16`），这样我在编辑大文件时知道光标位置。

5. 作为验证工程师，我希望状态栏显示当前文件的编码（UTF-8）、换行符（LF/CRLF）和语言标识（SystemVerilog），这样我能确认文件的元信息。

6. 作为验证工程师，我希望状态栏显示缩进大小（`Tab: 2` 或 `空格: 4`），这样我能快速确认缩进风格。

7. 作为验证工程师，我希望编辑器显示缩进指南线（每个缩进级别一条淡色竖线），这样在深层嵌套的 `begin/end` 块中能直观对齐代码结构。

8. 作为验证工程师，我希望按 `Ctrl+F` 打开搜索面板，按 `Ctrl+H` 打开搜索替换面板，这样我能在文件内快速查找和替换文本。

9. 作为有 Vim 习惯的验证工程师，我希望在设置中开启 Vim 模式，这样我可以用 `h/j/k/l`、`dd`、`yy`、`p`、`:wq` 等 Vim 键位编辑代码。

10. 作为有 Vim 习惯的验证工程师，我希望 Vim 模式开启后编辑器底部显示当前模式（`NORMAL`/`INSERT`/`VISUAL`/`COMMAND`），这样我能确认当前处于哪个 Vim 模式。

11. 作为有 Vim 习惯的验证工程师，我希望 Vim 模式支持完整的 Normal 模式命令（`w`/`b` 词移动、`0`/`$` 行首尾、`gg`/`G` 文件首尾、`ciw`/`daw` 文本对象操作），这样我的 Vim 肌肉记忆能直接迁移。

12. 作为有 Vim 习惯的验证工程师，我希望 Vim 模式支持 Visual 模式（`v` 字符可视、`V` 行可视、`Ctrl+V` 块可视），这样我能进行块选编辑。

13. 作为有 Vim 习惯的验证工程师，我希望 Vim 模式支持 `:` 命令模式（`:w` 保存、`:q` 关闭、`:wq` 保存并关闭、`:%s/old/new/g` 全局替换），这样我能使用 Vim 命令行指令。

14. 作为有 Vim 习惯的验证工程师，我希望 Vim 模式的 `:w` 命令能触发文件保存（等效于 `Ctrl+S`），这样我不需要切换回普通模式保存。

15. 作为验证工程师，我希望编辑器右侧有 minimap 缩略图，这样我能在上千行的 RTL 文件中快速跳转到大致位置。

16. 作为验证工程师，我希望在 minimap 上点击或拖拽可以快速跳转到对应位置，这样大文件导航更高效。

17. 作为验证工程师，我希望编辑器的括号匹配高亮更明显（匹配的括号有背景色和边框），这样在复杂表达式 `always @(*) begin ... end` 中能快速找到配对的括号。

18. 作为验证工程师，我希望 Vim 模式开关持久化（关闭应用重启后仍保持上次的设置），这样我不需要每次重新开启。

19. 作为验证工程师，我希望 Vim 模式关闭后编辑器恢复标准快捷键行为，这样 Vim 模式不影响不使用 Vim 的工程师。

20. 作为验证工程师，我希望语法高亮能正确识别 SystemVerilog 关键字（`module`/`endmodule`/`always`/`assign`/`wire`/`reg`/`input`/`output` 等），颜色语义与主题强调色一致。

21. 作为验证工程师，我希望编辑器在保存文件后状态栏的保存状态指示从「已修改」变为「已保存」，这样我能确认保存成功。

22. 作为验证工程师，我希望 Vim 的 Insert 模式下 `Ctrl+S` 仍然能保存文件（不被 Vim 模式拦截），这样我的保存习惯不被打断。

## Implementation Decisions

### 不更换编辑器内核

不将 CodeMirror 替换为 Monaco Editor。理由：Monaco ~5MB 包体积、需调整 CSP `default-src 'self'` 策略以加载 web worker、需重新映射 4 套主题、`monaco-vim` 第三方包维护弱。CodeMirror 6 的模块化扩展系统足以实现全部优化目标，且零增量包体积。

### Vim 扩展选型

使用 `@replit/codemirror-vim` 6.4.0。这是目前唯一成熟的 CodeMirror 6 Vim 扩展，由 Replit 官方维护。peer dependencies 为 `@codemirror/commands`/`@codemirror/language`/`@codemirror/search`/`@codemirror/state`/`@codemirror/view` 均 `6.x.x`，与项目已安装版本完全匹配。

### 语法高亮主题架构

为每套主题定义独立的 `HighlightStyle`，通过 `@codemirror/language` 的 `syntaxHighlighting(highlightStyle)` extension 注入。高亮色不硬编码，而是引用 CSS 变量（如 `var(--syn-keyword)`），在 `globals.css` 中为每套 `[data-theme="xxx"]` block 定义对应的语法色变量。切换主题时 CSS 变量联动，无需重载编辑器。

语法色语义映射（基于 OKLCH）：
- 关键字（`module`/`always`/`assign`）→ 紫色系（`--syn-keyword`）
- 字符串 → 绿色系（`--syn-string`）
- 数字 → 金色系（`--syn-number`）
- 注释 → 灰色系，斜体（`--syn-comment`）
- 函数名 → 青色系（`--syn-function`）
- 类型名 → 红色系（`--syn-type`）

### Vim 开关持久化

在现有 `useFontStore`（字体/字号 store）旁新建 `useEditorStore`（Zustand store），管理 `vimEnabled: boolean`，持久化到 `localStorage` key `socverify:editor`。在设置面板「外观」Tab 中新增 Vim 开关。`FileEditor` 组件通过 `useEditorStore` 读取 `vimEnabled`，按条件将 `vim()` extension 加入 CodeMirror extensions 数组。

### Vim 状态栏

`@replit/codemirror-vim` 的 `getCM()` API 提供模式变更通知。通过 `EditorView.plugin` 创建一个自定义 `PluginValue` 监听模式变更，将当前模式写入 React state，渲染在编辑器底部的状态栏区域。模式标识使用主题色（NORMAL → 绿、INSERT → 青、VISUAL → 金、COMMAND → 紫）。

### 面包屑导航

将 `filePath` 按路径分隔符拆分为段数组（`['my-chip', 'rtl', 'tb_subsys', 'alu_add.sv']`），每段渲染为可点击的面包屑项。点击中间段调用 `useWorkbenchStore` 的左栏导航能力，在文件树中定位到对应父目录。面包屑取代当前工具栏中完整路径字符串的展示。

### 底部状态栏

新建 `EditorStatusBar` 组件，渲染在 `FileEditor` 的底部。状态项：
- 保存状态（已保存/已修改）
- 光标行列号（从 CodeMirror `EditorSelection` 的 `head` position 计算）
- 编码（固定 UTF-8）
- 换行符（通过 tRPC `project.readFile` 返回的元信息判断，或文件内容 `\r\n` 检测）
- 语言标识（从文件扩展名映射）
- 缩进大小（从 `basicSetup.tabSize` 读取）

行列号通过 CodeMirror `updateListener` extension 监听选区变化，实时更新。

### 缩进指南线

使用 CodeMirror 6 `ViewPlugin` 自定义实现：遍历可见行的缩进层级，在每级缩进位置渲染一条淡色竖线（`border-left: 1px solid var(--border)`）。性能优化：仅渲染视口可见行，通过 `EditorView.viewport` 范围限制。

### 搜索替换面板

`@codemirror/search` 包已内置 `SearchQuery`、`openSearchPanel`、`findNext`、`findPrevious`、`replaceAll` 等命令。通过 `keymap.of([...searchKeymap])` 绑定 `Ctrl+F`（打开搜索面板）和 `Ctrl+H`（打开替换面板，需传入 `search` 配置）。搜索面板 UI 由 CodeMirror 内置渲染，样式通过 `.cm-panel.cm-search` CSS 选择器适配主题。

### Minimap

基于 CodeMirror 6 `ViewPlugin` 自定义实现：在编辑器右侧创建一个 60px 宽的 DOM 容器，将每行的文本长度映射为一条短色块（高度 2px，宽度按行长度比例）。视口位置用半透明矩形标识。点击 minimap 跳转，拖拽同步滚动。大文件（>2000 行）采样显示，每 N 行取一条。使用 `requestAnimationFrame` 节流渲染。

## Testing Decisions

### 测试策略

全部使用项目已有的 `tests/ui/` 测试 seam — `@testing-library/react` + `jsdom`，mock `trpc` 和 stores，渲染组件验证 DOM 行为。

### 好测试的原则

只测外部行为，不测实现细节。具体：
- **不**断言 CodeMirror 内部 state 或 extension 数组的内部结构
- **要**断言用户可感知的行为：Vim 开关切换后 CodeMirror 的 extensions 是否包含 Vim 扩展（通过 mock CodeMirror 的 `EditorView` 捕获传入的 extensions）、面包屑 DOM 是否渲染正确路径段、状态栏文本是否正确、保存按钮是否可点击

### 测试文件

新增 `tests/ui/editor-file-editor.test.tsx`，覆盖：
- 面包屑渲染正确路径段
- 面包屑点击触发导航回调
- 状态栏显示行列号、语言标识
- Vim 开关关闭时 extensions 不含 vim 扩展
- Vim 开关开启时 extensions 含 vim 扩展
- 搜索快捷键 `Ctrl+F` 触发搜索面板

新增 `tests/stores/editor-store.test.ts`，覆盖：
- `vimEnabled` 默认为 `false`
- `setVimEnabled(true)` 后 state 更新
- localStorage 持久化读写

### Prior Art

- `tests/ui/LeftRail.test.tsx` — mock `trpc` + stores + 渲染组件验证 DOM，是组件测试的模板
- `tests/composer-editor.test.tsx` — 纯 DOM 工具函数测试的模式
- `tests/stores/` 目录 — store 级测试的模式

## Out of Scope

1. **不更换编辑器内核** — 不迁移到 Monaco Editor或其他编辑器
2. **不实现 LSP 集成** — 不接入 Language Server Protocol，不做实时诊断、跳转定义、hover 提示
3. **不实现 AI 代码补全** — 编辑器自动补全仍使用 CodeMirror 内置的 `autocompletion`，不接入 AI 模型的 inline suggestion
4. **不实现多光标编辑** — 超出 CodeMirror 6 basicSetup 的多光标编辑暂不实现
5. **不实现文件对比（diff editor）** — 已有独立的 `DiffReviewView` 组件，不在此 PRD 范围内重构
6. **不实现代码格式化** — 不集成 formatter（如 `prettier`/`verible`），格式化按钮仅预留 UI 入口
7. **不修改 `ComposerEditor`** — 聊天输入框的 contentEditable 编辑器不在此次优化范围内
8. **不修改 `DiffReviewView`** — Diff 审阅视图使用 `highlight.js` 静态高亮，不在此次 CodeMirror 优化范围内

## Further Notes

- 原型文件位于 `docs/prototypes/editor-optimization.html`，可在浏览器中打开预览完整的 UI 效果。
- `@replit/codemirror-vim` 是 Replit 在其在线 IDE 产品中使用的 Vim 扩展，维护活跃，是 CodeMirror 6 生态中唯一可靠的 Vim 方案。
- 项目已有的 4 套 OKLCH 主题系统（Drafting/Bench/Slate/Daylight）是语法高亮增强的基础，CSS 变量联动机制已在 `globals.css` 的 `.cm-editor` 样式块中部分建立，扩展即可。
- CodeMirror 6 的模块化 extension 系统使所有优化都可以增量添加，不需要修改 `@uiw/react-codemirror` 的封装层。
