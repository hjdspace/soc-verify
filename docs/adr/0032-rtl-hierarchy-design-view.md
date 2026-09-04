# ADR 0032: RTL 层级解析与设计视图——yosys/slang-server/verible 三工具集成

## 状态

Proposed（2026-09-02 经 grilling 确认 12 项子决策；2026-09-04 S0 spike 验证通过，见文末实测结论，可进入 S1 实施）

## 背景

平台需要 Verdi-like 的 RTL 浏览能力：层级树、模块解析、模块接口、基于解析结果的顶层框图（含信号连线）、AMBA 等通用协议信号 bundle 收拢，以及编辑器智能（诊断/补全/格式化）。候选开源工具：yosys、slang 生态、verible。

### 已核实的关键事实（2026-09-02）

- **yosys ≥0.67 起 sv-elab（原 yosys-slang）集成进核心**：官方 README 明确 "Yosys is using sv-elab and slang libraries to provide comprehensive SystemVerilog support"（可综合子集，IEEE 1800-2017/2023）。`read_slang` 命令原生可用，支持 slang 风格选项。当前版本 0.68+。
- **write_json 格式成熟**：modules → ports（direction/bits）→ cells（type/port_connections）→ netnames，正是层级树+框图连线的数据模型（netlistsvg 生态验证过）。
- **slang 主仓不含 LSP**：tools 目录仅 driver/hier/reflect/tidy。正确的 LSP 选型为 [hudson-trading/slang-server](https://github.com/hudson-trading/slang-server)（v0.2.10+，`slang-server-windows-x64.zip` 官方资产已验证），支持 `.f` Build File 模式全项目 elaboration、每次击键诊断、hover/goto/references/completions。
- **verible**：win64.zip 官方发行；lint（70+ 风格规则、JSON 输出、waiver）+ format 为本职；不做预处理展开与 elaboration。
- 项目现状：CodeMirror 6 编辑器（legacy verilog 高亮，无 LSP client）；二进制分发有 officecli 成熟模式（`resources/binaries/` + 下载脚本 + 版本锁定 + 下载失败不阻断构建 + 运行时降级，ADR 0015）。
- 本项目 DE 树 RTL 为纯扁平端口命名，无 SV interface（用户确认）。

## 决策

### 主题 1：范围与数据源

**1.1 Phase 1 全量交付**：层级树、模块接口、框图（含连线）、AMBA bundle、slang-server LSP、verible lint/format 全部纳入。接受交付节奏风险，实施按垂直切片推进，每片可运行。

**1.2 层级范围只看 DE 树**：层级四件套针对 design 组目录（多目录机制，ADR 0027）。UVM/TB 运行时层级为明确非目标（静态 elaborator 拿不到 class 实例树）。lint/format 是文件级能力，不与层级范围绑定。

**1.3 Design Source 配置**：项目设置中用户配置一个或多个 .f 文件（VCS 风格 `+incdir+`/`+define+`/`-f` 嵌套全支持）+ 从 elaborated top units 列表选择顶层（记住选择）。`ifdef` 会改变层级结构，defines 必须来自项目真实编译配置，故不做自动扫描组 filelist；自动推导（如从 runsim 环境）留作后续项目插件。

### 主题 2：引擎与数据流

**2.1 yosys ≥0.67 为唯一 elaboration 引擎**：`read_slang --top <top> <files>` + `write_json` 产出层级/接口/连线数据。版本锁定 ≥0.67；Windows 二进制从 OSS CAD Suite 提取（yosys.exe + share/ 树）。

> 决策过程中曾以"yosys SV 前端受限"为由推荐 slang 单引擎，经查证该认知过时（v0.67 起 slang 已是 yosys 的内置 SV 前端）后反转。记录于此防止后人基于同样的过时信息"修复"这个选型。

**2.2 主进程解析 + SQLite 存储**：主进程 spawn yosys → 流式解析 write_json → 提炼为自有模型（实例树/模块定义表/连线表，含 Protocol Bundle 打标）→ 存 `.socverify/` 下 SQLite（对齐 Case Database 模式，ADR 0017）→ tRPC 按需返回子树/模块接口/连线数据。渲染端零解析；层级树虚拟滚动（SoC 级几万 instance 节点）。raw write_json 不持久化（体积大，重 elaboration 可再生）。

**2.3 刷新对齐 Case Scan 模式**：DB 有数据秒开，手动刷新触发重 elaboration，源文件 mtime 变化提示过期。不做文件监听自动重跑（DE 树大、网络盘，监听成本高）。

### 主题 3：AMBA bundle（自研语义层）

**3.1 命名规则识别**：yosys 只认位向量不认协议，bundle 是平台自研语义索引层。主进程提炼阶段做端口命名模式匹配（本 DE 树纯扁平命名，已确认无 interface 依赖）。内置 AMBA 协议规则包（AXI4/AXI4-Lite/AHB/APB 通道信号模式）+ 项目级自定义规则文件（`.socverify/` 下，覆盖/扩展内置规则）。

**3.2 bundle 是公共消费索引**：框图边收拢（一组端口对间的多信号合并为一条协议标签粗边）、模块接口分组、树节点徽标统一从打标数据消费。

### 主题 4：UI

**4.1 新增第七视图「设计」（Design View）**：与总览/仿真/覆盖率/回归/token/workspace 平级。层级树+框图联动；模块源码跳转走 Workbench 文件 tab 打开。（曾推荐 Workbench destination，用户拍板视图级入口——设计浏览是平台一级工作流。）

**4.2 框图**：React Flow + elkjs 自动布局，任意模块可作为图根（双击实例下钻+面包屑；数据模型天然支持全层级）。端口按方向分布 box 边缘，bundle 默认收拢（SoC top 裸信号不可读，收拢是可用性前提）。hover 端口看信号/位宽，点击信号高亮同名连线。不做手动拖拽编辑；跨层级信号 trace 后置（Verdi 核心玩法但工作量独立成期）。

### 主题 5：编辑器智能

**5.1 slang-server 集成**：主进程 spawn（stdio LSP）+ 桥接到渲染端 CodeMirror 6。MVP 能力 = 诊断+hover+跳转（读代码场景，与浏览四件套同频）；补全/引用第二波（CM6 补全桥接最重且是写代码场景）。配置共享 Design Source（.f 转 Build File 模式），避免诊断瞎报。

**5.2 verible 集成**：风格 lint 打开/保存时后台跑（问题面板+波浪线）；format 显式触发（命令/按钮），design 组目录文件默认 dry-run（diff 预览确认后写回），dv 树直接写。语义诊断由 slang-server 提供，verible 管 style lint + formatter——互补不冗余。

### 主题 6：架构与分发

**6.1 主进程核心模块 `src/main/rtl/`**：binary.ts（三工具路径解析）/elaborator（yosys 执行）/extractor（write_json 提炼）/bundle-rules（规则引擎）/lsp-bridge（slang-server）/types.ts + `src/main/ipc/routers/rtl-router.ts`。officecli 同款模式。硬约束 3「EDA 工具集成由插件实现」不适用：该约束针对 VCS/IMC/runsim 类项目特定集成，解析基础设施属平台自带能力（officecli 先例一致）。bundle 规则文件本身就是用户扩展点，无需新 PluginKind。

**6.2 二进制分发**：复用 officecli 模式（ADR 0015 主题 1）——`download:rtl-tools` 脚本、package.json 版本锁定、`resources/binaries/` 打包、下载失败不阻断构建、运行时降级。三个来源：OSS CAD Suite Windows 包（提取 yosys.exe + share/）、slang-server GitHub Releases（windows-x64.zip）、verible GitHub Releases（win64.zip）。

## 结果

### 架构收益

1. **三工具零冗余分工**：yosys（elaboration+网表 JSON）/ slang-server（编辑器语义智能）/ verible（风格 lint+format）
2. **渲染端零解析**：SoC 级数据不进渲染进程主线程
3. **单一数据源**：Design Source 同时驱动层级解析与 LSP 编译选项
4. **复用全部既有模式**：二进制分发（officecli）、SQLite（Case Database）、视图路由（六视图→七视图）、多目录 design/verify 边界（写保护）
5. **白送能力**：yosys passes（`stat` 模块统计可挂树节点）、slang-server 的 references/inlay hints 后续解锁成本低

### 新增依赖

| 依赖 | 用途 | 位置 |
| --- | --- | --- |
| `@xyflow/react`（React Flow） | 框图交互 | renderer |
| `elkjs` | 框图分层自动布局 | renderer |
| better-sqlite3 | RTL 层级 DB（已有依赖） | main |

## 阶段路线图（垂直切片）

| 阶段 | 交付物 | 依赖 |
| --- | --- | --- |
| S0 spike | 真实 DE 树验证：read_slang+write_json 输出/耗时、OSS CAD Suite Windows 提取可用性、slang-server windows 二进制连 CM6 桥可行性 | 无 |
| S1 二进制分发 | `download:rtl-tools` 脚本、binary.ts、package.json 锁定 | S0 |
| S2 解析管线 | elaborator/extractor/bundle-rules、SQLite、rtl-router | S1 |
| S3 设计视图+层级树 | 第七视图骨架、虚拟滚动树、top 选择 | S2 |
| S4 模块接口视图 | 端口表/bundle 分组/源码跳转 | S3 |
| S5 bundle 引擎 | 内置 AMBA 规则包+自定义规则文件 | S2 |
| S6 框图 | React Flow+elkjs、下钻、高亮 | S4+S5 |
| S7 slang-server 桥 | 主进程 LSP 管理+CM6 client（诊断/hover/跳转） | S1 |
| S8 verible | lint 自动+format 显式+dry-run 保护 | S1 |
| S9 测试补齐 | tests/rtl/（mock spawn 模式，ADR 0015 主题 8 同款） | 全部 |

## S0 Spike 实测结论（2026-09-04，D:/AI/rtl-spike）

**全部验证点通过**：yosys 0.68+138（OSS CAD Suite Windows 20260902）read_slang elaboration 0 errors 0 warnings、<1s；slang-server LSP 全链路（握手/诊断/hover/跳转）与 verible lint/format 行为均已实测。

关键发现（对 S1/S2 的直接输入）：

1. **read_slang 默认 flatten 整个设计**——不加参数时 write_json 只剩顶层模块+门级原语（$buf/$add/...），层级树完全丢失。必须加 **`--keep-hierarchy`**（实测本版无 crash；备选 `--best-effort-hierarchy`）。这是本次 spike 最重要的架构级发现。
2. **层级保留模式下的模块命名**：每实例 uniquified 为独立模块，命名 `<defName>$<完整实例路径>`（如 `spike_ip$spike_top.u_subsys1.gen_ip[3].u_ip`）——模块名本身编码实例树；generate 展开正确（N_IP=2/4 两实例分别展开 2/4 个子实例）。extractor 按 defName 聚合定义、按命名/cells 遍历重建树。
3. **实例 cell 的 `connections` 键即端口名**（值为 bit id 数组），比预期更直接；`netnames` 带 `hdlname` attribute 保持 RTL 原名——信号连线提取的锚点。
4. **参数覆盖值丢失**：uniquified 模块的 `parameter_default_values` 为空（S2 需补参数展示方案，可从子实例数量反推或 slang 辅助）。
5. **Windows DLL 分发事实**：yosys.exe 静态链接 mingw 运行时但仍依赖 7 个 DLL（libstdc++-6/libgcc_s_seh-1/libwinpthread-1/libffi-8/libreadline8/libtermcap-0/tcl86/zlib1，共 8 个）——**必须放 exe 同目录**（PATH 方式实测不生效）。实际占用 ≈ yosys.exe 36MB + share/yosys 31MB + DLLs ≈ 70MB，S1 下载脚本从 568MB tgz 选择性提取即可。
6. **bundle 规则引擎在真实 write_json 端口数据上 96% 入束（73/76）**：AXI4（27 信号含 awid/arid/wlast/rlast 全通道特征）、AXI4-Lite、AHB、APB 判别与 role 推断全部正确；leftovers 均为自定义信号（fab_irq_en/irq_o），符合预期。
7. 框图边提取验证：top 层 82 bit-edges（3 条实例互连含 link_irq + 79 条 top-to-inst），与夹具设计一致。

## 考虑的替代方案

- **前端解析 write_json**（原始提案之一）：SoC 级 JSON 几十~几百 MB，渲染进程解析卡死+双份内存。否决。
- **slang 单引擎（ast-json 提取层级）**：AST 提取成本高、slang-hier 实验性；被"yosys ≥0.67 内置 slang + write_json 成熟格式"击败。该方案的反面论据（yosys SV 受限）基于过时信息，已被官方 README 推翻。
- **双引擎冗余**（yosys+slang 都做 elaboration）：双倍解析时间、双失败面、双版本管理。否决。
- **drawio 生成方案**：复用内嵌 viewer 但交互编程能力不足（信号高亮/下钻/端口联动受限）。否决。
- **自动扫描目录组 filelist**：无 defines 时 `ifdef 分支瞎猜、同名 module 冲突。否决。
- **从 runsim 环境推导 filelist**：项目特定知识，适合后续项目插件，不适合平台内置。
- **Workbench destination 入口**：被用户决策否决（设计浏览升级为一级工作流视图）。
- **保存自动 format**：对 DE 只读树是事故率最高的选项。否决，以 dry-run 写保护替代。
- **hankhsu1996/slangd**：WIP 状态、API 不稳定。否决，选 hudson-trading/slang-server。
