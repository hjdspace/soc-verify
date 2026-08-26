# Spec: UI 视觉增强 — thinking-orbs + border-beam + liquid-gooey

**Status:** ready-for-agent
**Created:** 2026-08-26
**Prototype:** `docs/prototypes/ui-visual-enhancement.html`

## Problem Statement

SoC Verify 桌面应用的 AI Agent 交互体验目前使用简单的 CSS 动画（`ap-chase` 点阵追逐、`ap-sweep` 扫光、`ap-shimmer` 文字流光、`animate-ping` 脉冲点）来表达 Agent 的各种工作状态。这些动画缺乏语义区分（所有工具执行中看起来一样）、视觉粗糙（3×3 像素点阵）、无状态感知（用户无法判断 Agent 正在"搜索"还是"求解"），且输入框和按钮缺少视觉层次和焦点引导。

## Solution

引入三个开源 React UI 库，替换现有 CSS 动画：

1. **thinking-orbs** — 用 9 种语义化的 canvas 状态动画替换 AI Agent 的加载/运行指示器。每种状态（working/searching/solving/listening/connecting/weaving/composing/breathing/shaping）对应一种独特的动画模式，用户一眼可辨 Agent 当前活动类型。纯 2D canvas，无 WebGL/滤镜，自带 `prefers-reduced-motion` 支持、IntersectionObserver 离屏暂停、`data-theme` 自动主题检测。

2. **border-beam** — 给输入框、搜索框和关键按钮添加动态光边效果。`line` 类型提供底部旅行光（输入框 focus 时），`pulse-inner` 提供内呼吸光（按钮 active 时），`pulse-outside` 提供向外呼吸光（审批卡 pending 时）。自带 `active`/`play`/`pause` 淡入淡出、strength 强度控制、IntersectionObserver 离屏暂停。

3. **liquid-gooey** — 为 NavRail 视图切换按钮添加液态拖尾指示器（Move 效果），视图切换时指示器以液体橡胶拖尾从旧位置流向新位置。SVG 轮廓层 + crisp 内容层分离，零空闲开销。

## User Stories

1. 作为验证工程师，我想看到 AI Agent 推理时显示精致的呼吸式动画而非粗糙的脉冲点，这样我可以直观感受 AI 正在思考
2. 作为验证工程师，我想通过不同的动画形态区分 Agent 当前是在"读文件"还是"搜索代码"，这样我不需要看文字标签就能判断 Agent 的活动类型
3. 作为验证工程师，我想在等待 LLM 响应时看到一个有层次的多频带波动动画，这样等待体验更专业、更有质感
4. 作为验证工程师，我想在子代理运行时看到编织式动画，这样我可以区分主 Agent 和子代理的不同活动状态
5. 作为验证工程师，我想在输入框获得焦点时看到底部有蓝色光带流动，这样焦点引导更清晰
6. 作为验证工程师，我想在命令面板搜索框获得焦点时看到光边效果，这样搜索交互更直观
7. 作为验证工程师，我想在运行仿真按钮上看到呼吸光效果，这样按钮的可操作性更突出
8. 作为验证工程师，我想在审批卡等待时看到向外扩散的呼吸光，这样审批请求更醒目不易忽略
9. 作为验证工程师，我想在切换视图时看到液态拖尾指示器从旧位置流向新位置，这样视图切换的动效更流畅自然
10. 作为验证工程师，我想所有新增动画在 `prefers-reduced-motion` 时自动降级为静态帧或禁用，这样我不会被动画干扰
11. 作为验证工程师，我想所有动画在滚出屏幕时自动暂停以节省 CPU，这样应用在多面板场景下保持流畅
12. 作为验证工程师，我想动画主题自动适配当前应用的暗色/亮色主题，这样无需手动配置

## Implementation Decisions

### 依赖管理

- 将 `thinking-orbs`、`border-beam`、`liquid-gooey` 添加为 `package.json` 的 `dependencies`（三个库均为 MIT 协议、React ≥18 peer dependency，与本仓库 React 18 兼容）
- 三个库均为纯 ESM 包、零 `sideEffects`，不影响 electron.vite 的 CJS 主进程构建

### thinking-orbs 集成

**替换 ThinkingBlock 的脉冲点指示器：**
- 当前：`ThinkingBlock.tsx` 使用 `animate-ping` CSS 动画（脉冲圆点）表示推理中
- 优化后：替换为 `<ThinkingOrb state="breathing" size={20} theme="auto" />`
- `breathing` 状态：环面缓慢形变，语义对应"深度思考"
- 保留现有 `ap-sweep` 扫光背景（作为容器级装饰）

**替换 ToolCard 的 ap-chase 点阵：**
- 当前：`ToolCard.tsx` 在 `status === 'running'` 时使用 `.ap-chase`（8 点追逐）
- 优化后：替换为 `<ThinkingOrb state={toolToOrbState(toolName)} size={20} theme="auto" />`
- 状态映射决策（来自原型验证）：
  - 文件类工具（read/write/edit）→ `working`（轨道粒子，"正在工作"）
  - 搜索类工具（grep/glob）→ `searching`（扫描子午线，"正在搜索"）
  - 执行类工具（bash/eval）→ `solving`（频带打乱→归位，"正在求解"）
  - 其他工具 → `working`（默认轨道粒子）

**替换 RunningIndicator 的 ap-shimmer 文字流光：**
- 当前：`RightPanel.tsx` 的 `RunningIndicator` 使用 `.ap-shimmer` 文字流光 + 计时器
- 优化后：在文字旁添加 `<ThinkingOrb state="composing" size={64} theme="auto" />`
- `composing` 状态：多频带波动丝带，语义对应"AI 正在组织回复"
- 64px 尺寸用于头像级展示，视觉层次更高
- 保留计时器文字

**替换 SubagentCard 的 ap-chase 点阵：**
- 当前：`SubagentCard.tsx` 在 `status === 'running'` 时使用 `.ap-chase`
- 优化后：替换为 `<ThinkingOrb state="weaving" size={20} theme="auto" />`
- `weaving` 状态：三股辫编织，语义对应"多线程编织"

**替换 ToolCard executing placeholder 的 ap-chase：**
- 当前：`ToolCard.tsx` 的 `ToolBody` 在 `isExecuting` 时使用 `.ap-chase`
- 优化后：替换为 `<ThinkingOrb state="solving" size={20} />`

### border-beam 集成

**ComposerEditor 输入框光边：**
- 当前：`RightPanel.tsx` 的输入框容器使用静态 `border-[var(--dsw-border-l2)]`
- 优化后：用 `<BorderBeam size="line" theme="dark" active={isFocused} colorVariant="ocean">` 包裹
- `line` 类型：底部旅行光，蓝色光带沿底边循环流动
- `active` 绑定输入框 focus 状态，失焦时光带淡出
- `colorVariant="ocean"` 与 DSH 暗色面板的蓝色主调一致

**CommandPalette 搜索框光边：**
- 当前：`CommandPalette.tsx` 的输入区使用静态 `border-b border-border`
- 优化后：用 `<BorderBeam size="line" theme="dark" active={commandPaletteOpen}>` 包裹输入区
- `active` 绑定面板打开状态

**SimCommandBar 运行按钮呼吸光：**
- 当前：`SimCommandBar.tsx` 的运行按钮使用静态 `bg-status-pass`
- 优化后：用 `<BorderBeam size="pulse-inner" theme="dark" colorVariant="ocean" active={hasCase && !running}>` 包裹
- `pulse-inner`：内呼吸光，绿色光圈脉冲
- `active` 绑定按钮可点击状态

**ApprovalCard 审批卡向外呼吸光：**
- 当前：`ApprovalCard.tsx` 在 `!resolved` 时使用静态琥珀条
- 优化后：用 `<BorderBeam size="pulse-outside" theme="dark" colorVariant="sunset" active={!resolved}>` 包裹
- `pulse-outside`：向外呼吸光，琥珀色光晕扩散
- `colorVariant="sunset"` 匹配审批的琥珀暖色
- resolved 后 `active={false}` 光晕淡出

### liquid-gooey 集成

**NavRail 视图切换液态指示器：**
- 当前：`NavRail.tsx` 的激活按钮使用静态 `bg-primary/10 text-primary` + 底部 2px 圆角条
- 优化后：用 `<Liquid blur={6} contrast={18} fill="var(--primary)" shadow="0 2px 6px rgba(0,0,0,.08)">` 包裹视图按钮组
- 每个按钮用 `<Liquid.Item effect="move" move={{ springiness: 0.5, trail: 0.575 }}>` 包裹
- 激活按钮内部添加液体指示器元素
- 视图切换时液态从旧位置流向新位置
- `fill` 使用 CSS 变量 `var(--primary)` 以适配主题

### 主题适配

- 三个库均支持 `theme="auto"` 或 CSS 变量主题
- thinking-orbs：`theme="auto"` 通过 `data-theme` 属性自动检测 SoC Verify 的主题切换
- border-beam：`theme="dark"` 固定（AI 面板当前设计为暗色 DSH 主题），或 `theme="auto"` 随全局主题
- liquid-gooey：`fill="var(--primary)"` 使用 CSS 变量自动跟随主题

### CSP 兼容性

- thinking-orbs 使用纯 2D canvas，无外部资源，符合 `default-src 'self'` CSP
- border-beam 使用 CSS `@property` 和 `requestAnimationFrame`，无外部资源
- liquid-gooey 使用 SVG 滤镜（inline），不加载外部 SVG 文件，符合 CSP

### ai-panel.css 清理

- 保留 `.ap-sweep`（仍作为 ThinkingBlock 的容器级背景扫光使用）
- 保留 `.ap-shimmer`（仍作为 RunningIndicator 的文字流光保留，与 ThinkingOrb 并存）
- 保留 `.ap-cursor`（流式光标不变）
- `.ap-chase` 可在所有引用点替换为 ThinkingOrb 后移除（或保留备用）
- `.ap-sdot` 不受影响（状态点用于 ok/error/warn，非加载指示器）

## Testing Decisions

### 测试策略

沿用现有 `tests/ui/` 目录的组件级渲染测试模式（`@testing-library/react` + jsdom + `vi.mock`）。三个视觉库均为纯渲染组件，mock 后验证 props 传递和条件激活逻辑，不验证视觉效果本身。

### thinking-orbs 测试

- **模块：** `tests/ui/ThinkingBlock.test.tsx`（现有）、`tests/ui/ToolCard.test.tsx`（现有）
- **mock 策略：** `vi.mock('thinking-orbs', () => ({ ThinkingOrb: (props) => <canvas data-testid="thinking-orb" {...props} /> }))`
- **测试内容：**
  - ThinkingBlock 在 `isThinkingActive` 时渲染 `<ThinkingOrb state="breathing" size={20} />`
  - ToolCard 在 `status === 'running'` 时渲染 `<ThinkingOrb>`，且 `state` prop 正确映射工具类型
  - RunningIndicator 渲染 `<ThinkingOrb state="composing" size={64} />`
  - SubagentCard 在 `status === 'running'` 时渲染 `<ThinkingOrb state="weaving" size={20} />`
- **先验：** `tests/ui/ToolCard.test.tsx` 已有 `completedMessage` / `pendingMessage` 测试模式

### border-beam 测试

- **模块：** 新建 `tests/ui/border-beam.test.tsx`，或扩展 `tests/ui/RightPanel.test.tsx`、`tests/ui/command-palette.test.tsx`
- **mock 策略：** `vi.mock('border-beam', () => ({ BorderBeam: ({ children, active, size }) => <div data-testid="border-beam" data-active={active} data-size={size}>{children}</div> }))`
- **测试内容：**
  - ComposerEditor 容器在 focus 时 `BorderBeam` 的 `active` 为 true
  - CommandPalette 输入区在面板打开时 `BorderBeam` 的 `active` 为 true
  - SimCommandBar 运行按钮在 `hasCase && !running` 时 `BorderBeam` 的 `active` 为 true
  - ApprovalCard 在 `!resolved` 时 `BorderBeam` 的 `active` 为 true，`size="pulse-outside"`
- **先验：** `tests/ui/command-palette.test.tsx` 已有面板打开/关闭测试模式

### liquid-gooey 测试

- **模块：** 扩展 `tests/ui/nav-rail.test.tsx`（现有）
- **mock 策略：** `vi.mock('liquid-gooey', () => ({ Liquid: ({ children }) => <div data-testid="liquid-group">{children}</div>, Liquid.Item: ({ children }) => <div data-testid="liquid-item">{children}</div> }))`
- **测试内容：**
  - NavRail 渲染 `Liquid` 包裹视图按钮组
  - 每个视图按钮被 `Liquid.Item` 包裹
  - 视图切换时激活态正确传递
- **先验：** `tests/ui/nav-rail.test.tsx` 已有视图切换测试模式

## Out of Scope

- 不修改 omp 引擎源码（硬约束 1）
- 不引入 WebGL 或 GPU-heavy 动画（三个库均为 CSS/SVG/2D canvas）
- 不替换 `.ap-sweep` 扫光（仍作为容器级装饰保留）
- 不替换 `.ap-shimmer` 文字流光（仍作为 RunningIndicator 的文字部分保留，与 ThinkingOrb 并存）
- 不替换 `.ap-cursor` 流式光标
- 不替换 `.ap-sdot` 状态点（ok/error/warn 状态指示器）
- 不修改 ai-panel.css 的 DSH 设计令牌
- 不修改全局主题系统（`globals.css` / `theme.ts`）
- 不增加新的 tRPC API 或主进程改动（纯渲染进程 UI 优化）
- liquid-gooey 的 `dissolve` 接触溶解效果不在此范围内（仅用 Move 效果）
- 不优化 EDA 工具集成或覆盖率面板的 UI（仅 AI Agent 交互区域和通用输入/按钮）

## Further Notes

### 原型验证

原型 HTML 位于 `docs/prototypes/ui-visual-enhancement.html`，包含 9 个 Before/After 对比场景和全部 9 种 ThinkingOrbs 状态的 64px/20px 展示。原型使用简化版 canvas 动画模拟 thinking-orbs 的实际效果，实际实现使用 npm 包的真实引擎。

### 性能考量

- thinking-orbs：纯 2D canvas arcs，无 `ctx.filter`，DPR cap 2，所有实例共享一个 clock，离屏自动暂停。20px 尺寸开销极低。
- border-beam：rotate 类型使用 CSS `@property` keyframes（GPU 加速），pulse 类型使用共享 rAF 循环（~30fps cap），离屏自动暂停。
- liquid-gooey：组件驱动运动编译为 CSS `linear()` 缓动（GPU 合成），测量循环在静止时完全休眠。

### 可访问性

- thinking-orbs：自带 `role="img"` + 每状态 `aria-label`，`prefers-reduced-motion` 渲染静态代表帧
- border-beam：效果层均为 `pointer-events: none` 装饰，不影响键盘导航；pulse 类型自带 `prefers-reduced-motion: reduce` 禁用块
- liquid-gooey：内容层为真实 DOM，焦点环、ARIA、事件处理不变；`prefers-reduced-motion` 时过渡折叠为瞬态 snap

### 渐进式实施建议

可按以下顺序分批实施（每批可独立验证和提交）：
1. **第一批：thinking-orbs** — 替换 ThinkingBlock + ToolCard running + RunningIndicator + SubagentCard（4 个组件，最高视觉收益）
2. **第二批：border-beam** — 包裹 ComposerEditor + CommandPalette + SimCommandBar + ApprovalCard（4 个组件，焦点引导提升）
3. **第三批：liquid-gooey** — NavRail 视图切换液态指示器（1 个组件，动效流畅度提升）
