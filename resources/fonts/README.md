# resources/fonts

Nerd Font 字体目录（Issue #1 — 终端增强 Phase 1 基础设施）。

全部 8 个 TTF 文件均已入库（共 ~20MB），打包时**无需任何下载**。

## JetBrainsMono Nerd Font（4 文件，~10MB）

- `JetBrainsMonoNerdFont-Regular.ttf`
- `JetBrainsMonoNerdFont-Bold.ttf`
- `JetBrainsMonoNerdFont-Italic.ttf`
- `JetBrainsMonoNerdFont-BoldItalic.ttf`

来源：[ryanoasis/nerd-fonts](https://github.com/ryanoasis/nerd-fonts/releases) Release
（从 123MB 的 `JetBrainsMono.zip` 中提取上述 4 个文件，zip 不入库）

## MesloLGS NF（4 文件，~10MB）

- `MesloLGS NF Regular.ttf`
- `MesloLGS NF Bold.ttf`
- `MesloLGS NF Italic.ttf`
- `MesloLGS NF Bold Italic.ttf`

来源：[romkatv/powerlevel10k-media](https://github.com/romkatv/powerlevel10k-media)

## 升级方式

```sh
# 1. 删除已有 TTF（或加 --force）
# 2. 重新下载
npm run download:nerd-fonts -- --force
# 3. 提交新的 TTF 文件
git add resources/fonts/*.ttf
git commit -m "chore(fonts): upgrade nerd fonts"
```

JetBrainsMono 升级时：优先从本地 `JetBrainsMono.zip` 提取（若存在），
否则从 GitHub 下载 123MB zip，提取后删除 zip。

## 说明

- 所有 TTF 已入库，`.gitignore` 允许 `JetBrainsMonoNerdFont-*.ttf` 和 `MesloLGS NF *.ttf`
- `*.zip` 不入库（123MB 临时下载文件）
- 打包后随 `extraResources` 分发到 `resourcesPath/fonts/`
- 运行时通过 `local-resource://` 协议 + CSS `@font-face` 加载
- 字体缺失时应用正常启动，终端/界面回退到系统 fallback 字体

face 清单见 `src/shared/nerd-fonts.ts` 的 `NERD_FONT_FACES`。
