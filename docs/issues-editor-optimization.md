# Issues：代码编辑器优化 — UI 美化 · 布局增强 · Vim 模式

> **Parent PRD**: [PRD: 代码编辑器优化](./prd-editor-optimization.md)
>
> **Prototype**: [编辑器优化原型](./prototypes/editor-optimization.html)
>
> **Glossary**: [术语表](./adr/glossary.md)
>
> 以下 Issue 按依赖顺序排列，采用可独立验证的垂直切片。

---

## Issue #1：编辑器 store 与 Vim 模式集成

### What to build

新建 Zustand store 管理编辑器偏好（`vimEnabled: boolean`），持久化到 localStorage。安装 `@replit/codemirror-vim` 6.4.0，在 `FileEditor` 组件中根据 `vimEnabled` 开关条件加载 `vim()` CodeMirror extension。在设置面板「外观」Tab 中新增 Vim 模式开关。Vim 状态栏渲染在编辑器底部，显示当前模式（`NORMAL`/`INSERT`/`VISUAL`/`COMMAND`），模式标识使用主题色。Vim 的 `:w` 命令触发文件保存（等效于 `Ctrl+S`）。Insert 模式下 `Ctrl+S` 不被 Vim 拦截。

### Acceptance criteria

- [ ] 新建 `useEditorStore`，管理 `vimEnabled` 状态，默认 `false`
- [ ] `vimEnabled` 持久化到 localStorage key `socverify:editor`，应用重启后恢复
- [ ] 安装 `@replit/codemirror-vim` 6.4.0，peer dependencies 与已安装 CodeMirror 6 包匹配
- [ ] `FileEditor` 读取 `vimEnabled`，为 `true` 时在 extensions 数组中加入 `vim()` 扩展
- [ ] 设置面板「外观」Tab 新增 Vim 模式开关，切换后立即生效
- [ ] 编辑器底部 Vim 状态栏显示当前模式（`NORMAL`/`INSERT`/`VISUAL`/`COMMAND`），颜色随模式变化
- [ ] Vim Normal 模式下 `:w` 触发文件保存（与 `Ctrl+S` 等效）
- [ ] Vim Insert 模式下 `Ctrl+S` 正常保存文件，不被 Vim 拦截
- [ ] Vim 开关关闭后编辑器恢复标准快捷键行为，无残留影响
- [ ] `npm run typecheck && npm run lint` 通过
- [ ] 新增 `tests/stores/editor-store.test.ts` 覆盖 `vimEnabled` 默认值、setVimEnabled、localStorage 持久化
- [ ] 新增 `tests/ui/editor-file-editor.test.tsx` 覆盖 Vim 开关开启/关闭时 extensions 差异

### Blocked by

None — 可立即开始。

---

## Issue #2：语法高亮主题增强

### What to build

为项目 4 套主题（Drafting/Bench/Slate/Daylight）各定制一套 CodeMirror 语法高亮色。在 `globals.css` 中为每套 `[data-theme="xxx"]` block 添加语法高亮 CSS 变量（`--syn-keyword`/`--syn-string`/`--syn-number`/`--syn-comment`/`--syn-function`/`--syn-type`/`--syn-property`）。用 `@codemirror/language` 的 `HighlightStyle.define()` + `syntaxHighlighting()` 创建高亮 extension，高亮色引用 CSS 变量（如 `color: 'var(--syn-keyword)'`）。`FileEditor` 根据 `currentTheme` 选择对应高亮 extension，切换主题时语法色自动联动。

### Acceptance criteria

- [ ] `globals.css` 中 4 套主题各有完整的语法高亮 CSS 变量定义
- [ ] 语法色使用 OKLCH 值，与各主题的强调色和状态色语义一致
- [ ] `HighlightStyle.define()` 正确映射 `@lezer/highlight` tags 到 CSS 变量：keyword/string/number/comment/function/typeName/propertyName
- [ ] `FileEditor` 根据 `currentTheme` 加载对应的语法高亮 extension
- [ ] 切换主题（Bench → Drafting）时代码语法高亮颜色立即变化，无需重载编辑器
- [ ] SystemVerilog 关键字（`module`/`always`/`assign`/`wire`/`reg`/`input`/`output`/`begin`/`end`/`endmodule`）正确高亮
- [ ] 注释显示为斜体灰色，字符串为绿色，数字为金色
- [ ] `npm run typecheck && npm run lint` 通过
- [ ] `tests/ui/editor-file-editor.test.tsx` 覆盖不同主题下高亮 extension 的加载

### Blocked by

None — 可立即开始。

---

## Issue #3：面包屑导航与底部状态栏

### What to build

将 `FileEditor` 工具栏中的完整文件路径字符串替换为面包屑导航组件：将 `filePath` 按路径分隔符拆分为段，每段渲染为可点击的面包屑项（`project › rtl › subsys › file.sv`），点击中间段调用左栏导航在文件树中定位到对应父目录。新建 `EditorStatusBar` 组件渲染在 `FileEditor` 底部，通过 CodeMirror `updateListener` extension 监听选区变化实时更新行列号。状态栏显示：保存状态（已保存/已修改）、行列号（`Ln 42, Col 16`）、编码（UTF-8）、换行符（LF/CRLF）、语言标识（从扩展名映射）、缩进大小（从 `basicSetup.tabSize` 读取）。

### Acceptance criteria

- [ ] 工具栏不再显示完整路径字符串，改为面包屑导航分段展示
- [ ] 面包屑点击中间段（如 `rtl`）能在左栏文件树中定位到对应父目录
- [ ] 面包屑最后一段（文件名）为高亮活动状态，不可点击
- [ ] `EditorStatusBar` 渲染在 `FileEditor` 底部，样式与 `globals.css` 的状态栏 CSS 一致
- [ ] 状态栏显示当前光标行列号，光标移动时实时更新
- [ ] 状态栏显示语言标识（如 `SystemVerilog`/`Python`/`JSON`），从文件扩展名映射
- [ ] 状态栏显示编码（UTF-8）和缩进大小（`Tab: 2`）
- [ ] 保存后状态栏从「已修改」变为「已保存」
- [ ] `npm run typecheck && npm run lint` 通过
- [ ] `tests/ui/editor-file-editor.test.tsx` 覆盖面包屑渲染路径段、点击导航回调、状态栏文本

### Blocked by

None — 可立即开始。

---

## Issue #4：缩进指南线与搜索替换面板

### What to build

在 `FileEditor` 的 CodeMirror extensions 中添加缩进指南线 ViewPlugin：遍历可见行（`EditorView.viewport` 范围）的缩进层级，在每个缩进级别位置渲染一条淡色竖线（`border-left: 1px solid var(--border)`），仅渲染视口可见行。绑定 `@codemirror/search` 的 `searchKeymap` 到 `Ctrl+F`（搜索面板）和 `Ctrl+H`（替换面板），搜索面板 CSS 通过 `.cm-panel.cm-search` 选择器适配主题色。增强括号匹配高亮对比度（通过 CSS 变量提升 `.cm-matchingBracket` 的背景和边框颜色）。

### Acceptance criteria

- [ ] 编辑器显示缩进指南线，每个缩进级别一条淡色竖线
- [ ] 缩进指南线颜色使用 `--border` CSS 变量，随主题变化
- [ ] 缩进指南线仅渲染视口可见行，大文件不卡顿
- [ ] `Ctrl+F` 打开 CodeMirror 内置搜索面板
- [ ] `Ctrl+H` 打开搜索替换面板
- [ ] 搜索面板样式适配主题（背景色、边框、文字色使用 CSS 变量）
- [ ] 括号匹配高亮对比度提升（背景色 + 边框更明显）
- [ ] `npm run typecheck && npm run lint` 通过
- [ ] `tests/ui/editor-file-editor.test.tsx` 覆盖 `Ctrl+F` 快捷键触发搜索面板

### Blocked by

None — 可立即开始。

---

## Issue #5：Minimap 缩略图

### What to build

在 `FileEditor` 右侧创建 60px 宽的 minimap 容器，基于 CodeMirror 6 `ViewPlugin` 自定义实现：将每行文本长度映射为一条短色块（高度 2px，宽度按行长度比例），色块颜色使用主题色（引用 `--fg-faint` CSS 变量）。视口位置用半透明矩形标识。点击 minimap 跳转到对应行，拖拽同步滚动。大文件（>2000 行）采样显示，每 N 行取一条。使用 `requestAnimationFrame` 节流渲染。minimap 可通过设置开关关闭。

### Acceptance criteria

- [ ] 编辑器右侧显示 60px 宽 minimap 缩略图
- [ ] minimap 中每行映射为一条短色块，宽度按行长度比例
- [ ] minimap 中视口位置用半透明矩形标识
- [ ] 点击 minimap 跳转到对应行，拖拽同步滚动
- [ ] 大文件（>2000 行）采样显示，不卡顿
- [ ] minimap 色块颜色随主题变化
- [ ] minimap 可通过设置开关关闭
- [ ] `npm run typecheck && npm run lint` 通过
- [ ] `tests/ui/editor-file-editor.test.tsx` 覆盖 minimap 容器渲染

### Blocked by

- Issue #2（语法高亮主题增强 — minimap 色块需要引用主题色 CSS 变量）
