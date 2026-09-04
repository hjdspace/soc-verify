# 内嵌 runner 二进制 + native addon

`npm install` 会通过 `scripts/setup-agent.mjs` 自动尝试从 GitHub Release 下载当前平台的 runner：

- Windows: `socverify-runner.exe`
- Linux/macOS: `socverify-runner`

`npm run build:runner` 编译 runner 二进制，`npm run download:natives` 提取 pi_natives 原生插件。

## 为什么需要单独提取 native addon？

`socverify-runner` 通过 `bun build --compile` 编译，它将所有 JS/TS 代码打包进单个可执行文件。
然而，**原生插件（`.node` 文件）无法被嵌入编译后的二进制**——因为构建 native addon 需要
Rust nightly 工具链，而该工具链版本已被 Rust 官方撤回。

omp 引擎依赖的 `pi_natives` 是 Rust 编译的原生插件，必须在运行时从文件系统加载。

### 提取流程

`scripts/download-natives.mjs` 脚本（已优化）：

1. 从 `engine/oh-my-pi/packages/natives/package.json` 读取 omp 版本
2. 检查 `.natives-version` 文件，如果版本匹配则跳过（避免重复下载）
3. 下载匹配版本的完整 omp 二进制（如 `omp-windows-x64.exe`，~155MB）到 `.cache/omp/` 缓存目录
4. **直接从二进制中提取 `.node` 文件**（优先方法，比运行二进制更快）
5. 如果直接提取失败，运行 omp 二进制触发 native addon 提取到 `~/.omp/natives/<version>/`（回退方法）
6. 复制提取出的 `.node` 文件到 `resources/binaries/`
7. 写入 `.natives-version` 文件记录版本

**x64 平台只提取 baseline 变体**（适用于所有 x64 CPU，避免了 AVX2/Modern 变体导致的重复下载问题）。

### 运行时加载

runner 启动时，omp 引擎的 loader（`loader-state.js`）在以下路径搜索 native addon：

1. `~/.omp/natives/<version>/` — omp 默认缓存目录
2. `<安装目录>/resources/binaries/` — 应用打包目录（即此目录）← 关键
3. Bun 临时解压目录

将 `.node` 文件放在 `resources/binaries/` 中，打包后 runner 即可在路径 2 找到它。

### 优化

- **缓存机制**：omp 二进制缓存在 `.cache/omp/` 中，避免重复下载 155MB 文件
- **直接提取**：直接从二进制提取，比运行二进制更快（无进程启动开销）
- **版本追踪**：`.natives-version` 文件记录提取的版本，子模块更新后自动重新提取
- **baseline 变体**：x64 平台只要求 baseline 变体，兼容所有 CPU 并避免重复下载

## RTL 三工具（download:rtl-tools）

`npm run download:rtl-tools` 下载 Design View 依赖的三个 RTL 工具（版本锁定在 package.json），
**按当前平台（Windows / Linux）自动选择对应资产**。SoC 验证主战场是 Linux，两平台均在分发范围；
macOS 不在范围（脚本在非 win/linux 平台跳过）。

| 工具 | 来源 | 版本字段 | Windows 产物 | Linux 产物 |
|------|------|----------|--------------|------------|
| yosys | OSS CAD Suite tgz（选择性提取，非全量 568MB） | `ossCadSuiteVersion`（release 日期） | `yosys/yosys.exe` + `share/yosys/` + 8 DLL（≈70MB） | `yosys/yosys` + `share/yosys/`（ELF，链接系统库） |
| slang-server | hudson-trading/slang-server Releases | `slangServerVersion` | `slang-server/slang-server.exe`（windows-x64.zip） | `slang-server/slang-server`（linux-x64.tar.gz） |
| verible | chipsalliance/verible Releases | `veribleVersion` | `verible/verible-verilog-{lint,format}.exe`（win64.zip） | `verible/verible-verilog-{lint,format}`（linux-static-x86_64.tar.gz，静态链接零依赖） |

**平台差异要点**：

- **Windows**：yosys.exe 的 8 个依赖 DLL（libstdc++-6 / libgcc_s_seh-1 / libwinpthread-1 / libffi-8 /
  libreadline8 / libtermcap-0 / tcl86 / zlib1）**必须与 yosys.exe 同目录**——S0 实测 PATH 方式不生效。
  `binary.ts` 的 `yosysMissingDlls()` 校验此布局。
- **Linux**：yosys 是 ELF，链接系统库，**无同目录 DLL 布局要求**（`yosysMissingDlls()` 在非 win32 恒返回空）。
  运行依赖 OSS CAD Suite 官方要求的系统库：`libtinfo`、`libffi`、`libz`（主流发行版一般自带，缺失时 yosys 启动报错）。
  verible Linux 版为静态链接，无运行时依赖。slang-server Linux 版为单 ELF。

**通用**：

- 归档缓存在 `.cache/rtl-tools/`；离线网络可将对应平台归档（文件名与 GitHub 资产名一致）手动放入后重跑（已放置则跳过下载）。
- 镜像：`--mirror <base>`（ghproxy 风格前缀）或 `--yosys-url/--slang-url/--verible-url` 单独覆盖。
- 下载失败不阻断构建；运行时 `src/main/rtl/binary.ts` 解析路径并给出可用性状态（`trpc.rtl.toolsStatus`）。

**版本升级验证点**（改 package.json 三个版本字段后必查）：

1. `yosys -p "help read_slang"` 帮助中 `--keep-hierarchy` 仍存在（elaboration 硬性要求，S0 实测不加会 flatten 整个设计）；
2. **Windows**：yosys.exe 的 DLL 依赖集不变（当前 8 个，用 `pe-imports` 类工具核对；变化则同步更新 download-rtl-tools.mjs 的 `YOSYS_DLLS` 与 binary.ts）；
3. **Linux**：`ldd yosys` 无 `not found`（系统库依赖满足）+ slang-server / verible 的 Linux 资产名不变（`slang-server-linux-x64.tar.gz` / `verible-<tag>-linux-static-x86_64.tar.gz`）。

## 打包行为

`electron-builder.yml` 已配置 `extraResources` 将本目录（排除 README.md）内嵌到安装包 `resources/binaries`，
并 `asarUnpack` 以便子进程直接执行和加载。`engine/oh-my-pi` 不随桌面安装包打包。

> 历史说明：早期版本曾内置 draw.io desktop CLI（`drawio-linux-<arch>/`）用于 .drawio 导出，
> 现已移除——导出改由包内 `viewer-static.min.js` 隐藏窗口渲染实现（`src/main/drawio/viewer-exporter.ts`），
> 不依赖 draw.io Desktop，安装包体积显著减小。
