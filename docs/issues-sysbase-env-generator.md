# Issues: Unisoc SoC 验证环境自动生成 Flow

> 来源 PRD：`docs/prd-sysbase-env-generator.md`
> 原型参考：`docs/prototypes/sysbase-env-gen-wizard.html`

---

## Issue 1: 基础骨架 + 命令构建器

### What to build

注册「验证环境生成器」为独立工具窗口，创建 `SysbaseGenConfig` 类型定义和 `buildSysbaseCommand` 纯函数，搭建 9 步向导壳（stepper 导航 + 空白步骤内容 + 前进/后退按钮 + 步骤状态指示器），并实现命令构建纯函数及其单元测试。

用户打开工具后能看到一个可导航的 9 步向导界面，步骤之间可前进/后退，步骤指示器显示当前/已完成/待完成状态。命令构建函数可从完整或部分配置生成格式化的 `sysbase_gen.py` 命令字符串。

### Acceptance criteria

- [ ] `shared/tool-types.ts` 中注册 `sysbase-env-gen` 工具元数据（id、name、icon、category: environment、窗口尺寸 1100×750）
- [ ] `tools/registry.tsx` 中注册工具组件入口
- [ ] `shared/types/` 下新增 `sysbase-gen.ts`，定义 `SysbaseGenConfig` 类型（含所有 14 个字段）
- [ ] `src/main/tools/sysbase-gen/command-builder.ts` 导出 `buildSysbaseCommand(config, scriptPath): string` 纯函数
- [ ] 命令格式：`<python> <scriptPath> gen -rtl ... -n ... -i ... -x ... -mini ... -ral ... -clk ... [-clk2 ...] -mod_io ... [-pinlist ...] [-dmalist ...] -o ...`，可选参数仅在填写时包含
- [ ] 多个 ralDirs 以空格分隔拼接
- [ ] 命令输出参数换行对齐（反斜杠续行）
- [ ] `src/renderer/src/stores/sysbase-gen.ts` Zustand store 搭建：step、config、scriptPath（默认 `/pri/project/tools/sprd/dv/sysbase/r3p4/bin/sysbase_gen.py`）、loading 状态
- [ ] `src/renderer/src/tools/sysbase-env-gen/SysbaseEnvGen.tsx` 主组件渲染向导壳：header + 9 步 stepper + content 区域 + footer 导航按钮
- [ ] stepper pill 样式参考 `EnvWizard.tsx`（active/completed/pending 三态）
- [ ] footer 显示「步骤 N / 9」和步骤名称
- [ ] 步骤间可自由前进/后退，最后一步显示「执行生成」按钮替代「下一步」
- [ ] `tests/sysbase-gen-command-builder.test.ts` 测试纯函数：完整配置、缺少可选字段、多个 ralDirs、自定义脚本路径
- [ ] `npm run build && npm run typecheck && npm run test && npm run lint` 全部通过

### Blocked by

None — can start immediately

---

## Issue 2: Steps 1-2 — Subsys 选择 + RTL 顶层文件 + Module 名提取

### What to build

实现向导前两步的完整功能。Step 1：用户从已知 Subsys 下拉列表中选择名称，系统自动推导例化名（`xxx_sys` → `u_sys_xxx`），用户可手动覆盖，同时可修改脚本路径。Step 2：系统扫描 `$PROJ_RTL/<subsys>/design/rtl/top/` 下列出所有 `.v` 文件供用户选择，选择后自动从文件内容中提取 `module <name>` 声明名。

后端新增 `inferInstanceName`、`listRtlFiles`、`extractModuleName` 三个 tRPC procedure，前端实现 `StepSubsys` 和 `StepRtl` 两个步骤组件。

### Acceptance criteria

- [ ] `inferInstanceName` procedure：给定 subsys 名，返回推导的例化名（规则：去 `_sys` 后缀，前移为 `u_sys_<prefix>`）
- [ ] `listRtlFiles` procedure：给定 subsys 名，从 `$PROJ_RTL/<subsys>/design/rtl/top/` 扫描所有 `.v` 文件，返回文件名 + 完整路径列表
- [ ] 若 `$PROJ_RTL` 未设置，返回明确错误提示
- [ ] `extractModuleName` procedure：读取指定 `.v` 文件，正则提取 `module <name>` 声明，返回 module 名
- [ ] Step 1 组件：Subsys 下拉列表（硬编码已知列表），选择后自动填充例化名输入框
- [ ] 例化名输入框可手动编辑覆盖自动值
- [ ] 脚本路径输入框默认填充 `/pri/project/tools/sprd/dv/sysbase/r3p4/bin/sysbase_gen.py`，可修改
- [ ] Step 2 组件：RTL 文件列表渲染为可选项，同时显示文件名和路径
- [ ] 选择文件后自动调用 `extractModuleName`，在下方显示提取的 module 名
- [ ] RTL 路径输入框支持手动浏览（复用 `toolsRouter.selectFiles`）
- [ ] Subsys 和 RTL 文件为必填项，未填写时禁用「下一步」
- [ ] `tests/sysbase-gen-router.test.ts` 覆盖三个 procedure（mock 临时目录 + 模拟文件树）
- [ ] `npm run build && npm run typecheck && npm run test && npm run lint` 全部通过

### Blocked by

- Issue 1

---

## Issue 3: Steps 3-4 — DUT Spec + Mini Excel 导入与模板编辑

### What to build

实现向导 Step 3 和 Step 4。每步提供「导入」按钮（通过文件对话框选择 Excel 文件并回填路径）和「打开模板编辑」按钮（在应用内 XlsxEditor 中打开模板 Excel 供用户直接编辑）。dut_spec 模板从 `docs/dut_spec_template.xlsx` 加载，mini Excel 模板从`docs\sysbase_mini_case_template.xlsx`加载。

复用现有 officecli 集成（ADR 0015）的 xlsx 编辑能力，编辑后通过 `requestFlush` + `notifyFileChanged` 机制保存。

### Acceptance criteria

- [ ] Step 3 组件：DUT Spec 文件路径输入框 + 「导入」按钮 + 「打开模板编辑」按钮
- [ ] Step 4 组件：Mini Excel 文件路径输入框 + 「导入」按钮 + 「打开模板编辑」按钮
- [ ] 「导入」按钮调用 `toolsRouter.selectFiles` 打开文件对话框，选择后回填路径
- [ ] 「打开模板编辑」按钮在应用内 XlsxEditor 中打开模板 Excel
- [ ] dut_spec 模板从 `docs/dut_spec_template.xlsx` 加载
- [ ] mini Excel 模板从`docs\sysbase_mini_case_template.xlsx`加载
- [ ] 模板编辑后通过 `requestFlush` + `notifyFileChanged` 保存
- [ ] Step 3 显示模板预览缩略图（Architecture / MemoryMap 两个 sheet 的表头预览）
- [ ] 两个文件路径为必填项，未填写时禁用「下一步」
- [ ] 每步显示参数说明 callout（说明 Excel 的用途和 sheet 结构）
- [ ] `npm run build && npm run typecheck && npm run test && npm run lint` 全部通过

### Blocked by

- Issue 1

---

## Issue 4: Steps 5-6 — RAL 目录 + CLK 目录自动推导

### What to build

实现向导 Step 5 和 Step 6。Step 5：一键自动推导 RAL 目录（扫描 `$PROJ_RTL/<subsys>/design/spec/` 和 `$PROJ_RTL/<subsys>/design/rtl/` 两个根目录，查找同时包含 `for_de` 和 `for_dv` 子目录的上级目录），支持手动添加/删除目录条目，每个推导结果显示子目录结构验证标记。Step 6：一键自动推导 CLK 目录（扫描 `$PROJ_RTL/<subsys>/design/rtl/` 下文件名包含 `clk_max_cfg` 关键字的文件所在目录），支持 CLK2 可选填写（格式 `<de路径>,<clk文件名前缀>`）。

后端新增 `inferRalDirs`、`inferClkDirs` 两个 tRPC procedure。

### Acceptance criteria

- [ ] `inferRalDirs` procedure：给定 subsys 名，递归扫描（最大深度 5）两个根目录，返回同时包含 `for_de` 和 `for_dv` 子目录的目录路径列表
- [ ] `inferClkDirs` procedure：给定 subsys 名，递归扫描 `$PROJ_RTL/<subsys>/design/rtl/`，返回文件名包含 `clk_max_cfg` 的文件所在目录路径
- [ ] Step 5 组件：「一键自动推导」按钮触发 `inferRalDirs`，结果渲染为目录列表
- [ ] 每个目录项显示路径 + `✓ for_de ✓ for_dv` 验证标记 + 删除按钮
- [ ] 支持手动添加目录（输入框 + 添加按钮）
- [ ] 推导完成后显示「已推导 N 个目录」状态 badge
- [ ] 推导过程中按钮显示 loading spinner
- [ ] Step 6 组件：CLK 目录输入框 + 「推导」按钮 + 浏览按钮
- [ ] CLK2 输入框可选，placeholder 提示格式 `<de路径>,<clk文件名前缀>`
- [ ] RAL 目录和 CLK 目录为必填项，CLK2 可选
- [ ] `$PROJ_RTL` 未设置时推导按钮显示明确错误提示
- [ ] `tests/sysbase-gen-router.test.ts` 覆盖两个 procedure（mock 临时目录 + 模拟 for_de/for_dv 和 clk_max_cfg 文件）
- [ ] `npm run build && npm run typecheck && npm run test && npm run lint` 全部通过

### Blocked by

- Issue 1

---

## Issue 5: Step 7 — Module IO 生成（Verdi getModIO）

### What to build

实现向导 Step 7。用户选择 filelist 文件，系统自动从 Step 2 的 RTL 选择中填充 module 名（只读显示），点击「生成 Module IO」按钮调用 Verdi 的 `getModIO_batch.p` perl 脚本生成 Module IO 文件，执行输出流式显示在终端区域。生成成功后自动填充输出文件路径。

后端新增 `generateModIo` procedure，通过 `node:child_process` spawn 执行 perl 脚本，流式收集 stdout/stderr。

### Acceptance criteria

- [ ] `generateModIo` procedure：接收 filelist 路径和 module 名，执行 `$VERDI_HOME/share/VIA/Apps/DesignComprehension/GetModIO/getModIO_batch.p -f <filelist> -modules "<module_name>" -o getModIO.log`
- [ ] `$VERDI_HOME` 从环境变量或 `.socverify/env.json` 读取
- [ ] 若 `$VERDI_HOME` 未设置，返回明确错误提示（「请在环境变量管理中配置 VERDI_HOME」）
- [ ] 若 filelist 文件不存在，返回明确错误提示
- [ ] 脚本执行输出流式返回前端（通过原生 IPC eventBridge 或 tRPC subscription）
- [ ] Step 7 组件：filelist 文件选择（浏览按钮）+ module 名只读显示（从 Step 2 自动填充）+ 输出文件路径
- [ ] 「生成 Module IO」按钮触发 `generateModIo`
- [ ] 执行过程中按钮显示 loading，执行输出流式显示在终端区域
- [ ] 执行成功后自动填充输出文件路径（默认 `getModIO.log`）
- [ ] 执行失败时在终端区域显示错误信息（区分 VERDI_HOME 未设置 / filelist 错误 / 脚本执行失败）
- [ ] module 名输入框显示「从 Step 2」来源 badge
- [ ] `tests/sysbase-gen-router.test.ts` 覆盖 `generateModIo`（mock child_process spawn）
- [ ] `npm run build && npm run typecheck && npm run test && npm run lint` 全部通过

### Blocked by

- Issue 2（需要 RTL 步骤提取的 module 名）

---

## Issue 6: Steps 8-9 — 可选参数 + 命令预览 + 终端执行 + 配置持久化

### What to build

实现向导最后两步。Step 8：可选填写 pinlist/dmalist 文件路径和输出目录。Step 9：展示配置摘要表 + 格式化命令预览（语法高亮、参数对齐），提供「复制命令」和「执行生成」按钮，执行时在终端面板流式显示 `sysbase_gen.py` 输出。同时实现配置持久化：保存/加载向导配置到 `.socverify/sysbase-gen/<subsys>.json`。

后端新增 `runGen`、`saveConfig`、`loadConfig`、`listSavedConfigs` 四个 procedure。

### Acceptance criteria

- [ ] Step 8 组件：pinlist 文件路径（可选）+ dmalist 文件路径（可选）+ 输出目录（必填，默认 `./`）+ 浏览按钮
- [ ] Step 9 组件：配置摘要表（两列 grid，显示所有参数的 flag 和值，未设置的可选参数显示灰色「未设置」）
- [ ] 命令预览区域：调用 `buildSysbaseCommand` 生成格式化命令，语法高亮（python 路径、脚本路径、flag、value 不同颜色）
- [ ] 「复制」按钮将完整命令复制到剪贴板，点击后短暂显示「已复制」反馈
- [ ] `runGen` procedure：在终端中执行 `sysbase_gen.py` 命令，复用 `terminalManager`（PTY 或 log-mode 回退）
- [ ] 「执行生成」按钮触发 `runGen`，执行输出流式显示在终端面板
- [ ] 执行状态 badge：待执行 → 执行中 → 执行完成
- [ ] `saveConfig` procedure：将向导配置保存到 `.socverify/sysbase-gen/<subsys>.json`
- [ ] `loadConfig` procedure：加载指定 subsys 的已保存配置
- [ ] `listSavedConfigs` procedure：列出所有已保存的配置（按 subsys 名分组）
- [ ] header 区域「保存配置」按钮调用 `saveConfig`，「加载配置」按钮弹出已保存配置列表供选择
- [ ] 加载配置后自动填充所有步骤的表单值
- [ ] 脚本路径也持久化到 `.socverify/sysbase-gen/config.json`，跨会话保持
- [ ] `tests/sysbase-gen-router.test.ts` 覆盖 `saveConfig`/`loadConfig` 配置持久化往返
- [ ] `tests/ui/sysbase-wizard.test.tsx` 覆盖步骤导航、命令预览渲染（mock tRPC）
- [ ] `npm run build && npm run typecheck && npm run test && npm run lint` 全部通过

### Blocked by

- Issue 2
- Issue 3
- Issue 4
- Issue 5
