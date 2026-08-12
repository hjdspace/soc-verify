# TraceWeave 内置 MCP Server 使用手册

## 概述

TraceWeave 是一个面向仿真失败调试的 MCP Server，通过日志解析和波形（FSDB/VCD）分析帮助 AI Agent 快速定位根因。SoC Verify 将 TraceWeave 作为内置 MCP Server 集成，随桌面应用自动打包分发，无需用户额外安装。

## 前置条件

### Python 运行时

TraceWeave 需要 Python 3.11+。请确保系统 PATH 中可找到 `python3.11`、`python3` 或 `python`。

验证 Python 可用性:
```bash
python3.11 --version
# 或
python3 --version
```

### Python 依赖

TraceWeave 依赖两个 Python 包:
```bash
pip install mcp pyyaml
```

### EDA 工具（可选）

TraceWeave 的能力取决于可用的 EDA 工具:

| 能力 | 需要的工具 | 环境变量 |
|------|-----------|---------|
| VCD 波形解析 | 无（纯 Python） | — |
| FSDB 波形解析 | Verdi 运行时 | `VERDI_HOME` |
| 驱动/负载追踪 | Verdi NPI + KDB | `VERDI_HOME` + 许可证 |
| KDB 自动构建 | Verdi vericom/elabcom | `VERDI_HOME` |
| VCS 日志解析 | 无 | — |
| Xcelium 日志解析 | 无 | — |

## EDA 工具配置

### Verdi

```bash
# 在 ~/.bashrc 或系统环境变量中设置
export VERDI_HOME=/path/to/verdi
export NOVAS_HOME=$VERDI_HOME
export SNPSLMD_LICENSE_FILE=xxxx@license-server
export LD_LIBRARY_PATH=$VERDI_HOME/share/FsdbReader/linux64:$LD_LIBRARY_PATH
```

### VCS

```bash
export VCS_HOME=/path/to/vcs
export SNPSLMD_LICENSE_FILE=xxxx@license-server
```

### Xcelium (xrun)

```bash
export XLM_ROOT=/path/to/xcelium
export CDS_INST_DIR=/path/to/cadence
export CDS_LICENSE_FILE=xxxx@license-server
```

### Windows 环境

在 Windows 上，通过系统属性 → 高级 → 环境变量设置上述变量。或通过 PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("VERDI_HOME", "C:\tools\verdi", "User")
[Environment]::SetEnvironmentVariable("SNPSLMD_LICENSE_FILE", "xxxx@license-server", "User")
```

## 使用方式

### 自动集成

TraceWeave 在 SoC Verify 中自动集成:

1. 启动 SoC Verify 应用
2. 打开项目并创建 AI 会话
3. TraceWeave 自动注册为 MCP Server（写入 `~/.omp/mcp.json`）
4. AI Agent 获得 TraceWeave 全部工具

无需手动配置 MCP Server。

### 验证连接

1. 在 SoC Verify 中打开设置面板
2. 切换到 MCP 标签页
3. 应看到 `TraceWeave` 服务器，状态为 `connected`
4. 展开可查看暴露的工具列表

### 标准调试工作流

使用 TraceWeave 的推荐工作流:

```
get_sim_paths → build_tb_hierarchy + scan_structural_risks → parse_sim_log → sweep_handshakes → recommend_failure_debug_next_steps
```

#### 1. 路径发现

```
AI: 调用 TraceWeave 的 get_sim_paths，传入验证目录路径
```

`get_sim_paths` 自动发现:
- 编译日志（`*comp*.log`, `*elab*.log`）
- 仿真日志（`*run*.log`, `xm*.log`, `sim*.log`, `vcs.log`）
- 波形文件（`*.fsdb`, `*.vcd`）

#### 2. 层次构建 + 结构扫描

```
AI: 对精化日志并行执行 build_tb_hierarchy 和 scan_structural_risks
```

#### 3. 日志解析

```
AI: 解析仿真日志 parse_sim_log
```

#### 4. 协议健康扫描

```
AI: 如果仿真失败且有波形，执行 sweep_handshakes
```

#### 5. 深入分析

根据推荐使用:
- `search_signals` — 搜索信号
- `get_signal_at_time` — 查询时刻值
- `get_signals_by_cycle` — 按周期采样
- `explain_signal_driver` — 驱动回溯
- `trace_x_source` — X/Z 追踪
- `inspect_handshake` — 握手分析

### 示例对话

```
用户: 帮我分析 work/case_uart 的仿真失败

AI: 
1. [调用 get_sim_paths(verif_root="work/case_uart")]
   → 发现 sim.log, dump.fsdb, comp.log

2. [调用 build_tb_hierarchy(compile_log="comp.log")]
   → 返回测试台层次结构

3. [调用 scan_structural_risks(compile_log="comp.log")]
   → 发现 2 个结构风险

4. [调用 parse_sim_log(sim_log="sim.log")]
   → 发现 UVM_ERROR，失败时间 125000ps

5. [调用 sweep_handshakes(wave_file="dump.fsdb")]
   → AXI 写通道存在 payload-hold 违规

6. [调用 explain_signal_driver(wave="dump.fsdb", signal="dut.axi.awvalid")]
   → 驱动源为 TB driver

根因分析: AXI 写通道的 WDATA 在等待状态期间不稳定，
检查 TB driver 的 WDATA 逻辑。
```

## 工具快速参考

### 路径与层次
| 工具 | 功能 |
|------|------|
| `get_sim_paths` | 发现编译/仿真日志和波形文件 |
| `build_tb_hierarchy` | 构建测试台层次 |
| `scan_structural_risks` | 结构风险扫描 |

### 日志分析
| 工具 | 功能 |
|------|------|
| `parse_sim_log` | 解析仿真日志，归一化失败事件 |
| `diff_sim_failure_results` | 比较两次仿真运行 |
| `get_error_context` | 提取日志上下文 |

### 波形分析
| 工具 | 功能 |
|------|------|
| `search_signals` | 搜索信号层次路径 |
| `get_signal_at_time` | 查询时刻值 |
| `get_signal_transitions` | 信号跳变 |
| `get_signals_by_cycle` | 周期采样 |
| `get_waveform_summary` | 波形元数据 |

### 协议分析
| 工具 | 功能 |
|------|------|
| `sweep_handshakes` | 全设计握手扫描 |
| `inspect_handshake` | 握手时序分析 |
| `verify_window` | 时序谓词验证 |
| `reconstruct_transactions` | 事务重建 |

### 深度分析
| 工具 | 功能 |
|------|------|
| `explain_signal_driver` | RTL 驱动回溯 |
| `find_signal_loads` | 扇出查找 |
| `trace_signal_path` | 连通性路径（需 NPI） |
| `trace_x_source` | X/Z 传播追踪 |
| `build_kdb` | 自动构建 KDB |

## 仿真日志路径说明

TraceWeave 没有固定的默认日志路径，而是通过模式匹配自动发现:

**编译日志**:
- `*comp*.log` — 如 `comp.log`, `compile.log`, `comp_uart.log`
- `*elab*.log` — 如 `elab.log`, `elaborate.log`

**仿真日志**:
- `*run*.log` — 如 `run.log`, `run_sim.log`, `run_uart.log`
- `xm*.log` — Xcelium 特定，如 `xrun.log`, `xmelab.log`
- `sim*.log` — 如 `sim.log`, `simulation.log`
- `vcs.log` — VCS 默认日志名

**波形文件**:
- `*.fsdb` — FSDB 格式（需 Verdi 运行时）
- `*.vcd` — VCD 格式（无外部依赖）

### 典型目录结构

```
verification/
├── work/
│   ├── comp.log                  # 共享编译日志
│   ├── elab.log                  # 共享精化日志
│   ├── work_uart_tx/
│   │   ├── run_sim.log           # 仿真日志
│   │   ├── dump.fsdb             # FSDB 波形
│   │   └── simv.daidir/          # VCS 运行目录
│   │       └── kdb.elab++/       # KDB（如有）
│   └── work_spi_rx/
│       ├── run_sim.log
│       └── dump.vcd              # VCD 波形
```

## 故障排除

### TraceWeave 未出现在 MCP 列表

1. 检查 Python 3.11+ 是否在 PATH 中
2. 检查 `~/.omp/mcp.json` 是否包含 TraceWeave 条目
3. 在设置面板点击 "刷新 MCP"
4. 重启 AI 会话

### FSDB 解析不可用

1. 设置 `VERDI_HOME` 环境变量指向 Verdi 安装路径
2. 确保 `$VERDI_HOME/share/FsdbReader/linux64/libnsys.so` 存在
3. 设置 `LD_LIBRARY_PATH` 包含 FSDB 运行时库目录
4. 使用 VCD 波形作为替代

### NPI 后端不可用（Static 回退）

1. 确保 Verdi KDB 存在:
   - VCS: `simv.daidir/kdb.elab++`（需用 `-kdb=only` 重新编译）
   - Xcelium: 调用 `build_kdb` 工具自动构建
2. 确保 `VERDI_HOME` 指向有效 Verdi 安装
3. 确保 `pynpi` 可从 `$VERDI_HOME` 加载
4. 检查许可证是否有效

### Python 依赖缺失

```bash
pip install mcp pyyaml
```

如果使用虚拟环境，确保 SoC Verify 进程能继承该环境的 PATH。

## 开发者信息

### 源码位置

- TraceWeave 源码: `engine/traceweave/`
- 集成模块: `src/main/mcp/traceweave-paths.ts`
- 配置管理: `src/main/mcp/mcp-config.ts` (`ensureBuiltinMcpServers`)
- 会话注入: `src/main/agent/session-manager.ts`

### 修改 TraceWeave 源码

TraceWeave 源码直接在 `engine/traceweave/` 中（非 submodule），可自由修改:

1. 修改 Python 源码
2. 运行 TraceWeave 测试: `cd engine/traceweave && python3.11 -m pytest`
3. 如修改 `fsdb_wrapper.cpp`: `bash build_wrapper.sh`
4. 重新打包 SoC Verify

### 架构参考

- [ADR 0020: TraceWeave MCP Server 集成](../adr/0020-traceweave-integration.md)
- [TraceWeave README](../../engine/traceweave/README.md)
- [TraceWeave 架构文档](../../engine/traceweave/docs/architecture.md)
