# 0030 — 终端增强设计：主题系统、Prompt 美化与 Shell Integration

## 背景

现有终端基于 `TerminalManager`（三种后端：node-pty / fallback / log-mode）+ `TerminalView`（xterm.js + FitAddon），仅满足基本仿真输出展示需求。`TerminalView` 字体用 `Consolas`，主题从 CSS 变量读取 4 色，无 Nerd Font、无 Prompt 美化、无命令预测、无 Shell Integration。

`web_terminal_prd.md` 提出了基于 node-pty + xterm.js + Starship + zsh-autosuggestions 的完整终端方案，但原 PRD 面向通用 Web 终端（WebSocket 架构），需适配现有 Electron 桌面应用的 tRPC/IPC 架构后实施。

## 决策

在现有 Electron 架构上增强终端，保留 tRPC/IPC + 三种后端。分三期实施：

### 1. 主题系统：混合模式

终端主题默认跟随 UI 主题（从 CSS 变量读取 16 色 ANSI 调色盘），用户可在设置中切换为独立终端主题（类似 VS Code `terminal.integrated.colorTheme`）。

- 新建 `useTerminalThemeStore`（Zustand），与 `useThemeStore` 解耦
- 6 个 UI 主题在 `globals.css` 中新增 16 个 CSS 变量（`--term-black` 到 `--term-bright-white`），手动调色
- 8 款内置独立主题（Dracula / Nord / Tokyo Night / Catppuccin Mocha / Gruvbox / Solarized / One Dark / Snazzy）
- 用户自定义主题 JSON 导入，存 `appData/terminal-themes/`
- 扩展 `AppearanceTab`，在 UI 主题下方加终端主题区块
- 持久化通过 `settings-router` 扩展

被拒绝方案：终端主题完全独立于 UI 主题（失去联动便利性）；终端主题完全跟随 UI 主题（无法满足用户选独立主题的需求）。

### 2. Prompt 美化：仅交互式终端

- **Linux/macOS**：zsh + Starship + zsh-autosuggestions（完整 Prompt 美化 + 命令预测）
- **Windows**：PowerShell + Starship（Prompt 美化，无命令预测——zsh-autosuggestions 不可用）
- **zsh 不存在的 Linux**：降级为 bash + Starship（Prompt 美化，无命令预测）
- **仿真终端**：保持 csh 不动（EDA 环境初始化脚本用 csh 语法，切换 shell 会破坏环境）

被拒绝方案：仿真终端也切到 zsh 运行 runsim（破坏 EDA 环境初始化）；前端模拟 Prompt 美化（实现复杂度高且效果不如原生 Starship）。

### 3. Shell Integration：仅交互式终端

通过 OSC 133 转义序列标记命令边界，前端 xterm.js 解析后渲染命令装饰器（退出码、执行时间、复制按钮、命令折叠）。

自编写 `osc133.zsh` / `osc133.ps1` 脚本，参考 VS Code MIT 开源实现（`src/vs/platform/terminal/node/scripts/shellIntegration.zsh`）的核心 OSC 133 序列发送模式（`precmd` / `preexec` 钩子中发送 A/C/D 标记），精简为本项目所需的 3 标记版本（约 30-50 行）。不直接 copy VS Code 完整脚本（300+ 行，包含命令导航、Sticky Scroll、OSC 633 等本项目不需要的功能，且依赖 VS Code 特有环境变量）。脚本打包到 `resources/terminal/zsh/`。

仿真终端不做 Shell Integration——命令执行信息已由 `SimTerminalLinker` + `SimControlToolbar` 提供。

被拒绝方案：仿真终端也注入 csh 端 OSC 序列（csh 不易注入 OSC 序列）；用 xterm.js 内置 shell integration addon（功能有限，不如自写灵活）。

### 4. 打包策略

| 组件 | 方式 | 位置 |
|------|------|------|
| Nerd Font | CSS `@font-face` 声明 + `electron-builder` extraResources 打包 | `resources/fonts/` |
| Starship 二进制 | 照搬 officecli 模式（`download:starship` + `package.json` 版本固定 + 多平台下载） | `resources/binaries/` |
| zsh 配置 | 打包 `.zshrc` + `starship.toml` + shell-integration.zsh | `resources/terminal/zsh/` |
| zsh-autosuggestions | `download:zsh-plugins` 独立下载脚本（不混入 postinstall） | `resources/terminal/zsh/plugins/zsh-autosuggestions/` |

`TerminalManager.create()` 新增 `enhanced?: boolean` 参数，true 时注入 `ZDOTDIR`、`STARSHIP_CONFIG` 等环境变量。`terminal-router` 的 `create` procedure 需同步新增 `enhanced` 字段并透传。仿真终端调 `create()` 时不传 `enhanced`。

`ZDOTDIR` 指向 `resources/terminal/zsh/` 后，zsh 从该目录读取 `.zshrc` 而非 `~/.zshrc`。因此打包的 `.zshrc` 必须显式 `source "$HOME/.zshrc"`（若存在）以保留用户自定义配置。加载顺序：先 source `~/.zshrc` → 再 source `osc133.zsh` → 最后 `eval "$(starship init zsh)"`，确保 Starship 的 Prompt 渲染在 OSC 133;A 标记之后。

Windows PowerShell 用 `-NoProfile -ExecutionPolicy Bypass -File <path>/osc133.ps1` 启动（不加载用户 profile 避免冲突），在 `osc133.ps1` 中先 `. $PROFILE` 加载用户配置，再注入 OSC 钩子。

被拒绝方案：zsh 配置动态生成临时文件（不优雅）；追加 source 语句到用户 `~/.zshrc`（侵入性强）；用 Git submodule 管理 zsh-autosuggestions（与现有项目结构不一致）；将 zsh-autosuggestions clone 放入 `postinstall`（增加复杂度且依赖网络/ git，CI 离线环境可能失败）。

### 5. 渲染加速

Phase 1 引入 `@xterm/addon-webgl`（版本须与 `@xterm/xterm@^6.0.0` 兼容，即 `@xterm/addon-webgl@^0.18.0`）实现 WebGL 渲染加速，应对百万行仿真日志滚动场景。加载顺序：`term.open()` → `loadAddon(webglAddon)` → `fitAddon.fit()`，WebGL 加载失败时 try-catch 降级为默认 Canvas 渲染。

命令装饰器使用 xterm.js Decoration API 的 `marker` 方式（非固定行号），确保终端 scroll 后装饰器位置自动跟随。OutputBuffer restore（TerminalView remount 场景）时需处理 OSC 133 序列的二次解析问题：在 restore 前清空命令装饰器状态，让重新解析重建。

## 后果

- Phase 1：主题系统 + Nerd Font + WebGL + 设置 UI（最核心，不依赖外部工具）
- Phase 2：Starship + zsh 配置 + autosuggestions + Shell Integration 脚本 + `enhanced` 参数
- Phase 3：前端 OSC 133 解析 + 完整命令装饰器
- `TerminalManager` 需修改 `create()` 方法支持 `enhanced` 参数
- `globals.css` 6 个主题各新增 16 个 CSS 变量
- `package.json` 新增 `starshipVersion` 字段和 `download:starship` / `download:zsh-plugins` 脚本
- `electron-builder.yml` 的 `extraResources` 新增 `resources/fonts` → `fonts` 打包配置
- 术语：Terminal Theme Mode、Terminal ANSI Palette、Enhanced Terminal、Shell Integration、Command Decorator、Nerd Font Registration、Starship Binary（见 CONTEXT.md 终端增强域）
