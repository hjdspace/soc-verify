# 终端增强：主题系统、Prompt 美化与 Shell Integration

## Problem Statement

SoC Verify 的终端目前只满足基本仿真输出展示——字体用 `Consolas`，配色只从 CSS 变量读取 4 个色值，没有 Nerd Font（图标和 Powerline 符号显示为方块或问号），没有 Prompt 美化（路径/git 分支不可见），没有命令预测（输入命令时无灰色 ghost text 提示），没有 Shell Integration（看不到命令退出码和执行时间）。用户在终端中工作时体验远不如 VS Code Terminal 或 Warp。

## Solution

在现有 Electron 架构上增强终端，保留 tRPC/IPC + 三种后端（node-pty / fallback / log-mode）。分三期实施：

- **Phase 1**：终端主题系统（混合模式——默认跟随 UI 主题，可切换独立主题）+ Nerd Font 打包（CSS `@font-face` 加载）+ WebGL 渲染加速。
- **Phase 2**：交互式终端 Prompt 美化（zsh + Starship + zsh-autosuggestions）+ Shell Integration 脚本注入。仿真终端保持原样（csh，无美化）。
- **Phase 3**：前端命令装饰器（OSC 133 解析 + 退出码/执行时间/复制按钮/命令折叠）。

## User Stories

### 主题系统

1. As a SoC 验证工程师, I want 终端配色跟随 UI 主题自动切换, so that 切换 UI 主题时终端颜色不需要手动调整
2. As a SoC 验证工程师, I want 终端有完整的 16 色 ANSI 调色盘, so that `ls`、`git status`、`vim` 等 TUI 工具颜色正确渲染
3. As a SoC 验证工程师, I want 在设置中切换终端为独立主题（如 Catppuccin Mocha）, so that 终端配色可以与 UI 主题不同
4. As a SoC 验证工程师, I want 至少 8 款内置终端主题可选, so that 我可以根据偏好选择喜欢的配色
5. As a SoC 验证工程师, I want 通过 JSON 文件导入自定义终端主题, so that 我可以使用社区主题或自己调的配色
6. As a SoC 验证工程师, I want 在外观设置中直接预览终端主题效果, so that 不需要打开终端就能看到配色
7. As a SoC 验证工程师, I want 终端主题设置在重启后保持, so that 不需要每次重新配置
8. As a SoC 验证工程师, I want 可删除不再需要的自定义主题, so that 主题列表保持整洁

### 字体与渲染

9. As a SoC 验证工程师, I want 终端使用 Nerd Font, so that 图标和 Powerline 符号正确显示（无方块/问号乱码）
10. As a SoC 验证工程师, I want Nerd Font 随应用打包, so that 不需要在每台机器上手动安装字体
11. As a SoC 验证工程师, I want 终端使用 WebGL 加速渲染, so that 百万行仿真日志滚动时不卡顿
12. As a SoC 验证工程师, I want WebGL 加载失败时自动降级, so that 终端在低性能 GPU 环境仍可用

### Prompt 美化

13. As a SoC 验证工程师, I want 交互式终端显示 Starship Prompt, so that 我可以看到当前路径、git 分支和 git 状态
14. As a SoC 验证工程师, I want Prompt 中图标和 Powerline 符号正确显示, so that 终端看起来专业而非杂乱
15. As a SoC 验证工程师, I want 命令执行错误时 Prompt 图标变红，成功时变绿, so that 我可以一眼看出上条命令是否成功
16. As a SoC 验证工程师, I want 支持多层级路径截断, so that 深层目录路径不会占满终端
17. As a SoC 验证工程师, I want Windows 上也能使用 Starship Prompt, so that Windows 环境也有美化效果
18. As a SoC 验证工程师, I want zsh 不存在时降级为 bash + Starship, so that 在没有 zsh 的机器上仍有 Prompt 美化
19. As a SoC 验证工程师, I want Starship 不存在时降级为原始 shell, so that 终端在任何环境下都可用
20. As a SoC 验证工程师, I want 仿真终端保持 csh 不动, so that EDA 环境初始化脚本正常工作

### 命令预测

21. As a SoC 验证工程师, I want 在 zsh 终端中输入命令时显示灰色 ghost text 预测, so that 我可以快速接受历史命令
22. As a SoC 验证工程师, I want 按 `→` 或 `End` 键接受预测, so that 不需要完整输入命令
23. As a SoC 验证工程师, I want Backspace 删除时 ghost text 同步更新, so that 预测内容不会残留
24. As a SoC 验证工程师, I want 命令预测基于历史, so that 常用命令可以快速复用

### Shell Integration

25. As a SoC 验证工程师, I want 命令完成后显示退出码图标, so that 我可以一眼看出命令是否成功
26. As a SoC 验证工程师, I want 命令完成后显示执行时间, so that 我可以了解命令耗时
27. As a SoC 验证工程师, I want 点击复制按钮复制命令文本, so that 我可以快速复用命令
28. As a SoC 验证工程师, I want 长输出命令可折叠/展开, so that 终端不会被长输出淹没
29. As a SoC 验证工程师, I want 装饰器视觉风格与终端主题一致, so that 整体观感协调
30. As a SoC 验证工程师, I want 仿真终端不显示命令装饰器, so that 仿真输出不被干扰（SimControlToolbar 已提供执行信息）

## Implementation Decisions

### 架构定位

- 在现有 Electron 架构上增强终端，保留 tRPC/IPC + 三种后端（node-pty / fallback / log-mode）
- PRD 中 WebSocket 架构不适用，全部走现有 tRPC router + IPC eventBridge

### 主题系统（Phase 1）

- **混合模式**：Terminal Theme Mode 取值为 `follow-ui`（默认，从 CSS 变量读取 16 色 ANSI 调色盘，随 UI 主题切换联动）或 `independent`（从内置/自定义主题 JSON 读取调色盘，与 UI 主题解耦）
- 新建 `useTerminalThemeStore`（Zustand store），管理 themeMode / themeId / builtinThemes / customThemes / setter 方法。与 `useThemeStore` 解耦
- 6 个 UI 主题在 `globals.css` 中各新增 16 个 CSS 变量（`--term-black` 到 `--term-bright-white`）+ 4 个语义色变量（`--term-background` / `--term-foreground` / `--term-cursor` / `--term-selection`），手动调色
- `TerminalView` 的 `readTerminalThemeFromCss()` 从读取 4 个变量扩展为读取完整 20 个变量构建 `ITheme`
- 8 款内置独立主题（Dracula / Nord / Tokyo Night / Catppuccin Mocha / Gruvbox Dark / Solarized Dark / One Dark / Snazzy），每个是完整的 xterm.js `ITheme` 对象
- 用户自定义主题 JSON 存 `appData/terminal-themes/`，格式与 xterm.js `ITheme` 兼容。**CSP 合规**：`index.html` 的 CSP 为 `default-src 'self'`，前端不能直接通过 `fetch('file://...')` 或 `<link>` 加载 `appData` 中的 JSON 文件。所有自定义主题的读写必须通过 tRPC procedure 在主进程完成，前端只接收主题数据对象（不涉及文件路径）
- settings-router 新增 procedures：getTerminalThemeMode / setTerminalThemeMode / getTerminalThemeId / setTerminalThemeId / importTerminalTheme / listCustomTerminalThemes / deleteCustomTheme
- 扩展 AppearanceTab，在 UI 主题区块下方新增终端主题区块：模式切换开关 + 内置主题卡片 + 自定义主题卡片 + JSON 导入按钮 + 删除按钮

### 字体与渲染（Phase 1）

- Nerd Font（JetBrainsMono Nerd Font + MesloLGS NF）打包到 `resources/fonts/`，通过 CSS `@font-face` 声明加载（Electron 没有 `app.registerFont()` API，渲染进程可直接访问 `file://` 协议的本地字体文件）
- `electron-builder.yml` 的 `extraResources` 新增 `resources/fonts` → `fonts` 打包配置，确保字体文件随包分发
- 下载脚本 `scripts/download-nerd-fonts.mjs`，从 GitHub Release 下载，下载失败不阻断构建
- `globals.css`（或专用字体 CSS 文件）中新增 `@font-face` 声明，`src` 指向打包后的字体路径（dev 模式 `resources/fonts/`，打包模式 `process.resourcesPath/fonts/`）
- `TerminalView` 引入 `@xterm/addon-webgl`（版本须与 `@xterm/xterm@^6.0.0` 兼容，即 `@xterm/addon-webgl@^0.18.0`），加载顺序：`term.open()` → `loadAddon(webglAddon)` → `fitAddon.fit()`，WebGL addon 加载失败时 try-catch 降级为 Canvas
- `TerminalView` 字体改为 `'JetBrainsMono Nerd Font', 'MesloLGS NF', 'Consolas', monospace`

### Prompt 美化（Phase 2）

- 仅交互式终端：Linux/macOS 用 zsh + Starship + zsh-autosuggestions；Windows 用 PowerShell + Starship（无命令预测）
- 仿真终端保持 csh 不动（EDA 环境初始化脚本用 csh 语法）
- zsh 不存在时降级为 bash + Starship（无命令预测）；Starship 不存在时降级为原始 shell
- Starship 二进制照搬 officecli 模式：`package.json` 加 `starshipVersion`，`scripts/download-starship.mjs` 下载多平台二进制到 `resources/binaries/`，下载失败不阻断构建
- zsh 配置打包到 `resources/terminal/zsh/`：`.zshrc`（先 `source "$HOME/.zshrc"` 保留用户自定义配置，再 source osc133.zsh 和 zsh-autosuggestions，最后 `eval "$(starship init zsh)"` 初始化 Starship——此加载顺序确保 Starship 的 Prompt 渲染在 OSC 133;A 标记之后）+ `starship.toml` + `osc133.zsh`，通过 `ZDOTDIR` 环境变量注入。**`ZDOTDIR` 设置后 zsh 从该目录读取 `.zshrc` 而非 `~/.zshrc`，因此打包的 `.zshrc` 必须显式 `source "$HOME/.zshrc"`**
- zsh-autosuggestions 通过 `download:zsh-plugins` 独立下载脚本 clone 到 `resources/terminal/zsh/plugins/zsh-autosuggestions/`（**不放入 `postinstall`**——`postinstall` 已有 `setup-agent.mjs` + `patch-native-modules.mjs`，再加 clone 步骤增加复杂度且依赖网络/ git，CI 离线环境可能失败）
- `TerminalCreateOptions` 新增 `enhanced?: boolean` 字段，true 时注入 ZDOTDIR / STARSHIP_CONFIG。`terminal-router.ts` 的 `create` procedure 需同步新增 `enhanced` 字段并透传。仿真终端不传 enhanced
- 复用现有 `resolveInteractiveShell()` 函数（已 export），在 `enhanced` 模式下传入 zsh 候选路径（而非新建 `findInteractiveShell()` 函数，避免与现有 `resolveInteractiveShell()` 和内部 `findShell()` 命名混淆）
- Windows PowerShell 用 `-NoProfile -ExecutionPolicy Bypass -File <path>/osc133.ps1` 启动（不加载用户 profile 避免冲突），在 `osc133.ps1` 中先 `. $PROFILE`（若存在）加载用户配置，再注入 OSC 钩子

### Shell Integration（Phase 2-3）

- 自编写 `osc133.zsh` / `osc133.ps1` 脚本，参考 VS Code MIT 开源实现（`src/vs/platform/terminal/node/scripts/shellIntegration.zsh`）的核心 OSC 133 序列发送模式（`precmd` / `preexec` 钩子中发送 A/C/D 标记），精简为本项目所需的 3 标记版本（约 30-50 行）。不直接 copy VS Code 完整脚本（300+ 行，包含命令导航、Sticky Scroll、OSC 633 等不需要的功能，且依赖 VS Code 特有环境变量）
- Phase 2：注入 Shell Integration 脚本
- Phase 3：前端 `TerminalView` 注册 `term.parser.registerOscHandler(133, ...)`，解析 A/C/D 序列维护命令边界
- 使用 xterm.js Decoration API（`term.registerDecoration({ marker })`）渲染命令装饰器：退出码图标（✓绿/✗红）、执行时间、复制按钮、命令折叠。**必须使用 `marker` 方式（而非固定行号）**，确保终端 scroll 后装饰器位置自动跟随
- 装饰器用 React 组件渲染在 Decoration DOM 元素上，配色用 CSS 变量语义色
- 仅 Enhanced Terminal 生效；仿真终端不发送 OSC 133 序列
- **OutputBuffer restore 与 OSC 133 二次解析处理**：`TerminalManager` 的 `outputBuffer` 会保存所有 PTY 输出（含 OSC 133 转义序列）。TerminalView remount 时 restore 的文本会重新写入 xterm.js，OSC 133 序列会被二次解析导致装饰器状态混乱。解决方案：在 restore 前清空命令装饰器状态，让重新解析重建

## Testing Decisions

### 测试原则

只测外部行为，不测实现细节。验证"用户做了什么→看到了什么"，不验证内部函数调用顺序。

### 测试 seam（全部复用现有，不新建文件）

1. **`tests/terminal/terminal-manager.test.ts`**（主进程层）
   - 已有：测试 TerminalManager 的 create/write/resize/destroy/exit 行为
   - 新增：enhanced 参数的 zsh/Starship 注入逻辑——验证 env 变量注入结果（ZDOTDIR/STARSHIP_CONFIG 是否设置）、shell 选择路径（zsh 优先 → bash 降级 → 原始 shell 降级）、仿真终端不受 enhanced 影响
   - 先例：现有 `resolveInteractiveShell` / `getInteractiveShellArgs` 测试模式

2. **`tests/simulation/simulation-settings.test.ts`**（主进程持久化层）
   - 已有：测试 appData 持久化（mkdtemp + vi.mock electron + freshSettings）
   - 新增：终端主题设置（themeMode/themeId）的持久化读写、自定义主题 JSON 的导入/列出/删除
   - 先例：现有 `getPreferLogMode` / `setPreferLogMode` 测试模式

3. **`tests/ui/sim-control-toolbar.test.tsx`**（渲染层）
   - 已有：测试 React 组件 + tRPC mock 模式（vi.hoisted mock trpc + store selector mock）
   - 新增：AppearanceTab 终端主题区块——模式切换后 TerminalView ITheme 数据源变化、内置主题选择后 ITheme 对象正确、JSON 导入成功/失败后的 UI 反馈、删除自定义主题后列表更新
   - 先例：现有 `vi.hoisted` + `vi.mock('@renderer/lib/trpc')` + store selector mock 模式

## Out of Scope

- PRD 中 WebSocket/WebSocket 架构——不适用，本项目是 Electron 桌面应用
- 仿真终端的 Prompt 美化——仿真终端保持 csh，不做美化
- 仿真终端的 Shell Integration——SimTerminalLinker + SimControlToolbar 已提供执行信息
- 前端 AI 命令预测（基于历史命令的 AI 补全）——Phase 3 仅做 shell 层 zsh-autosuggestions
- 模拟 Prompt 美化（前端 xterm.js Decoration API 模拟 Starship）——用原生 Starship，不前端模拟
- 主题生态系统中的亮暗模式自动切换——本次不做
- 修改 omp 引擎源码——硬约束，不修改
- 将 zsh-autosuggestions clone 放入 `postinstall`——增加复杂度且依赖网络/ git，CI 离线环境可能失败，改用 `download:zsh-plugins` 独立脚本
- 直接 copy VS Code 完整 shellIntegration 脚本——300+ 行含不需要的功能（命令导航、Sticky Scroll、OSC 633），且依赖 VS Code 特有环境变量

## Further Notes

- 本 PRD 基于 [ADR-0030](../adr/0030-terminal-enhancement-design.md) 的设计决策，术语定义见 [CONTEXT.md](../../CONTEXT.md) 终端增强域
- 分 7 个 vertical slice issue 实施，详见 [docs/issues/terminal-enhancement-issues.md](../issues/terminal-enhancement-issues.md)
- 依赖链：#1 Nerd Font → #2 ANSI CSS+WebGL → #3 Theme Store+UI → #4 JSON 导入；#5 Starship 二进制（可与 #1-#4 并行）→ #6 Enhanced Terminal → #7 命令装饰器
