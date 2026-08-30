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
- **TV 场景**（`TVAISuggestionCard` 重构）：`AISuggestion` → 单选项 `RecommendationOption` 映射——body=确认人/确认结果（pass/issue 徽章，语义色 14% tint 派生、ValuePill 同款）/分析理由/详细分析字段行，short=reason 兜底；confidence→signal/label 由 `confidenceTier` 单点分层（≥0.7→3 格 pass 绿、≥0.4→2 格 aborted 橙、>0→1 格 fail 红，标签「高置信度/需复核/低置信度 NN%」；confidence=0 不渲染信号条，对齐原卡）；违例上下文块落 `preface` 槽；「确认并应用」走 `applyAISuggestion`（数据源 violation-router 不变，仍写 confirmation store），「重新分析/拒绝」落 `footerLeft` 槽（语义不变），rejected 时 `disabled` + CTA 文案切「已拒绝」；`accepted={applied || isConfirmed}` 外部受控（手工确认对话框路径也覆盖）。**code-review 修复**：confirmer/result 不全时 cta 置空串隐藏 CTA——旧卡该场景不渲染确认按钮，若直译重构会出现「点击早退不写 store 却变绿已应用」的假 success 态（契约补充：cta 空串 = 建议不可确认，不渲染 CTA）。
- **followUps 场景**（`AssistantActions`）：`.ap-followups` 胶囊列表升级为 `RecommendationCard`（第二场景）——首条为当前建议正文，其余进备选抽屉，CTA「发送追问」`sendMessage`（session-router.generateFollowUps 数据链路不变），无 signal/label；`data-testid="assistant-followups"` 保留。旧 `.ap-followups-label/.ap-followup-item` 样式已删（无引用点），`.ap-followups` 简化为外边距壳。
- **测试**：`tests/ui/recommendation-card.test.tsx`（11 例：SignalMeter 格数/零格、正文与页脚渲染、抽屉 0fr→1fr 与 aria-expanded、切换备选重置 accepted + 信号条随动、busy/accepted 态、外部受控 accepted、单选项无抽屉、无 signal 场景、disabled 全禁、空 options 渲染 null）+ `tests/ui/tv-ai-suggestion-card.test.tsx`（7 例：字段行与 3 格信号条、确认写 store + success 态、拒绝禁用全部、重新分析走 startAISuggestion、违例已确认受控态、confidence=0 无信号条、非 TV JSON 渲染 null）+ `tests/ui/assistant-actions.test.tsx` 追问用例更新为建议卡交互断言（CTA 发送当前建议 + 切换备选后发送备选项）。全量 `tests/ui` 1029 例中 1027 过；2 例失败为 CaseTreePanel 折叠用例，干净基线复跑同样失败（issue #3 已备案），与本次无关。

---

## Issue #5: SelectionActions — 划选交给 AI 操作条

**Labels**: `ready-for-agent` `p0` → **已完成**（2026-08-30）
**Blocked by**: #1

### What to build

划选文本后附着的 AI 操作条：快捷动作（Explain/Improve/Shorten 等，图标换 lucide）+ 自定义 prompt 输入；idle → thinking（spinner + Shimmer）→ streaming（逐字打字，复用 `ap-stream-tail`）→ result（Keep/Discard/Retry）状态机；WAAPI 宽度过渡（320ms）随内容切换。**新增唯一测试缝**：划选监听抽成独立 hook（`selectionchange` 监听 + `place()` 定位——`getClientRects()` 最后一行 bottom 锚点 + rAF 批处理 + ResizeObserver 重算），UI 测试直接驱动 hook/受控 props，不模拟真实划选。宿主：AI 消息气泡（MarkdownRenderer）先行。

参考（绝对路径）：

- `D:\AI\beautiful-ui\components\primitives\SelectionActions.tsx`（491 行；iconoir 图标 10 个全换 lucide；StreamText/Shimmer 依赖——前者项目已有等效 CSS，后者 Issue #1 已适配）

### Acceptance criteria

- [x] 划选 hook 独立成文件，可脱离 DOM Selection 单测
- [x] 气泡内划选出现浮条，定位在选区最后一行下方居中，窗口 resize 后重算
- [x] 状态机完整：thinking → streaming → result，Discard 恢复原文，Retry 重跑当前动作
- [x] 提交动作走现有 session 发送链路（作为一条带引用上下文的消息）
- [x] 组件测试：状态机流转（mock hook）、Keep/Discard/Retry 行为
- [x] typecheck + lint + 相关测试通过

### 落地记录（2026-08-30）

- **划选 hook**（`src/renderer/src/hooks/use-selection-anchor.ts`）：`selectionchange`/window resize/ResizeObserver（host）三路触发统一经 `place()` rAF 批处理重算（同帧合并）；锚点 x=选区包围盒水平中心（`(left+right)/2`）、y=`getClientRects()` 最后一行 bottom + gap（默认 8）。DOM Selection 读取抽成可注入 `readSelection` 纯函数（默认 `readDomSelection`：折叠/空选区/越出 host → null）——UI 测试注入假 reader 即可脱离真实划选（issue 指定的唯一测试缝）。`enabled=false` 移除监听但保留已得锚点（回合进行中浮条不消失、不跳位）。
- **状态机 hook**（`src/renderer/src/hooks/use-selection-run.ts`）：phase 由 session 状态**渲染期派生**而非逐事件推进——run 时快照在场 assistant 消息 id，本回合回复 = 自尾扫描首个不在场 id 的 assistant 消息；无首字 → thinking、有内容/思考 → streaming、status idle/error + 无 pending tool + 占位收尾 → result；result 用 latch 锁存（回合落定后用户手动发新回合不会把浮条拖回 busy）。keep/discard/retry/dismiss 四出口，discard/retry 前都经 `onCancel`（宿主恢复原文）；retry 先 onCancel 再原请求重跑（消息 id 快照使删后重发的新回合仍可被识别）。执行（onSubmit）与恢复（onCancel）全归宿主回调，测试直接构造假 session 对象驱动、零 store mock。
- **组件**（`components/ui/SelectionActions.tsx`）：全受控 props（anchor/visible/phase/request/streamText），36px 胶囊包 28px 控件同心圆角；iconoir 10 个图标全换 lucide（解释/改进/精简/展开/翻译 + Check/X/RotateCcw/ChevronDown/ArrowUp）；前二动作常驻、后三收进 chevron 展开区（`aria-expanded`）；自定义 prompt 输入——输入时动作区 max-width 塌缩、发送槽位展开（首字符锁定当前条宽防跳变），Esc 清空恢复；busy = spinner + Shimmer 标签（thinking）/实时回复预览（streaming，尾 6 字符复用 ai-panel.css `.ap-stream-tail` 模糊尾缘，与 MarkdownRenderer STREAM_TAIL_CHARS 对齐）；result = 保留（primary）/放弃/重试；条宽切换走 WAAPI `animate()` 320ms `cubic-bezier(0.23,1,0.32,1)`（无 Element.animate 的环境直接落终态宽度，jsdom 可测）；条上 `mousedown` preventDefault（输入框除外）保住文档选区，点击动作时引用文本仍高亮。偏差说明：busy 末尾追加减动关闭按钮——真实会话回合无法在条内取消，必须给用户脱离浮条的出口（回合照常进行）。
- **会话链路**（`components/chat/SelectionActionsHost.tsx` + RightPanel MessageBubble）：Host 包裹 MarkdownRenderer（TV 卡/错误消息分支不接），划选出浮条定位于选区最后一行下方居中（`translate3d` + `translateX(-50%)`，选区折叠后停在最后锚点隐藏）。快捷动作/自定义 prompt 组装为「指令文案 + `> 引用自你的回复：` blockquote（2000 字截断）」经 `sendMessage` 走现有 session 发送链路；Discard/Retry 经新增 `session-messages.removeMessagesFrom`（截断 fromIndex 起消息 + `persistSessionMessages` 全量覆盖持久化，基线 = 提交前 `messages.length`）恢复提交前会话状态——注意 omp 运行时上下文无法回写，仅本地记录与持久化存储回退。流式/回合执行中停止划选监听（enabled 门控），已开始回合（request 非空）继续驱动浮条。
- **样式**（globals.css，`.ap-rec-*` 块之后）：`.ap-sel-*` 落 globals.css 共享件——layer（translate3d 承载锚点位移 + opacity 过渡）、pill（`--shadow-overlay`）、slot（max-width+opacity+translateX 三段过渡承担 prompt/动作区互斥折叠）、control/primary/iconbtn/send（语义变量 `--card/--foreground/--background/--muted-foreground/--fg-faint/--border/--accent`，active 按压缩放）；reduced-motion 下锚点位移与 slot 折叠去过渡（保留 opacity）、入场 pop-in 关闭。
- **测试**：`tests/ui/selection-anchor.test.tsx`（9 例：锚点换算/gap/清空/selectionchange/resize/引用稳定/enabled 开关 + readDomSelection 契约）、`tests/ui/selection-run.test.tsx`（10 例：状态机流转/result 锁存/pending tool 不落定/keep/discard/retry/dismiss/自定义 prompt）、`tests/ui/selection-actions.test.tsx`（14 例：动作渲染与展开/prompt 发送与槽位塌缩/空 prompt/锚点 translate3d 定位与隐藏/mousedown 拦截/thinking/streaming 预览尾缘/result 三按钮/splitStreamPreview）、`tests/ui/selection-host.test.tsx`（6 例：mock 划选 hook + store——引用消息组装断言/Discard 基线/Retry 二次发送/Keep 不删消息）、`tests/session/session-store.test.ts` 新增 removeMessagesFrom 2 例（截断回 idle 全量持久化/fromIndex 0 清空）。全量 `tests/ui` 1069 例中 1067 过；2 例失败为 CaseTreePanel 折叠用例（预存，#3 已备案）。另 `tests/session/session-store.test.ts` 有 1 例预存失败（sendMessage 期望缺 `thinkingLevel: "default"`，干净基线复跑同样失败，与本次无关）。
- **review 修订（2026-08-30，双轴评审后）**：① Retry 后再 Discard 截不到消息——基线原取渲染闭包里的 session prop，同一点击事件内 onCancel 截断后 prop 未重渲染；改为提交时从 `useSessionCoreStore.getState()` 读 live 消息数（`SelectionActionsHost.onSubmit`）。② 旧回合 abort 遗留的无 toolResult 工具消息（agent_end 不回填）会把新回合的落定判定永久卡死在 streaming——pending tool 扫描改为只看本回合（run 后新增消息，`findTurnStart` 以 run 时在场全部消息 id 圈定本回合起点）。回归测试：`selection-run.test.tsx` 增加「历史回合 abort 遗留 pending tool 不卡死」；`selection-host.test.tsx` 重构为真实 store + trpc mock 基线（sendMessage/removeMessagesFrom 真实落库），增加「Retry 后再次 Discard 仍按重提时基线恢复」。resize 测试强化为几何变化后锚点真实更新（观察者本身 jsdom 无从触发，ResizeObserver 路径仅代码层覆盖）。

---

## Issue #6: DiffTable — AI 批量编辑采纳模式

**Labels**: `ready-for-agent` `p1` → **已完成**（2026-08-30，组件本体；场景接入另立 issue，见落地记录末条）
**Blocked by**: #1

### What to build

泛化"提议 → 分阶段着色 → 逐行采纳 → Apply"模式为 props 化组件：`{ rows, additions, removals }` 输入；stage 状态机（原始 → 删除行红 tint → 新增行 grid-rows 0fr→1fr 展开 + 页脚 fade-up）；被删/新增行可点击切换 `edits[row.key]`（取消后褪色），页脚实时统计 "N removals · M additions"，Apply 后冻结并 pop-in 确认 pill。首个落地场景：AI 批量修改 case cfg 参数（CaseCfgPanel 的 AI 建议入口）。

参考（绝对路径）：

- `D:\AI\beautiful-ui\components\primitives\DiffTable.tsx`（237 行，零依赖；`useStage` hook 与 `STAGE_DELAYS = [180, 260]` 分阶段机制、`IncludedMark` 勾选块、页脚统计派生逻辑）

### Acceptance criteria

- [x] 组件 props 化，演示数据不进正式代码
- [x] 逐行勾选/取消即时反映：行褪色 + 页脚统计数变化；0 项时 Apply 禁用
- [x] Apply 后行交互冻结、确认 pill 出现
- [x] 组件测试：stage 推进后 DOM 断言、勾选统计、Apply 冻结
- [x] typecheck + lint + 相关测试通过

### 落地记录（2026-08-30）

- **组件**（`components/ui/DiffTable.tsx`）：props 化 `DiffTable`（title/columns/colWidths/rows/onApply/applyLabel/hint/stageDelays）+ 导出 `DiffRow`/`DiffApplyResult` 契约与 `DiffBadge`（圆点语义 pill，调用方按需放入 cells 承载分组/标签元信息，参考实现的 dept DOT 映射不进正式代码）。**契约偏差说明**：issue 文本的 `{ rows, additions, removals }` 输入合并为单一 `rows` 数组 + `kind: 'removal'|'addition'` 判别字段——删除/新增行共用同一渲染管线与勾选/统计派生，功能等价。`DiffRow = { key, kind, cells, label? }`——cells 顺序与 columns 对齐（首列为主标识）。`useStage` setTimeout 链驱动 stage 递增（0 原始 → 1 删除行红 tint → 2 settled：新增行 grid-rows 0fr→1fr 展开 + 页脚 fade-up + 行交互开启），`STAGE_DELAYS=[180,260]` 保留为默认值并经 `stageDelays` prop 注入（UI 测试传 [0,0] 配合 waitFor 推进）；delays 数组按值 memo 化，内联字面量在宿主重渲染时不重置计时链。edits 缺省全部采纳（读取 `?? true` 兼容 rows 后续追加的 key，`isIncluded` 单点收敛）；勾选块 IncludedMark 采纳时 tone 底白勾、取消缩放 0.92 褪为 muted+hairline 环；页脚统计实时派生「N 项删除 · M 项新增」，0 项 Apply 禁用；Apply 支持异步 `onApply`（busy 禁用防重复，失败 catch 保持可交互、错误上报归调用方），成功后行交互冻结 + pop-in 绿色确认 pill「N 项变更已应用」。键盘 Enter/Space 切换（变更行 `role="checkbox"` + aria-checked/aria-label，removal/addition 共用 interactiveRowProps）。表格用 grid 行布局（表头/删除行/新增行共享 gridTemplateColumns，`colWidths` 缺省均分），替代参考实现 table+colSpan 混排——新增行展开壳无需跨列穿孔。
- **样式**（globals.css，`.ap-rec-*` 与 `.ap-sel-*` 块之间）：`.ap-diff-*` 落 globals.css 共享件——卡 `--shadow-card`、删除/新增采纳行 tint 在使用点 `color-mix` 14% 混卡面（红 `--status-fail`/绿 `--status-pass`，随亮暗主题自动取值）、删除行着色态主列红字 + 次列删除线（50% 透明红描线）、新增行未采纳褪为 `--fg-faint`、mark/badge/确认 pill 颜色一律语义变量（勾/圆内图形取 `--background`，同 PillButton success 的暗主题对比处理）；reduced-motion 下新增行去 grid-rows 高度过渡（保留 opacity 淡入）、页脚 fade-up 改纯 fade-in（去位移）、确认 pill pop-in 关闭。
- **测试**：`tests/ui/diff-table.test.tsx` 9 例——stage 0/1/2 DOM 形态断言（未着色/无页脚 → 删除行着色 → 新增行展开+页脚+提示）、默认延迟真实推进（~440ms 内分两段到达 settled）、stageDelays 注入、逐行勾选统计联动与重新勾选恢复、键盘 Enter/Space 切换、0 项 Apply 禁用且不回调、Apply 冻结（确认 pill 出现/CTA 与提示消失/行点击失效）、onApply pending 期间 busy 冻结与 reject 后回退可交互不进 accepted、空 rows 渲染 null + DiffBadge 圆点着色。全量 `tests/ui` 1080 例中 1078 过；2 例失败为 CaseTreePanel 折叠用例（预存，#3 已备案），与本次无关。
- **场景接入说明**：本期 ACs 仅覆盖组件本体（原型 HTML 沿 #2–#5 先例省略，ACs 未列）。issue 列出的首个落地场景（CaseCfgPanel 的 AI 建议入口）在当前代码库尚无 AI→cfg 提议数据链路（case-cfg-router 仅管 cfg 文件加载/解析，host tools 无 cfg 批量提议/写回工具），需先立「AI 批量修改提议」链路（host tool 或结构化输出 + 应用写回后端）再以本组件承接——已登记为下方待立 issue（沿 #10「组件先行落地 + 业务接入另立 issue」先例）。

---

## 待立 issue: AI 批量修改提议链路（DiffTable 首个落地场景前置）

**Labels**: `backlog`（待功能场景确认后转 `ready-for-agent`）
**Blocked by**: 无（DiffTable 组件已就绪，见 #6）

### What to build

让 AI 会话能对结构化行级变更（key/kind/cells）发起批量提议，用户在 DiffTable 中逐行采纳后 Apply 写回。候选场景（PRD D8）：AI 批量修改 case cfg 参数（CaseCfgPanel 的 AI 建议入口）、回归 list 开关批量提议、覆盖率 exclusion 建议批量采纳。需补齐：① 提议来源——omp host tool 或会话结构化输出（沿 TVAISuggestionCard 的 JSON 解析先例）；② 应用写回——各场景的持久化后端（cfg 文件改写/开关落库/exclusion 提交）；③ UI 入口——CaseCfgPanel 等宿主面板的「AI 建议」入口与聊天卡片渲染位。

---

## Issue #7: FilterTable — 状态 chips 筛选（行折叠动画）

**Labels**: `ready-for-agent` `p1` → **已完成**（2026-08-30）
**Blocked by**: #1

### What to build

chips 筛选组件：带彩色圆点与计数徽标的状态 chips（计数从数据实时计算——参考实现是写死的，须修正），未匹配行 `grid-template-rows 1fr→0fr` + opacity 300ms 平滑折叠，表格高度收拢。摘取 `filter-status-*` color-mix 派生 pill（明暗双份）。落地：回归 `HistoryTable`（当前无筛选）先行；`RunListPanel` 已有分段 chips 仅做视觉对齐，不重构逻辑。

参考（绝对路径）：

- `D:\AI\beautiful-ui\components\primitives\FilterTable.tsx`（127 行，零内部依赖）
- 对应 CSS：`D:\AI\beautiful-ui\app\globals.css` 约 L1400–1433（`filter-status-todo/progress/done` + `.dark` 变体）

### Acceptance criteria

- [x] 计数徽标由数据派生，非硬编码
- [x] 切换 chips 后不匹配行平滑折叠（挂载不卸载），再切回平滑展开
- [x] HistoryTable 接入排序保留、筛选生效
- [x] 亮/暗主题 pill 色正确
- [x] 组件测试：过滤结果集、计数徽标
- [x] typecheck + lint + 相关测试通过

### 落地记录（2026-08-30）

- **组件**（`components/ui/FilterTable.tsx`）：拆为两个可复用件 + 一个 pill 小件，参考实现 127 行单文件 demo 不整体搬（表格列布局归属宿主）。`StatusFilterChips`（受控 props 化：filters/items/statusOf/value/onChange）——计数徽标由 items 经 statusOf 单遍 Map 派生（'all' = 总数，其余 key = 命中数），**修正参考实现写死 FILTERS.count 的缺陷**；items 变化实时重算；彩色圆点 dot 为任意 CSS 颜色（宿主传语义变量）。`FilterCollapseRow`（shown/className/testId）——grid-rows 1fr→0fr + opacity 300ms 平滑折叠，行保持挂载不卸载（切回平滑展开），折叠行加 `inert` 移出 tab 序与可访问性树；className 落外层 grid 行（宿主承载 border），行内边框留在 children 内随内容收拢（壳上无边框避免 0fr 残线）。`FilterStatusPill`（tone: pass/fail/running/aborted/muted）——状态 pill，`--ft-pill-base` 由 inline 注入语义状态变量。
- **样式**（globals.css，`.ap-sel-*` 之后）：`.ap-ft-*` 落 globals.css 共享件——chip 26px 胶囊（hover 取 `--accent`、激活取 `--secondary` + `--shadow-btn` 环）、badge 圆角 4px tabular-nums（激活态反白 `--card` 底）；pill 的 color-mix 派生比例对齐参考实现 filter-status-*（亮档 92/20/34 混 `--card`，暗档 `[data-shade='dark']` 86/34/34 混白加深）；折叠壳 transition 取映射层 `--ease-out-strong`；reduced-motion 下折叠去 grid-rows 高度过渡（保留 opacity 淡入）。chips/pill 中性面全部取主题语义变量，亮暗自动正确，无 oklch/hex 字面量。
- **HistoryTable 接入**：标题行下方加 `StatusFilterChips`（全部/运行中/已完成/失败/已停止，圆点取 `--status-*`，计数由 entries 派生），行包进 `FilterCollapseRow` 按状态折叠——**排序保留**：entries 顺序原样渲染、只控可见性（RegressionView 的 submittedAt 降序不受筛选影响）；末行分隔线由 `last:border-b-0` 改为按序号传入（折叠壳内 `:last-child` 语义失效）；当前状态 0 命中时显示无匹配提示（数据诚实）。数据链路不变（regression store 现有 history）。
- **RunListPanel 视觉对齐**（不重构逻辑）：分段 chips 换 `.ap-ft-chip` 形态（SEGMENTS 增加 `dot` 字段 + `.ap-ft-badge` 计数，testid/aria-pressed/计数派生逻辑不变）；ETA 列终态文案（通过/失败/已停止）由纯文字色升级为 `FilterStatusPill`（摘取 filter-status-* 明暗双份的真实落地场景），运行中/队列占位「—」不成 pill。
- **测试**：`tests/ui/filter-table.test.tsx` 11 例——计数徽标数据派生（all/各状态/0 命中）、items 变化重算、aria-pressed 受控切换、dot 注入语义变量、折叠壳 shown 双态 inline style + inert + 挂载不卸载 + className 透传、pill tone/base 变量、HistoryTable 接入（chips 计数、筛选后行序保留仅可见性变化、切回全部恢复、0 命中无匹配提示）。全量 `tests/ui` 1091 例中 1089 过；2 例失败为 CaseTreePanel 折叠用例（预存，#3 已备案），与本次无关。
- **review 修订（2026-08-30，双轴评审后）**：① `hideBorder` 原按全量 entries 末位判定，筛选后若末条被折叠，最后**可见**行仍带分隔线与容器描边成双线——改为单遍派生 `lastVisibleIndex`（与 visibleCount 同一循环），分隔线跟随可见末行，补筛选态边框回归用例。② `FilterStatusPillTone` 删除无调用方的 `'muted'` 档（推测泛化）。评审确认保留的取舍：暗档 pill 混白用 `white` 关键字（参考实现刻意复刻，非 hex/oklch 字面量，同 `--shadow-*` 用字面黑先例）；RunListPanel chips JSX 与 StatusFilterChips 的标记双份（fail 段聚合 fail‖error，现 `statusOf` 契约表达不了，留待后续收敛）；`FilterTable.tsx` 文件名沿袭 issue/参考实现名而实际导出三个件（头注释已点名）。

---

## Issue #8: FineTuneCard — ScrubField 数值微调控件

**Labels**: `ready-for-agent` `p1` → **已完成**（2026-08-30）
**Blocked by**: #1

### What to build

通用 ScrubField：label 即 `role="slider"` 手柄（aria-valuenow/min/max 全套），`setPointerCapture` 水平拖拽 `(Δx/2)*step` 连续调值（clamp+round），键盘 ↑↓/←→ ±step、Shift ×10，`inputMode="numeric"` 直接输入，偏离默认值 accent-tint 高亮。配套移植 segmented control（灰轨白 thumb translateX 滑动）。落地：CaseCfgPanel cfg 数值属性、覆盖率阈值（coverage-router getTarget/setTarget）、RunOptionsDialog 选项，至少接入一处真实场景。

参考（绝对路径）：

- `D:\AI\beautiful-ui\components\primitives\FineTuneCard.tsx`（249 行；ScrubField 逻辑自包含，Type 下拉依赖 Issue #1 GlideMenu；"Edited" 状态机 = 任一值偏离默认派生）

### Acceptance criteria

- [x] ScrubField 独立组件，键盘/拖拽/输入三路均可改值且 clamp 生效
- [x] 偏离默认值时高亮，恢复默认后高亮消失
- [x] 至少一处真实场景接入（cfg 参数或覆盖率阈值）
- [x] 组件测试：键盘步进、Shift ×10、clamp 边界
- [x] typecheck + lint + 相关测试通过

### 落地记录（2026-08-30）

- **组件**（`components/ui/ScrubField.tsx`）：props 化 `ScrubField`（label/value/onChange/min/max/step/suffix/defaultValue/active/handle/testId）。三路改值——拖拽（`setPointerCapture` 水平 `(Δx/2)*step` 连续调值，pointerup/cancel 复位；jsdom 无该 API 经可选调用防御）、键盘（↑↓/←→ ±step，Shift ×10）、输入（`inputMode="numeric"`，剥离非法字符后 Number 解析）。全部经 clamp 收敛；取整精度由 step 小数位派生（step=1 取整同参考实现，step=0.5 保留 1 位小数——**契约偏差说明**：参考实现恒用 `Math.round`，直填小数会被吞）。偏离默认值高亮：`defaultValue` 内部派生（value ≠ defaultValue）或 `active` 外部受控（同传时优先），`data-edited` 属性驱动 `.ap-scrub-field[data-edited='true']` 的 accent-tint（primary 14% 混卡面）+ accent 环。`handle` 槽允许宿主替换手柄内容（aria-label 仍用 label）。**输入适配**：聚焦期间保留草稿文本（避免「9.」被即时归一成 9 后小数点丢失，blur/Enter 落回受控值）；无可解析内容（清空/杂字符/仅负号）忽略不跳 0——参考实现 `Number('')` = 0 会把清空砸成 0，敲负号时先跳 0。
- **组件**（`components/ui/SegmentedControl.tsx`）：参考实现内嵌分段控件泛化为 props 化共享件——灰轨（`--muted`）白 thumb（`--card` + `--shadow-btn`），宽度按 `(100% - 4px)/N` 均分（4px 为轨道左右各 2px 内边距），`translateX(index*100%)` 300ms `--ease-out-strong` 滑动；段 key 驱动受控值（宿主免维护索引回环），aria-pressed 标注每段选中态，value 失配时隐藏 thumb 不猜测首段。
- **样式**（globals.css，`.ap-ft-*` 之后）：`.ap-scrub-*` / `.ap-seg-*` 落 globals.css 共享件——颜色一律取映射语义变量（`--muted`/`--card`/`--fg-faint`/`--primary`，accent-tint 在使用点 `color-mix` 14% 混卡面），手柄 `cursor: ew-resize` + `touch-action: none` + focus-visible accent 环；reduced-motion 下 thumb 去位移过渡（颜色过渡保留）。
- **场景接入① 覆盖率阈值**（`components/coverage/TargetsSection.tsx`，自 CoveragePanel 原地抽出独立文件，8 metric 行布局不变）：8 个目标数值输入升级为 ScrubField——手柄渲染 ↔ 图标（metric 名已在左列，label 作 aria）、min 0 / max 100 / suffix %、defaultValue = 行业默认（偏离高亮，调回默认即恢复）。语义收敛：**调回行业默认（assertion 为 0）即从 draft 移除 = 未设置**，保存 payload 不含该项（沿用旧 UI「清空 = 无目标」的语义，改由调值路径触达）；assertion 无默认目标回显 0（0 = 未设置，不会持久化）。保存链路不变（coverage-gaps store setTargets → trpc.coverage.setTarget）。METRIC_LABELS 随迁并导出（CoveragePanel 其余 6 处引用改从新文件导入）。
- **场景接入② RunConfigModal 类型筛选**：全部/列表/组三分段按钮升级为 SegmentedControl（互斥单选的自然形态，顺带给移植控件真实落点），`reg-run-filter-*` testid 与受控行为不变，既有 `tests/ui/regression-run-modal.test.tsx` 全绿。issue 列名「RunOptionsDialog 选项」指该弹窗的选项区；CaseCfgPanel 实为用例文件加载面板、无 cfg 数值属性（issue 列举场景与代码库现状有出入），故接入以上两处。
- **测试**：`tests/ui/scrub-field.test.tsx` 16 例——slider 全套 aria、四向键 ±step、Shift ×10、自定义 step、max/min 边界夹紧、拖拽 (Δx/2)*step 与 pointerup/cancel 停止、输入数字/负值夹紧/NaN 忽略、step=0.5 小数精度、defaultValue 高亮与回默认消隐、active 外部受控、SegmentedControl aria-pressed/thumb 位移/失配隐藏。`tests/ui/coverage-targets.test.tsx` 5 例——8 行 slider 渲染与已存目标回显（assertion 取 0）、偏离默认高亮、键盘改值进 draft 且保存 payload 正确、调回默认移除 draft 项、无 session 禁用保存。全量 `tests/ui` 1113 例中 1110 过；2 例失败为 CaseTreePanel 折叠用例（预存，#3 已备案），另 1 例 regression-view「今天」断言为午夜时间地雷（fixture 用 `Date.now() - 60_000`，跨零点后相对时间渲染为日期式「08-30 23:59」，白天时段通过），均与本次无关。
- **code-review 修订（2026-08-30，双轴评审后）**：① SegmentedControl 由索引驱动改为 key 驱动（消除宿主 findIndex/`!` 回环；value 失配隐藏 thumb）。② TargetsSection 三处 `def ?? 0` 收敛为单点 `baseline` 局部量。评审确认保留的取舍：provenance 参考路径头注释为 PRD D3 规范要求每文件标注；aria-pressed 互斥组对齐参考实现（radiogroup 为备选方案）；TargetsSection 清空输入由「删除覆盖」改为「blur 回显受控值」（未设置路径改由调回默认触达，提示文案已注明）。

---

## Issue #9: InsightCards — 洞察轮播（recharts 替换 liveline）

**Labels**: `ready-for-agent` `p2` → **已完成**（2026-08-30）
**Blocked by**: #1

### What to build

分页洞察卡（state 取模循环 + 前后按钮）：三张卡形态——双系列对比折线（hover 竖线游标 + 数值 tooltip）、异常检测（metric 切换 + 阈值头）、占比分段条（点选驱动大数字）。图表用项目已有 recharts 重绘（liveline 不引入）；**scrub 交互保留自建实现**：`chartIndexFromPointer()`（getBoundingClientRect 换算 pointer x → 数据 index）+ Catmull-Rom 平滑纯函数（`smooth()` 每段 9 点）直接搬。暗色检测改用 theme store（不用 MutationObserver）。数据源 dashboard-router（getTrend/getRecentFailures/getUnstableCases）。

参考（绝对路径）：

- `D:\AI\beautiful-ui\components\primitives\InsightCards.tsx`（490 行；注意其注释的坑：数据点须以调用时 `Date.now()` 锚定，模块级常量会过期）
- 对应 CSS：`D:\AI\beautiful-ui\app\globals.css` 约 L1350–1400（`.insight-chart-cursor/tooltip-*`）

### Acceptance criteria

- [x] 无 liveline 依赖，recharts 渲染折线；游标/tooltip 交互保留
- [x] 分页循环正确（末页 → 首页），每页含建议追问 pill
- [x] 暗色主题下图表配色正确
- [x] 组件测试：分页、metric 切换、segment 点选
- [x] typecheck + lint + 相关测试通过

### 落地记录（2026-08-30）

- **组件**（`components/ui/InsightCards.tsx`）：props 化轮播 `InsightCards`（pages/title/onAskPill/testId）+ 三卡形态 discriminated union（`InsightCardData` = compare/anomaly/allocation）。分页 state 按 **key 记忆**（数据刷新页序变化/页数增减不跳页，key 消失回落首页；比参考实现的 index state 更稳），`move = (index ± 1 + len) % len` 取模循环（末页→首页、首页反向→末页）；页切换 `key` 重挂载 fade-in 180ms 交叉淡入。**scrub 自建实现直接搬**：`chartIndexFromPointer()`（getBoundingClientRect 拆参便于脱离 DOM 单测，补零宽/单点防 NaN 守卫）+ Catmull-Rom `smooth()`（每段 9 点，`SMOOTH_PER_SEGMENT` 导出）逐行移植；compare 双系列经 smooth 稠密化交给 recharts `<Line type="linear">` 直线连接（视觉即平滑曲线，参考实现由 liveline 完成同一效果），游标 `left %` 定位 + tooltip 锚点 28–72% 钳制与参考实现同款；anomaly 柱状卡同用 pointer→index scrub（游标 + tooltip + Cell fillOpacity 高亮）。头部 caption 悬停时切换为当前数据点标签（compare 切日期、anomaly 切「类目 · 值」）。参考实现「数据点以调用时 Date.now() 锚定」的坑不适用——时间轴语义由宿主数据（getTrend 日期）承担，组件不生成时间点。
- **契约偏差说明**：① `tone` 参考实现存 Tailwind 类名（`bg-orange`），此处改为语义变量名 `colorVar`（如 `'--status-pass'`）——SVG 属性不接受 `var()`，系列色由组件按变量名读 `:root` 计算值注入 stroke/fill，HTML 圆点/分段条仍用 `var()` 内联随主题自动取值；② anomaly 卡补阈值 **ReferenceLine 虚线**（`--status-aborted`，可缺省不画线）——参考实现自身注释即「bars with threshold」而正文只画线图，此处让「阈值头」有真实视觉锚点；③ 占比/页首叙述/页脚等文案全部宿主以字符串/ReactNode 传入，参考实现写死的冰淇淋演示数据零残留。
- **暗色检测**：`useShade()` 读 theme store（`currentTheme` → `THEMES[].mode`），替代参考实现的 MutationObserver；shade 进入 `useMemo` deps 作重算触发器（`applyTheme` 先于 store 更新，重渲染时读到的已是新主题计算值），根节点落 `data-shade` 供测试断言。
- **宿主**（`views/dashboard/InsightPanel.tsx`）：`buildInsightPages()` 纯函数把 dashboard store 现有查询映射为三页——getTrend → 通过/失败双系列对比折线（近 14 点、通过率/较前日 delta、**daily/weekly 粒度决定叙述单位「天/周」与悬停标签格式**）；getUnstableCases Top 6 → 异常检测柱状（失败率/失败次数 metric 切换、失败率 ≥50% 阈值线）；getRecentFailures 按子系统聚合 → 占比分段条（Top 3 + 「其他」吸收剩余百分比，点选驱动大数字）。缺数的页自动省略、全空整块隐藏（数据诚实）；trend/unstable 挂载时按需拉取（tabLoaded 防重复），仿真完成时 DashboardView 刷新钩子把 trend/unstable 一并重置重拉。追问 pill → `askFollowUp`：开 AI 面板（drawer 开抽屉 / docked 展开右栏），无活跃会话先 `createSession` 再 `sendMessage`——全走现有会话链路。
- **DashboardView 接入**：`<InsightPanel />` 落 KPI 行之后（`max-w-md` 独立行），页面其余布局不动。
- **样式**（globals.css，`.ap-seg-*` 之后）：`.ap-ins-*` 落共享件——卡 `--shadow-card`、面板 `--muted` + `--shadow-hairline`、tooltip 取 `--popover/--popover-foreground` + `--shadow-overlay`、游标 `--foreground` 26% 透明、metric 切换组深轨 `--background` + 卡面 thumb `--shadow-btn`；分段条选中态内环/sheen 用白系高亮（参考实现刻意复刻，同 `--shadow-*` 字面黑先例）；reduced-motion 下分段 sheen 去 width 过渡（保留 opacity），页切换 fade-in 本就纯 opacity 符合保留策略。
- **测试**：`tests/ui/insight-cards.test.tsx` 25 例（smooth/chartIndexFromPointer 纯函数单测、分页双向取模循环、单页/空 pages、pill 回调与非交互降级、metric 切换数据/参考线/头部联动、柱状 scrub 游标+tooltip、占比分段点选与宽度注入、折线 scrub 游标/tooltip/锚点钳制/离开清除、data-shade 随 theme store 切换、**明暗两档 stroke 计算值对照**（mock getComputedStyle 按 data-theme 返回可区分值，验证重读链路）、稠密化双系列数据缝断言）+ `tests/ui/insight-panel.test.tsx` 11 例（buildInsightPages 映射/缺数省略/周粒度/「其他」桶、挂载拉取、tabLoaded 防重复、pill 发送/建会话/docked 模式）。**测试缝**：recharts 在 jsdom 下 ResponsiveContainer 量不到尺寸（setup 的 ResizeObserver 为 noop），SVG 不渲染——两测试文件共用透传 stub（`tests/ui/recharts-stub.tsx`）把 props/data 落成 data-* 属性在 DOM 边界断言；真实 SVG 渲染由真实应用承担。
- **review 修订（2026-08-30，双轴评审后）**：① anomaly 卡补竖线游标（参考实现 AnomalyCard 同款，AC「游标交互保留」）；② 周粒度下「最近 N 天」表述错误 → 叙述单位/标签随 `trendGranularity` 切换；③ `onAskPill` 删掉无调用方的 `page` 参数；④ 两份 recharts stub 合并为共享工厂 `tests/ui/recharts-stub.tsx`；⑤ tooltip 色值收敛 `colors.barVar` 单点、`Em` 拆为 `Num`（数值）/`Name`（用例名）。确认保留的取舍：pill 接通发送链路（issue 只写「含建议追问 pill」，但死 pill 违背面板本意，沿 followUps 先例）、阈值 ReferenceLine、DashboardView 刷新扩展（数据新鲜度支撑）。全量 `tests/ui` 1149 例中 1147 过；2 例失败为 CaseTreePanel 折叠用例（预存，#3 已备案），与本次无关。

---

## Issue #10: RecordsTable 拆解吸收 — TagList 折叠 / 列宽拖拽 / AI 列逐行计算

**Labels**: `ready-for-agent` `p3` → **已完成**（2026-08-31，三个模式组件本体；失败用例表业务接入另立 issue，见落地记录末条）
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

- [x] 三个模式各自为独立组件/hook，无冰淇淋 demo 数据残留
- [x] TagList 在窄列正确折叠 +N，列宽拖拽时实时重算
- [x] AI 列逐行计算在失败用例表真实落地（或以 mock 数据先落地组件 + 测试，业务接入另立 issue）→ 组件 + 测试已落地，业务接入另立 issue
- [x] 组件测试覆盖三个模式的外部行为
- [x] typecheck + lint + 相关测试通过

### 落地记录（2026-08-31）

- **TagList**（`components/ui/TagList.tsx`）：props 化 `TagList`（items/className/label）+ 导出 `TagItem` 契约与 `fitVisibleCount` 纯函数（贪心装箱单测缝，同 #9 `chartIndexFromPointer` 先例）。隐藏测量层（`visibility: hidden` + `width: max-content`）同款渲染全部标签与「+N」徽标量宽；贪心循环 4px 间隙计入，且存在剩余标签时必须容纳「+N」徽标宽度才允许当前标签入列（溢出徽标本身不溢出）；`useLayoutEffect` 首帧量宽（绘制前完成，无闪烁）+ ResizeObserver 随容器尺寸实时重算（items 引用变化即重算）。契约偏差说明：参考实现 TAG_COLORS 以 oklch 色板按 tag 名硬映射，此处 `color` 由宿主逐项传语义变量（`var(--status-*)` 等），未传取 `--fg-faint` 中性档；title/aria-label 由全部 label 拼出（折叠语义下隐藏项保持可达）。
- **列宽拖拽**（`components/ui/ColumnResize.tsx`）：`useColumnResize` hook（tableRef/widths/locked/resizingKey/startResize）+ `ColumnResizeHandle` 组件（`role="separator"` + `aria-orientation="vertical"` + 「调整 X 列宽」aria-label）。首帧 `useLayoutEffect` 测量 `thead th` 锁定显式列宽（锁定前宿主自适应铺满，锁定后每列显式化、拖拽只改目标列与表格总宽）；拖拽 window 级 pointermove（`minWidth` 夹紧，缺省 120）+ pointerup/cancel 结束，期间 body 换 `col-resize` 光标并禁文本选择、结束恢复，卸载兜底清理监听与 body 样式。sticky 首列与 fixed 布局为宿主职责（`.ap-tbl-sticky` 左锚 + 投影、`table-fixed`），参考实现「重置列宽」菜单项归宿主状态管理不进 hook。
- **AI 列逐行计算**（`components/ui/StaggeredCalc.tsx`）：`useStaggeredRows` hook（resolved/running/done/start）+ `CalcCell` 组件（「计算中…」+ 右缘脉动圆点）。参考实现 `calc = {col, resolved}` 单状态承载多列，此处泛化为每列一个 hook 实例（col 字段由宿主实例天然区分）；110ms `setTimeout` 链逐行推进原样保留，rowCount 为 0 或缩减至 resolved 以下立即落定 done（不悬挂定时器），done 后 `start()` 重置重跑；「Go calculate」触发按钮归宿主。
- **样式**（globals.css，`.ap-ins-*` 块之后）：`.ap-tags*/.ap-tag`、`.ap-colresize-handle`、`.ap-tbl-sticky`、`.ap-calc*` 落共享件——tag 三色自 `--tag-base` color-mix 就地派生（明档浅 tint，暗档 `[data-shade='dark']` 34% 饱和底混白字，沿 FilterStatusPill 的 white 关键字先例），徽标/脉动点/手柄竖线颜色一律语义变量（`--muted/--input/--fg-faint/--primary`）；reduced-motion 不另立档——脉动圆点为 opacity 型状态指示（同 `animate-pulse` 先例保留），其余件无入场/位移动画。
- **业务接入说明**：issue 列出的首个落地场景（失败用例表「AI 根因」列）需先立「AI 根因批量分析」链路——现有 error-analysis 链路为单用例日志解析/逐用例 omp 会话，无逐行批量数据源，为失败用例表逐行生成 RCA 需批量编排（触发 N 路分析、结果落 store、成本与并发控制）。组件侧（`useStaggeredRows`+`CalcCell`+页脚统计）已就绪，已登记为下方待立 issue（沿 #6「组件先行落地 + 业务接入另立 issue」先例）。组合用例（拖拽列宽 → TagList 经 ResizeObserver 重算折叠）已入测试。
- **测试**：`tests/ui/tag-list.test.tsx` 12 例——fitVisibleCount 全放下/贪心截断（间隙计入）/徽标宽度预留/空数组/自定义 gap、宽敞全可见无徽标、窄列折叠 +N、title/aria 全标签可达、RO 变宽重算与变窄折叠、items 变化重算、color 注入 `--tag-base` 与缺省无 style、空列表、组合用例（useColumnResize 拖拽改 colgroup 宽 → RO 触发 → TagList 重折叠；jsdom 无布局，以 prototype getter mock 注入宽高、透传 RO stub 手动触发回调——拖拽→RO→重算即真实浏览器链路）；`tests/ui/column-resize.test.tsx` 7 例——首帧测量锁定、拖拽 Δx 累加与结束后失效、minWidth 夹紧（显式/缺省）、body 光标与文本选择切换恢复、is-resizing 态、手柄可访问性、拖拽中途卸载兜底清理；`tests/ui/staggered-calc.test.tsx` 8 例——110ms 推进链与 done 落定无悬挂定时器（fake timers）、stepMs 自定义、rowCount=0 立即落定、推进中 rowCount 缩减立即落定、done 后 start 重置重跑、CalcCell 渲染与 label/className、宿主组合（占位 → 逐行 CalcCell → 完成页脚统计；推进中全部未解析行均为 CalcCell——参考实现 isCalc = index >= resolved）。全量 `tests/ui` 1176 例中 1174 过；2 例失败为 CaseTreePanel 折叠用例（预存，#3 已备案），与本次无关。
- **附带**：`tests/ui/insight-cards.test.tsx` 的 `comparePage` 类型收窄为 `InsightPage & { card: InsightCompareCard }`——#9 提交（be7cca0）遗留 typecheck 失败（联合类型 `InsightCardData` 上读 `.series`），阻塞本次增量验证，随附单行修复。

---

## 待立 issue: AI 根因批量分析链路（失败用例表「AI 根因」列前置）

**Labels**: `backlog`（待功能场景确认后转 `ready-for-agent`）
**Blocked by**: 无（StaggeredCalc/CalcCell 组件已就绪，见 #10）

### What to build

让失败用例表（FailuresTab / FailureFocusPanel）能逐行展示 AI 根因（RCA）：为失败用例批量发起错误分析（omp 会话编排——触发 N 路 [仿真分析]、结果落 store、成本与并发控制），表内以 `useStaggeredRows` + `CalcCell` 逐行呈现分析进度（未解析行「计算中…」+ 脉动点），完成页脚统计「N 项已解析」。需补齐：① 批量触发入口与并发编排（现有 error-analysis 为单用例链路）；② RCA 结果的持久化与按 caseName 检索的 store；③ 表格宿主的「AI 根因」列渲染与手动重跑入口。

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
