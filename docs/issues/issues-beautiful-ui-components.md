# Issues: beautiful-ui AI 交互组件引入（P0–P3 分批落地）

> **Parent PRD**: [docs/prd/prd-beautiful-ui-components.md](../prd/prd-beautiful-ui-components.md)
>
> **参考库**: beautiful-ui（MIT）— `D:\AI\beautiful-ui\`。所有组件为纯 React + CSS，零 motion 依赖；每个适配文件头部注释标注参考实现的绝对路径（PRD D3 规范）。
>
> 11 个切片按依赖顺序排列：#1 公共映射层是 #2–#10 的 blocker（✅ 已完成）；#2–#5（P0）在 #1 完成后可并行；#11、#12 随时可做。每片完成后执行增量验证（`npm run typecheck && npm run lint && npx vitest run tests/ui`，按改动范围裁剪）。

---

## Issue #1: 公共映射层 — token 映射 + keyframes + GlideMenu + 四 atom

**Labels**: `ready-for-agent` `p0` → **已完成**（2026-08-30）
**Blocked by**: None — can start immediately.

### What to build

所有组件引入的前置。在 `globals.css` / `ai-panel.css` 建立一次性映射（PRD D2），并适配共享小件：

- 颜色映射：beautiful-ui 的 `--surface/--ink/--line/--accent/--red(-tint)/--green(-tint)` 等 → 指向项目现有语义色变量（不引入 oklch 字面量）
- 手写语义阴影等值：`--shadow-hairline/btn/card/raised/overlay`（替代 shadow-plugin 阶梯）
- `--ease-out-strong = cubic-bezier(0.23,1,0.32,1)`；keyframes `pop-in / fade-up / fade-in / spin / shimmer-text`（与已有 `ap-fadeup/ap-stream-tail/ap-cursor` 收敛去重）
- GlideMenu 抽为共享组件：从 `ComposerMenu` 已有的 `.ap-menu-highlight` 滑动高亮模式泛化（测量 `[data-menu-row]` 行位置 + 高亮层 `top/height` 220ms 过渡）
- 适配 Button / EntityChip / ValuePill / Shimmer 四个 atom 进 `components/ui/`

参考（绝对路径）：

- token/keyframes/阴影/间距工具类：`D:\AI\beautiful-ui\app\globals.css`（`:root`/`.dark` 块、`@theme inline`、`--shadow-*`、`.primitive-card-pad/bar/footer` 约 L371–380）
- GlideMenu：`D:\AI\beautiful-ui\components\primitives\GlideMenu.tsx`
- Button：`D:\AI\beautiful-ui\components\atoms\Button.tsx`；EntityChip：`D:\AI\beautiful-ui\components\atoms\EntityChip.tsx`；ValuePill：`D:\AI\beautiful-ui\components\atoms\ValuePill.tsx`；Shimmer：`D:\AI\beautiful-ui\components\atoms\Shimmer.tsx`

### Acceptance criteria

- [x] 映射层落在 globals.css/ai-panel.css，无 oklch/hex 字面量（遵循 AGENTS.md 语义色约束）
- [x] GlideMenu 为共享组件，ComposerMenu 改为复用后现有 `tests/ui/composer-menu.test.tsx` 全绿
- [x] 四 atom 进入 components/ui/，带 beautiful-ui 来源绝对路径头注释
- [x] 亮/暗主题下映射层均正确（阴影、tint 色、hover 层级）
- [x] typecheck + lint + `npx vitest run tests/ui` 通过

### 落地记录（2026-08-30）

- **映射层**（`globals.css`，`@theme` 块之后）：颜色以「映射表注释」形式给出 bu→项目语义变量对照，组件一律用右侧项目变量；tint（14% 混卡面）/描边（28% 透明）在**使用点** `color-mix` 就地计算——不设全局 tint 中间变量，从而自动随主题与 `.ai-panel` 作用域取值。语义阴影 `--shadow-hairline/btn/card/raised/overlay` 为真实 token，亮档 `:root` + 暗档 `[data-shade='dark']`（投影加深，环保持 `--border`）；`ai-panel.css` 内按 DSW 设计语言重声明（先例 `.ap-echip`，暗档环转低透明白）。
- **keyframes 收敛**：canonical `fade-up / fade-in / pop-in / spin / shimmer-text` 落在 globals.css；删除 `ap-fadeup/ap-popin/ap-rotate`，`.ap-turnactions/.ap-followup-item/.ap-menu/ToolRunGroup/TodoPanel` 全部改指 canonical 名（注意 `fade-up` 位移由旧 6px 对齐参考实现改为 8px）。全库内联 `cubic-bezier(0.23,1,0.32,1)` 已替换为 `var(--ease-out-strong)`。
- **GlideMenu**（`components/ui/GlideMenu.tsx`）：支持受控（`activeIndex`，ComposerMenu 键盘导航场景，`offsetTop` 内容系测量保证滚动后对齐）与自驱动（hover/focus 测量，参考实现同款 gBR）两种驱动；`scrollActiveIntoView` 承接键盘导航滚动。ComposerMenu 复用后行为不变（夹紧测试全绿）。
- **四 atom**：`components/ui/` 下 `PillButton.tsx`（**命名避开既有 shadcn `button.tsx`——Windows 大小写不敏感文件系统同名冲突**；active 按压由全局 button:active 规则承担）、`EntityChip.tsx`、`ValuePill.tsx`、`Shimmer.tsx`，头注释均按 D3 标注参考绝对路径。测试 `tests/ui/glide-menu.test.tsx` + `tests/ui/bui-atoms.test.tsx`。
- **附带**：`.ai-panel` 语义重映射补充 `--fg-faint→--dsw-label-caption`（Shimmer 的 ink-3 等值在面板内取正确值）。

---

## Issue #2: ContextCards — 聊天引用展开 chunk 卡 + KB 预览升级

**Labels**: `ready-for-agent` `p0` → **已完成**（2026-08-30）
**Blocked by**: #1

### What to build

聊天回复的引用来源胶囊展开列表升级为 chunk 卡（标题栏：图标+标题+字符数；正文摘要；底部来源 chip 错峰淡入）；KB 文档预览页 AI 摘要卡同形态升级。落地：`AssistantActions` 的 `extractMessageReferences` + `SourceIcon` 链路；`KbPreviewTab`。注意参考实现 `tone` 存的是 Tailwind 类名（`bg-red`），改为项目语义色映射。

参考（绝对路径）：

- `D:\AI\beautiful-ui\components\primitives\ContextCards.tsx`（91 行，零依赖）
- 对应 CSS：`D:\AI\beautiful-ui\app\globals.css` 中 source-avatar / COMPONENT-SPECIFIC 区块

### Acceptance criteria

- [x] 引用来源展开后显示 chunk 卡（标题/字符数/摘要/来源 chip），chip 700ms 后 `i*80ms` 错峰淡入
- [x] 无引用时不渲染展开区
- [x] KB 预览页摘要卡升级为 chunk 形态，数据来自 kb-router 现有接口
- [x] 新增 `tests/ui/<context-cards>.test.tsx`：渲染、展开、chip 数量断言
- [x] typecheck + lint + 相关测试通过

### 落地记录（2026-08-30）

- **组件**（`components/ui/ContextCard.tsx`）：props 化 `ContextCard`（单卡）+ `ContextCardList`（列表层管理 chip 错峰）。数据契约 `ContextChunk = { key, icon, title, meta, body, source, badge?, tone?, action?, onClick?, href? }`，演示 CHUNKS 不进正式代码。参考实现 700ms 定时 + `i*80ms` `transitionDelay` 错峰原样保留；卡片入场 `fade-up` `i*100ms` 错峰；`tone` 由 Tailwind 类名（`bg-red`）改为 `BADGE_TONES` 语义色映射（red→`--status-fail`、green→`--status-pass`、orange→`--status-aborted`、accent→`--primary`、neutral→`--muted-foreground`），随主题自动取值。
- **错峰缝**：chip 淡入的 `transition` 拆三段——opacity/transform 走 `i*80ms` 错峰延迟，background-color（hover）零延迟即时响应（inline `transitionProperty/Duration/TimingFunction/Delay` 列表分别指定），避免 hover 被错峰延迟拖慢。
- **聊天引用落点**（`AssistantActions`）：`extractMessageReferences` 返回的 `MessageReference[]` 经 `refToChunk` 映射为 chunk 卡——文件项：标题=文件名、meta=行号区间（`L42`/`L42–50`）、body=全路径、source chip=目录+ext badge（可点击打开，渲染外链图标）；host URI 项：标题=显示路径、body=全 URI、source chip=`scheme://`（不可点击，渲染为 span）。保留 `.ap-sources-collapse` grid-rows 0fr→1fr 折叠外壳与 `.ap-sources-stack` 胶囊堆叠；旧的 `.ap-turnactions-sources/.ap-turnactions-source/.ap-source-name/.ap-source-meta` 扁平行样式已删（无引用点）。`SourceIcon` 导出 `refIdentity`+`SourceHue`，hue→ContextTone 收敛映射（blue/violet→accent、teal→green、rose→red、amber→orange）。
- **KB 预览落点**（`KbPreviewTab`）：AI 摘要卡升级为单卡 `ContextCard`，数据来自 kb-router `index` 接口经 `parseIndexMd` 解析的 `indexEntry`（title/summary）+ `doc.sourcePath`。meta=摘要字符数、body=摘要、source chip=源文件名+ext badge（pdf→red、csv/xlsx→green、docx→orange，对齐参考实现的 bg-red/bg-green 语义）；"AI 重新分类"按钮落在标题栏 `action` 槽（`.ap-ctx-regen`）；无摘要时保留虚线兜底卡。
- **样式**：`.ap-ctx-*` 落 globals.css（共享件，AI 面板内/外均可用——颜色一律取全局语义变量 `--card/--foreground/--muted/--border/--fg-faint/--accent`，阴影取映射层 `--shadow-card/--shadow-btn`）；reduced-motion 下入场改 `fade-in`（去位移）、chip 错峰延迟归零。测试 `tests/ui/context-cards.test.tsx`（7 例：渲染/chip 计数/700ms 错峰/收起不淡入/空列表/onClick/button-vs-span/tone 映射）+ `tests/ui/assistant-actions.test.tsx` 更新为 chunk 卡 DOM 断言。

---

## Issue #3: SearchList — CommandPalette 搜索强化 + HistoryView 复用

**Labels**: `ready-for-agent` `p0` → **已完成**（2026-08-30）
**Blocked by**: #1

### What to build

CommandPalette 补齐：匹配片段高亮、非空清除按钮（fade-in 150ms）、空状态卡片（图标座 + 主/副文案，fade-in 250ms）、行间滑动高亮（复用 Issue #1 GlideMenu）。保留现有 `trpc.search.global` 数据链路与键盘导航。同一模式反哺会话历史 `HistoryView` 搜索框。

参考（绝对路径）：

- `D:\AI\beautiful-ui\components\primitives\SearchList.tsx`（94 行）
- `D:\AI\beautiful-ui\components\primitives\GlideMenu.tsx`（Issue #1 已抽取）

### Acceptance criteria

- [x] 输入非空出现清除按钮，点击清空并聚焦输入框
- [x] 无匹配时显示空状态卡片（现有纯文本文案替换）
- [x] 鼠标移动/键盘 ↑↓ 时高亮块平滑滑动（220ms），当前项执行仍走 Enter
- [x] 现有 `tests/ui/command-palette.test.tsx` 全绿 + 新增空状态/清除按钮断言
- [x] typecheck + lint + 相关测试通过

### 落地记录（2026-08-30）

- **共享件**（`components/ui/SearchList.tsx`）：SearchList primitive 不整体搬（宿主输入行/列表布局各异），拆为三个可复用切片——`SearchClearButton`（X 清除按钮，150ms 淡入，清空+回焦由宿主 onClear 处理，支持 absolute 定位类注入）、`SearchEmptyState`（图标座 + 主/副文案卡，250ms 淡入）、`SearchMatch`（label 首个命中片段渲染 `<mark>`，大小写不敏感 indexOf，无命中原样渲染）。结果行与滑动高亮由宿主各自布局承担。
- **CommandPalette**：输入行非空出现清除按钮（点击清空 query、重置选中并回焦输入框；onChange 即重置 selectedIndex）；空状态由纯文本升级为 SearchEmptyState（主文案"没有匹配的命令"保留，副文案"调整关键词再试一次"，testid `command-palette-empty` 不变）；结果行 label 经 SearchMatch 做匹配片段高亮（`mark` text-primary，trpc 搜索结果同享）；行列表包进 GlideMenu 受控模式——hover `onMouseEnter` 与键盘 ↑↓ 同一 `selectedIndex` 索引驱动，高亮层 `.palette-row-highlight` 220ms `--ease-out-strong` 滑动，`scrollActiveIntoView` 承接键盘导航滚动；行自身 bg 移除（原 `bg-accent`/`hover:bg-accent/50` 由滑动高亮层承担），行入场 200ms 淡入。`trpc.search.global` 数据链路与 Enter 执行不变。
- **HistoryView**（RightPanel）：搜索框同模式反哺——非空清除按钮（absolute 右缘，`pr-2`/`pr-8` 让位切换，点击清空并回焦输入框）、会话名 SearchMatch 高亮、"未找到匹配的会话"升级为空状态卡（"暂无历史会话"真空态保持原形态）。
- **样式**（globals.css，keyframes 块之后）：`.search-clear-in/.search-empty-in/.search-row-in`（150/250/200ms fade-in）、`.search-empty-seat`（映射层 hairline 环）、`.palette-row-highlight`（220ms 滑动，底色取应用 accent 与面板选中态同源，圆角对齐行 rounded-lg）；reduced-motion 下入场动画与滑动过渡全关。
- **测试**：`tests/ui/command-palette.test.tsx` 新增 5 例（清除按钮出现/清空回焦、空状态卡结构、mark 高亮、空 query 无 mark、`data-menu-row` 挂载），文件顶部 stub `scrollIntoView`（jsdom 未实现，GlideMenu `scrollActiveIntoView` 依赖）。全量 `tests/ui` 1010 例中 1008 过；2 例失败为 CaseTreePanel 折叠用例，干净基线复跑同样失败，属预存问题与本次无关。

---

## Issue #4: RecommendationCard — 通用建议卡 + TVAISuggestionCard 通用化

**Labels**: `ready-for-agent` `p0` → **已完成**（2026-08-30）
**Blocked by**: #1

### What to build

通用建议卡组件：置信度 Meter（3 根竖条信号条）+ Alternatives 抽屉（grid-rows 0fr→1fr 展开，点击备选项提升为当前建议并重置 accepted）+ CTA 确认后 success 态 + `key={active.key}` 重挂载交叉淡入（180ms）。数据契约 `Option = { key, body, short, signal(0-3), tone, label, cta, ctaVariant }`。将 `TVAISuggestionCard` 重构到该组件上（confirmer/result/reason/confidence/analysis 映射，数据源 violation-router 不变），并为追问建议（session-router.generateFollowUps）接入第二场景。

参考（绝对路径）：

- `D:\AI\beautiful-ui\components\primitives\RecommendationCard.tsx`（173 行；依赖 Button/EntityChip/ValuePill，Issue #1 已适配）

### Acceptance criteria

- [x] 通用建议卡组件 props 化（Option 契约），无业务字段硬编码
- [x] Alternatives 抽屉展开/收起动画正确，切换备选后 CTA 重置为未接受态
- [x] TV 违例场景行为回归：确认/拒绝/重新分析仍写 confirmation store，现有相关测试全绿
- [x] followUps 场景接入建议卡形态
- [x] 新增组件测试（信号条格数、切换备选、accepted 态）
- [x] typecheck + lint + 相关测试通过

### 落地记录（2026-08-30）

- **组件**（`components/ui/RecommendationCard.tsx`）：props 化 `RecommendationCard`（options/title/preface/footerLeft/onAccept/accepted/acceptedLabel/alternativesLabel/othersLabel/disabled）+ `SignalMeter` 导出（3 根竖条，前 signal 根取 tone 色、其余取 `--input`——映射 `--line-strong`）。备选抽屉 grid-rows 0fr→1fr + opacity 300ms（曲线取映射层 `--ease-out-strong`，替代参考实现的内联 `cubic-bezier(0.16,1,0.3,1)`）；正文 `key={active.key}` 重挂载 `fade-in 180ms` 交叉淡入；切换备选 `setSelected(i) + setSelfAccepted(false)`（抽屉保持展开便于对比，同参考实现）；CTA 确认后 success 变体 + busy 时 Loader2 spinner + 禁用防重复。相比参考契约，`signal/tone/label` 改为**可选**——追问建议等无置信度语义的场景不渲染信号条与标签。单选项自动不渲染备选开关；`accepted` 支持外部受控（违例已确认态）；`disabled` 一键禁用全部交互（拒绝/加载中场景）。选中项在 options 缩短时夹紧防越界。
- **样式**（globals.css，`.ap-ctx-*` 块之后）：`.ap-rec-*` 落 globals.css 共享件（卡 `--shadow-card`、正文 `--muted-foreground`、抽屉行 hover 取 `--accent`，颜色一律全局语义变量，AI 面板内/外取值均正确）；reduced-motion 下抽屉去 grid-rows 高度过渡、保留 opacity 淡入。
- **TV 场景**（`TVAISuggestionCard` 重构）：`AISuggestion` → 单选项 `RecommendationOption` 映射——body=确认人/确认结果（pass/issue 徽章）/分析理由/详细分析字段行，short=reason 兜底；confidence→signal（≥0.7→3 格 pass 绿、≥0.4→2 格 aborted 橙、>0→1 格 fail 红）+ 标签「高置信度/需复核/低置信度 NN%」（confidence=0 不渲染信号条，对齐原卡）；违例上下文块落 `preface` 槽；「确认并应用」走 `applyAISuggestion`（数据源 violation-router 不变，仍写 confirmation store），「重新分析/拒绝」落 `footerLeft` 槽（语义不变），rejected 时 `disabled` + CTA 文案切「已拒绝」；`accepted={applied || isConfirmed}` 外部受控（手工确认对话框路径也覆盖）。
- **followUps 场景**（`AssistantActions`）：`.ap-followups` 胶囊列表升级为 `RecommendationCard`（第二场景）——首条为当前建议正文，其余进备选抽屉，CTA「发送追问」`sendMessage`（session-router.generateFollowUps 数据链路不变），无 signal/label；`data-testid="assistant-followups"` 保留。旧 `.ap-followups-label/.ap-followup-item` 样式已删（无引用点），`.ap-followups` 简化为外边距壳。
- **测试**：`tests/ui/recommendation-card.test.tsx`（11 例：SignalMeter 格数/零格、正文与页脚渲染、抽屉 0fr→1fr 与 aria-expanded、切换备选重置 accepted + 信号条随动、busy/accepted 态、外部受控 accepted、单选项无抽屉、无 signal 场景、disabled 全禁、空 options 渲染 null）+ `tests/ui/tv-ai-suggestion-card.test.tsx`（7 例：字段行与 3 格信号条、确认写 store + success 态、拒绝禁用全部、重新分析走 startAISuggestion、违例已确认受控态、confidence=0 无信号条、非 TV JSON 渲染 null）+ `tests/ui/assistant-actions.test.tsx` 追问用例更新为建议卡交互断言（CTA 发送当前建议 + 切换备选后发送备选项）。全量 `tests/ui` 1029 例中 1027 过；2 例失败为 CaseTreePanel 折叠用例，干净基线复跑同样失败（issue #3 已备案），与本次无关。

---

## Issue #5: SelectionActions — 划选交给 AI 操作条

**Labels**: `ready-for-agent` `p0`
**Blocked by**: #1

### What to build

划选文本后附着的 AI 操作条：快捷动作（Explain/Improve/Shorten 等，图标换 lucide）+ 自定义 prompt 输入；idle → thinking（spinner + Shimmer）→ streaming（逐字打字，复用 `ap-stream-tail`）→ result（Keep/Discard/Retry）状态机；WAAPI 宽度过渡（320ms）随内容切换。**新增唯一测试缝**：划选监听抽成独立 hook（`selectionchange` 监听 + `place()` 定位——`getClientRects()` 最后一行 bottom 锚点 + rAF 批处理 + ResizeObserver 重算），UI 测试直接驱动 hook/受控 props，不模拟真实划选。宿主：AI 消息气泡（MarkdownRenderer）先行。

参考（绝对路径）：

- `D:\AI\beautiful-ui\components\primitives\SelectionActions.tsx`（491 行；iconoir 图标 10 个全换 lucide；StreamText/Shimmer 依赖——前者项目已有等效 CSS，后者 Issue #1 已适配）

### Acceptance criteria

- [ ] 划选 hook 独立成文件，可脱离 DOM Selection 单测
- [ ] 气泡内划选出现浮条，定位在选区最后一行下方居中，窗口 resize 后重算
- [ ] 状态机完整：thinking → streaming → result，Discard 恢复原文，Retry 重跑当前动作
- [ ] 提交动作走现有 session 发送链路（作为一条带引用上下文的消息）
- [ ] 组件测试：状态机流转（mock hook）、Keep/Discard/Retry 行为
- [ ] typecheck + lint + 相关测试通过

---

## Issue #6: DiffTable — AI 批量编辑采纳模式

**Labels**: `ready-for-agent` `p1`
**Blocked by**: #1

### What to build

泛化"提议 → 分阶段着色 → 逐行采纳 → Apply"模式为 props 化组件：`{ rows, additions, removals }` 输入；stage 状态机（原始 → 删除行红 tint → 新增行 grid-rows 0fr→1fr 展开 + 页脚 fade-up）；被删/新增行可点击切换 `edits[row.key]`（取消后褪色），页脚实时统计 "N removals · M additions"，Apply 后冻结并 pop-in 确认 pill。首个落地场景：AI 批量修改 case cfg 参数（CaseCfgPanel 的 AI 建议入口）。

参考（绝对路径）：

- `D:\AI\beautiful-ui\components\primitives\DiffTable.tsx`（237 行，零依赖；`useStage` hook 与 `STAGE_DELAYS = [180, 260]` 分阶段机制、`IncludedMark` 勾选块、页脚统计派生逻辑）

### Acceptance criteria

- [ ] 组件 props 化，演示数据不进正式代码
- [ ] 逐行勾选/取消即时反映：行褪色 + 页脚统计数变化；0 项时 Apply 禁用
- [ ] Apply 后行交互冻结、确认 pill 出现
- [ ] 组件测试：stage 推进后 DOM 断言、勾选统计、Apply 冻结
- [ ] typecheck + lint + 相关测试通过

---

## Issue #7: FilterTable — 状态 chips 筛选（行折叠动画）

**Labels**: `ready-for-agent` `p1`
**Blocked by**: #1

### What to build

chips 筛选组件：带彩色圆点与计数徽标的状态 chips（计数从数据实时计算——参考实现是写死的，须修正），未匹配行 `grid-template-rows 1fr→0fr` + opacity 300ms 平滑折叠，表格高度收拢。摘取 `filter-status-*` color-mix 派生 pill（明暗双份）。落地：回归 `HistoryTable`（当前无筛选）先行；`RunListPanel` 已有分段 chips 仅做视觉对齐，不重构逻辑。

参考（绝对路径）：

- `D:\AI\beautiful-ui\components\primitives\FilterTable.tsx`（127 行，零内部依赖）
- 对应 CSS：`D:\AI\beautiful-ui\app\globals.css` 约 L1400–1433（`filter-status-todo/progress/done` + `.dark` 变体）

### Acceptance criteria

- [ ] 计数徽标由数据派生，非硬编码
- [ ] 切换 chips 后不匹配行平滑折叠（挂载不卸载），再切回平滑展开
- [ ] HistoryTable 接入排序保留、筛选生效
- [ ] 亮/暗主题 pill 色正确
- [ ] 组件测试：过滤结果集、计数徽标
- [ ] typecheck + lint + 相关测试通过

---

## Issue #8: FineTuneCard — ScrubField 数值微调控件

**Labels**: `ready-for-agent` `p1`
**Blocked by**: #1

### What to build

通用 ScrubField：label 即 `role="slider"` 手柄（aria-valuenow/min/max 全套），`setPointerCapture` 水平拖拽 `(Δx/2)*step` 连续调值（clamp+round），键盘 ↑↓/←→ ±step、Shift ×10，`inputMode="numeric"` 直接输入，偏离默认值 accent-tint 高亮。配套移植 segmented control（灰轨白 thumb translateX 滑动）。落地：CaseCfgPanel cfg 数值属性、覆盖率阈值（coverage-router getTarget/setTarget）、RunOptionsDialog 选项，至少接入一处真实场景。

参考（绝对路径）：

- `D:\AI\beautiful-ui\components\primitives\FineTuneCard.tsx`（249 行；ScrubField 逻辑自包含，Type 下拉依赖 Issue #1 GlideMenu；"Edited" 状态机 = 任一值偏离默认派生）

### Acceptance criteria

- [ ] ScrubField 独立组件，键盘/拖拽/输入三路均可改值且 clamp 生效
- [ ] 偏离默认值时高亮，恢复默认后高亮消失
- [ ] 至少一处真实场景接入（cfg 参数或覆盖率阈值）
- [ ] 组件测试：键盘步进、Shift ×10、clamp 边界
- [ ] typecheck + lint + 相关测试通过

---

## Issue #9: InsightCards — 洞察轮播（recharts 替换 liveline）

**Labels**: `ready-for-agent` `p2`
**Blocked by**: #1

### What to build

分页洞察卡（state 取模循环 + 前后按钮）：三张卡形态——双系列对比折线（hover 竖线游标 + 数值 tooltip）、异常检测（metric 切换 + 阈值头）、占比分段条（点选驱动大数字）。图表用项目已有 recharts 重绘（liveline 不引入）；**scrub 交互保留自建实现**：`chartIndexFromPointer()`（getBoundingClientRect 换算 pointer x → 数据 index）+ Catmull-Rom 平滑纯函数（`smooth()` 每段 9 点）直接搬。暗色检测改用 theme store（不用 MutationObserver）。数据源 dashboard-router（getTrend/getRecentFailures/getUnstableCases）。

参考（绝对路径）：

- `D:\AI\beautiful-ui\components\primitives\InsightCards.tsx`（490 行；注意其注释的坑：数据点须以调用时 `Date.now()` 锚定，模块级常量会过期）
- 对应 CSS：`D:\AI\beautiful-ui\app\globals.css` 约 L1350–1400（`.insight-chart-cursor/tooltip-*`）

### Acceptance criteria

- [ ] 无 liveline 依赖，recharts 渲染折线；游标/tooltip 交互保留
- [ ] 分页循环正确（末页 → 首页），每页含建议追问 pill
- [ ] 暗色主题下图表配色正确
- [ ] 组件测试：分页、metric 切换、segment 点选
- [ ] typecheck + lint + 相关测试通过

---

## Issue #10: RecordsTable 拆解吸收 — TagList 折叠 / 列宽拖拽 / AI 列逐行计算

**Labels**: `ready-for-agent` `p3`
**Blocked by**: #1

### What to build

**不整体引入**（1053 行 TSX + 约 800 行专属 CSS，与 demo 数据深度耦合）。拆解三个模式为独立可复用件：

1. TagList 溢出折叠：隐藏测量层量宽 + 贪心 visibleCount（4px 间隙计入）+ ResizeObserver 随列宽重算，溢出 "+N"
2. 列宽拖拽：`role="separator"` 手柄 + window 级 pointermove、首帧 useLayoutEffect 测量锁定、sticky 首列 + fixed 布局
3. AI 列逐行计算：`calc = {col, resolved}` 每 110ms 推进，未解析行 "Calculating…" + 脉动点，完成页脚统计——落地为失败用例表"AI 根因"列（数据走 error-analysis 链路）

参考（绝对路径）：

- `D:\AI\beautiful-ui\components\primitives\RecordsTable.tsx`（TagList L222–269；列宽拖拽 resize-handle；AI 列 calc effect 约 L502–511）
- 对应 CSS：`D:\AI\beautiful-ui\app\globals.css` 约 L509–1400（records-* 专属块，按摘取部分裁剪）
- `D:\AI\beautiful-ui\components\primitives\GlideMenu.tsx`（Issue #1 已抽取）

### Acceptance criteria

- [ ] 三个模式各自为独立组件/hook，无冰淇淋 demo 数据残留
- [ ] TagList 在窄列正确折叠 +N，列宽拖拽时实时重算
- [ ] AI 列逐行计算在失败用例表真实落地（或以 mock 数据先落地组件 + 测试，业务接入另立 issue）
- [ ] 组件测试覆盖三个模式的外部行为
- [ ] typecheck + lint + 相关测试通过

---

## Issue #11: TaskRows 视觉吸收 — TodoPanel 换肤

**Labels**: `ready-for-agent` `p3`
**Blocked by**: None（独立于 #1，可随时做）

### What to build

**不新建组件**。TodoPanel 已是 TaskRows 等价物且为超集（omp `todo` 数据源、phase 分组、四态）。仅吸收视觉：行卡片化 variant（每行独立卡片）、错峰 fade-up 入场（`i*80ms`）、失败/放弃态红色徽章 + 旋转重试图标、详情 `grid-rows 0fr→1fr` 展开过渡、badge `pop-in`。参考实现的 useTick 脚本化演示状态机不移植。

参考（绝对路径）：

- `D:\AI\beautiful-ui\components\primitives\TaskRows.tsx`（222 行）

### Acceptance criteria

- [ ] TodoPanel 现有功能与数据链路不变，现有 `tests/ui/todo-panel.test.tsx` 全绿
- [ ] 四态视觉升级（徽章 pop-in、重试图标旋转、错峰入场），`prefers-reduced-motion` 降级
- [ ] typecheck + lint + `npx vitest run tests/ui/todo-panel.test.tsx` 通过

---

## 挂起项（不排期）

### Flowchart — 交互工作流画布

**Labels**: `backlog`（待功能场景确认后转 `ready-for-agent`）

参考（绝对路径）：`D:\AI\beautiful-ui\components\primitives\Flowchart.tsx`（538 行，零依赖：pointer capture 拖拽 + clamp、SVG 贝塞尔连线 `clamp(|Δy|*0.55, 24, 84)` 控制臂长、ResizeObserver 行高布局、点阵画布纯 CSS radial-gradient）。

启动条件：立项"AI 验证计划 DAG 可视化"或回归流程编排功能时，泛化 NODES/EDGES 为 props 引入。技术方案已备好，见 PRD D12。
