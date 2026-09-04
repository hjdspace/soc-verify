# Spec: RTL 层级解析与设计视图（Design View）

> 来源：ADR 0032（12 项子决策）+ S0 spike 实测结论（2026-09-04 全部验证点通过）。
> 领域术语见 CONTEXT.md「RTL 解析域」：Design Source / RTL Hierarchy / Module Instance / Module Definition / Protocol Bundle / Bundle Rule / Design View。

## Problem Statement

验证工程师在 SoC 验证工作中无法在本平台内浏览 DE 树 RTL 的设计结构：不知道模块层级组织（要开 Verdi hierarchy 树）、看不到模块接口全貌、没有顶层框图与信号连线、AMBA 总线的几十根信号在眼前是一堆扁平端口名不可读；编辑器打开 `.sv` 文件没有诊断、没有 hover、没有跳转，风格检查和格式化也缺位。设计理解与代码浏览工作流被迫在多个割裂的外部工具间往返。

## Solution

新增第七视图「设计」（Design View），与总览/仿真/覆盖率/回归/token/workspace 平级。用户配置 Design Source（一个或多个 VCS 风格 `.f` 文件 + 顶层模块选择）后：

- 主进程以 yosys（`read_slang --keep-hierarchy`）elaboration DE 树 RTL，`write_json` 流式提炼为自有模型（实例树 / 模块定义表 / 连线表，含 Protocol Bundle 打标），存 `.socverify/` 下 SQLite，tRPC 按需返回——渲染端零解析。
- 渲染端提供：虚拟滚动的 RTL Hierarchy 层级树、模块接口视图（端口表 + Protocol Bundle 分组）、可下钻的顶层框图（React Flow + elkjs，bundle 默认收拢为协议粗边，点击信号高亮连线）。
- 编辑器智能由 slang-server（LSP：诊断/hover/跳转）与 verible（style lint + format，design 组目录 dry-run 写保护）补齐。

## User Stories

**层级树与浏览**

1. 作为验证工程师，我想在 Design View 中浏览 DE 树 RTL 的层级结构（Module Instance 树），以便不开 Verdi 就能理解设计组织。
2. 作为验证工程师，我想层级树支持虚拟滚动，以便 SoC 级几万 instance 节点下滚动不卡。
3. 作为验证工程师，我想双击树上任意实例以它为图根下钻查看其内部结构，以便逐层深入子系统。
4. 作为验证工程师，我想在框图中通过面包屑知道当前图根路径并一键回退，以便在多层级下钻后不迷路。
5. 作为验证工程师，我想看到树节点上的模块统计信息（实例数等，来自 yosys `stat` 白送能力），以便快速判断子系统规模。

**模块接口与 Protocol Bundle**

6. 作为验证工程师，我想选中树节点查看该 Module Definition 的端口全表（名称/方向/位宽），以便写 TB 时对照接口。
7. 作为验证工程师，我想端口表按 Protocol Bundle 分组展示（AXI4/AXI4-Lite/AHB/APB/时钟/复位），以便 76 个端口的模块不是 76 行裸列表而是几组可读的协议束。
8. 作为验证工程师，我想在 bundle 分组内看到完整信号清单（含位宽与方向），以便需要裸端口视角时随时可得。
9. 作为验证工程师，我想看到未入束的自定义信号单列（leftovers），以便不遗漏非标准信号。
10. 作为验证工程师，我想通过项目级自定义 Bundle Rule 文件扩展/覆盖内置 AMBA 规则包，以便适配项目私有协议命名。

**框图与信号连线**

11. 作为验证工程师，我想查看以任意模块为根的框图（box = 实例，边 = 信号连线），以便直观看到子系统互连。
12. 作为验证工程师，我想 bundle 在框图上默认收拢为一条带协议标签的粗边（如 27 根 AXI4 信号合并为一条），以便 SoC top 框图可读。
13. 作为验证工程师，我想展开收拢的粗边看内部信号明细，以便核对具体连线。
14. 作为验证工程师，我想 hover 框图端口查看信号名/方向/位宽，点击信号高亮同名连线，以便追一条感兴趣的线。
15. 作为验证工程师，我想框图自动分层布局（elkjs）且不需要手动拖拽编辑，以便打开即用。

**Design Source 配置与数据生命周期**

16. 作为验证工程师，我想在项目设置中配置一个或多个 `.f` 文件（`+incdir+`/`+define+`/`-f` 嵌套全支持），以便 `ifdef` 分支与真实编译配置一致。
17. 作为验证工程师，我想从 elaborated top units 列表中选择顶层模块，且平台记住我的选择，以便下次直接进入同一结构。
18. 作为验证工程师，我想 DB 有数据时打开 Design View 秒开（缓存优先），以便不等待 elaboration。
19. 作为验证工程师，我想手动触发刷新（对齐 Case Scan 模式），源文件 mtime 变化时提示数据过期，以便自己控制何时重跑。
20. 作为验证工程师，我不想平台做文件监听自动重跑（DE 树大、网络盘监听成本高），以便后台不被频繁打断。

**编辑器智能（slang-server LSP）**

21. 作为验证工程师，我想在 CodeMirror 6 中打开 `.sv` 即获每次击键的语法/语义诊断，以便即时发现错误。
22. 作为验证工程师，我想 hover 符号看到类型/文档信息，以便读代码不用翻声明。
23. 作为验证工程师，我想跳转到定义（LSP definition），以便在层级文件间追踪信号来源。
24. 作为验证工程师，我想 LSP 的编译选项与 Design Source 共享同一 `.f` 配置，以便诊断不瞎报（不出现"明明配了 include 却报找不到头文件"）。

**verible lint 与 format**

25. 作为验证工程师，我想打开/保存 `.sv` 时后台自动跑 style lint 并在问题面板+波浪线展示，以便风格问题零成本暴露。
26. 作为验证工程师，我想显式触发 format（命令/按钮）而非保存自动格式化，以便不发生意外的批量改写。
27. 作为验证工程师，我想对 design 组目录的文件 format 默认走 dry-run（diff 预览确认后才写回），以便 DE 只读树不被误写。
28. 作为验证工程师，我想语义诊断由 slang-server 提供、风格由 verible 提供，两者互补不冗余，以便问题面板同时覆盖语义与风格。

**分发与降级**

29. 作为验证工程师，我想三工具（yosys/slang-server/verible）随应用打包或一键下载（`download:rtl-tools` 脚本 + 版本锁定），以便开箱即用。
30. 作为国内网络用户，我想下载支持镜像 URL 与离线手动放置，以便 568MB 的 OSS CAD Suite 包不走龟速直连。
31. 作为验证工程师，我想工具缺失时应用其余功能可用、RTL 功能给出明确降级提示与引导，以便下载失败不阻断构建与使用（officecli 同款策略）。

**源码联动**

32. 作为验证工程师，我想从树节点/框图实例/端口跳转到 Workbench 文件 tab 打开对应源码，以便层级浏览与代码阅读无缝切换。

## Implementation Decisions

### 范围与数据源（ADR 0032 主题 1）

1. **Phase 1 全量交付**层级树、模块接口、框图（含连线）、AMBA bundle、slang-server LSP、verible lint/format；按垂直切片（S1-S9）推进，每片可运行。
2. **层级四件套只看 DE 树**（design 组目录，多目录机制）；UVM/TB 运行时层级为明确非目标。lint/format 是文件级能力，不与层级范围绑定。
3. **Design Source = 用户配置 `.f` + 选 top**，不做目录自动扫描（无 defines 时 `ifdef 分支瞎猜）、不做 runsim 环境推导（项目插件化，后续）。

### 引擎与数据流（ADR 0032 主题 2 + S0 实测）

4. **yosys ≥0.67 为唯一 elaboration 引擎**（sv-elab/slang 已内置，Windows 二进制从 OSS CAD Suite 提取）。slang 单引擎、双引擎冗余方案均已否决——选型过程发现"yosys SV 前端受限"是过时认知（v0.67 起集成），ADR 0032 有完整记录，防止后人基于过时信息翻案。
5. **elaboration 命令**：`read_slang -f <filelist> --top <top> --keep-hierarchy` + `write_json`。**`--keep-hierarchy` 是硬性要求**——S0 实测不加此参数时整个设计被 flatten 成顶层门级原语，层级树完全丢失。备选 `--best-effort-hierarchy`。
6. **主进程解析 + SQLite**：spawn yosys → 流式解析 write_json → 提炼为自有模型（实例树/模块定义表/连线表 + bundle 打标）→ 存 `.socverify/` 下 SQLite（对齐 Case Database 模式）→ tRPC 按需返回子树/接口/连线。渲染端零解析；raw write_json 不持久化（体积大、可再生）。
7. **刷新对齐 Case Scan 模式**：DB 有数据秒开，手动刷新触发重 elaboration，mtime 变化提示过期，无文件监听。

### write_json 提炼模型（S0 实测确认的关键结构）

8. **uniquified 命名模式**：`--keep-hierarchy` 下每实例是独立模块，命名 `<defName>$<完整实例路径>`（如 `spike_ip$spike_top.u_subsys1.gen_ip[3].u_ip`）——模块名自带实例树，generate 展开正确（参数化实例各自展开）。extractor 按 defName 聚合 Module Definition，按 cells 遍历/命名重建 Module Instance 树。
9. **实例 cell 的 `connections` 键即端口名**（值为 bit id 数组）；`netnames` 带 `hdlname` attribute 保持 RTL 原名——框图连线提取锚点。bit id 通过 endpoints 聚合（≥2 实例 → 实例互连边 i2i；1 实例 + 顶层端口 → top2i 边）。
10. **已知缺口**：uniquified 模块的 `parameter_default_values` 为空，参数覆盖值（如 N_IP=2/4）丢失——S2 需补展示方案（从子实例数量反推或 slang 辅助），不阻塞架构。

### Protocol Bundle 规则引擎（ADR 0032 主题 3 + S0 原型）

11. **bundle 是平台自研语义层**（yosys 只认位向量不认协议）：主进程提炼阶段做端口命名模式匹配。本 DE 树纯扁平命名、无 SV interface（用户确认），按"前缀聚类 + 信号名后缀"识别。
12. **规则形态**（S0 原型验证，96% 入束）：每条规则含——
    - `prefixOf` 信号名聚类（如 `axi0_awvalid` 前缀 `axi0_`；`h_haddr` 前缀 `h_`）
    - 判别条件 `requiresAnyOf`（满足其一即协议成立，如 AXI4 的 awid/arid/awlen/wlast）与 `requiresAllOf`（全须满足，如 AXI4-Lite 的 awaddr/awvalid/wvalid/bresp）+ `minSignals` 下限
    - `roleDetection` 按关键信号方向推断 master/slave（如 `awvalid` 为 input → 本模块是 slave）
    - singleton 规则（clk/rst 正则，如 rst 匹配 `rst_n`/`rst_ni`/`aresetn`/`por_n` 等变体）
13. **内置 AMBA 规则包**（AXI4 / AXI4-Lite / AHB / APB / clk / rst）+ **项目级自定义规则文件**（`.socverify/` 下，覆盖/扩展内置）。规则按 priority 顺序匹配，单端口只入一个 bundle。
14. **bundle 是公共消费索引**：框图粗边、接口分组、树节点徽标统一从打标数据消费。
15. **S0 实测基准**：96% 入束（73/76 端口），AXI4（27 信号含全通道特征）/AXI4-Lite/AHB/APB 判别与 role 推断全对，leftovers 均为自定义信号。

### UI（ADR 0032 主题 4）

16. **第七视图 Design View**（`ui.activeView` 路由扩展为七视图，刷新持久化）；Workbench destination 入口方案被用户否决——设计浏览是一级工作流。
17. **框图**：React Flow + elkjs 自动分层布局；任意模块可作图根（双击实例下钻 + 面包屑）；端口按方向分布 box 边缘；bundle 默认收拢、可展开；hover 端口看信号/位宽；点击信号高亮同名连线；不做手动拖拽编辑。
18. **层级树虚拟滚动**（SoC 级几万节点）。
19. **源码跳转走 Workbench 文件 tab**（design 组目录写保护边界复用）。

### 编辑器智能（ADR 0032 主题 5 + S0 实测）

20. **slang-server 集成**（hudson-trading/slang-server v0.2.10+，windows-x64.zip 官方资产）：主进程 spawn（stdio LSP）+ 桥接渲染端 CodeMirror 6。MVP = 诊断 + hover + 跳转；补全/references 第二波。配置共享 Design Source（`.f` 转 slang-server Build File 模式）。hankhsu1996/slangd 因 WIP 不稳定已否决。
21. **verible 集成**：lint 无 JSON 输出旗标（S0 实测确认），输出为文本格式 `file:line:col-range: message [Style:] [rule]`，正则可解析；format 用 `--verify` 做 dry-run、`--inplace` 写回。lint 打开/保存时后台自动；format 显式触发，design 组目录默认 dry-run（diff 预览确认后写回），dv 树直接写。

### 架构与分发（ADR 0032 主题 6 + S0 实测）

22. **代码归属 `src/main/rtl/`**：binary.ts（三工具路径解析）/ elaborator（yosys 执行）/ extractor（write_json 提炼）/ bundle-rules（规则引擎）/ lsp-bridge（slang-server 桥）/ types.ts + `src/main/ipc/routers/rtl-router.ts`（领域 router 注册进 router.ts）。硬约束 3「EDA 工具集成由插件实现」不适用：该约束针对 VCS/IMC/runsim 类项目特定集成，解析基础设施属平台自带能力（officecli 先例一致）。bundle 规则文件本身即用户扩展点，无需新 PluginKind。
23. **二进制分发复用 officecli 模式**（ADR 0015 主题 1）：`download:rtl-tools` 脚本 + package.json 版本锁定 + `resources/binaries/` 打包 + 下载失败不阻断构建 + 运行时降级。三来源：OSS CAD Suite Windows 包（**从 568MB tgz 选择性提取**：yosys.exe 36MB + share/yosys 31MB + 8 个依赖 DLL ≈ 70MB 实际占用）、slang-server GitHub Releases、verible GitHub Releases。
24. **Windows DLL 事实（S0 实测）**：yosys.exe 依赖 8 个 DLL（libstdc++-6 / libgcc_s_seh-1 / libwinpthread-1 / libffi-8 / libreadline8 / libtermcap-0 / tcl86 / zlib1），**必须放 exe 同目录**——PATH 方式 bash/PowerShell 双重实测均不生效。分发脚本与运行时校验都按同目录布局。
25. **下载脚本必须支持镜像 URL 与离线手动放置**（国内网络实测教训：568MB 直连/代理均不可用）。

### 阶段路线（垂直切片）

26. S1 二进制分发 → S2 解析管线（elaborator/extractor/bundle-rules/SQLite/rtl-router）→ S3 设计视图+层级树 → S4 模块接口视图 → S5 bundle 引擎 → S6 框图（依赖 S4+S5）→ S7 slang-server 桥 → S8 verible → S9 测试补齐。S0 spike 已完成（2026-09-04，全部验证点通过）。

## Testing Decisions

- **测试哲学**：只测外部行为，不测实现细节；优先复用既有 seam，理想情况下一个主 seam。
- **主 seam = rtl-router tRPC procedure 边界**（最高层）：测试外部可观察行为——Design Source 配置 → 触发 elaboration → 查询层级树/模块接口/连线/bundle 数据。yosys 子进程在 spawn 边界 mock（fixture 提供固定 write_json），prior art = ADR 0015 主题 8 的 officecli mock spawn 模式。
- **bundle 规则引擎**：纯函数单测（前缀聚类 / requires 判别 / roleDetection / singleton 正则），fixture 用 S0 真实 yosys 端口数据（96% 入束为基准线），新增规则跑同一 fixture 回归。
- **extractor**：以 S0 真实 write_json（`def$instpath` uniquified 命名、generate 展开、i2i/top2i 边）为 golden fixture，断言聚合定义数/树形/边集合；合成大规模 fixture（几万实例）验证流式解析与分页查询性能。
- **LSP bridge**：进程边界 mock slang-server（录制 LSP 帧），测协议映射——didOpen → 诊断推送、hover 请求响应、definition 跳转。S0 的 lsp-probe.js 是真实协议帧的参考来源。
- **UI**：tests/ui 惯例的 RTL 组件测试（层级树渲染、bundle 分组、框图交互 mock 数据）。
- **不测**：yosys/slang/verible 工具本身的行为（外部依赖，S0 已实测背书）。

## Out of Scope

- UVM/TB 运行时层级（class 实例树，静态 elaborator 拿不到）
- CM6 补全 / references / rename / inlay hints（第二波，slang-server 已支持但桥接成本独立）
- 框图手动拖拽编辑（只读浏览）
- 跨层级信号 trace（Verdi 核心玩法，工作量独立成期）
- filelist 自动扫描 / runsim 环境推导（项目插件化）
- SV interface/modport 的 bundle 支持（本 DE 树无 interface，用户确认）
- 多用户协作 / Web 端（单用户桌面应用，硬约束 2）

## Further Notes

- 完整决策记录与已否决替代方案（前端解析 write_json / slang 单引擎 / 双引擎冗余 / drawio / hankhsu1996/slangd / 保存自动 format 等 9 项）见 ADR 0032 `docs/adr/0032-rtl-hierarchy-design-view.md`（含 S0 Spike 实测结论章节）。
- S0 spike 可复现资产在 `D:/AI/rtl-spike/`：合成 RTL 夹具（AXI4/AXI4-Lite/AHB/APB + generate + 参数化 + ifdef + include + 实例互连）、`run_yosys.ys`（已固化 `--keep-hierarchy`）、`extractor.mjs`（提炼器原型，可作 S2 参考实现）、`bundle-rules.json` + `bundle-test.mjs`（规则引擎原型）、`lsp-probe.js`（最小 LSP client）、`pe-imports.py`（PE 导入表解析，DLL 依赖排查可复用）。
- OSS CAD Suite 以 release 日期锁定版本（当前 20260902，含 yosys 0.68+138）；升级验证点 = `read_slang -h` 确认 `--keep-hierarchy` 仍存在 + DLL 依赖集不变。
- 遗留问题：参数覆盖值展示方案（write_json 不含实例参数 override）在 S2 设计时解决。
- 依赖 `read_slang` 遇到不可综合 SV 结构时 elaboration 失败的错误呈现（错误面板定位到源文件行）需在 S2 落实——slang 的诊断质量是该引擎的附加优势。
