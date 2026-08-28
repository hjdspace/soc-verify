# ADR 0020: TraceWeave MCP Server 集成

**状态**: Accepted（2026-08-28 修订：升级至 v2.0 并确立零安装分发策略，本文件为唯一决策记录）
**日期**: 2026-08-12（初版）/ 2026-08-28（修订）
**作者**: hjdspace

## 背景

SoC Verify 平台需要波形和仿真日志分析能力，以支持 AI Agent 进行仿真失败的根因分析。TraceWeave（https://github.com/gokeshenzhen/TraceWeave）是一个开源（MIT）的 Python MCP Server，提供：

- 仿真日志解析（VCS/Xcelium 编译与运行日志）
- 波形分析（FSDB/VCD）
- 信号驱动/负载回溯与连通性分析（v2.0 Source Graph / Verdi NPI / Legacy Static 三级后端）
- 协议握手分析、X/Z 传播追踪
- 结构性风险扫描

将 TraceWeave 作为内置 MCP Server 集成到 SoC Verify 桌面应用中，使 AI Agent 在创建会话时自动获得波形和日志分析能力，无需用户手动配置 TraceWeave 本身。

**分发原则（2026-08-28 决策）**：TraceWeave 源码随应用打包，**Python 运行时与其 pip 依赖由用户机器提供**，应用负责检测前置条件缺失并给出可操作的修复指引。目标用户为验证工程师，其 EDA 工作站标配 Python 3.11+ 与 Verdi（`VERDI_HOME` 已设置）。

## 决策

### 1. 源码放置与版本管理

TraceWeave 源码放在 `engine/traceweave/`，与 `engine/oh-my-pi/` 并列。与 omp 不同，TraceWeave **不是 git submodule**，而是整体替换式 vendored 副本（允许本地修改）。

版本记录（根因修复：早期 vendored 副本无上游版本标记，导致"集成版本太旧"无法追溯）：

- `package.json` 的 `traceweaveVersion`（如 `v2.0.0`）与 `traceweaveUpstreamCommit`（如 `ca32e38f...`）记录 vendored 基线
- `src/main/mcp/traceweave-paths.ts` 的 `TRACEWEAVE_VERSION` / `TRACEWEAVE_UPSTREAM_COMMIT` 常量供运行时诊断展示

**升级流程**：下载上游固定版本 → 整体替换 `engine/traceweave/` → 更新 `package.json` 版本字段与常量 → **重新应用本地补丁**（见下）→ diff 自查本地修改是否被覆盖 → 跑 `tests/mcp/` 适配测试 → 真实 MCP 握手冒烟。

**本地补丁清单**（升级时必须重打）：

| 补丁 | 文件 | 原因 |
|------|------|------|
| fcntl 条件导入 | `src/source_graph_disk_cache.py` | `fcntl` 为 POSIX-only，v2.0 顶层无条件导入导致 Windows 上 server.py 无法启动；补丁后 Windows 可启动（日志+VCD），磁盘缓存文件锁在非 POSIX 平台显式报错 |
| resource 条件导入 | `src/source_graph_worker.py` | `resource` 为 POSIX-only；峰值 RSS 遥测在 Windows 降级为 None |

### 2. Python 前置（不打包运行时）

**Python 本体不随包分发**，依赖用户机器（EDA 环境标配）。pip 依赖（`mcp==1.27.0`、`PyYAML`，可选 `pyslang==11.0.0`）同样由用户安装。

曾评估并否决的替代方案：

- **内置 python-build-standalone 发行版 + 预装 site-packages**：安装包增大约 80–150MB，且与"依赖用户机器"的前提冲突
- **离线 wheel 池 + 首启静默安装**：`pydantic-core` 等编译依赖按 Python 版本（cp311/cp312/cp313）分发 wheel，体积大且静默安装的失败模式多
- **改源码去三方依赖（纯 stdlib 实现 MCP 协议层）**：与上游同步成本过高

Python 二进制解析顺序：Unix `python3.11 → python3 → python`；Windows `python → python3 → python3.11 → py`（过滤 WindowsApps 商店别名 stub）。

### 3. 结构化诊断与缺失提示

前置条件缺失不是静默降级，而是**用户可操作的状态**：

- `diagnoseTraceweave()`（`traceweave-paths.ts`）三级探测：① Python 存在 → ② `python --version` 版本 ≥3.11 + `python -c "import mcp, yaml"` 依赖导入 → ③ FSDB 能力（wrapper .so + `VERDI_HOME`）
- 经 `settings.traceweaveDiagnostic`（tRPC）暴露给渲染端；设置页 MCP 标签页（用户级）展示诊断卡：Python/依赖/波形三行状态 + 未就绪原因 + **一键复制安装命令**（从上游 `requirements-source-graph.txt` 读取 mcp 版本 pin）
- 会话创建时（`session-manager.ts`）：注册成功但诊断未就绪，或注册跳过（Python 缺失）→ 通过通知中心**每次应用运行至多一次**推送修复指引

### 4. 默认 MCP 注册（全局注入）

在 `mcp-config.ts` 的 `ensureBuiltinMcpServers()` 将 TraceWeave 注入到用户级 MCP 配置（`~/.omp/mcp.json`），**所有 AI 会话均可用**（本应用为验证领域专用，任何会话中提问波形/日志问题都应能调用）。用户已在配置中注册或禁用时不覆盖；不可用时优雅跳过。

调用点在 `session-manager.ts` 的会话创建流程，`client.init()` 之前执行。

v2.0 共注册 **38 个工具**。v2.0 起 server 通过 `__file__` 自定位（`REPO_ROOT`），**不再读取 `TRACEWEAVE_HOME` 环境变量**（旧集成曾设置该变量，已移除）。

### 5. FSDB wrapper 与 EDA 工具环境

**能力降级阶梯**（自动探测，任何一级可用即工作）：

| 级别 | 依赖 | 能力 |
|------|------|------|
| Verdi NPI | `VERDI_HOME` + 许可证 + KDB | 完整连通性分析（driver/load/path/X-source） |
| Source Graph | 可选 `pyslang`（可经 `TRACEWEAVE_SOURCE_GRAPH_PYTHON` 指向隔离环境） | 源码级连通性，无需 Verdi 运行 |
| Legacy Static | 无 | 日志解析 + VCD/FSDB 波形 + 静态层次分析 |

**`libfsdb_wrapper.so` 分发**（无它则 FSDB 整体禁用）：

- `npm run package:linux` 时由 `scripts/build-traceweave-wrapper.mjs` 在**构建机预编译**（要求 Linux + `VERDI_HOME` + g++，即 EDA 构建机默认满足）；任一前置缺失则跳过并继续打包（非阻断，与 officecli 下载同策略），打包版降级为 VCD-only 并在诊断中标注
- Synopsys 运行库（`libnsys.so`/`libnffr.so`）**永不随包分发**，运行时从用户 `VERDI_HOME/share/FsdbReader/linux64/` 加载
- `fsdb_wrapper.cpp` + `build_wrapper.sh` 随包分发，作为用户机（有 `VERDI_HOME` + g++）自行重编译的兜底

**平台矩阵**：Linux 工作站为第一优先（AppImage，FSDB/NPI 完整能力）；Windows（NSIS）经本地补丁后可启动 TraceWeave，能力为日志解析 + VCD（Verdi 运行库无 Windows 版本）。

环境变量透传（`process.env` → MCP 配置 `env`）：`VERDI_HOME`、`NOVAS_HOME`、`VCS_HOME`、`XCELIUM_HOME`（回退映射 `XLM_ROOT`）、`CDS_INST_DIR`、`SNPSLMD_LICENSE_FILE`、`LM_LICENSE_FILE`、`CDS_LICENSE_FILE`、`LD_LIBRARY_PATH`、`PATH`。

### 6. 打包

`electron-builder.yml` 的 `extraResources` 将 `engine/traceweave` 打到 `process.resourcesPath/traceweave/`：

- **包含**：`server.py`、`config.py`、`custom_patterns.yaml`、`src/**`、`libfsdb_wrapper.so`（构建机产物，存在才打）、`fsdb_wrapper.cpp`、`build_wrapper.sh`、`requirements-source-graph.txt`、`LICENSE`
- **排除**：`third_party/**`（Synopsys 专有库）、`tests/`、`docs/`、`reference/`、`benchmarks/`、`assets/`、`scripts/`、`*.md`、`pytest.ini`、`__pycache__`、`.pytest_cache`、`.venv`（运行时非必需，控制包体）

## 集成架构

```
SoC Verify 桌面应用
├── engine/traceweave/            # vendored v2.0 源码（开发模式；含本地补丁）
├── resources/traceweave/         # 打包后路径（生产模式）
├── scripts/build-traceweave-wrapper.mjs   # package:linux 预编译 FSDB wrapper（非阻断）
├── src/main/mcp/
│   ├── mcp-config.ts             # MCP 配置读写 + ensureBuiltinMcpServers()
│   ├── mcp-probe.ts              # MCP 连接探测（initialize → tools/list）
│   └── traceweave-paths.ts       # 路径解析 + 配置构建 + diagnoseTraceweave()
├── src/main/agent/session-manager.ts      # 会话创建时注册 + 未就绪一次性通知
└── src/main/ipc/routers/settings-router.ts # settings.traceweaveDiagnostic
渲染端:
└── src/renderer/src/components/settings/McpTab.tsx  # 诊断卡 + 一键复制安装命令

数据流:
1. 用户创建 AI 会话
2. session-manager 调用 ensureTraceweaveDefaultMcp() 构建 stdio 配置（python server.py）
3. ensureBuiltinMcpServers() 写入 ~/.omp/mcp.json（幂等，不覆盖用户配置）
4. omp 引擎读取 mcp.json，spawn TraceWeave 进程
5. AI Agent 获得 38 个 TraceWeave 工具（get_sim_paths, parse_sim_log, ...）
6. 若诊断未就绪 → 通知中心一次性推送修复指引；设置 → MCP 有完整诊断卡
```

## 仿真日志与波形路径

TraceWeave 的 `path_discovery.py` 自动发现日志（`*comp*.log`、`*elab*.log`、`*run*.log`、`xm*.log`、`sim*.log`、`vcs.log`）与波形（`*.fsdb`、`*.vcd`），从用户指定的 `verif_root` 参数出发扫描。典型布局：

```
$PROJ_WORK/
└── <case_dir>/
    ├── run_sim.log      # 仿真日志
    ├── comp.log         # 编译日志（共享）
    └── dump.fsdb        # 波形文件
```

与平台侧的 `SimArtifactResolver`（`src/main/simulation/sim-artifact-resolver.ts`）各自独立：平台用 `$PROJ_WORK/<case>/log` 定位 `sprd_log_pass.log`/`sprd_log_fail.log` 判定状态；TraceWeave 由 AI 通过工具调用自主发现与解析。两者不混用路径。

## 验证

- 单元测试：`tests/mcp/traceweave-paths.test.ts`（40 个：路径解析、Python 解析与商店 stub 过滤、配置构建、EDA 环境变量透传、诊断三级探测、FSDB 阻塞项、平台矩阵）+ `tests/mcp/mcp-config.test.ts`（8 个）
- 集成冒烟：用户机 Python 环境下 `import server` 全链路导入 + 真实 MCP stdio 握手（initialize → notifications/initialized → tools/list 返回 38 工具）
- 人工验收：设置 → MCP（用户级）出现"内置 TraceWeave"诊断卡；删除/破坏 pip 依赖后诊断卡显示缺失模块与可复制安装命令；会话创建触发一次性通知
