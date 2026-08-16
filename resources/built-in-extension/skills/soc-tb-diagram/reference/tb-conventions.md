# 验证环境框图约定

元素词汇、分层布局、样式与连线规则。XML 语法细节见 [drawio-skill 的 xml-authoring.md](../../drawio-skill/references/xml-authoring.md)。

## 分层布局（自上而下）

```
┌─ Test 层 ──────────────────────────────┐
│  test（含 virtual sequencer）           │
├─ Env 层 ───────────────────────────────┤
│  env: scoreboard / coverage / ref model │
│  / RAL model / config                   │
├─ Agent 层 ─────────────────────────────┤
│  active agent(s) / passive agent(s)     │
│  每个 active agent 内: sequencer /      │
│  driver / monitor                       │
├─ DUT 层 ───────────────────────────────┤
│  interfaces / DUT (RTL) / clk&rst       │
└────────────────────────────────────────┘
```

- 画布方向固定 TB（上→下）：驱动流从 test 层流向 DUT 层，采样流（mon/ap）反向。
- 层用 **group 容器**（`group;pointerEvents=0;`）或 swimlane（层需要标题栏时）实现，层内组件坐标相对容器。
- Agent 一律用 swimlane 容器（有标题且自身常被连线引用）。
- 栅格：组件宽 160 / 高 50，水平间距 60，垂直层间距 80。同类 agent 横向等距排开。

## 组件词汇与样式

| 组件 | 容器/节点 | style 要点 |
| --- | --- | --- |
| test / virtual sequencer | 节点 | `rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;` |
| env | 容器（swimlane） | `swimlane;startSize=30;fillColor=#fff2cc;strokeColor=#d6b656;` |
| scoreboard / ref model | 节点（env 内） | `rounded=1;fillColor=#e1d5e7;strokeColor=#9673a6;` |
| coverage collector | 节点（env 内） | `rounded=1;fillColor=#e1d5e7;strokeColor=#9673a6;dashed=1;` |
| RAL model（reg model） | 节点（env 内） | `shape=cylinder3;fillColor=#f5f5f5;strokeColor=#666666;` |
| config（config_db/env cfg） | 节点（env 内） | `shape=note;fillColor=#fff2cc;strokeColor=#d6b656;` |
| agent（active/passive） | 容器（swimlane） | active: `swimlane;startSize=28;fillColor=#d5e8d4;strokeColor=#82b366;` passive 同色加 `dashed=1;` |
| sequencer / driver | 节点（agent 内） | `rounded=1;fillColor=#ffe6cc;strokeColor=#d79b00;` |
| monitor | 节点（agent 内） | `rounded=1;fillColor=#ffe6cc;strokeColor=#d79b00;dashed=0;`（passive agent 内的 monitor 与 active 同款，容器虚线已区分） |
| interface（vif / pin 接口） | 节点 | `shape=parallelogram;fillColor=#f5f5f5;strokeColor=#999999;` |
| DUT（RTL top / subsys） | 节点 | `rounded=0;fillColor=#f8cecc;strokeColor=#b85450;fontStyle=1;` |
| clk / rst gen | 节点 | `ellipse;fillColor=#f5f5f5;strokeColor=#999999;` |

命名：组件 label 用实例语义名（如 `apb_master_agent`），必要时第二行注明类型（`&#xa;uvm_agent`）。

## 连接类型与 edge 样式

连线统一 `edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;`，再按类型叠加：

| 类型 | 语义 | source → target | 附加样式 |
| --- | --- | --- | --- |
| item | seq_item 传输 | sequencer → driver | 无（实线箭头） |
| drv | 激励驱动 | driver → interface | `strokeWidth=2;` |
| mon | 采样观测 | interface → monitor（虚线反向表达采样） | `dashed=1;` |
| ap | analysis port 分发 | monitor → scoreboard / coverage / ref model | `dashed=1;strokeColor=#9673a6;` 带 label（`ap`） |
| cfg | 配置下发 | config → agent / component | `strokeColor=#d6b656;dashed=1;endArrow=open;` |
| ral | 寄存器总线 | RAL model ↔ adapter(→ driver) | `strokeColor=#666666;` |
| vseq | virtual seq 控制 | virtual sequencer → sub-sequencer | `endArrow=open;` |
| clk_rst | 时钟复位 | clk/rst gen → DUT | `dashed=1;strokeColor=#999999;endArrow=open;` |

- 连到容器内部的组件时，edge 的 source/target 直接指向**内部组件 cell**，不指向容器本身。
- 一个 monitor 的 ap 有多个 consumer 时，用 exit/entry 点（`exitX/exitY/entryX/entryY`）把多条 ap 线在 monitor 底边分开，避免叠线。
- label 统一 `fontSize=11;labelBackgroundColor=#ffffff;`。

## 图例

在画布右上角放一个 legend（参考 drawio-skill xml-authoring.md 的 Legend 节），列出：四种容器色块含义 + ap/cfg/clk_rst 三种虚线含义。
