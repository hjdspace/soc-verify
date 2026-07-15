# 内嵌 runner 二进制占位

`npm install` 会通过 `scripts/setup-agent.mjs` 自动尝试从 GitHub Release 下载当前平台的 runner：

- Windows: `socverify-runner.exe`
- Linux/macOS: `socverify-runner`

打包脚本使用严格检查；如果本目录没有 runner，会要求先下载或本地构建：

```sh
npm run setup:agent
npm run build:runner
```

## 打包行为

`electron-builder.yml` 已配置 `extraResources` 将本目录（排除 README.md）内嵌到安装包 `resources/binaries`，并 `asarUnpack` 以便子进程直接执行。`engine/oh-my-pi` 不随桌面安装包打包。

运行时 `src/main/agent/paths.ts` 负责从 `process.resourcesPath/binaries` 解析 runner；开发模式会先查本目录，再回退到 Bun + engine submodule。
