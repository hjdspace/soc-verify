# ADR 0020: TraceWeave MCP Server 集成

**状态**: Accepted  
**日期**: 2026-08-12  
**作者**: hjdspace  

## 背景

SoC Verify 平台需要波形和仿真日志分析能力，以支持 AI Agent 进行仿真失败的根因分析。TraceWeave（https://github.com/gokeshenzhen/TraceWeave）是一个开源的 MCP Server，提供：

- 仿真日志解析（VCS/Xcelium 日志）
- 波形分析（FSDB/VCD）
- 信号驱动回溯
- 协议握手分析
- X/Z 传播追踪
- 结构性风险扫描

将 TraceWeave 作为内置 MCP Server 集成到 SoC Verify 桌面应用中，使 AI Agent 在创建会话时自动获得波形和日志分析能力，无需用户手动配置。

## 决策

### 1. 源码放置

TraceWeave 源码克隆到 `engine/traceweave/`，与 `engine/oh-my-pi/` 并列。与 omp 引擎不同，TraceWeave 不是 git submodule，而是直接克隆的源码副本，允许后续根据需要修改源码。

### 2. 打包方式

通过 `electron-builder.yml` 的 `extraResources` 配置将 TraceWeave 源码随应用打包：

```yaml
extraResources:
  - from: engine/traceweave
    to: traceweave
    filter:
      - "**/*"
      - "!**/__pycache__/**"
      - "!**/*.pyc"
      - "!third_party/**"           # FSDB 运行时二进制不打包
      - "!libfsdb_wrapper.so"       # 本地编译的 wrapper 不打包
```

打包后路径为 `process.resourcesPath/traceweave/`。

### 3. 路径解析

新增 `src/main/mcp/traceweave-paths.ts` 模块，负责：

- **TraceWeave 目录解析**：优先打包路径 → 回退开发路径
- **Python 二进制解析**：python3.11 → python3 → python（通过 `which`/`where`）
- **MCP 配置构建**：组装 `McpServerConfig`（stdio 传输，命令为 python，参数为 server.py 路径）

### 4. 默认 MCP 注册

在 `mcp-config.ts` 新增 `ensureBuiltinMcpServers()` 函数，在会话创建时将 TraceWeave 注入到用户级 MCP 配置（`~/.omp/mcp.json`）：

- 如果用户尚未配置 TraceWeave，自动添加
- 如果用户已配置（或已禁用），不覆盖用户设置
- 如果 TraceWeave 或 Python 不可用，静默跳过（优雅降级）

调用点在 `session-manager.ts` 的 `createSession()` 中，在 `client.init()` 之前执行。

### 5. EDA 工具环境变量

TraceWeave 依赖以下环境变量来定位 EDA 工具和许可证：

| 环境变量 | 用途 | 说明 |
|---------|------|------|
| `VERDI_HOME` | Verdi 安装路径 | FSDB 运行时 + NPI 后端 + KDB 构建 |
| `NOVAS_HOME` | Verdi/Novas 安装路径 | 同 VERDI_HOME（别名） |
| `VCS_HOME` | VCS 安装路径 | 编译日志解析 |
| `XLM_ROOT` | Xcelium 安装路径 | 编译日志解析 |
| `CDS_INST_DIR` | Cadence 安装路径 | Xcelium/irun 路径 |
| `SNPSLMD_LICENSE_FILE` | Synopsys 许可证 | Verdi/VCS 许可 |
| `LM_LICENSE_FILE` | 通用许可证 | 备选许可 |
| `CDS_LICENSE_FILE` | Cadence 许可证 | Xcelium 许可 |
| `LD_LIBRARY_PATH` | 动态库路径 | FSDB/NPI 动态库加载 |

这些变量从 `process.env` 透传到 MCP 配置的 `env` 字段，用户只需在系统环境变量中设置即可。

## 仿真日志与波形路径分析

### 仿真日志

TraceWeave 的 `path_discovery.py` 自动发现以下日志文件：

**编译日志模式**:
- `*comp*.log` — 编译阶段日志
- `*elab*.log` — 精化阶段日志

**仿真日志模式**:
- `*run*.log` — 通用运行日志
- `xm*.log` — Xcelium (xrun) 日志
- `sim*.log` — 通用仿真日志
- `vcs.log` — VCS 日志

**日志默认路径**：无固定默认路径。TraceWeave 通过 `get_sim_paths` 工具从用户指定的 `verif_root` 参数自动发现。典型目录结构：

```
project/
├── work/
│   ├── work_case1/
│   │   ├── run_sim.log      # 仿真日志
│   │   ├── dump.fsdb        # 波形文件
│   │   └── ...
│   ├── comp.log             # 编译日志（共享）
│   └── elab.log             # 精化日志（共享）
```

### 波形文件

**波形模式**:
- `*.fsdb` — Synopsys FSDB 格式（需要 Verdi 运行时）
- `*.vcd` — 标准 VCD 格式（纯 Python 解析，无需外部依赖）

**FSDB 运行时解析**（两级回退）:
1. 仓库本地: `third_party/verdi_runtime/linux64/libnsys.so` + `libnffr.so`
2. `VERDI_HOME/share/FsdbReader/linux64/`

如果两者都不可用，FSDB 解析被禁用，TraceWeave 仍可解析 VCD 波形。

### EDA 工具配置

#### Verdi

```
VERDI_HOME=/path/to/verdi
NOVAS_HOME=/path/to/verdi
SNPSLMD_LICENSE_FILE=xxxx@license-server
LD_LIBRARY_PATH=$VERDI_HOME/share/FsdbReader/linux64:$LD_LIBRARY_PATH
```

Verdi 提供:
- FSDB 波形读取（通过 ffrAPI）
- NPI 后端（KDB 连通性分析，驱动/负载追踪）
- KDB 自动构建（vericom + elabcom）

#### VCS

```
VCS_HOME=/path/to/vcs
SNPSLMD_LICENSE_FILE=xxxx@license-server
```

VCS 特点:
- 编译日志通过 `vcs.log` 或 `comp.log` 解析
- KDB 构建方式: `vcs -kdb=only`（用户需重新编译）
- 波形通常为 FSDB 格式

#### Xcelium (xrun)

```
XLM_ROOT=/path/to/xcelium
CDS_INST_DIR=/path/to/cadence
CDS_LICENSE_FILE=xxxx@license-server
```

Xcelium 特点:
- 编译日志通过 `xm*.log` 或 `comp.log`/`elab.log` 解析
- 默认无 KDB，TraceWeave 可自动构建（`build_kdb` 工具）
- 波形可为 FSDB 或 VCD 格式

## 集成架构

```
SoC Verify 桌面应用
├── engine/traceweave/           # 源码（开发模式）
├── resources/traceweave/       # 打包后路径（生产模式）
├── src/main/mcp/
│   ├── mcp-config.ts           # MCP 配置读写 + ensureBuiltinMcpServers()
│   ├── mcp-probe.ts            # MCP 连接探测
│   └── traceweave-paths.ts     # TraceWeave 路径解析 + 配置构建
└── src/main/agent/
    └── session-manager.ts       # 会话创建时注册 TraceWeave

数据流:
1. 用户创建 AI 会话
2. session-manager 调用 ensureTraceweaveDefaultMcp()
3. 构建 TraceWeave MCP 配置（python3.11 server.py）
4. ensureBuiltinMcpServers() 写入 ~/.omp/mcp.json
5. omp 引擎读取 mcp.json，spawn TraceWeave 进程
6. AI Agent 获得 TraceWeave 工具（get_sim_paths, parse_sim_log, ...）
```

## 后续修改计划

用户计划后续修改 TraceWeave 源码以适配具体 SoC 验证流程。由于源码直接在 `engine/traceweave/` 中（非 submodule），可以自由修改。修改后需要：

1. 确保 Python 依赖已安装: `pip install mcp pyyaml`
2. 如修改了 FSDB wrapper: `bash build_wrapper.sh`
3. 运行 TraceWeave 测试: `python3.11 -m pytest`
4. 重新打包 SoC Verify 应用

## 验证

- 单元测试: `tests/mcp/traceweave-paths.test.ts`（17 个测试，覆盖路径解析、Python 解析、配置构建）
- 集成验证: 创建 AI 会话后，在设置面板的 MCP 标签页应看到 TraceWeave 服务器
