# 内嵌二进制占位

M0 阶段此目录为空（仅本说明文件）。打包前需放入：

- `omp`（oh-my-pi 二进制，Windows 为 `omp.exe`）
- `bun`（Bun 运行时，Windows 为 `bun.exe`）

## 获取方式

```sh
# omp（PowerShell）
irm https://omp.sh/install.ps1 | iex
# 或
bun install -g @oh-my-pi/pi-coding-agent

# bun（PowerShell）
powershell -c "irm bun.sh/install.ps1 | iex"
```

## 打包行为

`electron-builder.yml` 已配置 `extraResources` 将本目录（排除 README.md）内嵌到安装包 `resources/binaries`，并 `asarUnpack` 以便子进程直接执行。

运行时 `src/main/omp/paths.ts` 负责从 `process.resourcesPath/binaries` 解析路径（开发时回退到 PATH / 用户配置）。
