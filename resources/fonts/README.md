# resources/fonts

Nerd Font 字体目录（Issue #1 — 终端增强 Phase 1 基础设施）。

## JetBrainsMono Nerd Font

4 个 TTF 文件已入库（共 ~10MB），打包时无需下载 123MB 的 zip：

- `JetBrainsMonoNerdFont-Regular.ttf`
- `JetBrainsMonoNerdFont-Bold.ttf`
- `JetBrainsMonoNerdFont-Italic.ttf`
- `JetBrainsMonoNerdFont-BoldItalic.ttf`

来源：[ryanoasis/nerd-fonts](https://github.com/ryanoasis/nerd-fonts/releases) Release
（从 123MB 的 `JetBrainsMono.zip` 中提取上述 4 个文件，zip 不入库）

升级方式：`npm run download:nerd-fonts -- --force`
（需先放 `JetBrainsMono.zip` 到本目录，或联网从 GitHub 重新下载）

## MesloLGS NF

MesloLGS NF 字体文件不入库，构建时由下载脚本填充：

- `MesloLGS NF Regular.ttf`
- `MesloLGS NF Bold.ttf`
- `MesloLGS NF Italic.ttf`
- `MesloLGS NF Bold Italic.ttf`

来源：[romkatv/powerlevel10k-media](https://github.com/romkatv/powerlevel10k-media)

## 说明

- JetBrainsMono TTF 已入库，`.gitignore` 允许 `*.ttf`；`*.zip` 不入库
- MesloLGS NF 体积小（每个 ~1MB），不入库，由下载脚本按需获取
- 打包后随 `extraResources` 分发到 `resourcesPath/fonts/`
- 运行时通过 `local-resource://` 协议 + CSS `@font-face` 加载
- 字体缺失时应用正常启动，终端/界面回退到系统 fallback 字体

face 清单见 `src/shared/nerd-fonts.ts` 的 `NERD_FONT_FACES`。
