# SOC 验证环境自动生成 (soc-env-gen)

封装内网 `sysbase_gen.py` 的 skill,让 agent 能在用户描述 SOC 验证需求时,自动产出 subsys/top 层的 socv env(含 sysbase ttb 与 systba),并辅助生成 dut_spec / mini_excel / mod_io 等输入。

## Language

**SOC (System On Chip)**:
整颗芯片顶层,在本 skill 中对应 top 层。
_Avoid_: chip, system

**subsys (Subsystem)**:
芯片内一个独立分仓验证的功能子系统,有自己的 dut_spec 与 mini_excel。
_Avoid_: sub-system, sub_block, block(用 block 易与 IP block 混淆)

**top**:
芯片最顶层验证环境,与 subsys 区分时使用,只在"层级"上下文中使用。
_Avoid_: fullchip, chip(在层级对比时)

**sysbase**:
底层基础验证环境框架生成器,对应内网脚本 `sysbase_gen.py` 的 sysbase 分支。生成 ttb、env 框架、clock/reset/power 等公共组件。
_Avoid_: base env

**systba**:
subsys 层的 testbench 生成器(同脚本的另一分支),产生 vip conn、ral model、pin cfg task 等。
_Avoid_: subsys tb, sub tb

**socv env**:
soc verification environment 的缩写,泛指 SOC 验证环境。本 skill 的最终产物。
_Avoid_: dv env(过宽)、testbench(过窄,不含 env 框架)

**dut_spec**:
subsys 的设备规格说明 excel,记录 ip 列表、协议、位宽、master/slave 关系等。sysbase_gen.py 用其生成 systba vip / sysbase bfm。
_Avoid_: spec(太泛)

**mini_excel**:
提供给 ipsocv 的精简 excel,只含 ipsocv 关心的关键列;由 sysbase_gen.py 用于生成 ipsocv 相关环境。
_Avoid_: mini_spec(易与 dut_spec 混淆)

**mod_io**:
由 verdi 内 "Get Module IO" app(Synopsys 提供的 `getModIO_batch.pl` 批处理脚本)从 rtl 中抓出的模块端口列表,带方向、位宽。sysbase_gen.py 用其做 vip 信号位宽检测与 vip conn 生成。skill 调用入口见 [assets/run_extract_mod_io.sh](assets/run_extract_mod_io.sh)。
_Avoid_: io_list(易与 pin list 混淆)

**ral (Register Abstraction Layer)**:
DE 提供的 reg 模型目录,典型结构为 `<ral>/for_de / for_dv / for_sw`。sysbase_gen.py 用其生成 systba/sysbase ral 文件并例化。
_Avoid_: reg model

**clk_max**:
DE 提供的时钟管理工具,本 skill 接受其 cfg、set_clk_freq task、sva 三份文件作为输入。
_Avoid_: clk manager

**pinlist**:
ip pin 列表,用于生成 ip pin cfg task/define,后续单独生成,不在本 skill 主流程内。
_Avoid_: pin cfg

**dmalist**:
dma req id excel,用于生成 get_dma_req_id task,后续单独生成,不在本 skill 主流程内。
_Avoid_: dma req list

**top csv**:
top 层 sysbase 所需的 subsys 信息表:首列 subsys name,后续列为该 subsys 下的 cpu master info,格式为 `core_name(amba_protocol)(data_width)`。
_Avoid_: subsys csv

## Boundaries

**In scope**:
- subsys 层 socv env 生成(-rtl/-n/-i/-x/-mini/-mod_io/-ral/-clk)
- top 层 socv env 生成(-rtl/-n/-i/-c/-ral,-o 可默认)
- dut_spec / mini_excel 的 AI 草拟(基于 rtl 与现有模板)
- mod_io 的 AI 自动抓取(基于 verdi getModIO_batch.pl;AI 读 log 转 csv)
- 调用前审批闸门(预执行清单 + y/n)
- 调用后结构化报告(目录树 + 关键文件 + 手动检查项)
- 失败时的智能错误提示(基于预设错误模式)
- 重入支持(用户补充输入后可重跑)

**Out of scope**:
- pin list 生成(后续单独 skill)
- dma list 生成(后续单独 skill)
- 修改 SOC 项目的 RTL/约束/DE 文件(只生成 skill 资产)
- 在 Windows 环境下直接执行(只支持内网 Linux)

## Trigger Conditions

**显式触发**: 用户说"生成 SOC 验证环境"、"帮我搭 aon_sys 的 DV env"、"产出 top socv"等明确意图。

**隐式触发**: 用户描述需求如"我需要在 aon_sys 上做验证"或"新建一个 xxx subsys"。

**不触发**:
- 用户只是问 SOC 验证概念(skill 主动告知用户该话题不在本 skill 范围)
- 用户只想修一个已生成 env 的 bug(应转入具体调试)

## Decision Authority

Skill 在每个关键 AI 动作前必须经用户审批。审批形态:结构化预执行清单 + 用户明确 y/n。

Skill 不替用户做以下决策:
- 改 rtl、约束、DE 文件
- 修改 sysbase_gen.py 本身
- 选择环境输出路径(只提供默认并要求用户确认)

## Retry Semantics

Skill 记录最近一次请求的目标(subsys name 或 top name + 参数快照),允许用户补充缺失输入后,触发增量或重新生成。每次重新调用前必须重走审批闸门。
