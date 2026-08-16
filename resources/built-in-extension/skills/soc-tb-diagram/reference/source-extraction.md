# 从 SystemVerilog/UVM 源码提取环境结构

把 TB 源码变成 Step 1 的组件/连接清单。只读不改。

## 识别组件

| 源码特征 | 清单条目 |
| --- | --- |
| `class X extends uvm_test` | test 层：`X`（test），其成员 `uvm_sequencer#(...)` 类型的 virtual sequencer 单列 |
| `class X extends uvm_env` | env 层容器 `X`；`build_phase` 中 `X::type_id::create(...)` 的成员归入其下 |
| `class X extends uvm_agent` | agent 层容器 `X`；`is_active == UVM_ACTIVE` 决定 active/passive |
| agent 内 `uvm_sequencer` / `uvm_driver` / `uvm_monitor` 派生类成员 | agent 三件套（passive agent 只留 monitor） |
| env 内 `uvm_scoreboard` / `uvm_subscriber`（coverage） / reference model 成员 | env 层检查/覆盖组件 |
| `uvm_reg_block` 派生类实例化 | RAL model 组件 |
| tb_top（module）中 `xxx_if` 实例 / `dut` 例化 | interface 组件 / DUT 组件；tb_top 里的 clk/rst 生成语句 → clk_rst 组件 |

## 识别连接

| 源码特征 | 连接类型 |
| --- | --- |
| `seq_item_port.connect(seq_item_export)`（connect_phase） | item: sequencer → driver |
| driver 内 `vif` 赋值（config_db get）+ 源码对 `vif.xxx` 驱动 | drv: driver → 对应 interface |
| monitor 内对 `vif.xxx` 采样 | mon: interface → monitor |
| `uvm_analysis_port` / `uvm_analysis_imp` / `.write(` 调用 | ap: monitor → 每个 imp/subscribe 方 |
| `uvm_config_db#(...)::set` 或 env cfg 对象传递 | cfg: config → 目标 agent/component |
| `uvm_reg_adapter` + `adapter.reg2bus` | ral: RAL model → adapter 所在 agent 的 driver |
| virtual sequencer 中 `uvm_sequencer` 句柄赋值 | vseq: virtual sequencer → 各 sub-sequencer |
| tb_top 中 clk/rst 连到 dut 端口 | clk_rst: clk/rst gen → DUT |

## 要点

- 只提取结构，不提取行为（sequence 内容、约束、断言不进框图）。
- 接口名（`apb_if` / `axi_if`...）作为 interface 组件 label，DUT 与 agent 靠它对上 drv/mon 两端。
- 多个同构 agent（如 4 个 uart agent）：图中全部画出，横向等距；用户明确要求合并时才折叠成 `uart_agent ×4` 单节点。
- 源码缺连接信息（比如 ap 的 consumer 在别的文件）：宁可留到清单里标 `consumer?` 让用户确认，不要凭空补。
