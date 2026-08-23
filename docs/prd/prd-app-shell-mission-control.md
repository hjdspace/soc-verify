# PRD: App Shell 重构 — Mission Control（方案 A v2）

> **Plan**: [app-shell-mission-control-plan.md](../app-shell-mission-control-plan.md) — 现状盘点、分片实施与验收标准（执行 Agent 必读）
>
> **Prototype**: [prototypes/app-shell-redesign-a2-mission-control-refined.html](../prototypes/app-shell-redesign-a2-mission-control-refined.html)（单文件自包含，视觉与交互规范唯一来源）
>
> **Glossary**: [adr/glossary.md](../adr/glossary.md)
>
> **Triage label**: `ready-for-agent`

## Problem Statement

SoC Verify 的桌面 UI 目前是经典 VSCode 式 IDE 布局：宽文件树左栏 + 多 Tab 中区 + AI 聊天右栏 + 底部终端，信息架构以「文件」为中心。但产品定位是 **AI Agent 驱动的 SoC 验证管理平台**，用户核心关注的是「验证状态与进度」，打开应用第一眼看到的却是一棵文件树。

具体痛点：

1. **打开即错位**：用户最关心的验证全局状态（KPI、里程碑、运行中仿真、覆盖率、失败聚焦）被埋在左栏 overview tab 和各处面板里，需要多次点击才能拼出全局认知。
2. **验证数据无独立工作区**：仿真/覆盖率/回归三类核心数据共享多 Tab 工作台，与文件编辑器、浏览器、终端混排，验证管理和工程编辑两种心智模型互相干扰。
3. **左栏信息密度错配**：256px 宽侧栏常驻文件树，但文件浏览是低频操作；高频的验证状态反而不在一级入口。
4. **TitleBar 拥挤**：面包屑、折叠按钮、搜索、设置、窗口控制挤在一行，多项目切换和全局状态感知能力弱。
5. **AI 聊天定位尴尬**：AI Agent 是平台核心能力，却作为固定右栏存在，屏幕空间被永久占用，且与验证数据割裂，AI 活动不可一眼感知。

经三轮原型比选（A Mission Control / B AI Workbench / C Dense Pro），确定采用 **方案 A v2（Mission Control 细化版）**。**重构原则：增量替换，功能零丢失**——现有所有功能入口必须有新归宿，禁止一刀切重写。

## Solution

将 App Shell 重构为 Mission Control 布局：

- **打开即见全局仪表盘**：总览视图承载 KPI、里程碑、运行中仿真流、覆盖率环、AI 活动流、失败聚焦。
- **左侧 60px 窄图标导航栏**切换四大视图：总览 / 仿真 / 覆盖率 / 回归（`Ctrl+1..4` 快捷键）。
- **混合视图路由**：四大主视图独占切换 + 现有多 Tab 工作区完整保留为第五个视图（workspace），文件/浏览器/终端/仿真详情等 Tab 能力零破坏。
- **文件树与 AI 会话降级为可呼出抽屉**（overlay + backdrop），按需占用屏幕；AI 面板保留 docked 模式回退。
- **TitleBar 重构**：项目选择器、全局搜索（Ctrl+K）、回归运行徽章、通知中心。
- **全局状态栏**：omp 连接状态、引擎版本、仿真数、覆盖率、license、时钟。

视觉与交互规范以原型 HTML 为唯一来源；实现时色彩必须映射到 globals.css 语义变量，禁止 hex/oklch 字面量。

## User Stories

### 视图路由与导航

1. 作为 SoC 验证工程师，我希望应用启动后默认落在总览视图（Mission Control 仪表盘），这样打开应用第一眼就能看到全局验证状态而不是文件树。
2. 作为 SoC 验证工程师，我希望通过左侧 60px 窄图标导航栏在总览/仿真/覆盖率/回归四大视图间切换，这样单次点击即可到达核心工作区。
3. 作为 SoC 验证工程师，我希望通过 `Ctrl+1..4` 快捷键切换四大视图，这样双手不离键盘也能高效切换。
4. 作为 SoC 验证工程师，我希望当前激活视图在导航栏有明显的选中态指示，这样我随时知道自己在哪个视图。
5. 作为 SoC 验证工程师，我希望导航按钮 hover 时显示 tooltip 说明，这样我能快速了解每个图标的功能。
6. 作为 SoC 验证工程师，我希望导航栏的仿真按钮显示当前运行中仿真数量 badge，这样不进入仿真视图也能感知仿真活动。
7. 作为 SoC 验证工程师，我希望刷新或重启应用后回到上次所在的视图，这样不必每次重新导航。
8. 作为 SoC 验证工程师，我希望现有工作区 Tab 能力完整保留（文件编辑/浏览器/终端/仿真详情/office 文档等），这样重构不破坏任何已有工作流。
9. 作为 SoC 验证工程师，我希望打开文件/终端/仿真详情等目的地时自动切换到 workspace 视图并打开对应 Tab，这样操作路径自然流畅。
10. 作为 SoC 验证工程师，我希望从其他入口（命令面板、AI 会话链接、通知等）跳转 dashboard/coverage/regression/running-simulations 时切换到对应视图而不是新开 Tab，这样避免视图和 Tab 双重入口造成混乱。

### 总览视图（Mission Control 仪表盘）

11. 作为 SoC 验证工程师，我希望总览视图顶部显示验证里程碑进度条（需求导入→签核 6 步），这样我能快速了解项目所处阶段。
12. 作为 SoC 验证工程师，我希望总览视图显示功能覆盖率/代码覆盖率/通过率/活跃失败 4 张 KPI 卡，这样核心指标一目了然。
13. 作为 SoC 验证工程师，我希望 KPI 卡显示趋势 delta 与 sparkline，这样我能感知指标的近期变化方向。
14. 作为 SoC 验证工程师，我希望总览视图显示运行中仿真流（状态点/用例名+seed/子系统/进度条/ETA），这样无需进入仿真视图就能监控在跑任务。
15. 作为 SoC 验证工程师，我希望总览视图显示覆盖率环面板（总覆盖率环 + 四类图例条），这样覆盖率结构一眼可见。
16. 作为 SoC 验证工程师，我希望总览视图显示 AI Agent 活动流（主/子代理消息与时间戳），这样我能随时了解 AI 正在做什么。
17. 作为 SoC 验证工程师，我希望总览视图显示失败聚焦面板（用例名/原因/失败次数/RCA 状态），这样最需要关注的失败被推到眼前。
18. 作为 SoC 验证工程师，我希望总览视图头部提供动作区（自动重跑 pill/导出/启动回归），这样常用操作触手可及。
19. 作为 SoC 验证工程师，我希望无数据时各面板显示骨架屏或空状态而不是空白/报错，这样应用状态始终可理解。

### 仿真视图

20. 作为 SoC 验证工程师，我希望仿真视图提供状态分段筛选器（全部/运行中/失败/通过/队列/已停止）且每段带计数，这样一步过滤出目标用例。
21. 作为 SoC 验证工程师，我希望仿真视图支持按用例名/seed 关键字过滤，这样能快速定位特定仿真。
22. 作为 SoC 验证工程师，我希望仿真视图表格展示状态点/用例+seed/子系统/进度条/耗时/ETA，这样信息密度足够判断仿真状态。
23. 作为 SoC 验证工程师，我希望点击仿真表格行打开该仿真的详情 Tab，这样下钻路径直接。
24. 作为 SoC 验证工程师，我希望筛选无匹配结果时显示空状态（图标+文案+清空筛选按钮），这样不会面对一片空白。
25. 作为 SoC 验证工程师，我希望仿真视图加载中显示骨架屏，这样数据加载有明确反馈。
26. 作为 SoC 验证工程师，我希望仿真视图顶栏提供停止全部/新建仿真动作，这样批量操作不用去别处找。

### 覆盖率视图

27. 作为 SoC 验证工程师，我希望覆盖率视图提供模块排序/Bin 明细双 Tab，这样两种分析视角切换便捷。
28. 作为 SoC 验证工程师，我希望覆盖率视图显示 7 日覆盖率趋势折线图（含 90% 目标虚线），这样收敛速度一目了然。
29. 作为 SoC 验证工程师，我希望覆盖率视图显示四类覆盖率汇总条 + 距目标差值 + 收敛预测文案，这样离目标还有多远有量化感知。
30. 作为 SoC 验证工程师，我希望模块排序表按覆盖率着色（<75% 黄、<70% 红），这样薄弱模块视觉上直接突出。
31. 作为 SoC 验证工程师，我希望点击模块排序表行打开现有覆盖率明细（workspace Tab），这样保持既有下钻路径。
32. 作为 SoC 验证工程师，我希望 Bin 明细首次加载时显示骨架屏，这样加载过程不突兀。

### 回归视图

33. 作为 SoC 验证工程师，我希望回归视图以卡片网格展示回归套件（smoke/nightly/feature_full/cov_closure 等，含状态色与通过率），这样套件状态一目了然。
34. 作为 SoC 验证工程师，我希望回归视图显示历史趋势表（#id/时间/通过·失败数/通过率/时长/Δ），这样回归质量的时间变化可追溯。
35. 作为 SoC 验证工程师，我希望点击历史行打开回归详情，这样能下钻查看单次回归。
36. 作为 SoC 验证工程师，我希望回归视图显示失败聚类面板（聚类 chip/相似度/计数；数据源暂缺时显示「待分类」占位且不造假数据），这样相似失败被归组便于批量分析。

### 文件抽屉与 AI 抽屉

37. 作为 SoC 验证工程师，我希望通过导航栏文件图标呼出左抽屉（文件树/子系统双 Tab），这样需要浏览文件时才占用屏幕空间。
38. 作为 SoC 验证工程师，我希望左抽屉底部显示最近打开的文件列表，这样高频文件一键直达。
39. 作为 SoC 验证工程师，我希望通过导航栏 AI 图标呼出右抽屉（紧凑 AI 会话），这样 AI 协作不再永久占用固定右栏。
40. 作为 SoC 验证工程师，我希望 AI 抽屉支持消息流/审批卡/子代理展示/composer 发送等全部既有聊天能力，这样功能无降级。
41. 作为 SoC 验证工程师，我希望通过设置把 AI 面板切回固定侧栏（docked）模式，这样习惯旧布局的用户不受影响。
42. 作为 SoC 验证工程师，我希望抽屉按钮为 toggle（再点关闭）、`Esc` 可关闭、点击 backdrop 关闭，这样关闭路径符合直觉。
43. 作为 SoC 验证工程师，我希望切换视图时抽屉自动关闭，这样视图切换后画面干净。
44. 作为 SoC 验证工程师，我希望抽屉打开时 TitleBar/导航栏/状态栏仍可交互（backdrop 只遮内容区），这样抽屉打开时框架操作不被阻断。
45. 作为 SoC 验证工程师，我希望抽屉关闭后完全不遮挡导航栏，这样导航图标始终完整可见可点击。

### TitleBar 与通知中心

46. 作为 SoC 验证工程师，我希望 TitleBar 提供项目选择器（下拉切换已打开项目），这样多项目切换一步完成。
47. 作为 SoC 验证工程师，我希望 TitleBar 提供全局搜索触发框（含 `Ctrl K` 键帽提示），这样命令面板入口醒目。
48. 作为 SoC 验证工程师，我希望 TitleBar 显示运行中回归徽章（`回归 #N 运行中 · x/y`），这样回归进度全局可见；点击跳转回归视图。
49. 作为 SoC 验证工程师，我希望 TitleBar 提供通知中心（铃铛 + 未读计数 + 下拉面板），这样仿真失败/覆盖率里程碑/任务完成等事件不遗漏。
50. 作为 SoC 验证工程师，我希望通知按类型着色图标（失败红/覆盖率蓝/评审琥珀/通过绿）并区分未读高亮与圆点，这样重要事件视觉优先级明确。
51. 作为 SoC 验证工程师，我希望通知支持「全部标为已读」，这样清理通知状态一步完成。
52. 作为 SoC 验证工程师，我希望工具（ToolsDropdown）入口保留在 TitleBar，这样既有工具操作路径不变。

### 命令面板与状态栏

53. 作为 SoC 验证工程师，我希望命令面板同时支持 `Ctrl+K` 与 `Ctrl+P` 触发，这样两种肌肉记忆都有效。
54. 作为 SoC 验证工程师，我希望命令面板分组展示（导航/动作/面板）并支持输入过滤 + ↑↓ 键盘导航 + Enter 执行 + Esc 关闭，这样键盘操作效率最大化。
55. 作为 SoC 验证工程师，我希望命令面板的动作组接入真实操作（启动回归/停止全部仿真/重跑失败用例/生成覆盖率报告），这样高频操作键盘直达。
56. 作为 SoC 验证工程师，我希望命令面板搜索无结果时显示空结果态，这样搜索落空有明确反馈。
57. 作为 SoC 验证工程师，我希望全局状态栏显示 omp 连接状态/引擎版本/仿真数/覆盖率/license/时钟，这样系统健康状态常驻可见（缺数据源的字段降级隐藏）。
58. 作为 SoC 验证工程师，我希望状态栏提供底部终端面板开关，这样终端呼出不需要去 TitleBar 找。

### 视觉、主题与功能保全

59. 作为 SoC 验证工程师，我希望新 UI 的颜色全部走主题语义变量，这样切换主题（含浅色）时四大视图/抽屉/面板全部正确适配。
60. 作为 SoC 验证工程师，我希望新 UI 的间距遵循统一刻度（4/8/12/16/24px）、z-index 遵循统一刻度（backdrop 40 / drawer 50 / dropdown 70 / palette 80 / toast 100），这样视觉节奏与层叠行为一致可预期。
61. 作为 SoC 验证工程师，我希望现有全部功能入口（文件树/子系统/概览/插件视图/源代码管理/设置/各对话框/任务面板/仿真选项浮窗）在新布局中都有归宿，这样重构零功能丢失。

## Implementation Decisions

> 完整的现状盘点（现有 Shell 结构、关键 store、功能保全清单逐项映射）与分片实施顺序见 Plan 文档 §3/§6，执行 Agent 以其为执行细节权威来源。本节记录关键架构决策。

### 视图路由（核心决策）

**混合模式：四大主视图独占切换 + 工作区 Tab 保留。**

- ui store 新增 `activeView` 状态（来自原型/Plan 的决策性类型）：

```ts
type ActiveView = 'dashboard' | 'simulation' | 'coverage' | 'regression' | 'workspace';
```

- `activeView` 纳入既有布局持久化链路（hydrateLayout / saveState），刷新后保持。
- workspace 视图 = 现有多 Tab CenterArea **原样完整嵌入**，不拆不改，保证任意时刻可运行。
- workbench 的 `open(destination)` 分流：
  - `dashboard` / `coverage` / `regression` / `running-simulations` → 改为切换对应视图（不再开 Tab）；
  - 其余（file/browser/terminal/simulation-detail/office-document/…）→ 照旧开 Tab，并自动切换到 workspace 视图。
- 为避免 workbench ↔ ui store 循环依赖，workbench 内通过 `getState()` 访问 ui store，不用 hook。
- 快捷键 `Ctrl+1..4` 切换四视图；仅当 `ctrlKey` 时拦截，不劫持输入框中的数字键。

### 组件状态模型（ui store 新增字段，来自原型）

```ts
activeView: ActiveView;              // 视图路由
fileDrawerOpen: boolean;             // 左抽屉
aiDrawerOpen: boolean;               // 右抽屉
aiPanelMode: 'drawer' | 'docked';    // AI 面板模式（默认 drawer，docked=旧固定右栏回退）
notifications: NotificationItem[];   // 通知中心 + unreadCount / markAllRead / pushNotification
```

### 抽屉几何与层叠（原型踩坑沉淀，必须遵守）

1. **左抽屉关闭位移必须 ≥ left + width**：抽屉定位在导航栏右侧（原型 left:68px + 宽 330px，位移须 ≥ 400px 才完全离屏），否则残留面板盖住导航栏并拦截点击。
2. **Backdrop 只遮内容区**：范围为 TitleBar(40px) 以下、状态栏(24px) 以上、导航栏(61px) 以右——抽屉打开时框架（TitleBar/导航栏/状态栏）仍可交互。
3. 抽屉按钮为 toggle；`setActiveView()` 时自动关闭所有抽屉；`Esc` / backdrop 点击关闭。
4. z-index 刻度：backdrop 40 / drawer 50 / dropdown 70 / palette 80 / toast 100；间距刻度 `--s1..--s5 = 4/8/12/16/24px`。

### TitleBar / 导航栏职责重新分配

- TitleBar：Logo + 项目选择器（复用现有项目切换逻辑）+ 全局搜索触发框 + 回归运行徽章（数据为当前运行中回归的 x/y 进度，点击跳回归视图）+ 通知铃铛 + 窗口控制；ToolsDropdown 保留。
- NavRail（60px）：上部 4 视图按钮（仿真按钮带 activeRuns badge）+ 文件/版本控制/AI 抽屉开关 + 底部设置；tooltip 纯 CSS。
- LeftRail 宽侧栏在文件树/子系统入抽屉、overview 入总览视图、plugins 走 workspace 后**移除**（Slice 6 时机）。

### 通知事件通道（硬约束）

tRPC subscription 不可用。通知事件走 `webContents.send` + preload `eventBridge` 通道（与 `session:event` 同模式）：

- 数据源：仿真失败事件、覆盖率里程碑、任务完成。已有事件通道的直接订阅映射；没有的在主进程对应 router 补发（仅 renderer 侧消费，不改 omp）。
- 通知持久化：主进程 JSON（与项目状态同级）或 SQLite 表，实现时二选一并在交付说明中注明。

### 数据绑定与降级策略

各视图数据源优先复用现有 store（overview / simulation / coverage / regression / session）与现有查询，本 PRD 是「重新编排 + 视觉统一」，不重写数据层：

- 无现成数据的（里程碑、失败聚类、覆盖率 7 日趋势、KPI sparkline）按 Plan §7 降级：静态配置、占位 UI + TODO、或隐藏，**禁止假数据入库/入 UI**。
- 覆盖率视图最大化复用现有覆盖率组件；AI 抽屉消息渲染复用现有 RightPanel 内部组件（MarkdownRenderer/ApprovalCard/SubagentCard），仅外壳换抽屉。

### 样式与主题约束

- Tailwind v4 + `cn()`；语义色一律用 globals.css 的 HSL 语义 token，禁止直接写 hex/oklch 字面量（原型 OKLCH 仅作视觉参考）。映射：运行/正向→`--status-running`/`--status-pass`、红→`--status-fail`、琥珀→`--warning`、蓝→`--info`。
- 所有新组件必须适配多主题（`[data-theme]`，含浅色）。
- Zustand 一律选择器取值；文件 kebab-case、组件 PascalCase；TypeScript strict 禁 `any`。

### 增量替换策略

分片实施（Plan §6 的 Slice 0–8），每个切片独立可运行、独立提交、独立验证；任意中间状态不破坏现有功能。LeftRail/RightPanel 在骨架阶段暂不动，待抽屉就绪后再移除/降级。

## Testing Decisions

### 测试缝策略

复用项目已有测试缝，不新建缝：

**主缝：UI 组件缝（React Testing Library）**

- 所有新组件（Backdrop/Drawer/StatusBar/NavRail/ViewContainer/四大视图/FileDrawer/AiDrawer/NotificationCenter/CommandPalette 升级）在 `tests/ui/` 下测试
- Mock tRPC proxy / store 数据返回固定数据
- 先例：`tests/ui/title-bar.test.tsx`、`tests/ui/right-panel.test.tsx`、`tests/ui/coverage-dashboard.test.tsx`

**辅助缝：Store 状态缝**

- `ui.ts` 的视图路由/抽屉状态/持久化 hydration、`workbench.ts` 的 open() 分流逻辑
- 先例：`tests/ui/workbench-store.test.ts`

**几何行为断言（本 PRD 特有）**

- 抽屉关闭态离屏（不遮挡导航栏）、backdrop 范围（不遮 TitleBar/导航栏/状态栏）用 `getBoundingClientRect` 断言——这是原型踩坑的回归防线

**主进程事件缝（仅通知中心）**

- 主进程事件补发与通知持久化按 event-relay 模式测试；先例：`tests/ipc/event-relay.test.ts`

### 测试质量标准

- 只验证外部行为（渲染结果、交互后的可见状态、路由结果），不验证内部实现细节
- 测试命名描述行为意图（"closing drawer fully off- screens it from nav rail" 而非 "test drawer"）
- 覆盖：正常数据、空数据（骨架屏/空状态切换）、筛选组合、键盘交互（Esc/Ctrl+1..4/↑↓Enter）
- 覆盖率目标：新增 UI 组件 > 60%（项目标准）

### 增量验证纪律（AGENTS.md 规定）

每个切片完成后执行 `npm run typecheck && npm run lint && npx vitest run tests/ui`（按改动范围裁剪），通过即可提交，不跑全量。验收前逐主题（含浅色）目检四大视图 + 抽屉 + 面板。

## Out of Scope

- 不改 BottomPanel / TaskPanel / OptionDock / 各对话框（SettingsPanel/SourceControlDialog/EnvWizard/EnvManagerDialog）内部实现，仅外壳归位。
- 不做方案 B（对话驱动工作台）的合并。
- 不做多用户/协作/Web 端。
- 失败聚类 AI 归因只做占位 UI，不含聚类算法实现。
- 不修改 omp 引擎源码（`engine/oh-my-pi/`）；主进程改动仅限事件补发与通知持久化。
- 里程碑/覆盖率趋势等无数据源项不做真实数据接入（降级策略见 Implementation Decisions）。

## Further Notes

### 风险与对策

| 风险 | 对策 |
|---|---|
| CenterArea 内嵌 workspace 视图后尺寸/滚动异常 | 骨架切片单独验证文件编辑器、浏览器、终端三类 Tab |
| workbench ↔ ui store 循环依赖 | workbench 内用 `getState()`，不 import hook |
| 通知事件改动主进程面扩大 | 通知切片拆小 PR：先 renderer 消费已有事件，再补缺失事件 |
| AI 抽屉化影响既有聊天工作流 | `aiPanelMode: 'docked'` 保留旧布局作回退 |
| 覆盖率趋势/里程碑无数据 | 降级策略，禁止假数据 |

### 功能保全清单（验收红线）

现有入口 → 新归宿的逐项映射见 Plan §3.3（LeftRail files/subsystems/overview/plugins、TitleBar 折叠按钮/面包屑/运行徽章/ToolsDropdown/搜索/设置/源代码管理、RightPanel、BottomPanel、TaskPanel/OptionDock/对话框）。验收时逐项点通，无死入口。

### 关联文档

- Plan（执行细节权威来源）：现状盘点、Slice 0–8 分片、数据绑定总表、DoD
- 原型 HTML：视觉/交互规范唯一来源，含逐段 CSS 注释
