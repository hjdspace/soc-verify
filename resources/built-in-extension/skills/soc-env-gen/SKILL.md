---
name: soc-env-gen
description: "为 SOC subsys / top 层自动生成 socv env。Invoke when user requests SOC 验证环境生成、描述 subsys 验证需求,或搭 DV env。"
---

# SOC 验证环境自动生成

在 Linux 上为 SOC subsys / top 层生成 socv env,只读 RTL / DE / ral,不修改。

## Triggers

scope: 仅 SOC env 生成(显式 / 隐式生成意图)。概念咨询、已生成 env 调试走对应 skill。

## Before You Start

1. 读 [CONTEXT.md](CONTEXT.md) 确认领域词汇与边界。
2. 读 [docs/adr/](docs/adr/) 确认关键决策(职责、审批、AI 边界)。
3. 确认环境变量已就位:`$PROJ_RTL` / `$VERDI_HOME`;`sysbase_gen.py` / `python3` / `verdi` 在 PATH 中。
4. (可选)复制 [assets/env.json.template](assets/env.json.template) 为 `env.json`,**仅**覆盖需要自定义的字段。默认全部走 env var / PATH。

`Completion`: `proj_rtl` 至少一个来源可解析,`sysbase_gen.py` / `python3` / `verdi` 在 PATH 中。

## Workflow

### Step 1: 判定 SOC 生成层级 + 推导参数

读用户输入,三选一:

- 输入含 `-c` / `<chip_name>` / "top" / "chip 顶层" → **top**。
- 输入含 subsys name(非 "top")、`-x` / `-mini` 等 subsys 专用参数 → **subsys**。
- 不确定 → 直接问用户。

**推导 -rtl / -n / -i**: 层级确定后按 [reference/rtl-conventions.md](reference/rtl-conventions.md):`-rtl` 指向 subsys / top 的**顶层文件**(power wrapper),不是目录。命名约定是 `*_pwr_wrap.v` 但前缀可变,AI 按"未被其他候选例化"的层级关系判定顶层。

1. 读 `env.json.proj_rtl`(默认 `$PROJ_RTL`)
2. 用户已给出的 `-n` / `-i` / `-rtl` 优先
3. `-rtl` 缺失时,glob `<rtl>/top/*_pwr_wrap.v`,按 [rtl-conventions.md](reference/rtl-conventions.md) 的 "-rtl 推导:AI 读候选文件判定顶层 wrapper" 一节执行 Step A~F
4. `ls -l <derived_rtl_file>` 校验**是 regular file**
5. 用 AskUserQuestion 展示推导值,用户可接受或覆盖

`Completion`: 层级与 `-rtl` / `-n` / `-i` 全部确认,`-rtl` 是基于层级判定出的 `*_pwr_wrap.v` 顶层文件(regular file,目录命中即失败),`ls -l` 通过。

### Step 2: 收集必填与条件必填参数

#### subsys

- **必填**:
  - `-rtl` / `-n`(与仓名一致) / `-i`
  - `-mod_io`(**硬必填**):用户可二选一给法
    - `-mod_io <mod_io.csv>` — 直接给已生成的 csv
    - `-f <filelist>` — 给 filelist,触发 Step 4 自动抓 mod_io
- 条件必填: `-x`(dut_spec) / `-mini`(mini_excel) / `-ral` / `-clk`
- 可选: `-pinlist` / `-dmalist`(后续单独 skill) / `-clk2`(多 clk core) / `-o`(默认 `./`)

#### top

- 必填: `-rtl` / `-n` / `-i` / `-c`(subsys domain + core name)
- 条件必填: `-ral`(可多目录,空格分隔) / `top_csv`(见 [reference/top-csv-format.md](reference/top-csv-format.md))
- 可选: `-o`

`Completion`: 所有必填入参写入参数快照 dict,缺失项列表已输出。mod_io 入参形态已确定(直接 csv 路径 / `-f` 待 Step 4)。

### Step 3: 验证输入文件

逐项 `os.path.exists` + 结构检查:

- `-x` / `-mini` 存在且非空 → 失败提示用户去填(AI 不草拟 excel)
- `-ral` 每个子目录含 `for_de` / `for_dv` / `for_sw` → 失败提示
- `-clk` 含 `clk_max.cfg` / `set_clk_freq*` / `clk_max.sva` → 失败提示
- **`-mod_io` 必须就位**(subsys 硬必填):
  - 用户已给 `-mod_io <csv>` → 校验 csv 文件存在;不存在 → AskUserQuestion 让用户重给或切到 `-f` 走 Step 4
  - 用户只给 `-f <filelist>` → 转 Step 4 跑自动生成;**Step 4 跑完才回 Step 3 重核 csv 是否生成**
  - 都没给 → AskUserQuestion 二选一(给 csv / 给 filelist)
  - Step 4 仍失败 → 走 Step 7 失败处理(`FilelistMissing` / `ModIoMissing`)

`Completion`: 每一项验证返回 pass,`mod_io.csv` 已就位(由用户直给或 Step 4 落地)。**Step 5 之前 mod_io 缺失即 Step 3 不算完成**。

### Step 4: 抓取 mod_io(Step 3 触发,强制)

**前置**: `-f <filelist>` 必须已就位(Step 2 收或本步 AskUserQuestion 问用户)。**skill 不自动推导 filelist 路径** — DE 流程下 filelist 命名不固定,只有 DE 自己知道。

1. **跑 wrapper**:
   `bash assets/run_extract_mod_io.sh <rtl_dir> -f <filelist> [-o <log>] [-modules "<pat>"]`
   wrapper 内部调用 Synopsys `getModIO_batch.pl`,解析顺序见 [reference/config-resolution.md](reference/config-resolution.md)(`get_mod_io_pl` 字段)。无 `-modules` 默认报所有 modules。
2. **AI 读 log 转 csv**:
   wrapper 输出 `<log>` 是 perl 脚本的 log(非 csv)。AI 读 log 内容,提取 `module_name,port_name,direction,range` 四列,写 `<rtl_dir>/mod_io.csv`。列名首行:`module_name,port_name,direction,range`。
3. **双预览**:
   给用户同时展示 log 前 30 行 + csv 前 30 行,AskUserQuestion 确认格式无误。用户可改 `-modules` 子集重跑。
4. **落 `-mod_io <csv 绝对路径>`** 到参数快照,然后回到 Step 3 重核。

CSV 列定义:
- `module_name` — module 名称
- `port_name` — 端口名
- `direction` — `input` / `output` / `inout` / `unknown`
- `range` — `[left:right]` 或 `1`

`Completion`: mod_io.csv 已生成,log + csv 双预览已对用户展示,用户 y/n 确认格式,`-mod_io` 绝对路径已落参数快照,**Step 3 重核通过**。

### Step 5: 输出预执行清单 + 等待审批

展示结构化清单(必含):

- **SOC 目标**: subsys=`<name>` 或 top=`<chip>`
- **生成命令**: 完整 `${sysbase_gen_py} <args...>`,模板见 [reference/command-templates.md](reference/command-templates.md)
- **输入文件表**: 每个 -x / -mini / **-mod_io** / -ral / -clk 的绝对路径与大小
- **输出范围**: `-o` 绝对路径与权限
- **风险点**: rtl 不全、ral 缺目录、`-o` 非空等
- **回滚方案**: 生成失败后 `rm -rf -o` 目录

末尾用 AskUserQuestion 询问 y / n,**收到 y 才进入 Step 6**。

`Completion`: 清单已展示,用户答复 y。**清单必须含 `mod_io.csv` 绝对路径与大小,缺失即视为清单不完整,不收 y**。

### Step 6: 执行 sysbase_gen.py

1. `cd -o`(避免污染当前目录)。
2. 跑命令,捕获 stdout / stderr / 退出码 / 耗时。
3. 退出码 0 → Step 8;非 0 → Step 7。

`Completion`: 退出码与耗时已记录。

### Step 7: 失败处理

按 [reference/error-codes.md](reference/error-codes.md) 匹配错误,输出修复建议:

- `RtlNotFound` / `RalStructureBad` / `ClkFilesMissing` / `ExcelNotFilled` / `ModIoMissing` / `OutputDirNotEmpty` / `Unknown`

匹配靠 grep stderr 关键词(见 reference)。`Unknown` 落回原样输出 stderr 末尾 50 行。

`Completion`: 错误已分类,用户得到可执行修复建议。

### Step 8: 输出结构化 SOC 报告

1. 退出码 + 总耗时
2. 生成目录树(`tree -L 3 -o`,或递归 ls)
3. 关键文件清单: `env/` `tb_top.sv` / `ral model` / `clk link` / `vip conn`
4. 手动检查项:
   - 例化名是否与 `-i` 一致(`grep "u_${name}" env/tb_top.sv`)
   - dut 实例层级(`grep "dut" env/tb_top.sv`)
   - ral model 例化是否齐全
   - 用户手动跑 compile 确认
5. 后续动作提示: pin list / dma list 走单独 skill

`Completion`: 报告含退出码、目录树、关键文件清单、手动检查项四节,且后续动作(pin / dma 单独 skill)已提示。

## Retry

skill 在 Step 5 前记忆参数快照,允许用户补充缺失输入后重跑。每次重跑必须重走 Step 5 审批。

## Reference

- [reference/command-templates.md](reference/command-templates.md) — subsys / top 命令模板
- [reference/rtl-conventions.md](reference/rtl-conventions.md) — RTL 路径与例化名推导
- [reference/top-csv-format.md](reference/top-csv-format.md) — top csv 列定义
- [reference/error-codes.md](reference/error-codes.md) — 错误码与修复
- [reference/config-resolution.md](reference/config-resolution.md) — 配置解析顺序
- [assets/env.json.template](assets/env.json.template) — 环境配置
- [assets/run_extract_mod_io.sh](assets/run_extract_mod_io.sh) — 抓 mod_io wrapper(基于 Synopsys `getModIO_batch.pl`)
