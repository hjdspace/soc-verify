# 0029 — 回归发起流程收敛：卡片模态发起，删除仿真页回归卡片

## 背景

回归页（`RegressionView` + `SuiteCardGrid`）目前是纯展示看板：卡片只有 Discovery 数据和历史记录，没有任何运行入口；真正能发起回归的是遗留 workbench 面板 `RegressionPanel`，但只能从历史记录的 `regression-detail` 目的地到达。另一方面，仿真页 `SimOptionPanel` 有"回归测试"选项卡片（`-regr`/`-fm`/`-tag` 等字段，来自插件 schema），但 `SimCommandBar` 要求必须选中 case 才能运行——纯回归从仿真页走不通，是断头路；且该卡片的 `-m`（提交 dashboard）选项回归 runner 的 `buildRegrCommand` 并不支持。结果是两个页面都沾回归、都跑不通畅，用户不清楚该从哪里发起 `runsim -regr`。

## 决策

回归发起统一收敛到回归页：点击子系统卡片弹出宽模态运行配置，选择单个 Regression Item（list 或 group，entry 只读预览）+ 配置选项 → 只读命令预览 → 运行。运行后留在回归页，卡片就地显示进度。

### 关键决策

| # | 决策 | 被拒绝方案及理由 |
|---|------|------------------|
| 1 | **回归页卡片为唯一发起入口；仿真页"回归测试"卡片整体删除** | 双入口共享对话框（两套触发点维护成本）；仿真页为唯一入口（回归数据与 case 树/SimCommandBar 的 case 校验耦合，是历史包袱） |
| 2 | **选择单位为单个 Regression Item，entry 只读预览（可展开表格）** | 多选 items / entry 勾选生成临时列表——触碰 ADR 0020 决策 5 的边界（展开归 runsim），且 `.grp` 本身就是多 list 打包的正规机制 |
| 3 | **运行配置为宽模态（~960px）：左 item 搜索/过滤列表，右选项 + 命令预览** | workbench 详情页——发起是执行型动作，导航离开回归页会打断监控闭环；空间问题用搜索/过滤 + 按需展开 entry 预览解决 |
| 4 | **运行后不导航：模态关闭，卡片就地显示"N 运行中"+ 最新 run 的 x/y 进度，终端按需打开** | 自动跳转终端 tab（现有行为，强制离开回归页）；底部面板自动展开终端（用户选择了完全按需） |
| 5 | **允许多个回归并发，卡片聚合显示** | 同子系统互斥 / 全局串行——同 `-regr_work` 冲突由用户自行规避（可填不同 work 目录） |
| 6 | **命令预览只读 + 一键复制** | 可编辑命令——选项是唯一数据源，编辑造成双向同步复杂度（仿真页 `parseRunsimCommand` 的前车之鉴） |
| 7 | **选项在现有 6 项基础上新增 `-m`（dashboard DE TAG）** | 不收编——`-m` 是删除仿真卡片后唯一失去 UI 入口的选项，提交 dashboard 是真实工作流 |
| 8 | **卡片通过率 "—" 占位保持不动** | 本次接 regression-analyzer 数据链——run↔结果目录关联、聚合口径是独立工程，范围失控 |
| 9 | **不做选项预设** | 复用仿真 preset 机制——回归选项仅 7 项且 tag/nt 从 item 的 tagSet 推导，配置成本低 |

## 后果

- 仿真页侧需一并清理：插件 schema 的"回归测试"字段组、`runsim-command.ts` 的回归分支、`GROUP_ORDER` 的 `'回归测试'`、`parseRunsimCommand` 的 `-regr` 系列处理
- `regression` store 的 `runRegression()` 不再自动打开 workbench 终端 destination；终端改为卡片/通知按需打开
- `RegressionRunOptions` 与 `buildRegrCommand` 需扩展 `-m` 选项
- 遗留 `RegressionPanel` 保留，职责收窄为历史回看的深度浏览目的地（从历史记录进入），不再投资
- 卡片通过率数据链（regression-analyzer ↔ run 关联、聚合口径）为后续独立立项
- 术语：选择单位正名为 Regression Item，卡片数据单位正名为 Regression Suite（见 CONTEXT.md；与 ADR 0020 移除的手工 RegressionSuite 无关）
