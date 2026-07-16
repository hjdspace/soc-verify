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

## 打包行为

`electron-builder.yml` 已配置 `extraResources` 将本目录（排除 README.md）内嵌到安装包 `resources/binaries`，
并 `asarUnpack` 以便子进程直接执行和加载。`engine/oh-my-pi` 不随桌面安装包打包。
