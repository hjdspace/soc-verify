# Design Plan：App Shell 重构 —— Mission Control（方案 A v2）

> 交接文档：本文档面向执行 Agent，包含完整的现状盘点、目标架构、分片任务与验收标准。
> 视觉规范唯一来源：[docs/prototypes/app-shell-redesign-a2-mission-control-refined.html](./prototypes/app-shell-redesign-a2-mission-control-refined.html)（单文件自包含，浏览器打开可交互体验）。

## 1. 背景与目标

当前桌面 UI 是经典 VSCode 式 IDE 布局（宽文件树左栏 + 多 Tab 中区 + AI 聊天右栏 + 底部终端），信息架构以「文件」为中心。但产品定位是 **AI Agent 驱动的 SoC 验证管理平台**，用户核心关注的是「验证状态与进度」。

经三轮原型比选（A Mission Control / B AI Workbench / C Dense Pro），确定采用 **方案 A v2（Mission Control 细化版）**：

- 打开即见全局仪表盘：KPI、里程碑、运行中仿真、覆盖率、AI 活动、失败聚焦
- 左侧窄图标导航（60px）切换四大视图：总览 / 仿真 / 覆盖率 / 回归
- 文件树与 AI 会话降级为可呼出抽屉（overlay + backdrop）
- TitleBar 承载：项目选择器、全局搜索（Ctrl+K）、回归运行徽章、通知中心
- 全局状态栏：omp 连接状态、引擎版本、仿真数、覆盖率、license、时钟

**重构原则：增量替换，功能零丢失。** 现有所有功能入口必须有新归宿（见 §3.3 功能保全清单），禁止一刀切重写。

## 2. 视觉与交互规范来源

| 规范项 | 来源 |
|---|---|
| 布局结构、组件形态、间距节奏 | 原型 HTML（上表链接），CSS 内含逐段注释 |
| 间距刻度 | `--s1..--s5 = 4/8/12/16/24px` |
| z-index 刻度 | backdrop 40 / drawer 50 / dropdown 70 / palette 80 / toast 100 |
| 色彩 | 原型用独立 OKLCH 调色板；**实现时必须映射到 globals.css 语义变量**（见 §5） |

### 2.1 原型踩坑记录（实现时勿重复）

1. **左抽屉关闭位移必须 ≥ left + width**（原型：`left:68px` + 宽 330px，位移须 ≥ 400px 才完全离屏，否则残留面板盖住导航栏并拦截点击）。
2. **Backdrop 只遮内容区**（`top:40px; bottom:24px; left:61px; right:0`），不遮 TitleBar / 导航栏 / 状态栏——抽屉打开时框架仍可交互。
3. 抽屉按钮为 toggle（再点关闭），切换视图时自动 `closeDrawers()`。

## 3. 现状盘点（d:\AI\soc-verify）

### 3.1 现有 Shell 结构

```text
AppShell.tsx
├── TitleBar.tsx            # 自定义无边框：Logo/折叠按钮/面包屑/运行徽章/ToolsDropdown/搜索/设置/窗口控制
├── LeftRail.tsx            # 宽侧栏(256px, 200-500 可调)，4 tabs: files/subsystems/overview/plugins
├── CenterArea.tsx          # 多 Tab 工作台（WorkbenchDestination 驱动）
├── BottomPanel.tsx         # 底部终端
├── RightPanel.tsx          # AI 聊天持久右栏(384px)
├── TaskPanel.tsx           # 浮动后台任务面板
├── OptionDock.tsx          # 底部仿真选项浮窗
├── CommandPalette.tsx      # 命令面板（Ctrl+P）
└── 各对话框：SettingsPanel / SourceControlDialog / EnvWizard / EnvManagerDialog
```

### 3.2 关键 Store

| Store | 职责 | 本次改动 |
|---|---|---|
| `stores/ui.ts` | 布局状态（折叠标志、宽度、对话框开关、pluginViewLayouts） | **新增 `activeView`、抽屉状态、通知状态** |
| `stores/workbench.ts` | Tab 管理，`WorkbenchDestination` 联合类型（file/browser/terminal/simulation-*/coverage/regression/dashboard/…） | dashboard/coverage/regression/running-simulations 目的地重定向到视图切换 |
| `stores/simulation.ts` | activeRuns、simOptions | 只读复用 |
| `stores/session.ts` | AI 会话、子代理帧聚合 | 只读复用（AI 活动流、AI 抽屉） |
| `stores/overview.ts` / `stores/project.ts` | 仪表盘汇总 / 项目与文件树 | 只读复用 |

### 3.3 功能保全清单（每个现有入口 → 新归宿）

| 现有入口 | 新归宿 |
|---|---|
| LeftRail › files（FileTree） | 左抽屉「文件」tab（导航栏「文件」按钮） |
| LeftRail › subsystems（SubsysList） | 左抽屉「子系统」tab |
| LeftRail › overview（DashboardSummary） | 总览视图吸收 |
| LeftRail › plugins（PluginViewHost） | 保持 workspace tab 打开方式 + 命令面板入口 |
| TitleBar › 左/右栏折叠按钮 | 抽屉开关移至导航栏图标；底部面板开关移至状态栏 |
| TitleBar › 面包屑（项目›子系统） | TitleBar 项目选择器（下拉切换） |
| TitleBar › 运行徽章 | 回归运行徽章（增强：`回归 #N 运行中 · x/y`，点击跳回归视图） |
| TitleBar › ToolsDropdown | 保留在 TitleBar（或并入命令面板「动作」组） |
| TitleBar › 搜索 / 命令面板 | TitleBar 全局搜索框 → 命令面板（Ctrl+K / Ctrl+P 双绑定） |
| TitleBar › 设置 | 导航栏底部设置图标 |
| TitleBar › 源代码管理 | 导航栏「版本控制」图标 → 现有 SourceControlDialog |
| RightPanel（AI 聊天） | AI 抽屉（默认）+ 可切换回固定侧栏模式 |
| BottomPanel（终端） | 保持全局底部面板（所有视图下方），状态栏开关 |
| TaskPanel / OptionDock / 各对话框 | 原样保留 |

## 4. 目标架构

### 4.1 新 AppShell 结构

```text
AppShell.tsx
├── TitleBar.tsx                  # 重构：Logo + 项目选择器 + 全局搜索 + 回归徽章 + 通知中心 + 窗口控制
├── <div class="main">            # flex 行
│   ├── NavRail.tsx               # 新增：60px 窄图标导航栏（视图切换 + 抽屉开关 + 设置）
│   └── <div class="content">     # flex 列
│       ├── ViewContainer.tsx     # 新增：按 activeView 渲染
│       │   ├── DashboardView     # 总览（Mission Control 仪表盘）
│       │   ├── SimulationView    # 仿真（表格 + 筛选）
│       │   ├── CoverageView      # 覆盖率（趋势 + 排序表 + Bin）
│       │   ├── RegressionView    # 回归（套件 + 历史 + 聚类）
│       │   └── WorkspaceView     # 现有 CenterArea 原样嵌入（文件/浏览器/终端/详情等 Tab）
│       ├── BottomPanel.tsx       # 保留（全局）
│       └── StatusBar.tsx         # 新增：全局状态栏
├── FileDrawer.tsx                # 新增：左抽屉（文件树 / 子系统 tabs + 最近打开）
├── AiDrawer.tsx                  # 新增：右抽屉（紧凑 AI 会话）
├── Backdrop.tsx                  # 新增：内容区遮罩（见 §2.1）
├── CommandPalette.tsx            # 升级：Ctrl+K、过滤、分组、键盘导航
├── NotificationCenter.tsx        # 新增：TitleBar 下拉通知中心
├── TaskPanel / OptionDock / 对话框  # 原样保留
└── ToastContainer.tsx            # 原样保留
```

### 4.2 视图路由（核心决策）

**混合模式：四大主视图独占切换 + 工作区 Tab 保留。**

- `ui.ts` 新增：`activeView: 'dashboard' | 'simulation' | 'coverage' | 'regression' | 'workspace'` + `setActiveView()`，纳入 `hydrateLayout` 持久化（project store 的 UI state）。
- 导航栏前 4 个图标切换视图；`workspace` 视图 = 现有 CenterArea 完整嵌入（不破坏任何 Tab 能力）。
- `workbench.open(destination)` 分流：
  - `dashboard` / `coverage` / `regression` / `running-simulations` → 改为 `setActiveView(对应视图)`（不再开 Tab）；
  - 其余（file/browser/terminal/simulation-detail/office-document/…）→ 照旧开 Tab，并自动 `setActiveView('workspace')`。
- 快捷键：`Ctrl+1..4` 切换四视图（原型行为），`Ctrl+K`/`Ctrl+P` 命令面板，`Esc` 关抽屉。

### 4.3 组件状态模型（ui.ts 新增字段）

```ts
activeView: ActiveView;              // 视图路由
fileDrawerOpen: boolean;             // 左抽屉
aiDrawerOpen: boolean;               // 右抽屉
aiPanelMode: 'drawer' | 'docked';    // AI 面板模式（默认 'drawer'，docked=旧 RightPanel 行为）
notifications: NotificationItem[];   // 通知中心
unreadCount / markAllRead / pushNotification
```

## 5. 样式与主题约束

- **Tailwind v4 + `cn()`**，语义色用 globals.css 的 CSS 变量（HSL 语义 token），**禁止直接写 hex/oklch 字面量**（原型中的 OKLCH 仅作视觉参考）。
- 原型色 → 语义 token 映射：

| 原型变量 | 语义 token（globals.css） |
|---|---|
| `--accent`（运行/正向） | `--status-running` / `--status-pass` 按语义区分 |
| `--red` | `--status-fail` |
| `--amber` | `--warning` |
| `--blue` | `--info` |
| `--violet` | `--violet`（已有） |
| `--bg/--surface/--border/--fg*` | `--background/--card/--border/--muted-foreground` 等 |

- 所有视图必须适配多主题（`[data-theme]`），实现后逐主题目检。
- Zustand 一律 `useStore((s) => s.field)` 选择器；文件 kebab-case，组件 PascalCase；TypeScript strict 禁 `any`。

## 6. 分片实施计划

> 每个 Slice 完成后执行增量验证（AGENTS.md 规定）：
> `npm run typecheck && npm run lint && npx vitest run tests/<相关目录>`
> Slice 建议逐个独立提交；改动涉及 UI 组件的，测试放 `tests/ui/`。

---

### Slice 0：基础组件（Drawer / Backdrop / StatusBar 骨架）

**新建**
- `components/layout/Backdrop.tsx`：内容区遮罩。**范围 = TitleBar(40px) 以下、状态栏(24px) 以上、导航栏(61px) 以右**；`pointer-events` 随开关切换（对照原型 §2.1 第 2 条）。
- `components/layout/Drawer.tsx`：通用抽屉原语。props：`side: 'left' | 'right'`、`open`、`onClose`、宽。动画 `transform 320ms cubic-bezier(0.2,0.8,0.2,1)`（缓动同原型，时长取 300-400ms 推荐区间）；**关闭位移 ≥ left + width**（§2.1 第 1 条）。z-index：backdrop 40 / drawer 50。
- `components/layout/StatusBar.tsx`：静态数据先行（omp 已连接、引擎版本、时钟）。时钟 `useEffect` + `setInterval(1s)`，组件卸载清理。

**测试**：`tests/ui/drawer.test.tsx`（开合、Esc 关闭、backdrop 点击关闭、左侧关闭态不遮挡导航栏——用 getBoundingClientRect 断言）。

---

### Slice 1：视图路由骨架（NavRail + ViewContainer + AppShell 重组）

**ui.ts**：`activeView` + `setActiveView` + 持久化（接入 project store 的 `hydrateLayout` / `saveState` 链路）。

**新建**
- `components/layout/NavRail.tsx`：60px 图标栏。上部 4 视图按钮（总览/仿真/覆盖率/回归，仿真按钮带运行数 badge，数据来自 `simulation.activeRuns`）；分隔线后：文件（→ 左抽屉）、版本控制（→ SourceControlDialog）、AI（→ 右抽屉）；底部：设置。每个按钮 hover tooltip（纯 CSS，参照原型 `.nav-btn .tooltip`）。
- `components/layout/ViewContainer.tsx`：按 `activeView` 渲染五个视图；`workspace` = 现有 `<CenterArea />` 原样嵌入。

**修改**
- `AppShell.tsx`：重组为 §4.1 结构。此 Slice 中 LeftRail/RightPanel **暂不动**（仍渲染在 workspace 视图内或原位），仅搭骨架——保证任意时刻可运行。
- `workbench.ts`：`open()` 分流（§4.2）；删除 dashboard/coverage/regression/running-simulations 的 Tab 打开路径，改为 `useUiStore.getState().setActiveView(...)`（注意 store 循环依赖，workbench 内用 `getState()` 而非 hook）。
- 快捷键 `Ctrl+1..4`（全局 keydown，注意在输入框聚焦时不劫持数字键——仅当 `e.ctrlKey` 时拦截）。

**测试**：`tests/ui/nav-rail.test.tsx`（视图切换、badge 渲染、tooltip）；`tests/ui/view-routing.test.tsx`（workbench.open('coverage') 切视图不开 Tab；open(file) 切 workspace 并开 Tab）。

---

### Slice 2：总览视图（Mission Control 仪表盘）

**新建** `components/views/DashboardView.tsx` 及子组件（目录 `components/views/dashboard/`）：
- `ViewHeader`（通用，放 `components/layout/`）：标题 + 副标题 + 动作区（自动重跑 pill、导出、启动回归）。
- `MilestoneBar.tsx`：验证里程碑进度（需求导入→签核 6 步）。数据源：**新增轻量 tRPC 或先用静态配置**（见 §7 备注）。
- `KpiRow.tsx`：4 张 KPI 卡（功能覆盖率/代码覆盖率/通过率/活跃失败），含趋势 delta 与 sparkline。数据：`overview` store / `DashboardSummary` 现有查询。
- `RunningSimStream.tsx`：运行中仿真流（状态点/用例名+seed/子系统/进度条/ETA）。数据：`simulation.activeRuns`（复用 RunningCasesPanel 的数据逻辑，UI 重排）。
- `CoverageRingPanel.tsx`：覆盖率环 + 四类图例条。数据：coverage store 汇总。
- `AgentActivityPanel.tsx`：AI Agent 活动流（主/子代理消息、时间戳）。数据：`session` store 最近消息 + 子代理帧。
- `FailureFocusPanel.tsx`：失败聚焦（用例名/原因/失败次数 pill/RCA 状态 pill）。数据：overview/dashboard failures。

**布局**：`mid-grid = 1.6fr 1fr`、`bottom-grid = 1fr 1fr`，间距 `--s3`；KPI 行 `repeat(4, 1fr)`。

**测试**：`tests/ui/dashboard-view.test.tsx`（KPI 渲染、空数据骨架、失败面板 pill 状态）。

---

### Slice 3：仿真视图

**新建** `components/views/SimulationView.tsx`：
- 分段筛选器（全部/运行中/失败/通过/队列/已停止，含计数）+ 关键字过滤框（用例名/seed）。
- 表格（列：状态点/用例+seed/子系统/seed/进度条/耗时/ETA），行点击 → `workbench.open({ type: 'simulation-detail', runId })`。
- **空状态**（无匹配 → 图标 + 文案 + 清空筛选按钮）与 **骨架屏**（加载中 shimmer，参照原型 `.sk-line`）。
- 顶栏动作：停止全部 / 新建仿真（复用现有 simulation store 动作）。

**测试**：`tests/ui/simulation-view.test.tsx`（筛选组合、空状态切换、行点击路由）。

---

### Slice 4：覆盖率视图

**新建** `components/views/CoverageView.tsx`：
- 双 Tab：模块排序 / Bin 明细（tab 切换，Bin 首次进入显示骨架屏 700ms 模拟加载——真实实现为查询 loading 态）。
- 7 日趋势图（SVG 折线 + 90% 目标虚线，参照原型 `#cov-chart`；数据需新增历史查询或降级为「最近 N 次 merge session」）。
- 汇总面板（四类覆盖率条 + 距目标差值 + 收敛预测文案）。
- 模块排序表（模块名/覆盖率条/功能/语句/分支/断言/24hΔ；低覆盖 <75% 黄、<70% 红），点击行 → 打开现有 CoverageTreeTable/ClosureDetailPage（workspace Tab）。
- **最大化复用** `components/coverage/CoverageDashboard.tsx`、`CoverageTreeTable.tsx`——本视图做的是「重新编排 + 视觉统一」，能包则包，不重写数据层。

**测试**：`tests/ui/coverage-view.test.tsx`（tab 切换、排序交互、低覆盖着色、骨架→数据态）。

---

### Slice 5：回归视图

**新建** `components/views/RegressionView.tsx`：
- 套件卡片网格（`repeat(4,1fr)`：smoke/nightly/feature_full/cov_closure 等，状态色 + 通过率 + meta）。数据：现有 regression store / RegressionPanel 查询。
- 历史趋势表（#id/时间/通过·失败数/通过率/时长/Δ），点击 → 回归详情。
- 失败聚类面板（聚类 chip + 相似度 + 计数；数据源若暂缺，先渲染「待分类」占位并标注 TODO，不造假数据）。
- 复用 `components/regression/RegressionPanel.tsx` 的数据 hook。

**测试**：`tests/ui/regression-view.test.tsx`。

---

### Slice 6：文件抽屉 + AI 抽屉

**新建**
- `components/layout/FileDrawer.tsx`：左抽屉，两个 tab（文件树 / 子系统）复用 `FileTree.tsx` / `SubsysList.tsx`；底部「最近打开」列表（数据：workbench tabs 历史或 editor store，若无现成记录则新增最近文件数组到 project store）。
- `components/layout/AiDrawer.tsx`：右抽屉，紧凑 AI 会话（头部 live 状态 + 子代理 mini 行 spinner + 消息流 + mini 审批卡 + composer）。**消息渲染复用 RightPanel 内部组件**（MarkdownRenderer/ApprovalCard/SubagentCard），仅外壳换抽屉。
- `ui.ts`：`aiPanelMode`（`'drawer' | 'docked'`，默认 drawer；docked = 保留旧 RightPanel 持久栏，偏好写入 settings）。

**行为**（对照原型 §2.1 第 3 条）：抽屉按钮 toggle；`setActiveView()` 时 `closeDrawers()`；`Esc` 关闭；backdrop 点击关闭。

**此时移除**：`LeftRail.tsx` 宽侧栏渲染路径（文件树/子系统已入抽屉；overview 已入总览视图；plugins 走 workspace）。

**测试**：`tests/ui/file-drawer.test.tsx`、`tests/ui/ai-drawer.test.tsx`（开合、Esc、视图切换联动关闭、composer 发送）。

---

### Slice 7：TitleBar 重构 + 通知中心

**修改** `TitleBar.tsx` 为原型布局：Logo + 项目选择器（下拉复用现有项目切换逻辑）+ 全局搜索框（只读触发器，`Ctrl K` kbd 提示）+ 回归徽章（数据：当前运行中回归的 `x/y` 进度，点击 → 回归视图）+ 通知铃铛 + 窗口控制。ToolsDropdown 保留。

**新建** `components/layout/NotificationCenter.tsx`：
- 下拉面板（340px，z-index 70）：未读高亮 + 圆点、图标按类型着色（失败红/覆盖率蓝/评审琥珀/通过绿）、「全部标为已读」。
- **数据源**（事件驱动，走 `webContents.send` + `eventBridge` 通道——tRPC subscription 不可用，硬约束）：仿真失败事件、覆盖率里程碑、任务完成。已有事件通道的（如仿真状态）直接订阅映射；**没有的新事件在主进程对应 router 补发**（仅 renderer 侧消费，不改 omp）。
- 通知持久化：主进程 JSON（与项目状态同级）或 SQLite 表，选一实现并在 PR 说明。

**测试**：`tests/ui/notification-center.test.tsx`（未读计数、标为已读、事件推送入库）。

---

### Slice 8：命令面板升级 + 收尾

**修改** `CommandPalette.tsx`：
- 触发键增加 `Ctrl+K`（保留 `Ctrl+P`）。
- 分组（导航/动作/面板）+ 输入过滤 + ↑↓ 导航 + Enter 执行 + Esc 关闭 + 空结果态（对照原型 palette 交互）。
- 动作组接入真实操作：启动回归、停止全部仿真、重跑失败用例、生成覆盖率报告（复用现有 tRPC mutation）。

**收尾**
- 全局键盘地图文档化（TitleBar tooltip / 设置页快捷键表）。
- 移除废弃代码路径（旧 LeftRail 残留、废弃样式）。
- 全量回归：`npm run typecheck && npm run lint && npx vitest run tests/ui`；逐主题（含浅色）目检四大视图 + 抽屉 + 面板。
- 更新 AGENTS.md 架构参考段（AppShell 新结构一句话）。

---

## 7. 数据绑定总表

| 原型组件 | 数据源 | 备注 |
|---|---|---|
| KPI 卡 ×4 | overview store / DashboardSummary 现有查询 | sparkline 需 7 日序列，缺则新增查询或降级隐藏 |
| 里程碑 | **暂无现成数据** | Slice 2 先静态配置（项目级 settings），后续接 tRPC |
| 运行中仿真流 | `simulation.activeRuns` | 现成 |
| 覆盖率环/汇总 | coverage store 汇总 | 现成 |
| AI 活动流 | `session` store | 现成（子代理帧已有聚合逻辑） |
| 失败聚焦 | dashboard failures 查询 | 现成 |
| 仿真表格 | `simulation.activeRuns` + 历史 | 现成 |
| 覆盖率趋势 | merge session 历史 | 可能需新增查询 |
| 模块排序表 | CoverageTreeTable 数据层 | 现成 |
| 套件卡片/历史 | regression store | 现成 |
| 失败聚类 | **暂无** | 占位 + TODO，不造假 |
| 通知 | 仿真/覆盖率/任务事件 | 部分需主进程补发事件 |
| 状态栏 | omp 连接态/引擎版本/license | 核对现有可用字段，缺的降级隐藏 |

## 8. 验收标准（DoD）

1. 启动应用默认落在总览视图，四大视图 + workspace 可通过导航栏与 `Ctrl+1..4` 切换，刷新后保持。
2. §3.3 功能保全清单逐项可点通，无死入口。
3. 左抽屉关闭态完全不遮挡导航栏（自动化测试断言）；backdrop 不遮 TitleBar/导航栏/状态栏。
4. 所有新组件通过既有主题（含浅色）目检，无 hex 字面量。
5. `npm run typecheck && npm run lint` 零错误；`npx vitest run tests/ui` 全绿；新增组件测试覆盖 >60%。
6. 不修改 `engine/oh-my-pi/`；主进程改动仅限事件补发与通知持久化。

## 9. 非目标（Out of Scope）

- 不改 BottomPanel / TaskPanel / OptionDock / 各对话框内部实现（仅外壳归位）。
- 不做方案 B（对话驱动工作台）的合并。
- 不做多用户/协作/Web 端。
- 失败聚类 AI 归因只做占位 UI，不含算法实现。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| CenterArea 内嵌 workspace 视图后尺寸/滚动异常 | Slice 1 单独验证文件编辑器、浏览器、终端三类 Tab |
| workbench ↔ ui store 循环依赖 | workbench 内用 `useUiStore.getState()`，不 import hook |
| 通知事件改动主进程面扩大 | Slice 7 拆小 PR：先 renderer 消费已有事件，再补缺失事件 |
| AI 抽屉化影响既有聊天工作流 | `aiPanelMode: 'docked'` 保留旧布局作回退 |
| 覆盖率趋势/里程碑无数据 | §7 备注的降级策略，禁止假数据入库 |
