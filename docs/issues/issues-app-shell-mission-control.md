# Issues: App Shell 重构 — Mission Control（方案 A v2）

> **Parent PRD**: [docs/prd/prd-app-shell-mission-control.md](../prd/prd-app-shell-mission-control.md)
>
> **执行细节权威来源**: [docs/app-shell-mission-control-plan.md](../app-shell-mission-control-plan.md)（现状盘点、功能保全清单、数据绑定总表、DoD）
>
> **视觉规范唯一来源**: [docs/prototypes/app-shell-redesign-a2-mission-control-refined.html](../prototypes/app-shell-redesign-a2-mission-control-refined.html)
>
> 9 个垂直切片（tracer bullet），对应 Plan 的 Slice 0–8。每个切片独立可运行、独立提交，完成后执行增量验证（`npm run typecheck && npm run lint && npx vitest run tests/ui`，按改动范围裁剪）。
>
> Issues 按依赖顺序排列（blocker 在前）。#3–#8 在 #2 完成后可并行。

---

## Issue #1: 基础组件 — Drawer / Backdrop / StatusBar

### Parent

[PRD: App Shell 重构 — Mission Control](../prd/prd-app-shell-mission-control.md)

### What to build

App Shell 重构的地基：通用抽屉原语、内容区遮罩、全局状态栏骨架。完成后可以在测试中演示抽屉开合动画（240ms 缓出）、Esc / backdrop 点击关闭，且关闭态抽屉完全不遮挡导航栏区域（原型踩坑的回归防线）。状态栏以静态数据先行（omp 已连接、引擎版本、秒级时钟），后续切片再接真实数据。

关键几何约束（来自原型踩坑记录，必须遵守）：

- 左抽屉关闭位移必须 ≥ left + width（原型：left:68px + 宽 330px → 位移 ≥ 400px 才完全离屏）
- Backdrop 只遮内容区（TitleBar 以下、状态栏以上、导航栏以右），框架保持可交互
- z-index 刻度：backdrop 40 / drawer 50（后续 dropdown 70 / palette 80 / toast 100）

### Acceptance criteria

- [ ] Drawer 支持左/右侧、自定义宽度、开合动画（240ms cubic-bezier(0.2,0.8,0.2,1)）
- [ ] 关闭态抽屉完全离屏——自动化测试用 getBoundingClientRect 断言不遮挡导航栏区域
- [ ] Esc 键关闭抽屉；backdrop 点击关闭抽屉
- [ ] Backdrop 范围仅覆盖内容区，TitleBar / 导航栏 / 状态栏不被遮罩、可交互
- [ ] StatusBar 渲染静态数据（omp 连接状态、引擎版本、时钟），时钟每秒刷新且组件卸载时清理定时器
- [ ] 所有颜色使用 globals.css 语义 token，无 hex/oklch 字面量
- [ ] UI 测试覆盖：开合、Esc 关闭、backdrop 点击关闭、关闭态离屏几何断言（tests/ui/drawer.test.tsx）

### Blocked by

None — can start immediately.

---

## Issue #2: 视图路由骨架 — NavRail + ViewContainer + AppShell 重组

### Parent

[PRD: App Shell 重构 — Mission Control](../prd/prd-app-shell-mission-control.md)

### What to build

Mission Control 的核心决策落地——混合模式视图路由。应用重组为「TitleBar + (NavRail | (ViewContainer + BottomPanel + StatusBar))」结构：

- 左侧 60px 窄图标导航栏切换五个视图：总览 / 仿真 / 覆盖率 / 回归 / workspace；仿真按钮带运行数 badge（数据来自 simulation store 的 activeRuns）；导航栏还含文件 / 版本控制 / AI 按钮（本切片先占位或接已有对话框）与底部设置按钮，每个按钮 hover 有纯 CSS tooltip。
- workspace 视图 = 现有多 Tab 工作区**原样完整嵌入**——文件编辑器、浏览器、终端等全部 Tab 能力零破坏。
- workbench 打开目的地分流：dashboard / coverage / regression / running-simulations 切换对应视图（不再开 Tab）；其余目的地照旧开 Tab 并自动切到 workspace 视图。
- `Ctrl+1..4` 快捷键切换四大视图（仅 ctrlKey 时拦截，不劫持输入框数字键）。
- 当前视图纳入布局持久化链路，刷新后保持。
- 本切片 LeftRail / RightPanel 暂不动（仍渲染在 workspace 视图内或原位），保证任意时刻可运行。

注意循环依赖：workbench store 内通过 `getState()` 访问 ui store，不 import hook。

### Acceptance criteria

- [ ] 导航栏五视图切换可用，激活态有选中指示，hover 显示 tooltip
- [ ] 仿真按钮 badge 显示 activeRuns 数量，无运行时隐藏
- [ ] `Ctrl+1..4` 切换四视图；输入框聚焦时输入数字不受影响
- [ ] 刷新/重启应用后回到上次所在视图（布局持久化链路接入）
- [ ] workbench.open(dashboard/coverage/regression/running-simulations) 切换视图且不开新 Tab
- [ ] workbench.open(file/terminal/simulation-detail 等) 自动切 workspace 视图并打开对应 Tab
- [ ] workspace 视图内文件编辑器、浏览器、终端三类 Tab 功能与尺寸/滚动行为正常（风险对策验证点）
- [ ] UI 测试覆盖：视图切换、badge 渲染、tooltip、open 分流两方向（tests/ui/nav-rail.test.tsx、tests/ui/view-routing.test.tsx）
- [ ] 增量验证通过：typecheck + lint + tests/ui 相关用例

### Blocked by

- Issue #1（基础组件——AppShell 重组需嵌入 StatusBar，视图容器结构依赖统一布局）

---

## Issue #3: 总览视图 — Mission Control 仪表盘

### Parent

[PRD: App Shell 重构 — Mission Control](../prd/prd-app-shell-mission-control.md)

### What to build

应用默认视图：打开即见全局验证状态。自上而下：

- ViewHeader（通用组件，后续视图复用）：标题 + 副标题 + 动作区（自动重跑 pill、导出、启动回归）。
- 里程碑进度条：需求导入→签核 6 步。数据暂无现成来源，先用项目级静态配置，后续接 API。
- KPI 行：功能覆盖率 / 代码覆盖率 / 通过率 / 活跃失败 4 张卡，含趋势 delta 与 sparkline（7 日序列缺数据源则降级隐藏，不造假）。
- 中部网格（1.6fr 1fr）：运行中仿真流（状态点/用例名+seed/子系统/进度条/ETA，复用现有 simulation store 数据逻辑）+ 覆盖率环面板（总环 + 四类图例条，coverage store 汇总）。
- 底部网格（1fr 1fr）：AI Agent 活动流（session store 最近消息 + 子代理帧聚合）+ 失败聚焦（用例名/原因/失败次数 pill/RCA 状态 pill）。

数据全部只读复用现有 store 与查询，本切片是「重新编排 + 视觉统一」，不重写数据层。

### Acceptance criteria

- [ ] 应用启动默认落在总览视图
- [ ] 4 张 KPI 卡正确渲染数值与 delta；sparkline 无数据源时降级隐藏且不留空白破图
- [ ] 里程碑条渲染 6 步进度（静态配置数据源，结构留好后续 API 接入口）
- [ ] 运行中仿真流展示 activeRuns 数据，含进度条与 ETA
- [ ] 覆盖率环与四类图例条正确渲染 coverage 汇总
- [ ] AI 活动流展示主/子代理消息与时间戳
- [ ] 失败聚焦面板展示失败用例与 RCA 状态 pill
- [ ] 空数据时各面板显示骨架屏或空状态，不出现空白/报错
- [ ] 布局遵循原型网格（KPI repeat(4,1fr)、mid 1.6fr 1fr、bottom 1fr 1fr，间距 --s3）
- [ ] UI 测试覆盖：KPI 渲染、空数据骨架、失败面板 pill 状态（tests/ui/dashboard-view.test.tsx）
- [ ] 多主题（含浅色）下目检通过

### Blocked by

- Issue #2（视图路由骨架——需要 activeView 路由与 ViewContainer）

---

## Issue #4: 仿真视图

### Parent

[PRD: App Shell 重构 — Mission Control](../prd/prd-app-shell-mission-control.md)

### What to build

仿真运行管理的工作视图：状态分段筛选器（全部/运行中/失败/通过/队列/已停止，每段带计数）+ 用例名/seed 关键字过滤框；主表格列含状态点、用例+seed、子系统、进度条、耗时、ETA；行点击下钻到仿真详情（workspace Tab）。顶栏提供停止全部 / 新建仿真动作（复用现有 simulation store 动作）。筛选无匹配时空状态（图标 + 文案 + 清空筛选按钮），加载中显示骨架屏。

### Acceptance criteria

- [ ] 分段筛选器各段计数正确，点击过滤表格
- [ ] 关键字过滤按用例名/seed 匹配，与状态筛选可叠加
- [ ] 表格列完整（状态点/用例+seed/子系统/进度条/耗时/ETA）
- [ ] 行点击打开对应仿真详情 Tab 并切换到 workspace 视图
- [ ] 筛选无匹配时空状态显示且「清空筛选」按钮可用
- [ ] 加载中显示骨架屏
- [ ] 停止全部 / 新建仿真动作接通现有 store 动作
- [ ] UI 测试覆盖：筛选组合、空状态切换、行点击路由（tests/ui/simulation-view.test.tsx）
- [ ] 多主题（含浅色）下目检通过

### Blocked by

- Issue #2（视图路由骨架）

---

## Issue #5: 覆盖率视图

### Parent

[PRD: App Shell 重构 — Mission Control](../prd/prd-app-shell-mission-control.md)

### What to build

覆盖率分析工作视图，最大化复用现有覆盖率组件与数据层（本视图是「重新编排 + 视觉统一」，能包则包，不重写数据层）：

- 双 Tab：模块排序 / Bin 明细。Bin 明细首次进入显示骨架屏（真实实现为查询 loading 态）。
- 7 日覆盖率趋势图：SVG 折线 + 90% 目标虚线（数据需新增历史查询或降级为最近 N 次 merge session）。
- 汇总面板：四类覆盖率条 + 距目标差值 + 收敛预测文案。
- 模块排序表：模块名/覆盖率条/功能/语句/分支/断言/24hΔ；低覆盖着色（<75% 黄、<70% 红）；点击行打开现有覆盖率明细组件（workspace Tab）。

### Acceptance criteria

- [ ] 双 Tab 切换正常，Bin 明细首次进入显示骨架屏后转数据态
- [ ] 趋势图渲染折线与 90% 目标虚线；无历史数据源时按降级策略处理，不造假数据
- [ ] 汇总面板四类覆盖率条与距目标差值正确
- [ ] 模块排序表低覆盖行着色正确（<75% 黄、<70% 红）
- [ ] 点击模块行打开现有覆盖率明细（workspace Tab 下钻路径保持）
- [ ] UI 测试覆盖：Tab 切换、排序交互、低覆盖着色、骨架→数据态（tests/ui/coverage-view.test.tsx）
- [ ] 多主题（含浅色）下目检通过

### Blocked by

- Issue #2（视图路由骨架）

---

## Issue #6: 回归视图

### Parent

[PRD: App Shell 重构 — Mission Control](../prd/prd-app-shell-mission-control.md)

### What to build

回归测试管理的工作视图，复用现有 regression store / RegressionPanel 的数据 hook：

- 套件卡片网格（repeat(4,1fr)）：smoke / nightly / feature_full / cov_closure 等套件，状态色 + 通过率 + meta 信息。
- 历史趋势表：#id / 时间 / 通过·失败数 / 通过率 / 时长 / Δ，点击行打开回归详情。
- 失败聚类面板：聚类 chip + 相似度 + 计数。数据源暂缺，渲染「待分类」占位并标注 TODO，不造假数据。

### Acceptance criteria

- [ ] 套件卡片网格渲染套件状态色、通过率与 meta
- [ ] 历史趋势表列完整，点击行打开回归详情
- [ ] 失败聚类面板渲染「待分类」占位 + TODO 标注，无假数据
- [ ] UI 测试覆盖套件卡片、历史表渲染与行点击（tests/ui/regression-view.test.tsx）
- [ ] 多主题（含浅色）下目检通过

### Blocked by

- Issue #2（视图路由骨架）

---

## Issue #7: 文件抽屉 + AI 抽屉（含 LeftRail 退役）

### Parent

[PRD: App Shell 重构 — Mission Control](../prd/prd-app-shell-mission-control.md)

### What to build

文件树与 AI 会话从常驻栏降级为可呼出抽屉：

- 左抽屉：文件树 / 子系统双 Tab，复用现有 FileTree / SubsysList 组件；底部「最近打开」列表（数据取 workbench tabs 历史，无现成记录则在 project store 新增最近文件数组）。
- 右抽屉：紧凑 AI 会话——头部 live 状态 + 子代理 mini 行 spinner + 消息流 + mini 审批卡 + composer。消息渲染复用现有 RightPanel 内部组件（MarkdownRenderer / ApprovalCard / SubagentCard），仅外壳换抽屉。
- AI 面板模式偏好：`drawer`（默认）| `docked`（旧固定右栏回退），偏好写入设置。
- 行为闭环（原型踩坑沉淀）：抽屉按钮 toggle、Esc 关闭、backdrop 点击关闭、切换视图时自动关闭所有抽屉；抽屉打开时 TitleBar / 导航栏 / 状态栏仍可交互。
- **本切片移除 LeftRail 宽侧栏渲染路径**：文件树/子系统已入抽屉、overview 已入总览视图、plugins 走 workspace——这是旧布局的 contract 步骤。

### Acceptance criteria

- [ ] 左抽屉双 Tab 复用现有文件树/子系统组件，功能无降级
- [ ] 最近打开列表渲染且点击可打开文件
- [ ] 右抽屉支持消息流、审批卡、子代理展示、composer 发送（复用现有内部组件）
- [ ] AI 面板可切换 drawer / docked 模式，docked 模式恢复旧固定右栏行为，偏好持久化
- [ ] 抽屉按钮 toggle、Esc、backdrop 点击三种关闭路径可用
- [ ] 切换视图时抽屉自动关闭
- [ ] LeftRail 宽侧栏渲染路径移除，功能保全清单中 files/subsystems/overview/plugins 四项全部有新归宿且可点通
- [ ] UI 测试覆盖：开合、Esc、视图切换联动关闭、composer 发送、关闭态离屏（tests/ui/file-drawer.test.tsx、tests/ui/ai-drawer.test.tsx）
- [ ] 多主题（含浅色）下目检通过

### Blocked by

- Issue #1（Drawer / Backdrop 原语）
- Issue #2（视图路由——setActiveView 联动 closeDrawers）

---

## Issue #8: TitleBar 重构 + 通知中心

### Parent

[PRD: App Shell 重构 — Mission Control](../prd/prd-app-shell-mission-control.md)

### What to build

TitleBar 按原型重构：Logo + 项目选择器（下拉切换已打开项目，复用现有项目切换逻辑）+ 全局搜索触发框（只读，含 Ctrl K 键帽提示）+ 回归运行徽章（`回归 #N 运行中 · x/y`，数据为当前运行中回归进度，点击跳回归视图）+ 通知铃铛 + 窗口控制。ToolsDropdown 保留。

通知中心（新建下拉面板，340px，z-index 70）：未读高亮 + 圆点、图标按类型着色（失败红/覆盖率蓝/评审琥珀/通过绿）、「全部标为已读」。

事件通道硬约束：tRPC subscription 不可用，走 `webContents.send` + preload `eventBridge`（与 session:event 同模式）。数据源为仿真失败、覆盖率里程碑、任务完成事件；已有事件通道的直接订阅映射，缺失的在主进程对应 router 补发（仅 renderer 侧消费，不改 omp）。建议拆两步交付：先 renderer 消费已有事件，再补缺失事件。通知持久化在主进程 JSON（与项目状态同级）或 SQLite 表中二选一，并在交付说明中注明选型。

### Acceptance criteria

- [ ] TitleBar 布局符合原型：Logo / 项目选择器 / 搜索触发框 / 回归徽章 / 铃铛 / 窗口控制，ToolsDropdown 保留
- [ ] 项目选择器可切换已打开项目（复用现有逻辑）
- [ ] 回归徽章显示运行中回归的 x/y 进度，点击跳转回归视图；无运行回归时隐藏
- [ ] 通知中心下拉渲染通知列表：未读高亮 + 圆点、类型着色图标、全部标为已读
- [ ] 仿真失败 / 覆盖率里程碑 / 任务完成事件推送进入通知中心，未读计数联动铃铛
- [ ] 通知持久化到主进程存储，重启后不丢失
- [ ] 主进程改动仅限事件补发与通知持久化，不触碰 omp
- [ ] UI 测试覆盖：未读计数、标为已读、事件推送入库（tests/ui/notification-center.test.tsx）
- [ ] 多主题（含浅色）下目检通过

### Blocked by

- Issue #2（视图路由——回归徽章跳转依赖视图切换）

---

## Issue #9: 命令面板升级 + 收尾验收

### Parent

[PRD: App Shell 重构 — Mission Control](../prd/prd-app-shell-mission-control.md)

### What to build

命令面板升级为全局指挥台 + 整体重构收尾：

- 触发键增加 `Ctrl+K`（保留 `Ctrl+P`）；分组展示（导航/动作/面板）+ 输入过滤 + ↑↓ 键盘导航 + Enter 执行 + Esc 关闭 + 空结果态。
- 动作组接入真实操作（复用现有 tRPC mutation）：启动回归、停止全部仿真、重跑失败用例、生成覆盖率报告。
- 导航组覆盖五视图切换。
- 收尾：全局快捷键地图文档化（TitleBar tooltip / 设置页快捷键表）；移除废弃代码路径（旧 LeftRail 残留、废弃样式）；全量回归与逐主题目检；更新 AGENTS.md 架构参考段（AppShell 新结构）。
- 最终对照 PRD 的 DoD 与功能保全清单逐项验收。

### Acceptance criteria

- [ ] `Ctrl+K` 与 `Ctrl+P` 均可呼出命令面板
- [ ] 分组（导航/动作/面板）+ 输入过滤 + ↑↓/Enter/Esc 键盘闭环可用；无结果时显示空结果态
- [ ] 动作组四项操作接通真实 tRPC mutation 并可执行
- [ ] 导航组可切换五视图
- [ ] 快捷键地图在 TitleBar tooltip 与设置页快捷键表中文档化
- [ ] 旧 LeftRail 残留代码路径与废弃样式清除（无死代码）
- [ ] 全量回归通过：`npm run typecheck && npm run lint && npx vitest run tests/ui` 零错误全绿
- [ ] 逐主题（含浅色）目检四大视图 + 抽屉 + 面板通过，无 hex/oklch 字面量
- [ ] PRD §功能保全清单（Plan §3.3）逐项点通，无死入口
- [ ] AGENTS.md 架构参考段更新 AppShell 新结构
- [ ] PRD 验收标准（DoD）全部达成：默认总览视图、Ctrl+1..4 切换且刷新保持、抽屉几何断言、测试覆盖 >60%、主进程改动仅限事件补发与通知持久化

### Blocked by

- Issue #3（总览视图）
- Issue #4（仿真视图）
- Issue #5（覆盖率视图）
- Issue #6（回归视图）
- Issue #7（文件/AI 抽屉与 LeftRail 退役）
- Issue #8（TitleBar 与通知中心）
