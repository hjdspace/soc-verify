# resources/fonts

Nerd Font 字体目录（Issue #1 — 终端增强 Phase 1 基础设施）。

通过 `npm run download:nerd-fonts` 从 GitHub 下载以下字体（.ttf）：

- **JetBrainsMono Nerd Font**（`JetBrainsMonoNerdFont-{Regular,Bold,Italic,BoldItalic}.ttf`）
  来源：[ryanoasis/nerd-fonts](https://github.com/ryanoasis/nerd-fonts/releases) Release
- **MesloLGS NF**（`MesloLGS NF {Regular,Bold,Italic,Bold Italic}.ttf`）
  来源：[romkatv/powerlevel10k-media](https://github.com/romkatv/powerlevel10k-media)

字体文件不入库（见 `.gitignore`），构建时由下载脚本填充，
打包后随 `extraResources` 分发到 `resourcesPath/fonts/`。
运行时通过 `local-resource://` 协议 + CSS `@font-face` 加载；
字体缺失时应用正常启动，终端/界面回退到系统 fallback 字体。

face 清单见 `src/shared/nerd-fonts.ts` 的 `NERD_FONT_FACES`。
