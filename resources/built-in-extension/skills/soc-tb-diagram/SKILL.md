---
name: soc-tb-diagram
description: "生成 SoC/UVM 验证环境框图 (.drawio)。Invoke when user requests 验证环境框图、testbench 架构图、TB 框图、UVM env 结构图、agent/driver/monitor/scoreboard 连接图,或要把 socv env / tb top 可视化。"
---

# SoC 验证环境框图生成

生成分层验证环境（testbench）框图，输出 `.drawio` 文件。用户在 SoC Verify 中点击该文件即可预览，并导出 PNG / SVG / PDF / JPG。

基础 skill 是 [drawio-skill](../drawio-skill/SKILL.md)：XML 语法、校验脚本、CLI 导出全部复用它，本 skill 不重复 —— 只定义验证环境的领域约定（画什么、怎么分层、怎么连线）。

## Triggers

只画验证环境结构框图。通用流程图 / 架构图 / ER 图走 drawio-skill 本体；概念咨询（"scoreboard 是什么"）不属于本 skill。

## Step 0: 判定输入

三选一，不确定就问用户：

- **TB 源码**（`tb_top.sv` / `*_env.sv` / `*_agent.sv` 等 .sv 文件）→ Step 1 按 [reference/source-extraction.md](reference/source-extraction.md) 提取。
- **env.json**（soc-env-gen 产物）→ 子系统/组件结构直接读 JSON，跳过源码提取。
- **口头/文档描述** → 列出你理解的组件清单让用户确认，缺的 agent / scoreboard 必须补问。

`Completion`: 输入类型确定；组件来源明确（文件路径 / JSON / 用户确认的清单）。

## Step 1: 提取组件与连接清单

产出两张清单（写成中间笔记，不直接写 XML）：

- **组件清单**：每个 uvm_component / uvm_agent / DUT / interface 一行，标注层级归属（test / env / agent / dut，见 [reference/tb-conventions.md](reference/tb-conventions.md)）。
- **连接清单**：每条连接一行，类型必须是 tb-conventions 里定义的一种（item / drv / mon / ap / cfg / ral / vseq / clk_rst）。

`Completion`: 每个 agent 的 sequencer / driver / monitor 三件套（passive agent 无 sequencer/driver）都出现在组件清单；每条 analysis port（ap）都有明确的 consumer；连接清单中不存在未定义的连接类型。

## Step 2: 生成 .drawio

1. 先读 [drawio-skill 的 xml-authoring.md](../drawio-skill/references/xml-authoring.md)（文件骨架 / cell 形式 / edge 规则）。
2. 分层布局、容器结构、组件样式、连线样式全部按 [reference/tb-conventions.md](reference/tb-conventions.md) 执行；可从 [assets/tb-template.drawio](assets/tb-template.drawio) 起步。
3. 写入 `<输出名>.drawio`（默认当前工作目录，用户指定路径优先）。
4. 自检：XML 可解析、所有 edge 的 source/target 都指向存在的 cell id、无 `--` 注释。

`Completion`: 文件落盘且自检通过；组件清单和连接清单中的每一项都能在图中找到对应元素（逐项核对，不是抽查）。

## Step 3: 交付

- 告知用户：在 SoC Verify 文件树中点击 `.drawio` 文件即可在中间页面预览框图，预览页支持导出 PNG / SVG / PDF / JPG。
- 若 CLI（`drawio --version`）可用且用户要图片，按 drawio-skill 的导出步骤出 PNG，否则只交付 `.drawio`。

`Completion`: 文件路径已告知用户；导出（如有）已执行并报告路径。
