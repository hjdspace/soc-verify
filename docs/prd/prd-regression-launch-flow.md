# PRD: 回归发起流程 — 卡片模态发起回归

> **Parent ADR**: [ADR 0029: 回归发起流程收敛](../adr/0029-regression-launch-flow.md)
>
> **Glossary**: [术语表](../../CONTEXT.md) → 回归域（Regression Item / Regression Suite / Regression Run）
>
> **Triage label**: `ready-for-agent`

## Problem Statement

验证工程师在回归页能看到每个子系统的回归卡片（list/grp 数量、ON 用例数、历史状态），但卡片没有任何运行入口——真正能发起回归的面板藏在历史记录的详情目的地里，难以发现。仿真页虽然有一张"回归测试"选项卡片，但仿真命令栏要求必须选中 case 才能运行，纯回归从这条路走不通；且该卡片的 `-m` 选项回归执行链路并不支持。结果是：用户面对 `runsim -regr xxx.lst` 这个最基础的日常工作，却不知道该从哪里发起，两个页面都沾回归、都跑不通畅。

## Solution

回归发起统一收敛到回归页：点击子系统卡片弹出宽模态运行配置，在左侧搜索/过滤并选中一个 Regression Item（list 或 group，entry 只读预览辅助判断），在右侧配置选项（tag/nt/fm/cov/regr_work/merge/-m），底部实时预览 runsim 命令（只读 + 复制），点击运行。运行后模态关闭、不发生页面导航，卡片就地转为"运行中"并显示 x/y 进度；终端按需从卡片打开。仿真页"回归测试"卡片整体删除。允许多个回归并发，卡片聚合显示。

架构决策详见 [ADR 0029](../adr/0029-regression-launch-flow.md)。

## User Stories

### 发起入口

1. As a 验证工程师, I want to 点击子系统回归卡片直接打开运行配置模态, so that 我在回归页就能发起回归而不必寻找隐藏入口或切换页面
2. As a 验证工程师, I want to 在模态内按名称搜索 Regression Item, so that 在有 50+ list 的大子系统中快速定位目标列表
3. As a 验证工程师, I want to 按 type 过滤 item（只看 list 或只看 grp）, so that 我能收窄浏览范围
4. As a 验证工程师, I want to 按 tag 过滤 item, so that 我能找到包含指定标签（如 smoke）的列表
5. As a 验证工程师, I want to 在 item 列表中看到每个文件的 entry 数与 ON 用例数, so that 我能判断哪个列表规模合适
6. As a 验证工程师, I want to 展开选中 list 的 entry 只读预览（case/seed/tag/优先级）, so that 我能确认这是不是我要跑的那个列表
7. As a 验证工程师, I want to 查看 group 引用解析后的文件清单, so that 我知道跑这个 group 实际会包含哪些列表
8. As a 验证工程师, I want to 看到 group 聚合后的 tagSet, so that 我能对 group 整体做 tag 过滤

### 选项配置

9. As a 验证工程师, I want to 从选中 item 的 tagSet 中多选 `-tag`, so that 我只跑特定标签的用例
10. As a 验证工程师, I want to 配置 `-nt` 排除标签, so that 我能跳过不相关的标签
11. As a 验证工程师, I want to 勾选 `-fm`（fail mode）, so that 我能只重跑上次失败的用例
12. As a 验证工程师, I want to 勾选 `-cov` 收集覆盖率, so that 回归产出可用于 coverage merge
13. As a 验证工程师, I want to 填写 `-regr_work` 工作目录, so that 并发回归之间互不踩工作目录
14. As a 验证工程师, I want to 勾选 `-merge`（回归完成后自动 coverage merge）, so that 回归结束后不必手动 merge
15. As a 验证工程师, I want to 在未勾选 `-cov` 时 `-merge` 被禁用并说明原因, so that 我不会提交一条会被拒绝的命令
16. As a 验证工程师, I want to 输入 `-m` 的 DE TAG 把回归提交到 dashboard, so that 删除仿真页卡片后我仍有一个 UI 入口使用 dashboard 工作流
17. As a 验证工程师, I want to 看到随选项实时更新的只读 runsim 命令预览, so that 我在点击运行前确切知道将执行什么
18. As a 验证工程师, I want to 一键复制预览命令, so that 我可以拿去终端里手动执行或分享给同事

### 运行与反馈

19. As a 验证工程师, I want to 点击运行后模态关闭并停留在回归页, so that 我的监控视角不被打断
20. As a 验证工程师, I want to 卡片就地显示"N 个运行中"及最新 run 的 x/y 进度, so that 我不离开卡片网格就能掌握回归进展
21. As a 验证工程师, I want to 从运行中的卡片按需打开回归终端, so that 我想看实时输出时随时可看、不想看时不被强制跳转
22. As a 验证工程师, I want to 同时发起多个回归（不同 item 甚至不同子系统）, so that 我能并行推进多条验证线
23. As a 验证工程师, I want to 从卡片或历史终止一个运行中的回归, so that 发现提交错误时能及时止损
24. As a 验证工程师, I want to 回归结束时收到通知并可跳转终端或历史, so that 我不用盯着页面等待
25. As a 验证工程师, I want to 在历史表中看到每次 run 的命令、选项与状态, so that 我能回溯每次回归的执行细节

### 深度回看与页面清理

26. As a 验证工程师, I want to 从历史记录进入遗留回归详情面板做深度浏览, so that 分析过往运行时仍有充足空间（发起用模态、回看用详情页，意图分离）
27. As a 验证工程师, I want to 仿真页不再出现回归相关选项, so that 我建立单一心智模型：回归一律去回归页发起
28. As a 验证工程师, I want to 手动刷新 Discovery 以发现新增的 .lst/.grp 文件, so that 新写的回归列表立即可选

## Implementation Decisions

以下决策的完整论证见 ADR 0029，此处只列结论。

**入口与页面职责**

- 回归页子系统卡片（Regression Suite 卡片）是唯一发起入口：整卡可点击，打开运行配置模态
- 仿真页"回归测试"选项卡片整体删除，连带清理：插件仿真选项 schema 中的回归测试字段组、渲染进程 runsim 命令生成器中的回归分支、选项分组顺序常量中的回归测试分组、命令解析器对 `-regr` 系列标记的处理，以及对应测试断言
- 遗留回归详情面板保留，职责收窄为"历史回看的深度浏览目的地"（从历史记录进入），不再新增投入

**选择模型**

- 选择单位为单个 Regression Item（Regression List 或 Regression Group 二选一），一次 Regression Run 只跑一个 Item
- item 列表需支持名称搜索、type 过滤（list/grp）、tag 过滤；大子系统（50+ item）下应流畅（虚拟化或等效手段）
- entry 预览为只读、按需展开的表格；不做 entry 勾选、不做多 item 多选——多列表打包是 `.grp` 的职责（ADR 0020 决策 5 的展开边界不触碰）
- 选中 group 时 tagSet 由其引用的 list 递归聚合（复用现有 group 引用解析，含深度与循环保护）

**选项与命令**

- 选项集：`-tag`（多选，候选来自 item tagSet）、`-nt`（多选）、`-fm`、`-cov`、`-regr_work`（字符串）、`-merge`（依赖 `-cov`，UI 禁用 + 主进程校验双重把关）、`-m`（字符串，DE TAG）
- `RegressionRunOptions` 类型与回归命令构造函数扩展 `-m`；历史记录照旧序列化完整选项
- 命令构造逻辑收敛为共享纯函数，模态预览与实际执行共用同一实现——不出现第三个命令构造器（仿真页删除后，全应用回归命令构造只有这一处）
- 预览只读 + 一键复制；不做可编辑命令（选项是唯一数据源，避免双向同步）
- 不做选项预设

**运行反馈**

- 点击运行：模态关闭，无任何导航；回归 store 移除"自动打开终端目的地"的现有行为
- 卡片运行态：显示"N 个运行中" + 最新 run 的 x/y 进度（进度来自现有回归事件流：started/progress/finished）
- 并发不设限；同 `-regr_work` 的冲突由用户自行规避
- 终端按需打开：从运行中卡片（或完成通知的动作按钮）触发，走现有终端 tab 创建路径
- 卡片通过率 "—" 占位保持不动

**术语**

- 选择单位在 UI 与代码中统一称 Regression Item；卡片数据单位称 Regression Suite（代码中 SuiteCard* 命名不变）；均已写入 CONTEXT.md 回归域

## Testing Decisions

- 好的测试只断言外部行为：给定选项组合断言生成的命令串；渲染组件后模拟用户交互（点击卡片、搜索、勾选、运行），断言可见输出与 mutation 入参；不探测内部状态或实现细节
- **接缝一（主进程，已有）**：回归命令构造纯函数——扩展现有 `tests/regression/regression-runner.test.ts`，新增 `-m` 用例及全选项组合用例；先例即该文件现有的逐选项断言风格
- **接缝二（渲染进程，已有 + 一个新文件）**：扩展 `tests/ui/regression-view.test.tsx`（卡片可点击、运行态进度显示、无导航断言）；新增模态测试文件覆盖 item 搜索/过滤/选中、entry 预览展开、选项表单（含 `-merge` 依赖 `-cov` 的禁用逻辑）、命令预览文案、运行时 `regression.run` 入参；组件测试模式先例：`tests/ui/sim-option-panel.test.tsx`
- **删除侧（维护既有测试）**：`tests/ui/sim-option-panel.test.tsx` 与 `tests/simulation/sim-option-schema.test.ts` 中回归卡片相关断言随功能删除而移除
- 按项目增量验证约定：typecheck + lint + `npx vitest run tests/regression tests/ui tests/simulation`（按改动范围裁剪）

## Out of Scope

- 卡片通过率真实数据链（regression-analyzer 结果解析、run↔结果目录关联、聚合口径）——后续独立立项，"—" 占位不动
- 多 item 多选、entry 级勾选、临时合并列表生成
- 回归选项预设保存/复用
- Discovery 文件监听（自动发现新列表）——维持手动刷新
- 同 `-regr_work` 并发冲突的防护或告警
- 仿真页回归选项的任何形式回归（永久删除，ADR 0029 决策 1）
- case 级 pass/fail 结果的解析与展示（由 runsim 管理，见 CONTEXT.md Regression History 词条）

## Further Notes

- 本次 grilling 未产出 HTML 原型；若实现过程中需要原型定稿 UI，按项目规则放入 docs/prototypes 目录
- 术语变更已同步 CONTEXT.md：新增 Regression Item、Regression Suite 词条，Regression Run 补 `-m` 与单 Item 约束；注意 Regression Suite 与 ADR 0020 移除的手工 RegressionSuite（caseId 集合）无关，词条内已显式划清
- 仿真页删除的完整波及面清单见 ADR 0029"后果"一节
