# VS Code 的 Linux `node-pty` 构建方式与 CentOS 8 兼容性

研究日期：2026-08-07

固定上游版本：

- VS Code：[`c422acaa84f1992f3e27cc675aca594db0ec647a`](https://github.com/microsoft/vscode/tree/c422acaa84f1992f3e27cc675aca594db0ec647a)
- `microsoft/node-pty`：[`8f218f6c194be81d98b1eeea344b150e83445824`](https://github.com/microsoft/node-pty/tree/8f218f6c194be81d98b1eeea344b150e83445824)，即 tag [`v1.2.0-beta.15`](https://github.com/microsoft/node-pty/releases/tag/v1.2.0-beta.15)
- Electron 43.1.0 文档：[`b5c102b3f0f7e9c5be064ba337a3547a83cf7d09`](https://github.com/electron/electron/tree/b5c102b3f0f7e9c5be064ba337a3547a83cf7d09)

## 结论

VS Code 没有另一套能够绕过 Linux 原生依赖的终端实现。桌面终端同样调用 `node-pty` 的 `spawn`，只是把 PTY 服务放在独立 Electron utility process 中。它能在较老 Linux 上工作的核心不是运行时 fallback，而是发布工程：

1. 针对实际运行时重新编译原生模块。桌面客户端以 Electron headers/runtime 为目标，remote server 以其内置 Node 为目标。
2. Linux 构建使用固定 `glibc 2.28` sysroot，而不是直接继承 Ubuntu 22.04 构建机的 libc/C++ ABI。
3. 发布前检查所有 `.node` 文件的 `GLIBC_*` 和 `GLIBCXX_*` 符号版本。
4. ASAR 中显式 unpack `.node` 和 `node-pty/build/Release`，但继续使用上游 loader；ASAR 路径补丁不是兼容旧 Linux 的关键。

对 SoC Verify，推荐的根治方案是：**为 Electron 43.1.0 在 `glibc 2.28 + GCC 10.5` sysroot 中构建 `node-pty`，把符号版本检查和 CentOS/RHEL 8 运行冒烟测试设为 AppImage 发布硬门禁。** 仅在 Ubuntu Docker 中执行 `@electron/rebuild` 只能解决 Electron ABI，不保证 CentOS 8 的 glibc/glibcxx 兼容性。

VS Code 官方的当前 Linux 要求也印证了这个基线：支持 Red Hat Enterprise Linux 8，并要求 `GLIBC >= 2.28` 和 `GLIBCXX >= 3.4.25`：[VS Code 官方需求](https://github.com/microsoft/vscode-docs/blob/74f6c45c91823e59b72d0a60787fccf482900023/docs/supporting/requirements.md#L25-L44)。这是 RHEL 8 的支持声明，不是对所有 CentOS 8 图形环境的单独认证；但对本次 `pty.node` 的 ELF 基线选择有直接参考价值。

## 确定事实

### 1. VS Code 使用的仍然是 `node-pty`

- `[事实]` VS Code 的 `terminalProcess.ts` 直接从 `node-pty` 导入 `spawn` 和 `IPty`，不是自研 Linux PTY binding：[源码](https://github.com/microsoft/vscode/blob/c422acaa84f1992f3e27cc675aca594db0ec647a/src/vs/platform/terminal/node/terminalProcess.ts#L22)。
- `[事实]` PTY host 在独立 utility process 中启动并通过 message port 通信：[electronPtyHostStarter.ts](https://github.com/microsoft/vscode/blob/c422acaa84f1992f3e27cc675aca594db0ec647a/src/vs/platform/terminal/electron-main/electronPtyHostStarter.ts#L50-L82)、[ptyHostMain.ts](https://github.com/microsoft/vscode/blob/c422acaa84f1992f3e27cc675aca594db0ec647a/src/vs/platform/terminal/node/ptyHostMain.ts#L52-L92)。
- `[事实]` 研究版本的 VS Code 锁定 `node-pty ^1.2.0-beta.15` 和 Electron `42.8.0`：[package.json](https://github.com/microsoft/vscode/blob/c422acaa84f1992f3e27cc675aca594db0ec647a/package.json#L156-L220)。SoC Verify 截图中的 Electron 是 `43.1.0`，因此不能直接复用 VS Code 42 的二进制。

独立 PTY host 能隔离 crash、阻塞和生命周期问题，但不会改变 ELF 动态库需求，也不会让为新 glibc 编译的 `.node` 在旧 glibc 上自动可用。

### 2. VS Code 分开处理 Electron ABI 和 Node ABI

- `[事实]` VS Code 桌面根目录 `.npmrc` 指定 Electron headers、`runtime="electron"`、`target="42.8.0"`，并强制 `build_from_source="true"`：[.npmrc](https://github.com/microsoft/vscode/blob/c422acaa84f1992f3e27cc675aca594db0ec647a/.npmrc#L1-L6)。
- `[事实]` remote server 的 `.npmrc` 则指定 Node `24.18.0` 和 `runtime="node"`：[remote/.npmrc](https://github.com/microsoft/vscode/blob/c422acaa84f1992f3e27cc675aca594db0ec647a/remote/.npmrc#L1-L5)。
- `[事实]` VS Code 安装脚本会把独立的 remote `CC/CXX/CXXFLAGS/LDFLAGS` 注入 remote 依赖安装：[postinstall.ts](https://github.com/microsoft/vscode/blob/c422acaa84f1992f3e27cc675aca594db0ec647a/build/npm/postinstall.ts#L276-L292)。
- `[事实]` Electron 官方说明其 ABI 与普通 Node 不同，原生模块通常应使用 `@electron/rebuild` 重新编译：[Electron 43.1.0 文档](https://github.com/electron/electron/blob/b5c102b3f0f7e9c5be064ba337a3547a83cf7d09/docs/tutorial/using-native-node-modules.md#L3-L37)。
- `[事实]` `node-pty` 使用 `node-addon-api`，并以 `NODE_API_MODULE` 注册：[package.json](https://github.com/microsoft/node-pty/blob/8f218f6c194be81d98b1eeea344b150e83445824/package.json#L42-L51)、[pty.cc](https://github.com/microsoft/node-pty/blob/8f218f6c194be81d98b1eeea344b150e83445824/src/unix/pty.cc#L876)。
- `[事实]` `node-pty` 的安装脚本本来会优先使用当前平台的 prebuild，但在 `npm_config_build_from_source=true` 时会删除整个 `prebuilds` 目录并转入 `node-gyp rebuild`：[package.json](https://github.com/microsoft/node-pty/blob/8f218f6c194be81d98b1eeea344b150e83445824/package.json#L38-L43)、[prebuild.js](https://github.com/microsoft/node-pty/blob/8f218f6c194be81d98b1eeea344b150e83445824/scripts/prebuild.js#L17-L31)。结合 VS Code 根目录 `.npmrc` 的 `build_from_source="true"`，可以确定 VS Code 桌面发布不是直接复用 npm 包中的 Linux prebuild，而是用自己的 Electron 目标和 sysroot 重编译。

`[建议]` 即使 N-API 降低了 Node module ABI 漂移风险，发布过程仍应像 VS Code 一样明确以目标 Electron 版本构建。不要把“Node ABI 148 相同”当作完整兼容性证明；Electron ABI、glibc、glibcxx 和 ASAR 都是独立维度。

### 3. Linux 可移植性的核心是 `glibc 2.28` sysroot

- `[事实]` `node-pty` Linux target 显式链接 `-lutil`，并支持从 `SYSROOT_PATH` 注入 sysroot、头文件和链接目录：[binding.gyp](https://github.com/microsoft/node-pty/blob/8f218f6c194be81d98b1eeea344b150e83445824/binding.gyp#L57-L124)。
- `[事实]` `node-pty` 官方 prebuild 流水线安装 GCC 10，然后下载 sysroot，并在 `npm ci` 时传入 `SYSROOT_PATH/CC/CXX`：[pipelines/build.yml](https://github.com/microsoft/node-pty/blob/8f218f6c194be81d98b1eeea344b150e83445824/pipelines/build.yml#L18-L46)。
- `[事实]` 该 sysroot 被固定为 `glibc-2.28-gcc-10.5.0`：[install-sysroot.js](https://github.com/microsoft/node-pty/blob/8f218f6c194be81d98b1eeea344b150e83445824/scripts/linux/install-sysroot.js#L91-L112)。
- `[事实]` `node-pty` CI 把期望值设为 `GLIBC_2.28`、`GLIBCXX_3.4.25`：[ci.yml](https://github.com/microsoft/node-pty/blob/8f218f6c194be81d98b1eeea344b150e83445824/.github/workflows/ci.yml#L76-L83)。检查脚本通过 `objdump -T` 扫描 `.node`；其中 GLIBC 超限会退出失败，GLIBCXX 超限目前只打印错误而没有 `exit 1`：[verify-glibc-requirements.sh](https://github.com/microsoft/node-pty/blob/8f218f6c194be81d98b1eeea344b150e83445824/scripts/linux/verify-glibc-requirements.sh#L6-L35)。
- `[事实]` VS Code 客户端本身也下载 `glibc-2.28-gcc-10.5.0` sysroot；x64 客户端用匹配 Chromium 的 clang、Electron libc++ 和该 sysroot 构建：[setup-env.sh](https://github.com/microsoft/vscode/blob/c422acaa84f1992f3e27cc675aca594db0ec647a/build/azure-pipelines/linux/setup-env.sh#L10-L65)。
- `[事实]` VS Code 发布流水线在安装依赖前 source 上述环境，并在 server 产物上检查 `GLIBC_2.28/GLIBCXX_3.4.25`：[product-build-linux-compile.yml](https://github.com/microsoft/vscode/blob/c422acaa84f1992f3e27cc675aca594db0ec647a/build/azure-pipelines/linux/steps/product-build-linux-compile.yml#L138-L151)、[同文件检查步骤](https://github.com/microsoft/vscode/blob/c422acaa84f1992f3e27cc675aca594db0ec647a/build/azure-pipelines/linux/steps/product-build-linux-compile.yml#L324-L333)。

`[推论]` 若 SoC Verify 当前的 `pty.node` 是在 Ubuntu 22.04 默认 toolchain 中构建，即使 Electron ABI 正确，产物仍可能引用 CentOS 8 不提供的较新 `GLIBC_*` 或 `GLIBCXX_*`。这与“文件存在但 `dlopen` 失败”的现象一致，但截图没有暴露真实的首个 `dlopen` 错误，因此尚不能只凭截图定案。

### 4. VS Code 的 ASAR 做法

- `[事实]` VS Code 自建 `node_modules.asar` 时 unpack 所有 `**/*.node`，并额外 unpack `node-pty/build/Release/*`：[gulpfile.vscode.ts](https://github.com/microsoft/vscode/blob/c422acaa84f1992f3e27cc675aca594db0ec647a/build/gulpfile.vscode.ts#L402-L439)。
- `[事实]` Electron 的 `require` 通过 `process.dlopen` 加载原生模块；官方文档建议用 `--unpack *.node` 让它们随 `.asar.unpacked` 一起发布：[ASAR 文档](https://github.com/electron/electron/blob/b5c102b3f0f7e9c5be064ba337a3547a83cf7d09/docs/tutorial/asar-archives.md#L129-L178)。
- `[事实]` `node-pty` 上游 loader 依次尝试 `build/Release`、`build/Debug`、`prebuilds/<platform>-<arch>`，每个位置又尝试 unbundled/bundled 两种相对路径：[utils.ts](https://github.com/microsoft/node-pty/blob/8f218f6c194be81d98b1eeea344b150e83445824/src/utils.ts#L13-L28)。VS Code 没有为 Linux 增加自定义 `app.asar.unpacked` loader patch。

`[建议]` SoC Verify 应保留 `electron-builder.yml` 的 `asarUnpack: node_modules/node-pty/**`，并在产物测试中验证 `.node` 确实位于 `app.asar.unpacked`。不应把 loader 字符串替换补丁当作 glibc 兼容方案；ASAR 路径正确后，应优先回到上游 loader 行为，减少安装时修改第三方包的脆弱点。

### 5. 截图中的错误被最后一次加载尝试遮蔽

`[事实]` 上游 loader 在循环中不断覆盖 `lastError`，最终只附带最后一次尝试的异常：[utils.ts](https://github.com/microsoft/node-pty/blob/8f218f6c194be81d98b1eeea344b150e83445824/src/utils.ts#L17-L28)。因此：

- `build/Release/pty.node` 可能已被找到，但因 `GLIBC_x.y not found`、`GLIBCXX_x.y not found`、`libutil.so.1 not found` 或其他 `dlopen` 错误而失败。
- loader 随后继续检查不存在的候选路径。
- 最终消息可能只剩 `Cannot find module './prebuilds/linux-x64/pty.node'`，并不等于真正根因是该文件不存在。

`[推论]` 截图的 “Native binary exists but cannot be loaded (missing system dependencies)” 是 SoC Verify 当前诊断逻辑依据“文件存在”做出的分类，不是 `node-pty` 或动态链接器给出的确定结论。截图没有出现 `libutil.so.1: cannot open shared object file`，所以提示用户安装 Debian 包名 `libutil1` 对 CentOS 8 既无证据支撑，也不适合作为根治方案。

## 对 SoC Verify 的实施建议

### 必须做

1. `[建议]` 固定构建矩阵为 `linux-x64 + Electron 43.1.0 + node-pty 1.1.0 + glibc 2.28/GCC 10.5 sysroot`。可直接移植 `microsoft/node-pty` 的 `install-sysroot.js` 思路与 checksum 固定机制，不要依赖“某个 Ubuntu 镜像碰巧够旧”。
2. `[建议]` 在 sysroot 环境内执行目标 Electron 的 rebuild。`@electron/rebuild -v 43.1.0 -f -w node-pty --arch x64` 解决 Electron runtime 维度，`SYSROOT_PATH/CC/CXX` 解决 Linux libc/C++ ABI 维度；两者缺一不可。
3. `[建议]` 只确定一个发布时原生二进制来源。若同时保留 `build/Release/pty.node` 和 `prebuilds/linux-x64/pty.node`，必须校验 SHA-256 完全相同，因为 loader 优先加载 `build/Release`。避免旧文件抢先于已修复 prebuild 被加载。
4. `[建议]` 在打包前对最终将进入 AppImage 的 `pty.node` 执行 `file`、`ldd`、`readelf -d`、`objdump -T`。最高需求必须满足 `GLIBC <= 2.28`、`GLIBCXX <= 3.4.25`，任何 `not found` 都应让构建失败。这里应补严上游脚本：GLIBCXX 超限也必须 `exit 1`。
5. `[建议]` 修正诊断：记录每个候选路径各自的原始异常，至少保留第一次“文件存在但 `require` 失败”的错误；不要只展示 loader 的最后一个 `MODULE_NOT_FOUND`。
6. `[建议]` 对已打包 AppImage 做真实运行测试，而非仅检查文件存在：在 CentOS/RHEL/Rocky/UBI 8 x64 环境中启动主进程、`require('node-pty')`、spawn shell、写入命令、resize、检查输出和退出。测试对象必须是 AppImage 解包后的最终资源树。

### 发布门禁示例

在 Linux 构建机或 CI 中，对最终 `pty.node` 运行：

```sh
file path/to/pty.node
ldd path/to/pty.node
readelf -d path/to/pty.node
objdump -T path/to/pty.node | grep -E 'GLIBC(X|XX)?_' | sort -V
```

在故障 CentOS 8 机器上先收集：

```sh
ldd --version
ldd /tmp/.mount_*/resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node
objdump -T /tmp/.mount_*/resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node \
  | grep -E 'GLIBC(X|XX)?_' | sort -V | tail -20
```

若同时存在两个候选文件，再比较：

```sh
sha256sum \
  /tmp/.mount_*/resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node \
  /tmp/.mount_*/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/linux-x64/pty.node
```

### 可后置

- `[建议]` 仿照 VS Code 将 PTY 放入 utility process，能提高 crash/阻塞隔离，但它不是本次动态链接失败的修复条件，应在 Linux 二进制兼容性解决后另行评估。
- `[建议]` 升级到 VS Code 当前使用的 `node-pty 1.2.0-beta.15` 可以获得较新的修复和官方 Linux prebuild 工程，但 beta 升级会扩大行为变更范围。本次最小修复可先保持 1.1.0，只移植其上游 sysroot 构建与验证方法。

## 成功标准

以下条件全部满足才算问题被根治：

1. 最终 AppImage 内只有经确认的 `linux-x64` `pty.node`，ASAR unpack 路径正确。
2. 该二进制针对 Electron 43.1.0 构建，并通过 `GLIBC_2.28/GLIBCXX_3.4.25` 上限检查。
3. CentOS 8 内网机上不安装额外开发工具也能加载 `node-pty`。
4. 能创建交互 shell、输入命令、接收输出、resize 并正常退出，不进入 fallback/log mode。
5. 故意换入不兼容二进制时，日志能显示真实的首个 `dlopen` 错误，而不是误导性的最后一个 `MODULE_NOT_FOUND`。
