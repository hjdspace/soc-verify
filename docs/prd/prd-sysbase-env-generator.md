# PRD: Unisoc SoC 验证环境自动生成 Flow

## Problem Statement

SoC 验证工程师在搭建 Subsys 级 SoC 验证环境时，需要手动调用 `sysbase_gen.py` 脚本并准备大量输入件（RTL 顶层文件、dut_spec Excel、mini Excel、RAL 目录、CLK 目录、Module IO 文件等）。当前流程存在以下痛点：

1. **输入件多且路径复杂**：用户需要记住 10+ 个命令行参数及其路径规则，每次手动拼接容易出错。
2. **路径推导依赖经验**：例化名与 subsys 名的规则关系、RTL 顶层文件位置、RAL 目录的 for_de/for_dv 结构识别、CLK 目录的文件关键字匹配等，都需要用户对项目目录结构非常熟悉。
3. **Excel 模板编辑割裂**：dut_spec 和 mini Excel 需要在外部工具编辑，与命令执行流程脱节。
4. **Module IO 生成依赖 Verdi**：用户需要知道 Verdi 的 getModIO 脚本路径和参数格式，手动执行后再将结果文件路径填入命令。
5. **缺乏配置持久化**：每次搭建环境都需要从头开始，无法复用上次的配置。

## Solution

在 SoC Verify 桌面应用中新增「验证环境生成器」功能，以分步向导（Wizard）形式引导用户完成验证环境搭建：

1. **分步引导**：9 个步骤覆盖从 subsys 选择到命令生成/执行的全流程，每步聚焦一个输入件。
2. **一键自动推导**：针对有规律可循的输入件（例化名、RAL 目录、CLK 目录、Module IO），提供自动推导按钮，扫描 `$PROJ_RTL` 目录树自动填充。
3. **模板 Excel 内嵌编辑**：dut_spec 和 mini Excel 支持在应用内直接打开模板进行编辑（复用 officecli 集成），编辑后自动回填路径。
4. **命令预览与执行**：最终步骤展示完整命令字符串，用户确认后可直接在终端中执行或复制到剪贴板。
5. **配置持久化**：向导配置自动保存到 `.socverify/sysbase-gen/` 目录，支持加载历史配置继续编辑。

## User Stories

1. 作为 SoC 验证工程师，我想要通过下拉列表选择 Subsys 名称，这样我不需要手动输入且能保证名称一致性。
2. 作为 SoC 验证工程师，我想要在选择 Subsys 后自动生成例化名，这样我不需要记忆命名规则（如 apcpu_sys → u_sys_apcpu）。
3. 作为 SoC 验证工程师，我想要手动修改自动生成的例化名，这样在特殊命名场景下我可以覆盖默认值。
4. 作为 SoC 验证工程师，我想要以下拉列表形式浏览 `$PROJ_RTL/<subsys>/design/rtl/top/` 目录下的所有 `.v` 文件，这样我可以快速选择 DUT 顶层文件。
5. 作为 SoC 验证工程师，我想要在选择 RTL 顶层文件后自动提取 module 名，这样后续生成 Module IO 时不需要手动填写。
6. 作为 SoC 验证工程师，我想要一键导入 dut_spec Excel 文件路径，这样不需要手动输入长路径。
7. 作为 SoC 验证工程师，我想要直接在应用内打开 dut_spec 模板 Excel 进行编辑，这样我不需要切换到外部工具。
8. 作为 SoC 验证工程师，我想要一键导入 mini Excel 文件路径，这样不需要手动输入长路径。
9. 作为 SoC 验证工程师，我想要直接在应用内打开 mini Excel 模板进行编辑，这样我不需要切换到外部工具。
10. 作为 SoC 验证工程师，我想要一键自动推导 RAL 目录列表，这样系统自动扫描 `$PROJ_RTL/<subsys>/design/spec` 和 `$PROJ_RTL/<subsys>/design/rtl/` 下包含 `for_de/for_dv` 子目录的上一级目录路径。
11. 作为 SoC 验证工程师，我想要手动添加或删除 RAL 目录条目，这样自动推导结果不完整时我可以补充。
12. 作为 SoC 验证工程师，我想要多个 RAL 目录以空格分隔显示在输入框中，这样与脚本 `-ral` 参数格式一致。
13. 作为 SoC 验证工程师，我想要一键自动推导 CLK 目录，这样系统自动扫描 `$PROJ_RTL/<subsys>/design/rtl/` 下包含 `clk_max_cfg` 关键字的文件所在目录。
14. 作为 SoC 验证工程师，我想要手动修改 CLK 目录路径，这样自动推导不准确时我可以覆盖。
15. 作为 SoC 验证工程师，我想要填写 CLK2 目录（可选），这样存在多个 clk core 的 subsys 可以指定第二个时钟目录。
16. 作为 SoC 验证工程师，我想要 CLK2 支持填写 `<de路径>,<clk文件名前缀>` 格式，这样满足脚本的参数传递要求。
17. 作为 SoC 验证工程师，我想要选择 filelist 文件用于生成 Module IO，这样 Verdi getModIO 脚本可以使用它解析模块接口。
18. 作为 SoC 验证工程师，我想要系统根据 RTL 顶层文件的 module 名自动填充 getModIO 的 `-modules` 参数，这样不需要手动查找 module 名。
19. 作为 SoC 验证工程师，我想要一键调用 Verdi getModIO 脚本生成 Module IO 文件，这样不需要手动在终端执行 perl 命令。
20. 作为 SoC 验证工程师，我想要看到 getModIO 脚本的执行输出，这样我能确认生成是否成功。
21. 作为 SoC 验证工程师，我想要在 Module IO 生成失败时收到明确的错误提示，这样我知道是 VERDI_HOME 未设置还是 filelist 路径错误。
22. 作为 SoC 验证工程师，我想要可选地填写 pinlist 文件路径，这样在需要生成 ip pin cfg 时可以提供。
23. 作为 SoC 验证工程师，我想要可选地填写 dmalist 文件路径，这样在需要生成 get dma req id task 时可以提供。
24. 作为 SoC 验证工程师，我想要在最后一步看到完整的 `sysbase_gen.py` 命令预览，这样我可以确认所有参数正确无误。
25. 作为 SoC 验证工程师，我想要修改脚本路径（默认 `/pri/project/tools/sprd/dv/sysbase/r3p4/bin/sysbase_gen.py`），这样在脚本版本升级或路径变更时可以适配。
26. 作为 SoC 验证工程师，我想要指定输出目录（`-o` 参数），这样生成的环境文件放在我期望的位置。
27. 作为 SoC 验证工程师，我想要一键在终端中执行生成命令，这样不需要复制粘贴到外部终端。
28. 作为 SoC 验证工程师，我想要在命令执行过程中看到实时终端输出，这样我可以监控生成进度和错误。
29. 作为 SoC 验证工程师，我想要将向导配置保存为预设，这样下次搭建相同 subsys 的环境时可以快速加载。
30. 作为 SoC 验证工程师，我想要加载之前保存的配置继续编辑，这样中断的工作可以恢复。
31. 作为 SoC 验证工程师，我想要在每个步骤看到参数说明和示例，这样新手也能理解每个输入件的含义。
32. 作为 SoC 验证工程师，我想要在步骤之间自由导航（前进/后退），这样我可以修改之前填写的参数。
33. 作为 SoC 验证工程师，我想要在必填项未填写时禁止进入下一步，这样避免生成不完整的命令。
34. 作为 SoC 验证工程师，我想要看到每个步骤的完成状态指示器，这样我知道哪些步骤已完成、哪些还需要填写。
35. 作为 SoC 验证工程师，我想要在 RTL 顶层文件下拉列表中同时显示文件名和完整路径，这样我能区分同名文件。
36. 作为 SoC 验证工程师，我想要自动推导 RAL 目录时同时扫描 `$PROJ_RTL/<subsys>/design/spec/` 和 `$PROJ_RTL/<subsys>/design/rtl/` 两个根目录，这样不遗漏任何寄存器目录。
37. 作为 SoC 验证工程师，我想要在 RAL 自动推导结果中看到每个目录的子目录结构预览（确认包含 for_de/for_dv），这样我能验证推导结果正确。
38. 作为 SoC 验证工程师，我想要在命令预览中看到参数换行对齐的格式化输出，这样长命令也容易阅读。
39. 作为 SoC 验证工程师，我想要复制完整命令到剪贴板，这样我可以在外部终端手动执行。
40. 作为 SoC 验证工程师，我想要从工具下拉菜单中打开此向导，这样与其他工具入口一致。

## Implementation Decisions

### 整体架构

- **功能定位**：作为独立工具窗口（Tool Window）注册到 `tools/registry.tsx` 和 `shared/tool-types.ts`，复用现有工具窗口管理器（`tool-window-manager.ts`），与其他工具入口一致。
- **工具元数据**：`id: 'sysbase-env-gen'`，`category: 'environment'`，窗口尺寸 1100×750。

### 后端模块

- **主进程服务层**：新建 `src/main/tools/sysbase-gen/` 目录，包含：
  - `path-scanner.ts`：文件系统扫描逻辑（RTL 文件列表、RAL 目录推导、CLK 目录推导），纯函数 + `node:fs/promises` 调用。
  - `command-builder.ts`：纯函数 `buildSysbaseCommand(config: SysbaseGenConfig): string`，将向导配置序列化为 `sysbase_gen.py` 命令字符串。提取为纯函数以便单元测试。
  - `mod-io-runner.ts`：调用 Verdi getModIO perl 脚本的逻辑，通过 `node:child_process` spawn 执行，流式收集 stdout/stderr。
  - `index.ts`：聚合导出。
- **tRPC 子路由**：新建 `src/main/tools/routers/sysbase-gen-router.ts`，注册到 `tools-router.ts`，提供以下 procedure：
  - `listRtlFiles`（query）：给定 subsys 名，列出 `$PROJ_RTL/<subsys>/design/rtl/top/` 下所有 `.v` 文件。
  - `inferInstanceName`（query）：给定 subsys 名，按规则推导例化名（`xxx_sys` → `u_sys_xxx`，`xxx_sys` 中的 `xxx` 部分前移）。
  - `inferRalDirs`（query）：给定 subsys 名，扫描 spec 和 rtl 目录下包含 `for_de`/`for_dv` 子目录的上级目录，返回路径列表。
  - `inferClkDirs`（query）：给定 subsys 名，扫描 rtl 目录下包含 `clk_max_cfg` 关键字的文件，返回其所在目录路径列表。
  - `extractModuleName`（query）：读取指定 `.v` 文件，正则提取 `module <name>` 声明。
  - `generateModIo`（mutation）：执行 Verdi getModIO perl 脚本，返回输出日志和生成的文件路径。
  - `buildCommand`（query）：给定完整配置，返回格式化的命令字符串（纯函数调用，主进程侧执行以便类型共享）。
  - `runGen`（mutation）：在终端中执行 `sysbase_gen.py` 命令，复用 `terminalManager` + `simTerminalLinker` 模式。
  - `saveConfig`（mutation）：将向导配置保存到 `.socverify/sysbase-gen/<subsys>.json`。
  - `loadConfig`（query）：加载已保存的配置。
  - `listSavedConfigs`（query）：列出所有已保存的配置（按 subsys 名分组）。
- **文件对话框**：复用 `toolsRouter.selectDirectory` / `toolsRouter.selectFiles` / `toolsRouter.saveFileDialog`。

### 例化名推导规则

从文档中提取的规则：subsys 名 → 例化名的映射逻辑为：
- `apcpu_sys` → `u_sys_apcpu`
- `ap_sys` → `u_sys_ap`

推导逻辑：若 subsys 名以 `_sys` 结尾，则例化名 = `u_sys_` + subsys 名去掉 `_sys` 后缀的部分。规则可配置，用户可手动覆盖。

### RAL 目录推导逻辑

扫描两个根目录：
1. `$PROJ_RTL/<subsys>/design/spec/`
2. `$PROJ_RTL/<subsys>/design/rtl/`

对每个根目录递归遍历（最大深度 5），查找同时包含 `for_de` 和 `for_dv` 子目录的目录。匹配到的目录路径即为 RAL 总目录。多个结果以空格分隔。

### CLK 目录推导逻辑

扫描 `$PROJ_RTL/<subsys>/design/rtl/` 目录树（最大深度 5），查找文件名包含 `clk_max_cfg` 关键字的文件。返回该文件所在目录的路径。

### Module IO 生成

调用 Verdi 的 getModIO 脚本：
```
$VERDI_HOME/share/VIA/Apps/DesignComprehension/GetModIO/getModIO_batch.p -f <filelist> -modules "<module_name>" -o getModIO.log
```
- `$VERDI_HOME` 从环境变量或 `.socverify/env.json` 读取。
- `filelist` 由用户通过文件对话框选择。
- `module_name` 从 RTL 顶层文件中提取（`extractModuleName` procedure）。
- 输出文件默认为 `getModIO.log`，保存在用户指定的工作目录。
- 执行结果流式返回前端显示。

### Excel 模板编辑

复用 officecli 集成（ADR 0015）：
- 打开模板 Excel：调用 `documentRouter` 或 officecli 的 xlsx 编辑能力，在应用内 XlsxEditor 组件中打开。
- 模板文件路径：dut_spec 模板从 `docs/dut_spec_template.xlsx` 或内置资源加载；mini Excel 模板同理。
- 编辑后通过 `requestFlush` + `notifyFileChanged` 机制保存。

### 前端模块

- **Zustand Store**：`src/renderer/src/stores/sysbase-gen.ts`，管理向导状态：
  - `step`：当前步骤（0-8）
  - `config`：`SysbaseGenConfig` 对象（所有参数）
  - `scriptPath`：脚本路径（可修改，默认值）
  - `outputDir`：输出目录
  - `loading`：各自动推导操作的 loading 状态
  - `terminalId`：执行时的终端 ID
  - Actions：`setStep`、`updateConfig`、`inferRalDirs`、`inferClkDirs`、`generateModIo`、`buildCommand`、`runGen`、`saveConfig`、`loadConfig`
- **组件结构**：`src/renderer/src/tools/sysbase-env-gen/` 目录下：
  - `SysbaseEnvGen.tsx`：主组件，渲染向导壳（stepper + content + footer）
  - `steps/StepSubsys.tsx`：Step 1 — subsys 选择 + 例化名
  - `steps/StepRtl.tsx`：Step 2 — RTL 顶层文件选择
  - `steps/StepDutSpec.tsx`：Step 3 — dut_spec 导入/编辑
  - `steps/StepMini.tsx`：Step 4 — mini Excel 导入/编辑
  - `steps/StepRal.tsx`：Step 5 — RAL 目录列表 + 自动推导
  - `steps/StepClk.tsx`：Step 6 — CLK/CLK2 目录 + 自动推导
  - `steps/StepModIo.tsx`：Step 7 — Module IO 生成
  - `steps/StepOptional.tsx`：Step 8 — pinlist/dmalist（可选）
  - `steps/StepReview.tsx`：Step 9 — 命令预览 + 执行
- **UI 风格**：复用 Tailwind v4 + CSS 变量主题系统，stepper 样式参考 `EnvWizard.tsx` 的 pill-shaped 步骤指示器。

### 类型定义

在 `src/shared/types/` 下新增 `sysbase-gen.ts`：

```typescript
type SysbaseGenConfig = {
  subsys: string;
  instanceName: string;
  rtlFile: string;
  moduleName: string;       // 从 rtlFile 自动提取
  dutSpecPath: string;
  miniExcelPath: string;
  ralDirs: string[];         // 多个目录
  clkDir: string;
  clk2Dir: string;           // 可选，格式 "<de路径>,<前缀>"
  modIoPath: string;
  filelistPath: string;      // 用于生成 mod_io
  pinlistPath: string;       // 可选
  dmalistPath: string;       // 可选
  outputDir: string;
};
```

### 脚本路径配置

默认脚本路径 `/pri/project/tools/sprd/dv/sysbase/r3p4/bin/sysbase_gen.py`，存储在 store 的 `scriptPath` 字段。用户可在命令预览步骤修改。脚本路径也持久化到 `.socverify/sysbase-gen/config.json` 中，跨会话保持。

### 命令构建格式

最终命令格式参考文档中的 Makefile 示例：
```
<python> <scriptPath> gen \
    -rtl     <rtlFile> \
    -n       <subsys> \
    -i       <instanceName> \
    -x       <dutSpecPath> \
    -mini    <miniExcelPath> \
    -ral     <ralDirs.join(' ')> \
    -clk     <clkDir> \
    [-clk2   <clk2Dir>] \
    -mod_io  <modIoPath> \
    [-pinlist <pinlistPath>] \
    [-dmalist <dmalistPath>] \
    -o       <outputDir>
```

其中 `-clk2`、`-pinlist`、`-dmalist` 为可选参数，仅在用户填写时包含。Python 解释器路径从环境变量或配置中获取。

### 终端执行

复用 `simulationRouter.runInTerminal` 的模式：
- 创建 PTY 终端会话（或 log-mode 回退）
- 写入 `sysbase_gen.py` 命令
- 终端面板展示在向导底部或独立 Workbench tab 中
- 不注册 simTerminalLinker（这不是仿真，无需 pass/fail 判定）

## Testing Decisions

### 测试理念

- 只测试外部行为，不测试实现细节（如具体的目录遍历算法内部状态）。
- 纯函数优先提取，降低 mock 成本。
- tRPC router caller 作为主测试缝，一次覆盖完整后端逻辑。

### Seam 1：tRPC router 边界（主 seam）

- **测试文件**：`tests/sysbase-gen-router.test.ts`
- **方法**：`sysbaseGenRouter.createCaller({})`，mock `requireProject` 返回临时目录，在临时目录中创建模拟文件树（`.v` 文件、`for_de/for_dv` 目录、`clk_max_cfg` 文件等）。
- **覆盖**：
  - `listRtlFiles`：正确列出 `.v` 文件，过滤非 `.v` 文件
  - `inferInstanceName`：验证 subsys → instance name 映射规则
  - `inferRalDirs`：验证包含 for_de/for_dv 的目录被正确识别，不包含的被过滤
  - `inferClkDirs`：验证包含 clk_max_cfg 关键字的文件所在目录被正确返回
  - `extractModuleName`：从 `.v` 文件内容中正确提取 module 名
  - `buildCommand`：给定配置生成正确的命令字符串
  - `saveConfig`/`loadConfig`：配置持久化往返
- **先例**：`tests/dashboard-router.test.ts`

### Seam 2：纯函数命令构建器

- **测试文件**：`tests/sysbase-gen-command-builder.test.ts`
- **方法**：直接导入 `buildSysbaseCommand` 纯函数，传入各种配置对象，断言输出命令字符串。
- **覆盖**：
  - 完整配置 → 完整命令
  - 缺少可选字段（clk2、pinlist、dmalist）→ 命令中不包含对应参数
  - 多个 ralDirs → 空格分隔
  - 脚本路径自定义 → 命令中使用自定义路径
- **先例**：`tests/regression/regression-runner.test.ts`

### Seam 3：UI 组件测试

- **测试文件**：`tests/ui/sysbase-wizard.test.tsx`
- **方法**：`@testing-library/react` + mock tRPC，渲染各步骤组件，验证：
  - subsys 下拉列表渲染
  - 例化名自动填充
  - RTL 文件下拉列表
  - 自动推导按钮触发正确的 tRPC 调用
  - 步骤导航（前进/后退/禁用条件）
  - 命令预览渲染
- **先例**：`tests/ui/OptionDock.test.tsx`、`tests/ui/SubsysList.test.tsx`

## Out of Scope

1. **Top 级环境生成**：`sysbase_gen.py` 的 top 子命令（`-c` CSV 参数、chip 级环境生成）不在本期范围，后续可扩展。
2. **脚本后处理自动化**：文档中 Makefile 的 `ttb`、`mini`、`ral`、`connect` 等子目标的 mv/cp 后处理操作不自动执行，用户手动处理或后续迭代。
3. **sysbase_ral_gen.py 集成**：Makefile 中的 `RAL_GEN` 脚本调用不在本期范围。
4. **多 subsys 批量生成**：当前只支持单个 subsys 逐个生成，不支持批量选择多个 subsys 一次生成。
5. **生成结果验证**：不验证生成环境文件的正确性（如检查生成的 `.sv` 文件是否存在、语法是否正确）。
6. **AI 辅助填写**：不集成 AI Agent 自动分析 RTL 结构并推荐参数值，后续可考虑。
7. **脚本版本管理**：不管理 `sysbase_gen.py` 的多个版本（r3p4 等），用户通过修改脚本路径自行切换。
8. **pinlist/dmalist 的自动推导**：这两个可选参数不支持自动推导，仅提供手动文件选择。

## Further Notes

### 已知 Subsys 列表

从文档 CSV 示例中提取的已知 subsys 列表（硬编码在前端，后续可改为从 Case Database 动态获取）：
`aon_sys`、`ap_sys`、`apcpu_sys`、`camera_sys`、`dpu_sys`、`vpu_sys`、`gpu_sys`、`lpach_sys`、`dbg_sys`、`ai_sys`、`pub_sys`、`pcie_sys`

### 与现有 Env Wizard 的关系

现有的 `EnvWizard`（`src/renderer/src/components/env/EnvWizard.tsx`）是 EDA 工具检测和环境变量配置向导，与本功能定位不同：
- EnvWizard：配置 EDA 工具路径 + 环境变量（PROJ_RTL、LICENSE_FILE 等）
- 本功能：在 EnvWizard 配置好 `$PROJ_RTL` 等环境变量的基础上，使用 `sysbase_gen.py` 生成验证环境

两者是上下游关系：先完成环境配置（EnvWizard），再进行环境生成（本功能）。

### officecli 模板文件

dut_spec 模板文件已存在于 `docs/dut_spec_template.xlsx`（和 `.md` 格式预览版）。mini Excel 模板需确认是否有现成模板文件，若无则需从项目实际使用中提取一个空白模板。

### $PROJ_RTL 依赖

所有自动推导功能依赖 `$PROJ_RTL` 环境变量已正确配置（通过 EnvWizard 或 `.socverify/env.json`）。若 `$PROJ_RTL` 未设置，自动推导按钮应显示明确错误提示并引导用户先配置环境。

### $VERDI_HOME 依赖

Module IO 生成依赖 `$VERDI_HOME` 环境变量。若未设置，`generateModIo` procedure 应返回明确错误，提示用户在环境变量管理中配置 `VERDI_HOME`。
