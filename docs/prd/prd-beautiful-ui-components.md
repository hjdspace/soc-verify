# PRD: beautiful-ui AI 交互组件引入 — 11 组件评估与分批落地

> **参考库**: beautiful-ui（MIT License）— `D:\AI\beautiful-ui\`（Next.js 15 + React 19 + Tailwind v4 组件库）
>
> **既有引入先例**: 项目已按"参考适配"模式引入过 4 个 beautiful-ui 形态，文件头注释均标注了参考来源——StreamText（`MarkdownRenderer` 流式尾缘）、ToolChips（`ToolRunGroup`）、PromptBar（`ComposerMenu` 浮层/slash/@ 菜单）、引用来源胶囊（`SourceIcon` / `AssistantActions`）。本 PRD 沿用同一模式。
>
> **配套拆解**: [docs/issues/issues-beautiful-ui-components.md](../issues/issues-beautiful-ui-components.md)

---

## Problem Statement

SoC Verify 定位是 AI Agent 驱动的验证平台，AI 面板已具备流式文本、工具卡分组、引用来源胶囊等基础体验，但对照 AI 原生产品的完整交互形态，还缺少一批关键能力：

1. **文本无法划选交给 AI**。全项目没有任何划选菜单——AI 回复气泡、CodeMirror 编辑器、日志查看均无。用户想把某段回复或日志交给 AI 解释/改写时，只能手动复制、重新组织 prompt。
2. **引用来源没有 chunk 级展示**。KB（知识库）只到"文档 + AI 摘要"粒度，聊天里引用来源只有图标胶囊。用户无法判断"AI 这句话依据的是哪段知识"。
3. **建议卡是单域硬编码**。`TVAISuggestionCard` 只服务时序违例确认场景（置信度进度条 + 确认/拒绝），其他 AI 建议（追问、覆盖率收敛、失败分析）没有统一的建议卡形态，更没有"多备选方案比较"能力。
4. **命令搜索体验原始**。CommandPalette 是 `includes` 过滤 + 无匹配高亮 + 空状态纯文本"没有匹配的命令"。
5. **表格界面缺乏统一交互语言**。回归历史表无排序无筛选；dashboard 各 Tab 原生 `<table>` 混排；没有"AI 提议批量修改 → 逐行采纳 → 应用"的采纳模式——而 AI 批量改 case 配置、批量开关联动是平台的自然场景。
6. **数值参数微调体验原始**。cfg 参数、覆盖率阈值等遍地是普通输入框，没有拖拽微调（scrub）控件。
7. **数据洞察缺乏消化形态**。dashboard 数据源齐备（趋势/失败/不稳定用例），但只有图表 Tab，没有"分页洞察卡 + 可 scrub 图表"的结论型呈现。

beautiful-ui 提供了这 11 种形态的高质量参考实现，且经源码分析确认：**全部为纯 React + CSS（keyframes/transition/grid-rows/WAAPI），无 motion 依赖**，移植成本可控。

## Solution

分四批（P0→P3）将 11 个组件按"参考适配"模式引入，不整文件照搬：

- **P0（能力补全）**: SelectionActions（划选交给 AI）、ContextCards（知识 chunk 卡）、SearchList + GlideMenu（命令搜索体验）、RecommendationCard（通用建议卡）。
- **P1（小而美）**: DiffTable（AI 批量编辑采纳模式）、FilterTable（状态 chips 筛选）、FineTuneCard（ScrubField 数值微调）。
- **P2（按需决策）**: InsightCards（洞察轮播，图表用 recharts 替换 liveline）；Flowchart（交互画布，暂挂起待功能场景确认）。
- **P3（拆解吸收）**: RecordsTable 不整体引入，拆解吸收 TagList 溢出折叠 / 列宽拖拽 / AI 列逐行计算三个模式；TaskRows 不新建组件，视觉细节吸收进 TodoPanel 换肤。

前置工作是一个**公共映射层**：beautiful-ui 的设计 token（oklch 色板、语义阴影、缓动、keyframes）到项目语义色变量的映射，以及 GlideMenu 滑动高亮容器、Button/EntityChip/ValuePill/Shimmer 四个小 atom 的适配。之后每个组件的适配量只剩业务泛化。

**依赖策略**：不新增任何 npm 依赖——motion（11 个组件都没用）、liveline（用已有 recharts 替换，scrub 逻辑自建可保留）、iconoir-react（已有 lucide-react 全覆盖）。

## beautiful-ui 参考文件清单

> 以下路径均为绝对路径。移植时在适配文件头部注释标注来源绝对路径（沿用 ToolRunGroup 先例）。

### 11 个 primitives

| # | 组件 | 参考文件（绝对路径） | 行数 | npm 依赖 | 移植量 | 优先级 | 性质 |
|---|------|---------------------|------|----------|--------|--------|------|
| 1 | TaskRows 任务状态行 | `D:\AI\beautiful-ui\components\primitives\TaskRows.tsx` | 222 | 无 | 小 | P3（仅吸收视觉） | 与 TodoPanel 重复 |
| 2 | RecommendationCard 建议卡 | `D:\AI\beautiful-ui\components\primitives\RecommendationCard.tsx` | 173 | 无 | 小~中 | **P0** | 通用化 TVAISuggestionCard |
| 3 | ContextCards 知识 chunk 卡 | `D:\AI\beautiful-ui\components\primitives\ContextCards.tsx` | 91 | 无 | 小 | **P0** | 纯新增 |
| 4 | DiffTable AI 批量编辑 | `D:\AI\beautiful-ui\components\primitives\DiffTable.tsx` | 237 | 无 | 小 | P1 | 新增模式 |
| 5 | RecordsTable AI 表格 | `D:\AI\beautiful-ui\components\primitives\RecordsTable.tsx` | 1053 | 无 | **大**（+globals.css 约 800 行专属 CSS） | P3（拆解吸收） | 增强表格基建 |
| 6 | FilterTable chips 筛选 | `D:\AI\beautiful-ui\components\primitives\FilterTable.tsx` | 127 | 无 | 小 | P1 | 增强列表 |
| 7 | SearchList 命令搜索 | `D:\AI\beautiful-ui\components\primitives\SearchList.tsx` | 94 | GlideMenu | 小 | **P0** | 增强 CommandPalette |
| 8 | Flowchart 工作流画布 | `D:\AI\beautiful-ui\components\primitives\Flowchart.tsx` | 538 | 无 | 小~中 | P2（挂起） | 纯新增（场景待定） |
| 9 | InsightCards 洞察轮播 | `D:\AI\beautiful-ui\components\primitives\InsightCards.tsx` | 490 | **liveline** | 中~大 | P2 | 增强 dashboard |
| 10 | FineTuneCard 属性微调 | `D:\AI\beautiful-ui\components\primitives\FineTuneCard.tsx` | 249 | GlideMenu | 小~中 | P1 | 新增 ScrubField |
| 11 | SelectionActions 划选 AI 操作条 | `D:\AI\beautiful-ui\components\primitives\SelectionActions.tsx` | 491 | **iconoir-react** | 中 | **P0** | 纯新增 |

### 组件依赖的 atoms 与共享件

| 依赖 | 参考文件（绝对路径） | 行数 | 说明 | 被谁使用 |
|------|---------------------|------|------|----------|
| GlideMenu | `D:\AI\beautiful-ui\components\primitives\GlideMenu.tsx` | 59 | 滑动高亮菜单容器：单个绝对定位高亮层，`onMouseOver/onFocusCapture` 测量行位置，`top/height` 220ms 滑动 | SearchList、FineTuneCard、RecordsTable |
| Button | `D:\AI\beautiful-ui\components\atoms\Button.tsx` | 46 | 胶囊按钮，5 变体 × 2 尺寸，导出 `ButtonVariant` 类型 | RecommendationCard、DiffTable |
| EntityChip | `D:\AI\beautiful-ui\components\atoms\EntityChip.tsx` | 47 | `Monogram` 彩色首字母圆盘 + `EntityChip` 行内实体 pill | RecommendationCard |
| ValuePill | `D:\AI\beautiful-ui\components\atoms\ValuePill.tsx` | 33 | 行内数值徽章，5 tone，`color-mix` 派生 1px ring | RecommendationCard |
| Shimmer | `D:\AI\beautiful-ui\components\atoms\Shimmer.tsx` | 23 | 渐变扫光文字（依赖 `shimmer-text` keyframes） | SelectionActions |
| StreamText | `D:\AI\beautiful-ui\components\atoms\StreamText.tsx` | 78 | 逐字 reveal + 尾缘模糊 + 光标，`onProgress/onDone` 回调 | SelectionActions（项目已有等效流式尾缘 CSS） |
| StatusPill / ProgressRing / Chip | `D:\AI\beautiful-ui\components\atoms\StatusPill.tsx`、`...\ProgressRing.tsx`、`...\Chip.tsx` | 33/55/25 | 状态徽章 / 进度环 / 代码 chip | **11 组件均未直接使用**，暂不移植 |

### 共享设计基建（`D:\AI\beautiful-ui\app\globals.css`）

| 基建 | 位置 | 内容 |
|------|------|------|
| 颜色 token | `:root` / `.dark` 块 | `--surface/--page/--ink(--2/-3)/--line(--strong)/--field/--inset/--hover(--2)/--accent(--ink/-tint)/--red(--tint)/--green(--tint)/--orange(--tint)`，全 oklch |
| token → 工具类映射 | `@theme inline` 块 | `bg-surface`、`text-ink-2`、`border-line`、`rounded-card/control/chip` 等 |
| 语义阴影 | `--shadow-hairline/btn/card/raised/overlay/inset-field` | "1px ring + 阶梯投影"组合；底层阶梯来自 shadow-plugin 的 `--shadow-xs…lg`（移植时手写等值投影即可） |
| 缓动 | `--ease-out-strong` | `cubic-bezier(0.23, 1, 0.32, 1)` |
| 共享 keyframes | 文件多处 | `pop-in`（scale .95→1）、`fade-up`（translateY 8px→0）、`fade-in`、`spin`、`shimmer-text` |
| 间距工具类 | 约 L371–380 | `.primitive-card-pad/bar/footer` |
| 组件专属 CSS 块 | 约 L509–1400（records-*）、L1350–1400（insight-chart-*）、L1400–1433（filter-status-*，明暗双份 color-mix 派生）、L1463–1502（stream-tail/stream-caret） | 与对应组件一一对应，随组件一起摘取 |

## User Stories

### 划选交给 AI（SelectionActions，P0）

1. 作为验证工程师，我想在 AI 回复的文本上划选一段文字后立即看到附着的 AI 操作浮条，以便不必手动复制粘贴就能把片段交给 AI 处理。
2. 作为验证工程师，我想对划选内容选择 Explain / Improve / Shorten 等快捷动作，或输入自定义指令后回车发送，以便按意图一键发起处理。
3. 作为验证工程师，我想在 AI 处理期间看到 thinking 态（spinner + 扫光文字），以便知道系统在响应。
4. 作为验证工程师，我想看到改写结果以流式逐字打字的方式原位替换/展示，且浮条跟随内容回流，以便获得连贯的改写体验。
5. 作为验证工程师，我想在结果出来后选择 Keep（保留）、Discard（丢弃恢复原文）或 Retry（重试当前动作），以便改写不满意时无损回退。

### 知识 chunk 卡（ContextCards，P0）

6. 作为验证工程师，我想在 AI 回答的引用来源处展开看到每条引用的知识分块卡片（标题、字符数、内容摘要、来源文件 chip + 外链图标），以便判断答案的可信度与依据。
7. 作为知识库维护者，我想在 KB 文档预览页看到按分块组织的展示（而非只有文档级摘要），以便了解文档被 AI 检索的粒度。

### 通用建议卡（RecommendationCard，P0）

8. 作为验证工程师，我想在 AI 给出建议时看到 0–3 格的置信度信号条（高/中/无着色区分），以便快速决定是否采纳。
9. 作为验证工程师，我想展开"备选方案"抽屉查看其余建议（各自带信号条与置信标签），点击任一项将其提升为当前建议，以便比较后再决策。
10. 作为验证工程师，我想在确认建议后 CTA 按钮变为成功态（"已接受"），以便明确记录决策且防止重复操作。
11. 作为平台开发者，我想把现有 TV 违例建议卡重构为该通用形态，以便追问建议、覆盖率收敛建议、失败分析建议复用同一组件。

### 命令搜索（SearchList + GlideMenu，P0）

12. 作为验证工程师，我想在命令面板看到搜索词的匹配片段、输入非空时的清除按钮，以便快速定位与修正搜索。
13. 作为验证工程师，我想在没有匹配结果时看到带图标与主/副文案的空状态卡片，以便知道下一步该做什么。
14. 作为验证工程师，我想鼠标/键盘在结果行间移动时高亮块平滑滑动（而非瞬移），以便获得流畅的操作反馈。
15. 作为验证工程师，我希望会话历史搜索框获得同样的空状态与高亮体验，以便全应用搜索交互一致。

### AI 批量编辑采纳（DiffTable，P1）

16. 作为验证工程师，当 AI 提议批量修改（如 case 参数、回归用例开关）时，我想看到删除行以红底着色、新增行自底部平滑展开的分阶段呈现，以便理解改动范围。
17. 作为验证工程师，我想逐行勾选/取消采纳某条改动（取消后该行立即褪回正常色），页脚实时统计 "N removals · M additions"，以便精细控制应用范围。
18. 作为验证工程师，我想点击 Apply 后看到绿色确认 pill 并冻结行交互，以便明确批量修改已生效且不可误触。

### 状态 chips 筛选（FilterTable，P1）

19. 作为验证工程师，我想在回归历史等列表顶部用带彩色圆点与计数徽标的状态 chips 过滤，不匹配行以高度折叠动画平滑收起，以便聚焦关心的记录且保留空间感。

### 数值微调（FineTuneCard，P1）

20. 作为验证工程师，我想通过左右拖拽属性标签连续微调数值（水平 Δx 换算步进、↑↓/←→ ±step、Shift ×10、直接输入、偏离默认值时高亮），以便高效调整 cfg 参数与覆盖率阈值。

### 洞察轮播（InsightCards，P2）

21. 作为验证工程师，我想在 dashboard 用前后按钮分页浏览多张 AI 洞察卡（趋势对比 / 异常检测 / 占比分配），每张附建议追问 pill，以便快速消化验证数据结论。
22. 作为验证工程师，我想在洞察图表上悬停出现竖线游标与数值 tooltip（双系列对比、阈值标注），以便精确读取某个时间点的数值。

### 流程画布（Flowchart，P2 挂起）

23. 作为验证工程师，我想在点阵画布上查看 AI 规划的验证工作流（Trigger 卡 + If/Else 条件卡 + 贝塞尔连线），可拖拽卡片、点选查看，以便直观理解执行计划。（待功能场景确认后启动）

### 拆解吸收（RecordsTable / TaskRows，P3）

24. 作为验证工程师，我想在含多标签的表格列里看到标签自动溢出折叠为 "+N"（随列宽拖拽实时重算），以便窄列下仍可读。
25. 作为验证工程师，我想在失败用例表上让 AI 逐行填充分析列（自上而下逐行"计算中"脉动 → 出结果，完成后页脚统计 N filled），以便批量获得 AI 结论。
26. 作为验证工程师，我希望 AI 任务列表（TodoPanel）获得更清晰的视觉：行卡片化、错峰入场、失败态红色徽章 + 旋转重试图标、完成态绿勾徽章，以便一眼掌握执行进度。

## Implementation Decisions

### D1 — 依赖策略：零新增 npm 依赖

- 11 个组件中仅 InsightCards 依赖 `liveline`（canvas 图表）、SelectionActions 依赖 `iconoir-react`（图标）；`motion`/`glimm`/`dialkit`/`shadow-plugin` 均未被直接 import（shadow-plugin 仅提供 globals.css 底层阴影阶梯）。
- iconoir 的 10 个图标（ChatBubbleQuestion/Spark/Scissor/EmojiSatisfied/TextBox/ArrowUp/NavArrowRight/Check/Xmark/Refresh）全部用已有 `lucide-react` 平替。
- liveline 用已有 `recharts` 替换：InsightCards 的 scrub 交互（`chartIndexFromPointer` 坐标换算 + 自建 tooltip）本就是组件自建的，与 liveline 无关，可原样保留；Catmull-Rom 平滑函数（`smooth()/smoothPoints()`）为纯函数直接搬。
- 音效系统（`@web-kits/audio`，RecordsTable 的 `data-sound-silent`）整体丢弃。

### D2 — 公共映射层（第一批落地，所有组件的前置）

在 `globals.css` / `ai-panel.css` 建立一次性的映射，而非照搬 beautiful-ui token 块：

- **颜色映射**：`--surface/--page/--ink/--ink-2/--ink-3/--line/--line-strong/--field/--inset/--hover/--hover-2/--accent/--accent-tint/--red(-tint)/--green(-tint)/--orange` 指向项目现有语义色变量（遵循 AGENTS.md"语义色用 CSS 变量"约束，不引入 oklch 字面量）。
- **阴影语义层**：手写 `--shadow-hairline/btn/card/raised/overlay` 等值（"1px ring + 投影"组合，替代 shadow-plugin 阶梯）。
- **缓动与动画**：`--ease-out-strong = cubic-bezier(0.23,1,0.32,1)`；keyframes `pop-in / fade-up / fade-in / spin / shimmer-text`（`ap-stream-tail`/`ap-cursor`/`ap-fadeup` 已有等效实现，统一收敛）。
- **共享件**：GlideMenu 抽为共享组件——项目 `ComposerMenu` 的 `.ap-menu-highlight` 已实现同款滑动高亮模式，抽取泛化而非拷贝；Button/EntityChip/ValuePill/Shimmer 四个 atom 适配进 `components/ui/`。

### D3 — 适配与来源标注规范

- 沿用"参考适配"模式：正式代码按项目命名（组件 PascalCase、CSS `ap-*` 前缀），不整文件照搬；原型 HTML 先行放 `docs/prototypes/`（项目 Rules，先例：`toolchips-ai-panel.html`、`assistant-sources-pill.html`）。
- **每个适配文件头部注释标注 beautiful-ui 参考实现的绝对路径**（先例：`ToolRunGroup.tsx` 头注释"视觉参考 beautiful-ui 的 ToolChips primitive"），格式统一为：` * 视觉/交互参考 beautiful-ui: <绝对路径>`。

### D4 — SelectionActions：新增唯一测试缝（划选监听 hook）

- 参考实现 `D:\AI\beautiful-ui\components\primitives\SelectionActions.tsx` 的"划选"是预设高亮 span（280ms 后视为已选中），**真实场景需自行实现**：将 `place()` 定位逻辑（`selection.getClientRects()` 取最后一行 bottom 作锚点 + 选区中心作 x，`requestAnimationFrame` 批处理，ResizeObserver/window resize 重算）与监听逻辑抽成独立 hook（监听 `selectionchange`，返回 anchor 与选中文本）。这是本 initiative 唯一新增的缝。
- 宿主优先级：AI 消息气泡（`MarkdownRenderer`）→ CodeMirror `FileEditor`。图标换 lucide；thinking 态复用 Shimmer atom；streaming 态复用项目已有 `ap-stream-tail` CSS。
- WAAPI 宽度动画（`bar.animate()` 在 prev/next 渲染宽度间过渡 320ms）为 Chromium 原生，直接搬。

### D5 — ContextCards：聊天引用展开卡 + KB 预览升级

- 参考 `D:\AI\beautiful-ui\components\primitives\ContextCards.tsx`（91 行，零依赖；注意其 `tone` 字段存 Tailwind 类名字符串 `bg-red`，接入时改为项目语义色映射）。
- 落点 1：聊天回复引用来源——`AssistantActions` 已有 `extractMessageReferences` + `SourceIcon` 基建，胶囊展开列表升级为 chunk 卡（标题栏：图标+标题+字符数；正文摘要；底部来源 chip，700ms 后 chip 错峰淡入）。
- 落点 2：KB `KbPreviewTab` 的 AI 摘要卡升级（数据源 `kb-router`，当前无 chunk 级展示）。

### D6 — SearchList：CommandPalette 与 HistoryView 搜索强化

- 参考 `D:\AI\beautiful-ui\components\primitives\SearchList.tsx` + `D:\AI\beautiful-ui\components\primitives\GlideMenu.tsx`。
- 落点：`CommandPalette` 补匹配高亮、清除按钮、空状态卡片（图标+主/副文案）；行间滑动高亮复用 D2 抽取的 GlideMenu 模式；保留现有 `trpc.search.global` 数据链路。同样模式反哺会话历史 `HistoryView` 搜索框。

### D7 — RecommendationCard：通用建议卡 + TVAISuggestionCard 通用化

- 参考 `D:\AI\beautiful-ui\components\primitives\RecommendationCard.tsx`，连带 Button/EntityChip/ValuePill 三个 atom。
- 核心可复用结构：置信度 Meter（3 根竖条，`bar < signal ? tone : var(--line-strong)`）+ Alternatives 抽屉（grid-rows 0fr→1fr 展开；点击备选项提升为当前建议并重置 accepted）+ `key={active.key}` 重挂载实现 180ms 交叉淡入（motion AnimatePresence 的轻量等效）。
- 数据契约泛化：`Option = { key, body(ReactNode), short, signal(0-3), tone(CSS 颜色), label, cta, ctaVariant }`；`TVAISuggestionCard` 的 `{confirmer, result, reason, confidence, analysis}` 映射到该契约，数据源不变（violation-router / session-router.generateFollowUps / coverage-router.listGaps）。

### D8 — DiffTable：批量采纳模式泛化

- 参考 `D:\AI\beautiful-ui\components\primitives\DiffTable.tsx`。注意其"扫过"是**分阶段状态机而非逐行扫光**：`useTick` setTimeout 链驱动 stage 递增（原始 → 删除行红 tint → 新增行 grid-rows 0fr→1fr 展开 + 页脚 fade-up）。
- 泛化：写死的冰淇淋 ROWS 改为 props `{ rows, additions, removals }`；`edits: Record<string, boolean>` 逐行采纳、页脚统计由 edits 派生、Apply 后冻结交互与 `pop-in` 确认 pill 原样保留。
- 场景落地：AI 批量修改 case cfg 参数、回归 list 开关批量提议、覆盖率 exclusion 建议批量采纳。与 `scm/InlineDiffView`（代码 unified diff）定位不同，不冲突。

### D9 — FilterTable：chips 筛选与行折叠

- 参考 `D:\AI\beautiful-ui\components\primitives\FilterTable.tsx`（127 行，依赖最干净——连内部组件都不依赖）。
- 核心技巧：所有行始终挂载，filter 变化时未匹配行 `grid-template-rows 1fr→0fr` + opacity 过渡 300ms 平滑折叠，表格高度随之收拢。
- 接入修正：chips 计数徽标在参考实现里是写死的，改为从数据实时计算；status pill 的 color-mix 派生方案（`filter-status-*`，globals.css 约 L1400–1433，明暗双份）整体摘取。
- 落点：回归 `HistoryTable`（当前无任何筛选）、回归子系统列表；`RunListPanel` 已有分段 chips，视觉对齐即可。

### D10 — FineTuneCard：ScrubField 通用控件

- 参考 `D:\AI\beautiful-ui\components\primitives\FineTuneCard.tsx`。
- 核心可复用件 **ScrubField**：label 即 `role="slider"` 手柄（完整 aria-valuenow/min/max），`setPointerCapture` 后水平位移 `(Δx/2)*step` 连续调值（clamp+round），键盘 ↑↓/←→ ±step、Shift ×10，`inputMode="numeric"` 直接输入，偏离默认值时 accent-tint 高亮。
- 落点：`CaseCfgPanel` cfg 数值属性、覆盖率阈值（coverage-router `getTarget/setTarget`）、`RunOptionsDialog` 选项；Type 下拉与 segmented control 同卡移植（依赖 GlideMenu）。

### D11 — InsightCards：洞察轮播（图表替换 liveline）

- 参考 `D:\AI\beautiful-ui\components\primitives\InsightCards.tsx`。分页为极简 state 取模循环；三张卡形态：对比双折线 / 异常检测（metric 切换+阈值头）/ 占比分段条（点击 segment 驱动大数字）。
- 图表：liveline（canvas，paused 模式当静态图）替换为 recharts 折线；**scrub 交互自建可保留**——`chartIndexFromPointer()`（getBoundingClientRect 换算 pointer x → 数据 index）+ 游标/tooltip（`.insight-chart-*` CSS 块，globals.css 约 L1350–1400）；Catmull-Rom 稠密化纯函数（每段 9 点）直接搬。
- 暗色检测：参考实现用 MutationObserver 监听 `documentElement` class；项目改用现有 theme store。
- 数据源现成：dashboard-router（getTrend/getRecentFailures/getUnstableCases/getDurationHistogram 等）。
- 注意参考实现注释的坑：数据点以调用时 `Date.now()` 锚定时间戳，模块级常量会使点过期（canvas 渲染空白）。

### D12 — Flowchart：挂起（P2，待场景确认）

- 参考 `D:\AI\beautiful-ui\components\primitives\Flowchart.tsx`（538 行零依赖：pointer capture 拖拽 + clamp、SVG 贝塞尔连线控制臂长 `clamp(|Δy|*0.55, 24, 84)`、ResizeObserver 实测行高布局、点阵画布为纯 CSS radial-gradient 22px 网格）。
- 项目唯一交互画布空缺（DrawioViewer 只读、MermaidDiagram 只读），但 SoC 验证暂无"可拖拽编排"的真实需求；仅当启动"AI 验证计划 DAG 可视化"或回归流程编排功能时再引入，届时泛化 NODES/EDGES 为 props。

### D13 — RecordsTable：拆解吸收（不整体引入）

- 参考 `D:\AI\beautiful-ui\components\primitives\RecordsTable.tsx`（1053 行 TSX + globals.css 约 L509–1400 约 800 行专属 CSS）+ `D:\AI\beautiful-ui\components\primitives\GlideMenu.tsx`。
- 整搬成本大且与 60 条 demo 数据深度耦合。值得拆解吸收的三个模式：
  1. **TagList 溢出折叠**（L222–269）：隐藏测量层（visibility:hidden + width:max-content）量 tag 宽度，贪心计算 visibleCount（4px 间隙计入），ResizeObserver 随列宽重算，溢出显示 "+N"。
  2. **列宽拖拽**：`role="separator"` 手柄 + window 级 pointermove、首帧 useLayoutEffect 测量后锁定列宽、sticky 首列 + fixed 布局 + 双轴 z-index 分层。
  3. **AI 列逐行计算**：`calc = {col, resolved}`，effect 每 110ms `resolved+1`，未解析行渲染"Calculating…" + accent 脉动点，完成后页脚统计——落地为失败用例表加"AI 根因"列。
- 仅当决定做"验证数据 AI 电子表格"主打功能时才评估整体引入。

### D14 — TaskRows：TodoPanel 视觉换肤（不新建组件）

- 参考 `D:\AI\beautiful-ui\components\primitives\TaskRows.tsx`。
- TodoPanel 已是等价物且为超集（数据源 omp `todo` 工具，带 phase 分组、四态）。仅吸收视觉细节：行卡片化 variant（每行独立卡片 vs 单容器分隔线）、错峰 fade-up 入场（`i*80ms` 延迟）、失败态红色 Badge + 旋转 retry 图标、详情 `grid-rows 0fr→1fr` 展开过渡、badge `pop-in`。
- 参考实现的脚本化演示状态机（useTick 定时链）不移植。

## Testing Decisions

**测试缝（按优先采用既有缝的原则）：**

1. **组件 props 边界（现有缝，最高缝）**：引入的组件以 props 接收数据（mock 数据直灌），测试渲染后断言外部行为——展开/收起、过滤结果集、采纳计数、键盘导航、空状态出现等。先例：`tests/ui/tool-run-group.test.tsx`、`tests/ui/todo-panel.test.tsx`、`tests/ui/composer-menu.test.tsx`、`tests/ui/command-palette.test.tsx`、`tests/ui/assistant-actions.test.tsx`。
2. **zustand store mock（现有缝）**：与 store 耦合的组件（如通用建议卡写 confirmation store）mock store 后测交互。先例：`tests/stores/`、`tests/ui/coverage-store-split.test.ts`、`tests/ui/diff-review-store.test.ts`。
3. **新增唯一缝——划选监听 hook**（见 D4）：`selectionchange` 监听抽成独立 hook，UI 测试不模拟真实划选（jsdom 的 Selection 支持有限），直接驱动 hook 的返回值或以受控 props 注入选区。
4. **动画不做自动化断言**：CSS 过渡/keyframes 只测状态切换后的最终 DOM（如"展开后详情可见""取消勾选后统计数减一"），视觉效果走原型对照验收。

**每个引入的组件新增对应 `tests/ui/<component>.test.tsx`**，遵循 AGENTS.md 增量验证：`npm run typecheck` + `npm run lint` + `npx vitest run tests/ui`（按改动裁剪）。

## Out of Scope

- **不修改 beautiful-ui 源码**（外部参考项目，仅阅读与摘取；MIT 许可）。
- **不新增 npm 依赖**：motion / liveline / iconoir-react / shadow-plugin / @web-kits/audio 均不引入（替代方案见 D1）。
- **RecordsTable 不整体引入**（D13，仅拆解三个模式）。
- **TaskRows 不新建组件**（D14，TodoPanel 换肤）。
- **Flowchart 挂起**（D12，待功能场景确认；本期不排期）。
- **不迁移 beautiful-ui 的 @theme inline 全套 token 体系**——项目保持自身语义色变量，仅建映射层（D2）。
- **不做** 触屏适配、多窗口/iframe 场景、音效系统、omp 引擎侧任何改动。
- **本期不做** RecordsTable 整表场景的"AI 电子表格"产品化（列为后续评估项）。

## Further Notes

- **许可与署名**：beautiful-ui 为 MIT License（`D:\AI\beautiful-ui\LICENSE`）；按 D3 规范在适配文件头标注参考来源绝对路径即可满足署名要求。
- **分析来源**：本 PRD 基于 2026-08 对 11 个组件源码的逐文件分析（依赖链核查至 atoms/GlideMenu/globals.css 对应 CSS 块/package.json），关键结论已内联至上文各 Decision。
- **执行顺序**：D2 公共映射层 → P0 四项（可并行）→ P1 三项 → P2/P3 按需。切片级任务与验收标准见 [docs/issues/issues-beautiful-ui-components.md](../issues/issues-beautiful-ui-components.md)。
