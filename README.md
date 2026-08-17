# SoC Verify

<p align="center">
  <strong>AI Agent 驱动的 SoC 验证一站式管理平台</strong>
</p>

<p align="center">
  从项目 Kickoff 到 Tape-Out，所有验证工作——项目管理、仿真执行、覆盖率分析、时序违例管理、回归测试、AI 辅助验证——尽在单一桌面应用中完成。
</p>

<p align="center">
  <a href="https://github.com/hjdspace/soc-verify/releases"><img src="https://img.shields.io/github/v/release/hjdspace/soc-verify?style=flat-square&logo=github" alt="Release"></a>
  <a href="https://github.com/hjdspace/soc-verify/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/hjdspace/soc-verify/stargazers"><img src="https://img.shields.io/github/stars/hjdspace/soc-verify?style=flat-square&logo=github" alt="Stars"></a>
</p>

---

## 概述

**SoC Verify** 是一款 Electron 桌面应用，面向 SoC 验证工程师，覆盖从项目启动到流片的完整验证周期。核心 AI 能力由 [oh-my-pi (omp)](./engine/oh-my-pi/) 引擎提供，普通开发运行优先使用 GitHub Release 中的预编译 runner，只有重编 runner 时才需要初始化 engine submodule。

平台采用插件化架构，EDA 工具集成（仿真器、覆盖率工具等）全部通过插件实现，平台本身提供插件接口和运行框架，不绑定特定 EDA 厂商。

### 核心能力

| 能力域 | 说明 |
|--------|------|
| **项目管理** | 多项目打开/切换、文件树懒加载浏览、文件编辑器（图片预览/缩放）、项目状态持久化与恢复、源码控制 |
| **插件系统** | 6 种插件类型（case-parser / subsys-discoverer / simulation-runner / coverage-parser / sim-option-schema / ui），支持用户目录自动发现、优先级管理和沙箱视图，内置插件 SDK |
| **仿真执行** | SimulationManager 管理仿真生命周期，编译错误解析，运行历史记录与对比，运行预设管理 |
| **终端集成** | node-pty + xterm.js 多标签终端，支持仿真直连执行、自定义 bashrc 配置 |
| **错误分析** | 仿真失败自动触发 AI 错误分析，compile_error 自动修复并重试（最大 3 次），sim_error 给出建议 |
| **Diff Review** | AI Agent 代码改动的逐块审阅系统，接受/拒绝每个 hunk，支持 overwritten hunk 检测和 before reconstruction |
| **覆盖率分析** | CoverageManager 多维度覆盖率（行/Toggle/条件/FSM/断言），AI 覆盖率闭合（Closure Orchestrator + Recovery 恢复机制），gap 识别与定向测试生成，排除建议链，HTML/JSON 导出，Test Promotion |
| **时序违例管理** | vio_summary.log 解析（Worker 线程）、违例确认工作流、精确与模糊 Pattern 匹配、Violation Dashboard、AI Advisor |
| **用例数据库** | SQLite 统一数据源，Case Scanner 增量扫描，仿真历史自动记录，phase 字段支持 |
| **仪表盘** | ECharts 可视化，8+ 数据标签页（趋势/热力图/失败/回归进度/耗时分布/不稳定用例/阶段通过率/调试难度） |
| **回归测试** | 回归套件管理、批量执行、结果汇总 |
| **AI Agent** | 多会话管理（并发上限 10）、流式消息、Markdown + Mermaid 渲染、技能发现、上下文管理、OpenAI 兼容代理 |
| **知识库** | 文档知识库（ADR 0021），支持多格式文档转 Markdown（anydoc + markitdown 双引擎），跨知识库检索，KB AI 模型独立配置 |
| **文档预览** | Office 文档创建/编辑、PDF/Markdown/HTML 预览、xlsx 原地编辑（Fortune Sheet 集成） |
| **Draw.io 集成** | 内置 draw.io desktop CLI（Linux 内置二进制 / Windows 本机安装回退），流程图预览与 PNG/SVG 导出 |
| **浏览器** | In-app browser 支持 window.open、SSO、书签管理、下载处理 |
| **MCP 配置** | 多作用域 MCP 服务器配置管理、连接状态查询、工具查看 |
| **环境配置** | EDA 工具自动检测、环境变量配置向导 |
| **TO 检查清单** | 流片前检查项管理，自动评估与报告导出 |
| **凭据管理** | API 密钥安全存储、自定义接口地址 |
| **命令面板** | 快捷键触发，快速操作 |
| **内建工具集** | 18 个专业工具：Git Manager / Git Diff / Git Quick Pull / Time Analyzer / SV Ifdef Checker / Regression Analyzer / Regression List Gen / Register Table Parser / Reg2C / Coverage Merger / Code Line Counter / C-SV Converter / Batch Execution / Find Replace / Log Analyzer / System Monitor / Sysbase Gen（环境生成器） |

## 技术栈

| 层 | 技术 | 版本 |
|---|---|---|
| 运行时 | Electron | 43 |
| 构建 | electron-vite | 5 |
| 前端框架 | React | 19 |
| 语言 | TypeScript | 6 |
| 样式 | Tailwind CSS v4 + shadcn/ui (new-york) | 4.3 |
| 状态管理 | Zustand | 5 |
| RPC | electron-trpc (tRPC) | 0.7.1 |
| 终端 | node-pty + xterm.js | 1.1 / 6.0 |
| 代码编辑器 | CodeMirror | 4.25 |
| 表格编辑 | Fortune Sheet | 1.0 |
| Markdown | react-markdown + remark-gfm + rehype-raw | 10.1 / 4.0 |
| AI 引擎 | oh-my-pi (omp) | 预编译 runner + git submodule 开发回退 |
| 图表 | Apache ECharts | 5.6 |
| 测试 | Vitest | 4 |
| 图标 | lucide-react | 1.24 |
| 文档 | officecli | v1.0.143 |
| 流程图 | draw.io desktop | v31.1.8 |

## 项目结构

```
soc-verify/
├── src/
│   ├── main/                          # Electron 主进程 (ESM → CJS)
│   │   ├── index.ts                   # 应用入口
│   │   ├── ipc/router.ts              # tRPC router（24 个子路由）
│   │   ├── agent/                     # AI Agent 引擎集成
│   │   │   ├── agent-client.ts        # omp RPC 客户端
│   │   │   ├── openai-compatible.ts   # OpenAI 兼容代理
│   │   │   ├── session-manager.ts     # 会话管理（并发上限 10）
│   │   │   ├── session-persistence.ts # 会话持久化
│   │   │   ├── skill-discovery.ts     # 技能发现（SKILL.md 扫描）
│   │   │   ├── context-settings.ts    # AI 上下文配置
│   │   │   └── paths.ts               # omp/bun 路径解析
│   │   ├── tools/                     # 内建工具集（18 个工具）
│   │   │   ├── git-manager.ts         # Git 仓库管理（含缓存）
│   │   │   ├── git-quick-pull.ts      # 快速拉取
│   │   │   ├── git-diff.ts            # Git diff 查看
│   │   │   ├── env-checker.ts         # 环境检查（含缓存）
│   │   │   ├── time-analyzer.ts       # 时间分析
│   │   │   ├── sv-ifdef-checker.ts    # SV ifdef 检查
│   │   │   ├── regression-analyzer.ts # 回归分析
│   │   │   ├── regression-list-gen.ts # 回归列表生成
│   │   │   ├── register-table-parser.ts # 寄存器表解析
│   │   │   ├── reg2c.ts               # Excel→C 头文件转换
│   │   │   ├── coverage-merger.ts     # 覆盖率合并
│   │   │   ├── c-sv-converter.ts      # C↔SV 转换
│   │   │   ├── batch-execution.ts     # 批量执行
│   │   │   ├── code-line-counter.ts   # 代码行数统计
│   │   │   ├── find-replace.ts        # 查找替换
│   │   │   ├── log-analyzer.ts        # 日志分析
│   │   │   ├── system-monitor.ts      # 系统监控
│   │   │   ├── sysbase-gen/           # 系统环境生成器（模板/命令/配置）
│   │   │   └── routers/               # 各工具的 tRPC 路由
│   │   ├── host/                      # Host Tools / URI 注册中心
│   │   │   ├── host-tools.ts          # 工具注册中心（25 个 AI Host Tools）
│   │   │   ├── host-uris.ts           # URI scheme handler（case:/// log:/// cov:///）
│   │   │   ├── tools/                 # Host Tool 模块
│   │   │   │   ├── sim-tools.ts       # 仿真/用例工具（8 个）
│   │   │   │   ├── doc-tools.ts       # 文档创建工具（5 个）
│   │   │   │   ├── xlsx-edit-tools.ts # xlsx 细粒度编辑工具（2 个）
│   │   │   │   ├── kb-tools.ts        # 知识库工具（2 个）
│   │   │   │   ├── coverage-tools.ts  # 覆盖率分析工具（4 个，条件注册）
│   │   │   │   ├── context-tools.ts   # 上下文工具（2 个，条件注册）
│   │   │   │   └── shared.ts          # defineTool 等共享工具
│   │   │   └── plugin-discovery.ts    # 插件驱动适配层
│   │   ├── simulation/                # 仿真管理
│   │   │   ├── simulation-manager.ts  # 仿真生命周期
│   │   │   ├── log-analyzer.ts        # 编译/仿真日志解析
│   │   │   ├── error-analysis-coordinator.ts  # 自动错误分析
│   │   │   ├── sim-terminal-linker.ts # 仿真→终端关联
│   │   │   └── runsim-retry-tool.ts   # 仿真重试工具
│   │   ├── case/                      # 用例数据库
│   │   │   ├── db/                    # SQLite 数据库实现
│   │   │   ├── case-scanner.ts        # 用例增量扫描
│   │   │   ├── case-stats-service.ts  # 用例统计服务
│   │   │   └── sim-run-listener.ts    # 仿真运行监听
│   │   ├── timing-violation/          # 时序违例管理
│   │   │   ├── parser/                # vio_summary.log 解析
│   │   │   ├── scanner/               # 回归目录扫描
│   │   │   ├── confirm/               # 违例确认工作流
│   │   │   ├── export/                # Excel/CSV 导出
│   │   │   ├── ai/                    # TV AI Advisor
│   │   │   ├── db/                    # SQLite 存储
│   │   │   └── types.ts               # 类型定义
│   │   ├── diff/                      # Diff Review 引擎
│   │   │   ├── diff-engine.ts         # Hunk 解析/接受/拒绝/overwritten 检测
│   │   │   └── review-queue.ts        # 全局待审阅队列
│   │   ├── coverage/                  # 覆盖率管理
│   │   │   ├── coverage-manager.ts    # 覆盖率数据管理
│   │   │   ├── coverage-worker.ts     # Worker 线程解析
│   │   │   ├── closure-orchestrator.ts # AI 覆盖率闭合编排
│   │   │   ├── closure-manager.ts     # 闭合会话管理
│   │   │   ├── coverage-recovery.ts   # 闭合恢复机制
│   │   │   ├── exclusion-el.ts        # 排除链
│   │   │   ├── exclusion-suggestions.ts # AI 排除建议
│   │   │   ├── test-promoter.ts       # Test Promotion
│   │   │   ├── lsf-runner.ts          # LSF 作业提交
│   │   │   └── eda-config.ts          # EDA 配置
│   │   ├── kb/                        # 文档知识库（ADR 0021）
│   │   │   ├── converter.ts           # 文档→Markdown 转换
│   │   │   ├── engines/               # 双引擎（anydoc + markitdown）
│   │   │   ├── indexer.ts             # 索引构建
│   │   │   ├── searcher.ts            # 跨知识库检索
│   │   │   ├── scanner.ts             # 文档扫描
│   │   │   ├── deep-reindexer.ts      # 深度重索引
│   │   │   ├── registry.ts            # 知识库注册
│   │   │   ├── pipeline.ts            # 处理流水线
│   │   │   ├── context-injector.ts    # AI 上下文注入
│   │   │   ├── llm-config.ts          # KB AI 模型配置
│   │   │   └── layout.ts              # 知识库布局
│   │   ├── drawio/                    # Draw.io 集成
│   │   │   ├── binary.ts              # CLI 二进制路径解析（三级回退）
│   │   │   └── exporter.ts            # PNG/SVG 导出
│   │   ├── browser/                   # In-app 浏览器
│   │   ├── surface/                   # View Manager（视图边界与叠加层）
│   │   ├── document/                  # Office 文档预览/编辑
│   │   │   ├── xlsx-editor.ts         # xlsx 编辑（appendRows/updateCell）
│   │   │   ├── xlsx-reader.ts         # xlsx 读取
│   │   │   ├── fortune-sheet-bridge.ts # Fortune Sheet 桥接
│   │   │   └── editor-registry.ts     # 编辑器注册与 flush 机制
│   │   ├── officecli/                 # officecli 集成
│   │   │   ├── binary.ts              # 二进制路径解析
│   │   │   ├── downloader.ts          # 下载器
│   │   │   ├── executor.ts            # 命令执行器
│   │   │   └── service.ts             # 服务层
│   │   ├── mcp/                       # MCP 配置管理
│   │   ├── scm/                       # 源码控制服务
│   │   ├── project/project-manager.ts # 项目管理
│   │   ├── plugins/                   # 插件加载与目录
│   │   ├── plugin-adapters/           # 插件适配器
│   │   ├── terminal/                  # PTY 终端管理
│   │   ├── env/                       # 环境配置管理
│   │   ├── credentials/               # 凭据管理
│   │   ├── regression/                # 回归测试管理
│   │   └── ipc/electron-trpc-bridge.ts# tRPC ↔ Electron 桥接
│   ├── preload/                       # Preload 脚本 (CJS)
│   │   └── index.ts                   # contextBridge：tRPC + windowControls + eventBridge
│   ├── renderer/                      # 渲染进程 (React SPA)
│   │   └── src/
│   │       ├── App.tsx                # 根组件
│   │       ├── components/            # UI 组件
│   │       │   ├── layout/            # 布局组件
│   │       │   │   ├── AppShell.tsx   # 三栏 + TitleBar + OptionDock
│   │       │   │   ├── LeftRail.tsx   # 左栏：文件树 / 用例树 / Dashboard
│   │       │   │   ├── CenterArea.tsx # 中栏：终端 / AI产物 / 文件 / DiffReview
│   │       │   │   ├── RightPanel.tsx # 右栏：AI Agent 会话
│   │       │   │   ├── BottomPanel.tsx# 底部面板（终端/仿真选项）
│   │       │   │   ├── ResizeHandle.tsx # 面板宽度拖拽调节
│   │       │   │   ├── CommandPalette.tsx # 命令面板
│   │       │   │   ├── ComposerEditor.tsx # 编辑器组合
│   │       │   │   └── OptionDock.tsx # 底部仿真选项浮窗
│   │       │   ├── dashboard/         # 仪表盘（8+ 标签页）
│   │       │   ├── coverage/          # 覆盖率面板（含闭合详情/排除建议）
│   │       │   ├── timing-violation/  # 时序违例面板（9 个组件）
│   │       │   ├── kb/                # 知识库面板
│   │       │   ├── drawio/            # Draw.io 预览/编辑
│   │       │   ├── chat/              # AI 对话组件（Markdown/Mermaid/ToolCard）
│   │       │   ├── env/               # 环境向导
│   │       │   ├── regression/        # 回归面板
│   │       │   ├── terminal/          # 终端视图
│   │       │   ├── to/                # TO 检查清单
│   │       │   ├── diff-review/       # Diff Review 组件
│   │       │   ├── settings/          # 设置面板（含 KB 设置）
│   │       │   ├── plugins/           # 插件管理
│   │       │   ├── browser/           # 浏览器组件
│   │       │   ├── office/            # 文档预览（PDF/HTML/Office/xlsx）
│   │       │   ├── scm/               # 源码控制面板
│   │       │   ├── project/           # 文件树/子系统列表
│   │       │   ├── surface/           # Surface 视图层
│   │       │   ├── db/                # 数据库查看器
│   │       │   ├── editor/            # 文件编辑器 / Diff Review
│   │       │   └── ui/                # shadcn/ui 组件
│   │       ├── stores/                # Zustand stores（25 个）
│   │       │   ├── ui.ts              # 面板折叠 / 宽度 / 设置面板
│   │       │   ├── theme.ts           # 主题状态（4 套主题）
│   │       │   ├── font.ts            # 字体管理（UI/代码字体/字号）
│   │       │   ├── session.ts         # AI 会话管理
│   │       │   ├── project.ts         # 项目状态
│   │       │   ├── simulation.ts      # 仿真状态
│   │       │   ├── terminal.ts        # 终端状态
│   │       │   ├── diff-review.ts     # Diff Review 队列
│   │       │   ├── coverage.ts        # 覆盖率数据
│   │       │   ├── regression.ts      # 回归状态
│   │       │   ├── dashboard.ts       # 仪表盘数据
│   │       │   ├── timing-violation.ts # 时序违例状态
│   │       │   ├── to-checklist.ts    # TO 检查清单
│   │       │   ├── task.ts            # 后台任务面板
│   │       │   ├── todo-panel.ts      # Todo 面板折叠状态
│   │       │   ├── settings.ts        # 应用设置
│   │       │   ├── env.ts             # 环境配置
│   │       │   ├── toast.ts           # 消息提示
│   │       │   ├── source-control.ts  # 源码控制状态
│   │       │   ├── overview.ts        # 项目概览
│   │       │   ├── workbench.ts       # 工作区状态
│   │       │   ├── bookmarks.ts       # 书签管理
│   │       │   ├── browser.ts         # 浏览器状态
│   │       │   ├── kb.ts              # 知识库状态
│   │       │   └── sysbase-gen.ts     # 环境生成器状态
│   │       ├── lib/                   # tRPC 客户端、工具函数
│   │       └── styles/globals.css     # 全局样式 + 4 套主题
│   └── shared/                        # 主↔渲染共享类型
│       ├── types.ts                   # 通用类型定义
│       ├── plugin-types.ts            # 插件接口契约（6 种 PluginKind）
│       └── kb-types.ts                # 知识库跨进程共享类型
├── engine/oh-my-pi/                   # omp 引擎 (git submodule，仅重编 runner 需要)
├── plugins/                           # 内置插件
│   ├── sdk/                           # 插件 SDK（类型定义 + 运行时）
│   ├── builtin-coverage-parser/       # 内置覆盖率解析插件
│   ├── unisoc-subsys-discoverer/      # Unisoc 子系统发现
│   ├── unisoc-case-parser/            # Unisoc 用例解析
│   ├── unisoc-simulation-runner/      # Unisoc 仿真执行
│   └── unisoc-sim-option-schema/      # Unisoc 仿真选项 Schema
├── tests/                             # Vitest 测试（~150 个测试文件）
├── docs/                              # PRD、issues、ADR 文档
├── resources/binaries/                # omp/bun/drawio 预编译二进制
├── electron.vite.config.ts            # 三进程构建配置
├── electron-builder.yml               # 打包配置
└── package.json
```

## 架构设计

### 三进程模型

| 进程 | 目录 | 构建产物 | 职责 |
|------|------|----------|------|
| 主进程 | `src/main/` | CJS | 窗口管理、omp 子进程、tRPC router、IPC |
| Preload | `src/preload/` | CJS | contextBridge：tRPC 桥接 + 窗口控制 + 事件总线 |
| 渲染进程 | `src/renderer/` | ESM | React SPA，通过 tRPC proxy 调用主进程 API |

### tRPC API

| 路由 | 说明 |
|------|------|
| `ping` / `version` / `system` / `scm` | 健康检查、版本信息、Agent 运行时解析、源码控制状态/提交/推送 |
| `project` | 项目 CRUD、文件树（懒加载）、文件读写、子系统/用例发现、插件管理、搜索 |
| `session` | AI 会话创建/发送/中止/销毁、模型切换、技能发现、上下文管理、事件流 |
| `simulation` | 仿真运行/状态/编译错误/中止/历史/详情/对比/终端仿真 |
| `terminal` | 终端创建/写入/调整大小/销毁/列表/输出缓冲 |
| `env` | EDA 工具检测、环境变量配置 |
| `coverage` | 覆盖率总览/分子系统/趋势/导出/Closure 闭合 |
| `regression` | 回归套件创建/列表/执行/取消/结果 |
| `dashboard` | 项目指标总览（8+ 图表聚合查询） |
| `to` | TO 检查清单管理 |
| `settings` | 凭据管理、应用设置、MCP 配置、系统 Prompt、主题/字体持久化 |
| `search` | 全局搜索（仿真历史 / 回归套件） |
| `diff-review` | Diff 获取、拒绝应用 |
| `errorAnalysis` | 错误分析会话管理、日志读取 |
| `violation` / `confirmation` / `pattern` | 时序违例查询/解析/统计、确认工作流、Pattern 管理 |
| `scan` | 环境扫描缓存 |
| `document` | Office/PDF 文档预览/编辑 |
| `tools` | 18 个内建工具路由 |
| `browser` | In-app 浏览器管理、书签 |
| `database` | SQLite 数据库查看 |
| `kb` | 知识库管理（挂载/索引/搜索/配置） |
| `drawio` | Draw.io 预览/导出 |

### 关键机制

**无边框窗口** — `frame: false` + 自定义 TitleBar（拖拽区域、面板折叠、主题切换、窗口控制）。

**主题系统** — 4 套主题（Drafting 暖纸白底 / Bench 暖深底磷光绿 / Slate 冷石板底铜色 / Daylight 极浅灰白靛蓝），通过 CSS 变量 + `data-theme` 属性实现，持久化到 `localStorage` 和主进程文件级存储（双写防丢失），含旧 6 主题 ID 迁移映射。

**字体管理** — UI 字体与代码字体独立配置，4 档字号预设（sm/md/lg/xl），CSP 策略下仅使用系统已安装字体。

**omp 集成** — AI Agent 通过 `socverify-runner` JSONL 子进程通信，`SessionManager` 管理多会话（并发上限 10），支持预编译 runner 和 Bun + engine submodule 两种启动方式，同时可对接第三方 OpenAI 兼容 LLM 服务。

**插件系统** — 6 种 `PluginKind`（case-parser / subsys-discoverer / coverage-parser / simulation-runner / sim-option-schema / ui），从内置包、`~/.socverify/plugins` 和项目配置发现，通过设置中的插件管理页重载、启停和打开视图。内置插件 SDK 提供类型定义和运行时支持。

**Host Tools** — 25 个 AI Host Tools 分 3 层注册：
- 默认工具（17 个）：8 个仿真/用例工具 + 5 个文档创建工具 + 2 个 xlsx 编辑工具 + 2 个知识库工具
- 条件工具（8 个）：4 个覆盖率深度分析工具（CoverageManager 注入时注册）+ 2 个用例统计工具（CaseStatsService 注入时注册）+ 2 个上下文工具（discovery 注入时注册）

**Host URI Scheme** — `case:///` / `log:///` / `cov:///` 三种 URI scheme，供 AI Agent 按需读取用例、日志和覆盖率数据。

**Diff Review** — AI Agent 代码改动逐块审阅：hunk accept/reject、before reconstruction 重建修改前状态、overwritten hunk 检测、全局 Review Queue 跨会话聚合。

**自动错误分析** — 仿真失败自动触发 AI 分析：compile_error 自动修复并重试（最大 3 次），sim_error 仅给建议。

**用例数据库** — SQLite 单一数据源（`.socverify/cases.db`），Case Scanner 后台增量扫描更新，Dashboard 和 AI Agent 统一从 DB 读取。

**时序违例闭环** — Regression Scan → Parsed Violations → Pattern Match → AI Confirmation Suggestion → Manual Confirmation，支持精确与模糊 Pattern 匹配，Worker 线程解析保证 UI 不阻塞。

**AI 覆盖率闭合** — Closure Orchestrator 编排闭合迭代流程，Recovery 机制支持中断后恢复续作，AI 排除建议链提供智能 exclusion 推荐。

**知识库** — 多格式文档（docx/pdf/xlsx/pptx 等）通过双转换引擎（anydoc + markitdown）转 Markdown 入库，支持跨知识库全文检索，KB AI 模型可独立配置（ADR 0021 + ADR 0022）。

**Dashboard 架构** — 8+ 图表标签页，全量基于 Case Database SQL 聚合查询，ECharts 渲染，支持时间范围过滤和自动刷新。

**Draw.io 集成** — 内置 draw.io desktop CLI，Linux 平台打包内置二进制（无需联网安装），Windows/macOS 回退到本机安装路径，支持流程图预览和 PNG/SVG 导出。

## 开发

### 环境要求

- Node.js 22+
- npm 10+
- Windows 10/11（主要平台），macOS / Linux 理论支持

### 快速开始

```sh
# 安装依赖（自动下载预编译 runner）
npm install

# 启动开发模式
npm run dev
```

`npm install` 会自动尝试从 GitHub Release 下载当前平台的 `socverify-runner` 到 `resources/binaries/`。只有需要本地重编 runner 时，才执行：

```sh
git submodule update --init --recursive
cd engine/oh-my-pi && bun install
cd ../..
npm run build:runner
```

### 开发命令

```sh
npm run dev          # 启动开发模式（electron-vite dev）
npm run build        # 构建产物（main + preload + renderer）
npm run preview      # 构建后预览
npm run lint         # ESLint 检查
npm run test         # 运行 Vitest 测试
npm run test:watch   # 测试监听模式
npm run typecheck    # TypeScript 类型检查（tsconfig.node + tsconfig.web）
npm run package:win  # 打包 Windows NSIS 安装包
npm run package:linux # 打包 Linux AppImage
```

### 修改后验证

每次修改代码后，执行**增量验证**，通过即可提交，无需跑全量测试：

```sh
npm run typecheck                 # 类型检查（tsconfig.node + tsconfig.web）
npm run lint                      # ESLint
npx vitest run tests/<相关目录>     # 仅运行改动相关的测试目录
```

- 测试范围按改动确定：改 `src/main/coverage/` → 跑 `tests/coverage/`；改 `src/renderer/src/components/coverage/` → 跑 `tests/ui/coverage*.test.tsx`，以此类推。
- 无测试文件的改动可跳过测试步骤，仅跑 typecheck + lint。
- 任一失败则修复后重新执行这三条。

## 打包

打包脚本会强制检查 `resources/binaries/` 中存在预编译 runner，避免生成没有 AI Agent 的安装包：

```sh
npm run package:win    # Windows NSIS 安装包
npm run package:linux  # Linux AppImage（含 drawio 内置二进制）
```

打包配置见 `electron-builder.yml`。Windows 打包使用 `compression: store` 优先减少本地打包时间，代价是安装包体积会更大。Linux 打包含 drawio desktop AppImage 解压到 `resources/binaries/`。

## 布局

经典三栏 + 底部仿真选项浮窗：

```
┌──────────────────────────────────────────────────────┐
│                    TitleBar                           │
├──────────┬───────────────────────────┬───────────────┤
│          │                           │               │
│  LeftRail│      CenterArea           │  RightPanel   │
│          │                           │               │
│ 文件树    │  终端 / AI产物 / 文件编辑  │  AI Agent 会话 │
│ 用例树    │                           │  后台任务      │
│ Dashboard│                           │               │
│          │                           │               │
├──────────┴───────────────────────────┴───────────────┤
│                  OptionDock (仿真选项浮窗)             │
└──────────────────────────────────────────────────────┘
```

## 里程碑

| 里程碑 | 状态 | 内容 |
|--------|------|------|
| M0 | ✅ 完成 | 项目脚手架（Electron 43 + React 19 + TS 6 + Tailwind v4 + shadcn/ui） |
| M1 | ✅ 完成 | omp RPC 核心（JSONL 客户端、会话管理、Host Tools/URI） |
| M2 | ✅ 完成 | 项目管理 / 插件系统 / 子系统发现 / AI Chat UI |
| M3 | ✅ 完成 | 仿真执行 / 仿真选项 UI / 终端集成 |
| M4 | ✅ 完成 | AI 多会话 / 流式消息 / 高级功能 / 任务管理 |
| M5 | ✅ 完成 | 环境配置向导 / 覆盖率分析 / 覆盖率可视化 |
| M6 | ✅ 完成 | 仪表盘 / TO 检查清单 / 回归测试 |
| M7 | ✅ 完成 | 技能发现 / 会话持久化 / 凭据管理 / 源码控制 / 打磨 |
| M8 | ✅ 完成 | Diff Review 系统 / 自动错误分析 / 终端仿真执行 / Unisoc 插件集 |
| M9 | ✅ 完成 | 时序违例管理（解析/确认/Pattern/AI Advisor）/ Case Database / 仪表盘重构 |
| M10 | ✅ 完成 | 18 内建工具 / In-app 浏览器 / Document 预览 / Surface View Manager / MCP 配置 / Draw.io 集成 |
| M11 | ✅ 完成 | 知识库（anydoc + markitdown 双引擎）/ AI 覆盖率闭合 / Sysbase Gen 环境生成器 / Draw.io 集成 / 文件树懒加载 |

## 文档

- [PRD (M2-M10)](./docs/prd-m2-m7.md) — 产品需求文档
- [PRD (Case Database)](./docs/prd-case-database.md) — 用例数据库产品需求文档
- [PRD (Coverage Analysis)](./docs/prd-coverage-analysis.md) — 覆盖率分析产品需求文档
- [PRD (Dashboard)](./docs/prd-dashboard.md) — 仪表盘产品需求文档
- [PRD (Timing Violation)](./docs/prd-timing-violation.md) — 时序违例产品需求文档
- [PRD (AI Coverage Closure)](./docs/prd-ai-coverage-closure.md) — AI 覆盖率闭合产品需求文档
- [PRD (In-app Browser)](./docs/prd-in-app-browser.md) — 浏览器产品需求文档
- [PRD (Knowledge Base)](./docs/prd-knowledge-base.md) — 知识库产品需求文档
- [PRD (Officecli Integration)](./docs/prd-officecli-integration.md) — officecli 集成产品需求文档
- [PRD (Sysbase Env Generator)](./docs/prd-sysbase-env-generator.md) — 环境生成器产品需求文档
- [Issues (M2-M10)](./docs/issues-m2-m7.md) — 垂直切片 Issue
- [Plugin Development Guide](./docs/plugin-development.md) — 插件开发指南
- [TraceWeave Usage Manual](./docs/traceweave-usage-manual.md) — TraceWeave 使用手册
- [CHANGELOG](./CHANGELOG.md) — 变更日志
- [Release Notes](./release-notes/) — 各版本发布说明
- [CONTEXT.md](./CONTEXT.md) — 领域术语与统一语言
- [AGENTS.md](./AGENTS.md) — AI 编码助手项目指南
- [ADR 系列](./docs/adr/) — 架构决策记录（0001-0026 + glossary）

## 贡献

欢迎提交 Issue 和 Pull Request。

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交改动 (`git commit -m 'feat: add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 提交 Pull Request

**开发规范：**
- TypeScript strict 模式，不使用 `any`（除非有注释说明）
- 优先使用 `type` 而非 `interface`；函数式风格优先
- 文件命名：kebab-case（非组件）/ PascalCase（React 组件）
- Zustand 选择器：`useStore((s) => s.field)`
- 样式：Tailwind v4 + `cn()`；语义色用 CSS 变量（HSL），不直接用 hex
- 修改后必须通过增量验证：`typecheck` + `lint` + 相关测试

## License

MIT License — © 2026 hjdspace