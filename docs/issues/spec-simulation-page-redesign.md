# Spec: 仿真页面重构 — 左树 + 右选项面板 + 运行列表三栏布局

> **原型**: `docs/prototypes/sim-page-01-left-tree-right-options.html`
>
> **Triage Label**: `ready-for-agent`

---

## Problem Statement

当前的仿真视图（`SimulationView`）只是一个只读的运行列表表格，用户需要启动仿真时必须：
1. 打开左抽屉 → 切到「子系统」Tab → 在用例树中找到目标用例 → 点击运行
2. 仿真 Option 的配置在全局底部浮窗 `OptionDock` 中，与用例树分离
3. 运行列表在工作区的 `running-simulations` Tab 中，又需要额外切换

这意味着一次完整的「选用例 → 配参数 → 运行 → 查看结果」流程需要用户在三个不同位置之间反复切换，操作链路长、上下文频繁丢失。SoC 验证工程师期望在一个统一的仿真工作台中完成选用例、配参数、看运行的全流程，类似 IDE 的三栏布局。

## Solution

将仿真视图重构为 **IDE 三栏布局**（基于原型 `sim-page-01-left-tree-right-options.html`），在一个页面内整合：

1. **左侧栏 — 子系统/用例树**：从 `FileDrawer` 中抽出 `SubsysList` 组件，直接嵌入仿真视图左侧。保留全部功能：子系统展开/折叠、用例树（文件分组+baseCase 层级）、状态筛选、搜索、批量模式、右键菜单、刷新。
2. **中间区 — Option 面板 + 命令预览栏**：将 `OptionDock` 的 Option 卡片网格和命令预览/运行按钮从全局浮窗迁移到仿真视图中间区域。Option 面板标题动态显示当前选中的用例名。保留全部功能：schema 驱动的字段渲染、分组卡片、预设保存/加载、命令预览实时高亮、复制命令、运行仿真、解析回归指令。
3. **下方 — 运行列表**：复用现有 `SimulationView` 的运行列表表格（分段筛选器 + 关键字过滤 + 表格行），作为中间区域的下半部分。点击行跳转到运行详情 Tab。

`OptionDock` 全局浮窗和 `FileDrawer` 中的子系统 Tab 不再在仿真视图激活时使用（但工作区视图仍保留 OptionDock 浮窗和 FileDrawer 子系统 Tab，供用户在工作区快速运行仿真）。

## User Stories

1. 作为 SoC 验证工程师，我想在仿真页面左侧看到子系统/用例树，以便直接在仿真页面浏览和选用例，不需要打开左抽屉
2. 作为 SoC 验证工程师，我想在仿真页面左侧展开子系统后看到用例树（按文件分组、含 baseCase 层级），以便快速定位目标用例
3. 作为 SoC 验证工程师，我想在仿真页面左侧用状态筛选器（全部/通过/失败/运行中/待运行/后仿）过滤用例，以便快速找到特定状态的用例
4. 作为 SoC 验证工程师，我想在仿真页面左侧搜索框中输入关键字搜索用例，以便跨子系统快速定位用例
5. 作为 SoC 验证工程师，我想在仿真页面左侧点击用例后自动选中该用例并在中间区域填充 Option 参数（base/block/case），以便无需手动切换到 Option 面板逐项填写
6. 作为 SoC 验证工程师，我想在仿真页面左侧右键用例后看到上下文菜单（运行仿真/标记后仿），以便快速执行常用操作
7. 作为 SoC 验证工程师，我想在仿真页面左侧点击用例行的运行按钮直接启动该用例的仿真，以便跳过 Option 配置快速重跑
8. 作为 SoC 验证工程师，我想在仿真页面左侧进入批量模式后勾选用例并一键运行，以便批量执行回归用例
9. 作为 SoC 验证工程师，我想在仿真页面左侧刷新用例树（全局或单个子系统），以便用例配置变更后重新扫描
10. 作为 SoC 验证工程师，我想在仿真页面中间区域看到 Option 面板标题显示当前选中的用例名，以便明确当前正在配置哪个用例的参数
11. 作为 SoC 验证工程师，我想在仿真页面中间区域看到按分组（基础参数/波形配置/仿真参数/执行模式/回归测试）组织的 Option 卡片，以便按类别快速找到需要修改的参数
12. 作为 SoC 验证工程师，我想在仿真页面中间区域编辑 Option 字段值（文本/数字/开关/下拉），以便自定义仿真配置
13. 作为 SoC 验证工程师，我想在仿真页面中间区域看到实时生成的 runsim 命令预览（语法高亮），以便确认参数配置是否正确
14. 作为 SoC 验证工程师，我想在仿真页面中间区域复制 runsim 命令到剪贴板，以便在终端中手动执行
15. 作为 SoC 验证工程师，我想在仿真页面中间区域点击「运行仿真」按钮启动仿真，以便一键执行配置好的仿真
16. 作为 SoC 验证工程师，我想在仿真页面中间区域保存当前 Option 配置为预设，以便下次快速复用
17. 作为 SoC 验证工程师，我想在仿真页面中间区域加载已保存的预设，以便快速恢复之前的 Option 配置
18. 作为 SoC 验证工程师，我想在仿真页面中间区域看到「未指定 CASE」的警告提示，以便提醒我先用例树选中一个用例
19. 作为 SoC 验证工程师，我想在仿真页面中间区域解析回归指令文本（粘贴网页复制的完整指令），以便自动提取 runsim 命令参数填入 Option 字段
20. 作为 SoC 验证工程师，我想在仿真页面中间区域浏览选择回归列表文件（.list/.txt），以便配置回归测试的用例列表
21. 作为 SoC 验证工程师，我想在仿真页面下方看到运行列表表格（含状态点/用例名+seed/子系统/进度/耗时/ETA），以便实时监控仿真运行状态
22. 作为 SoC 验证工程师，我想在仿真页面下方用分段筛选器（全部/运行中/失败/通过/队列/已停止）过滤运行列表，以便快速查看特定状态的运行
23. 作为 SoC 验证工程师，我想在仿真页面下方用关键字过滤运行列表（用例名/seed），以便快速定位特定运行
24. 作为 SoC 验证工程师，我想在仿真页面下方点击运行行跳转到运行详情 Tab，以便查看该运行的详细信息（选项/编译错误/对比）
25. 作为 SoC 验证工程师，我想在仿真页面下方点击「停止全部」按钮中止所有运行中/队列中的仿真，以便快速停止全部
26. 作为 SoC 验证工程师，我想在仿真页面下方看到骨架屏（加载中状态），以便知道数据正在拉取
27. 作为 SoC 验证工程师，我想在仿真页面下方看到空状态提示（暂无仿真运行），以便知道当前没有任何运行
28. 作为 SoC 验证工程师，我想在仿真页面下方看到无匹配提示并可以清空筛选，以便在筛选无结果时快速重置
29. 作为 SoC 验证工程师，我想在仿真页面左中右三栏之间看到合理的分隔线和滚动行为，以便各区域独立滚动互不干扰
30. 作为 SoC 验证工程师，我想在仿真页面选中用例后左侧用例树高亮显示当前选中项（左侧条+背景色），以便明确当前正在配置哪个用例
31. 作为 SoC 验证工程师，我想在仿真页面左侧看到子系统旁的用例计数，以便快速了解各子系统的用例规模
32. 作为 SoC 验证工程师，我想在仿真页面左侧看到用例的状态点颜色（通过/失败/运行中/待运行），以便一眼判断用例的最近运行状态
33. 作为 SoC 验证工程师，我想在仿真页面左侧看到后仿标记（橙色标签），以便识别哪些用例需要跑后仿
34. 作为 SoC 验证工程师，我想在仿真页面左栏宽度可调（拖拽分隔线），以便根据用例名长度调整可视区域
35. 作为 SoC 验证工程师，我想在切换到仿真视图时自动加载子系统列表和活跃运行列表，以便无需手动刷新

## Implementation Decisions

### 模块变更总览

1. **`SimulationView` 组件大改**：从单一运行列表表格变为三栏布局容器，内部组合 `CaseTreePanel`（左）+ `SimOptionPanel`（中上）+ `RunListPanel`（中下）
2. **新增 `CaseTreePanel` 组件**：复用 `SubsysList` 的核心逻辑（用例树、搜索、筛选、批量、右键菜单），但适配为仿真视图内嵌面板（去掉外层容器 padding，调整为固定宽度可拖拽）
3. **新增 `SimOptionPanel` 组件**：复用 `OptionDock` 的 Option 卡片网格 + 命令预览栏逻辑，但迁移为仿真视图内嵌面板（不再使用全局浮窗 toggle 机制）
4. **新增 `RunListPanel` 组件**：从现有 `SimulationView` 中抽取出运行列表表格逻辑（分段筛选器 + 关键字过滤 + 表格行 + 空状态/骨架屏），作为仿真视图的下半部分
5. **`OptionDock` 保留但仅在 workspace 视图使用**：全局 OptionDock 浮窗不再在仿真视图激活时展示（通过 `activeView === 'simulation'` 条件隐藏），但工作区视图仍保留
6. **`FileDrawer` 子系统 Tab 保留但仅在 workspace 视图使用**：左抽屉的子系统 Tab 不变，但切换到仿真视图时不再需要打开左抽屉
7. **`AppShell` 布局条件**：仿真视图激活时隐藏 OptionDock 浮窗（避免与内嵌 Option 面板重复）

### 数据流与状态管理

- **simulation store 不变**：`simOptions`、`activeRuns`、`history`、`selectCase`、`setSimOption`、`startCaseRun` 等接口完全复用
- **project store 不变**：`selectedSubsys`、`caseStatusFilter`、`setSelectedSubsys`、`setCaseStatusFilter` 等接口完全复用
- **ui store 新增**：`simLeftPanelWidth`（左栏宽度，可拖拽调整，持久化到布局状态）
- 选中用例的联动保持不变：`SubsysList` 的 `handleCaseSelect` → `simulation.selectCase(caseData)` → `simOptions` 更新 → `SimOptionPanel` 响应式渲染

### 三栏布局结构

```
SimulationView (flex-1, flex-row)
├── CaseTreePanel (width: simLeftPanelWidth, flex-col)
│   ├── Header (子系统/用例 + 刷新/批量按钮)
│   ├── SearchBar (搜索框 + 子系统范围选择)
│   ├── StatusFilters (全部/通过/失败/运行中/待运行/后仿)
│   └── CaseTree (可滚动，子系统展开 → 文件分组 → 用例层级)
├── ResizeHandle (左栏宽度拖拽)
└── CenterArea (flex-1, flex-col)
    ├── SimOptionPanel (flex-shrink-0, max-h-280px, overflow-y-auto)
    │   ├── Header (仿真 Option · {caseName} + 预设/保存)
    │   ├── OptionCards (grid, schema 驱动的分组卡片)
    │   └── CommandBar ($ 命令预览 + 复制 + 运行按钮)
    └── RunListPanel (flex-1, flex-col)
        ├── Header (运行列表 + 计数 + 分段筛选器 + 搜索 + 停止全部)
        ├── TableHeader (状态/用例/子系统/进度/耗时/ETA)
        └── TableBody (可滚动，运行行)
```

### 组件复用策略

- `CaseTreePanel` **不直接复用** `SubsysList` 组件（因为 SubsysList 包含搜索范围下拉、刷新全部等抽屉专用功能），而是提取核心的 `buildCaseTree` + `CaseTreeItem` + 状态筛选 + 搜索逻辑，封装为仿真视图专用面板。`SubsysList` 组件本身保留不变（供 FileDrawer 使用）。
- `SimOptionPanel` **不直接复用** `OptionDock` 组件（因为 OptionDock 包含全局浮窗 toggle 机制），而是提取 `OptionCard` + `OptionField` + 命令预览逻辑。`OptionDock` 组件保留不变（供 workspace 视图使用），`OptionCard` / `OptionField` 提取为共享组件。
- `RunListPanel` **直接提取**自现有 `SimulationView` 的运行列表部分，逻辑无变化。

### OptionDock 隐藏策略

`AppShell` 中 `OptionDock` 的渲染增加条件：`activeView !== 'simulation'`。仿真视图内嵌的 Option 面板替代全局浮窗。

### 左栏宽度拖拽

使用现有 `ResizeHandle` 组件（`src/renderer/src/components/layout/ResizeHandle.tsx`），与右栏宽度拖拽一致的模式。宽度持久化到 `ui store` 的 `simLeftPanelWidth` 字段，随布局状态保存/恢复。

### API 契约

无新增 tRPC API。所有数据通过现有 store 接口获取：
- `trpc.project.getSubsystems.query` — 子系统列表
- `trpc.project.getCases.query` — 子系统用例列表
- `trpc.project.searchCases.query` — 用例搜索
- `trpc.project.getSimOptionsSchema.query` — Option schema
- `trpc.project.getSimOptionPresets.query` — 预设列表
- `trpc.project.saveSimOptionPreset.mutate` — 保存预设
- `trpc.simulation.listActiveRuns.query` — 活跃运行列表
- `trpc.simulation.runInTerminal.mutate` — 启动仿真
- `trpc.simulation.abortTerminalRun.mutate` — 中止单个
- `trpc.simulation.abort.mutate` — 中止单个（插件运行）
- `trpc.simulation.pickRegrFile.mutate` — 选择回归列表文件

### Schema 驱动的 Option 渲染

Option 字段 schema 由 `sim-option-schema` 插件提供（`SimOptionField` 类型，`src/shared/plugin-types.ts`），包含 `key` / `label` / `type`（string/number/boolean/enum）/ `default` / `group` / `enumValues` / `description`。渲染逻辑与现有 `OptionDock` 完全一致。

### 命令预览生成

使用现有 `generateRunsimCommand(simOptions)` / `tokenizeRunsimCommand(command)` / `parseRunsimCommand(text)` 函数（`src/renderer/src/lib/runsim-command.ts`），逻辑不变。

## Testing Decisions

### 测试理念

只测外部行为（用户能看到什么、能做什么），不测实现细节（内部状态、私有函数）。测试通过 mock 外部依赖（tRPC、store）隔离 IPC 和后端，聚焦于组件渲染输出和用户交互响应。

### 测试 seam

**一个主测试文件**：`tests/ui/simulation-view.test.tsx`（扩展现有文件），使用 jsdom + React Testing Library。

Mock 策略与现有 `simulation-view.test.tsx` / `SubsysList.test.tsx` / `OptionDock.test.tsx` 一致：
- `vi.mock('@renderer/stores/simulation', ...)` — mock `activeRuns` / `simOptions` / `startCaseRun` / `selectCase` / `setSimOption` / `stopAllRuns` 等
- `vi.mock('@renderer/stores/project', ...)` — mock `currentProjectId` / `selectedSubsys` / `caseStatusFilter` / `plugins` 等
- `vi.mock('@renderer/lib/trpc', ...)` — mock `project.getSubsystems` / `project.getCases` / `project.getSimOptionsSchema` / `project.getSimOptionPresets` / `simulation.listActiveRuns` 等
- `useUiStore` / `useWorkbenchStore` 使用真实 store（纯 zustand，无 IPC 依赖）

### 测试覆盖范围

1. **三栏布局渲染**：左栏 CaseTreePanel / 中栏 SimOptionPanel / 下栏 RunListPanel 均可见
2. **子系统用例树**：子系统展开/折叠、用例树渲染、状态点颜色、用例计数
3. **状态筛选**：点击筛选按钮 → 调用 `setCaseStatusFilter`
4. **搜索**：输入搜索词 → 调用 `trpc.project.searchCases.query`
5. **用例选中联动**：点击用例 → 调用 `selectCase` → simOptions 更新 → Option 面板标题更新 → 命令预览更新
6. **Option 字段编辑**：输入框变更 → `setSimOption` 调用 → 命令预览更新
7. **命令预览**：语法高亮 token 渲染（base/flag/value 三色）
8. **运行仿真**：点击运行按钮 → `startCaseRun` 调用
9. **预设保存/加载**：输入名称 → 保存 → `trpc.project.saveSimOptionPreset.mutate` 调用；加载预设 → `setSimOptions` 调用
10. **运行列表**：分段筛选器计数、关键字过滤、行点击路由（`workbench.open`）
11. **停止全部**：点击 → `stopAllRuns` 调用
12. **空状态/骨架屏/无匹配**：对应数据状态下正确渲染
13. **OptionDock 隐藏**：仿真视图激活时 OptionDock 浮窗不渲染

### 已有测试先例

- `tests/ui/simulation-view.test.tsx` — 现有仿真视图测试（运行列表部分）
- `tests/ui/SubsysList.test.tsx` — 子系统列表测试（树渲染、发现状态、筛选）
- `tests/ui/OptionDock.test.tsx` — Option Dock 测试（schema 渲染、字段编辑、命令预览、预设）
- `tests/ui/view-routing.test.tsx` — 视图路由测试（`workbench.open` 分流）

## Out of Scope

- **后端 API 变更**：不新增或修改任何 tRPC router procedure
- **simulation store 重构**：不修改 store 的 state 结构或 action 接口
- **OptionDock 组件删除**：`OptionDock` 全局浮窗保留，仅在工作区视图使用
- **FileDrawer 子系统 Tab 删除**：FileDrawer 的子系统 Tab 保留，仅在工作区视图使用
- **RunningCasesPanel 组件变更**：工作区中的 `RunningCasesPanel` 保持不变
- **新增 tRPC API**：不新增任何后端接口
- **omp 引擎修改**：不修改 omp 引擎源码
- **仿真历史/对比/编译错误视图**：这些 Tab 级视图保持不变，不在本次重构范围
- **SimControlToolbar / TerminalPanel**：终端相关组件不变
- **插件系统**：不修改插件接口或加载机制

## Further Notes

### 与现有 Mission Control 布局的关系

仿真视图重构是 App Shell Mission Control 布局（`docs/issues/issues-app-shell-mission-control.md` Issue #4）的延续。原 Issue #4 创建了只读运行列表的仿真视图，本次重构将其升级为完整的仿真工作台。

### OptionDock 浮窗与内嵌面板的共存策略

OptionDock 全局浮窗在仿真视图激活时隐藏（`activeView !== 'simulation'`），在工作区视图激活时保留。这样用户在工作区快速运行仿真（从文件树选中文件 → OptionDock 浮窗配置 → 运行）的流程不受影响。

### CaseTreePanel 与 SubsysList 的代码复用

`CaseTreePanel` 和 `SubsysList` 共享 `buildCaseTree` 函数和 `CaseTreeItem` 组件。建议将 `buildCaseTree` 和 `CaseTreeItem` 提取到 `src/renderer/src/components/project/case-tree-utils.ts` 中，供两个组件复用。`SubsysList` 的搜索范围下拉、全局刷新等抽屉专用功能不迁移到 `CaseTreePanel`。

### 左栏宽度持久化

`simLeftPanelWidth` 字段加入 `ui store` 的 `hydrateLayout` 持久化路径，与 `rightPanelWidth` / `optionDockExpanded` 一致。默认宽度 260px（与原型一致），最小 200px，最大 400px。

### 响应式行为

三栏布局在窗口宽度不足时优先压缩左栏（至最小宽度），其次压缩 Option 面板（滚动），运行列表始终保持可滚动。不设计移动端适配（Electron 桌面应用）。
