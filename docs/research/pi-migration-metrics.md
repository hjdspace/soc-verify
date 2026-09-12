# pi 引擎迁移 — 迁移前后指标对比（issue 10 验收项 5）

> 对应 issue 10：「记录并比较迁移前后的安装包大小、安装后占用、runner 启动时间、首 token 延迟和稳态内存。」
>
> 数据来源：
> - **omp 基线**：`docs/adr/0033-omp-to-pi-engine-migration.md`（产物字节级记录）与 `docs/research/pi-runtime-spike-report.md`。omp 时代未建立启动时间 / 首 token / 内存的量化基线（无历史测量记录），相关行如实标注。
> - **pi 实测**：spike 报告（win32-x64，Electron 43.1.0 / Node 24.18.0）+ 本次迁移收口时的载荷门禁实测（`scripts/engine-payload-gate.mjs`，报告见 `dist/engine-payload-report.json`）。
> - **载荷裁剪**：`scripts/prepare-runner-deps.mjs` 在 `npm ci` 后执行 prune（sourcemap / recheck-jar / docs / examples / 非合规 Markdown），2026-09-12 实测裁掉 101.8 MB。

## 1. AI 引擎载荷

| 项 | omp（迁移前） | pi（迁移后） | 变化 |
|---|---|---|---|
| 载荷构成 | Bun `--compile` 单文件 `socverify-runner.exe`（124,960,256 B）+ `pi_natives.win32-x64-baseline.node`（155,966,464 B） | `runner-pi/*.ts` 源脚本 + `runner-pi/node_modules`（npm ci 精确 lockfile + prune） | 构成从「单文件二进制 + native addon」变为「普通 Node 脚本 + 生产依赖树」 |
| 合计 | **268 MiB**（280,926,720 B，见 ADR 0033） | **188.3 MB / 24,292 files**（门禁实测，prune 后） | **≈ −32%**（−92 MB 直接替换口径） |
| 冗余能力 | 内含 LSP / DAP / browser / IRC-collab / memory 等产品未用能力 | 仅含 spec 要求的 provider / MCP / subagent / skills 运行时 | 移除 |

### < 30 MB 目标判定：**未达成（记录构成、原因与收益并停止无条件发布）**

按 issue 10 验收项 4，未达标时记录构成、原因和收益并停止无条件发布：

- **构成**（门禁实测 top-level，win32-x64，prune 后）：

  | 构成 | 大小 | 性质 |
  |---|---|---|
  | @earendil-works（pi 内核：pi-coding-agent / pi-ai / pi-tui / pi-agent-core） | 75.7 MB | 运行时必需（引擎本体 + 内置扩展） |
  | recheck-windows-x64 | 27.4 MB | 运行时必需（adapter ReDoS 校验器的 win32 原生二进制） |
  | @esbuild | 11.1 MB | 运行时必需（扩展 TS 运行时编译） |
  | Provider SDK（@modelcontextprotocol 7.0 + openai 6.8 + @google 6.6 + @anthropic-ai 6.1） | ≈ 26.5 MB | spec 要求 provider 能力完整 |
  | zod 5.8 + pi-subagents 5.7 + recheck(JS) 5.5 + 长尾 | ≈ 62 MB | 传递依赖 |

- **原因**：pi 内核 0.85.1 自带多 provider SDK 与 MCP / 扩展运行时，30 MB 仅够内核本体的一部分；spec 要求 provider 能力完整（openai / anthropic / google 等），provider SDK 与 esbuild 平台二进制不可裁剪。**已执行的裁剪**（prune 步骤，−101.8 MB）：`*.map` sourcemap、`recheck-jar/`（JVM 后端，Node/Windows 走 recheck.exe，运行时 resolve 失败安全降级已确认）、各包 `docs/`、`examples/`、非合规 Markdown（保留 LICENSE/NOTICE）。
- **收益**：相对 omp 268 MiB → 188.3 MB（**−32%**），且获得普通 Node 分发、无 Bun 构建链、无 submodule、无 native addon、无单文件反编译难题；后续减重候选：esbuild bundle 依赖树（预估可至 60–100 MB，−50%+）。
- **处置**：发布门禁已接入打包链（`npm run package` / `package:win` / `package:linux` 在 `prepare-runner-deps` 后、electron-builder 前执行），默认 30 MB 阈值 FAIL 即中断打包，阻止无条件发布；每版发布需 `SOCVERIFY_ACK_ENGINE_PAYLOAD=1` 显式确认，报告 JSON（`dist/engine-payload-report.json`）记录构成供逐版重新评估；禁含产物（omp 残留 / Bun runner / native addon / 旧 runner）不可 ack，门禁实测为零。

## 2. 安装包大小与安装后占用

| 项 | omp（迁移前） | pi（迁移后） |
|---|---|---|
| 安装包（NSIS） | 迁移前版本 v0.4.x 的实测值未纳入本报告（发布产物未留存于仓库） | 待下一次发布实测（runner 载荷减少 ≈ 268 MiB → 载荷实测值，主进程 asar 同步移除 omp 兼容代码） |
| 安装后占用 | 同上 | 同上（安装后占用 = 安装包 + 解压差值，as installed 与安装包近似同趋势） |

> 说明：仓库内可复现的对比口径是**引擎载荷**（第 1 节，字节级）；安装包级数据依赖发布产物，自 pi 迁移后的首个 release 起按同一口径补记。载荷的减少（−268 MiB + runner-deps 实测）会 1:1 传导到安装包与安装后占用。

## 3. runner 启动时间

| 指标 | omp（迁移前） | pi（迁移后，spike 实测） |
|---|---|---|
| 进程冷启动 → ready | 无量化基线（历史未记录） | SDK import 0.9s（热）～ 2.0s（冷）；`createAgentSession` 145–252ms |
| 扩展冷编译 | 不适用（omp 原生打包） | 冷 14.2s / 热 1.47s（jiti + pi 内置 esbuild 编译缓存，仅首次） |
| 运行时复用 | 独立 Bun 二进制 | `ELECTRON_RUN_AS_NODE=1` 复用 Electron Node 24.18.0，SDK 导入快于系统 Node 的 1.5–2.0s |

## 4. 首 token 延迟

| 指标 | omp（迁移前） | pi（迁移后，spike 实测） |
|---|---|---|
| 首 token | 无量化基线（历史未记录） | **2690ms**（真实调用，openrouter/free；以网络 RTT 为主，引擎侧开销占比小） |
| 首轮完整回复 | — | 2906ms（`message_update/text_delta` + `message_end.usage` 事件流正常） |

> 引擎侧可比口径：事件流（`text_delta` 首 chunk）延迟主要由 provider RTT 决定，两代引擎差异淹没在网络方差内；pi 侧新增的扩展热编译缓存（1.47s）只影响首个会话的工具面注册，不影响首 token。

## 5. 稳态内存

| 指标 | omp（迁移前） | pi（迁移后，spike 实测） |
|---|---|---|
| 稳态 RSS | 无量化基线（历史未记录） | 119–146 MB（会话构造后，win32-x64） |

## 6. 打包链与发布门禁（结构变化）

| 项 | 迁移前 | 迁移后 |
|---|---|---|
| 构建链 | Bun `--compile`（scripts/build-runner.mjs + compile-runner.ts）+ native addon 下载（download-natives.mjs） | 无编译：`runner-pi/*.ts` 直接分发，`ELECTRON_RUN_AS_NODE=1` 运行 |
| 依赖治理 | omp submodule（指针升级）+ Bun 版本检查 | `resources/runner-deps/package.json` + `package-lock.json`（精确版本），`npm ci --omit=dev --ignore-scripts` + prune（sourcemap / recheck-jar / docs / examples / 非合规 Markdown），`scripts/prepare-runner-deps.mjs` |
| 分发 | `resources/binaries/socverify-runner.exe` + `pi_natives.*.node`（asarUnpack） | extraResources：`runner-pi/`（脚本）+ `runner-pi/node_modules`（依赖载荷） |
| 发布门禁 | 无 | `scripts/engine-payload-gate.mjs`（已接入 package/package:win/package:linux 打包链）：载荷构成统计 + 禁含产物扫描（socverify-runner* / pi_natives* / bun|bunx / oh-my-pi，不可 ack）+ 30 MB 阈值（超限需 `SOCVERIFY_ACK_ENGINE_PAYLOAD=1`，未 ack 直接中断打包），报告写 `dist/engine-payload-report.json` |
| 前置校验 | setup-agent 下载/校验二进制 | `setup-agent.mjs --require-runner` 校验 runner 脚本与 node_modules 依赖在位 |

## 7. 结论

1. **载荷**：268 MiB → **188.3 MB**（门禁实测，含 prune −101.8 MB），**−32%**；30 MB 目标按 spec 流程记录构成/原因/收益后停止无条件发布，发布需 `SOCVERIFY_ACK_ENGINE_PAYLOAD=1`，后续以 esbuild bundle 作为减重候选。
2. **性能**：pi 侧启动（SDK 0.9–2.0s + 会话 145–252ms）与首 token（2690ms，RTT 主导）、稳态内存（119–146 MB）均可用；omp 侧无历史量化基线，故本报告以「pi 实测 + 结构对比」为准。
3. **可复现性**：精确版本 + lockfile + `npm ci` + 发布门禁，替代 omp submodule 指针升级。
