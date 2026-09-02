# 终端增强：主题系统、Prompt 美化与 Shell Integration

> **Parent ADR**: [ADR-0030](../adr/0030-terminal-enhancement-design.md)
> **Parent PRD**: [docs/prd/prd-terminal-enhancement.md](../prd/prd-terminal-enhancement.md)
> **背景**: 现有终端基于 `TerminalManager`（三种后端：node-pty / fallback / log-mode）+ `TerminalView`（xterm.js + FitAddon），仅满足基本仿真输出展示。本组 issue 在现有 Electron 架构上增强终端，保留 tRPC/IPC + 三种后端，分三期实施。

---

## 依赖关系总览

```
#1 Nerd Font ──→ #2 ANSI CSS+WebGL ──→ #3 Theme Store+UI ──→ #4 JSON 导入
                                                        │
#5 Starship 二进制 ─────────────────────────────────→  │
                                                        ↓
                                             #6 Enhanced Terminal ──→ #7 命令装饰器
```

- **#1 和 #5 可并行开始**（无互相依赖）
- **#6 依赖 #1 + #5**（Nerd Font 和 Starship 都先打包）
- **#7 依赖 #6**（Shell Integration 脚本先注入，才有 OSC 133 序列可解析）

---

## Issue #1 — 打包 Nerd Font 到 resources/fonts/ 并通过 CSS @font-face 加载

### What to build

将 JetBrainsMono Nerd Font 和 MesloLGS NF 字体文件打包到 `resources/fonts/`，通过 CSS `@font-face` 声明加载，使所有 Electron 窗口中的文本（包括 xterm.js 渲染的终端）均可使用 Nerd Font 图标和 Powerline 符号。

> **注意**：Electron 没有 `app.registerFont()` API。正确方式是在 CSS 中用 `@font-face` 声明本地字体文件路径（Electron 渲染进程可直接访问 `file://` 协议的本地文件）。

字体文件应通过下载脚本获取（Nerd Font 是开源字体，可从 GitHub Release 下载），下载失败不阻断构建，运行时降级为 fallback 字体。打包时需在 `electron-builder.yml` 的 `extraResources` 中新增 `resources/fonts` → `fonts` 配置，确保字体文件随包分发。

这是终端增强的 Phase 1 基础设施——后续的主题系统（16 色调色盘效果验证）和 Prompt 美化（Starship 图标渲染）都依赖 Nerd Font 可用。

### Acceptance criteria

- [ ] `resources/fonts/` 目录包含 JetBrainsMono Nerd Font 和 MesloLGS NF 的字体文件（.ttf 或 .woff2）
- [ ] 下载脚本 `scripts/download-nerd-fonts.mjs` 可从 GitHub Release 下载字体，支持 `--force` 重新下载，已存在则跳过
- [ ] `package.json` 新增 `download:nerd-fonts` npm script
- [ ] `electron-builder.yml` 的 `extraResources` 新增 `resources/fonts` → `fonts` 打包配置
- [ ] `globals.css`（或专用字体 CSS 文件）中新增 `@font-face` 声明，`src` 指向打包后的字体路径（dev 模式 `resources/fonts/`，打包模式 `process.resourcesPath/fonts/`）
- [ ] CSS `font-family` 声明后，xterm.js 终端和渲染进程均可使用 `'JetBrainsMono Nerd Font'` 和 `'MesloLGS NF'`
- [ ] 字体未下载时（降级场景）应用启动正常，终端使用 fallback 字体，不崩溃
- [ ] typecheck + lint 通过

### Blocked by

None — can start immediately.

---

## Issue #2 — 为 6 个 UI 主题新增 16 色 ANSI CSS 变量，引入 WebGL addon

### What to build

这是终端主题系统的基础切片，实现 Terminal Theme Mode 的 `follow-ui` 模式——终端配色跟随 UI 主题自动联动。

1. 在 `globals.css` 中为全部 6 个 UI 主题（drafting / bench / slate / daylight / apple-light / apple-dark）各新增 16 个 CSS 变量（`--term-black` 到 `--term-bright-white`），加上 `--term-background`、`--term-foreground`、`--term-cursor`、`--term-selection`。手动调色，确保每个主题的 16 色调色盘与该主题的整体风格一致。

2. 重构 `TerminalView` 的 `readTerminalThemeFromCss()` 函数，从只读 4 个 CSS 变量扩展为读取完整 20 个变量（16 色 + 4 语义色），构建完整的 xterm.js `ITheme` 对象。

3. 在 `TerminalView` 中引入 `@xterm/addon-webgl`（版本须与 `@xterm/xterm@^6.0.0` 兼容，即 `@xterm/addon-webgl@^0.18.0`），实现 GPU 加速渲染，应对百万行仿真日志滚动场景。WebGL addon 加载失败时降级为默认 Canvas 渲染。加载顺序：`term.open()` → `loadAddon(webglAddon)` → `fitAddon.fit()`，WebGL 加载失败时 try-catch 降级为默认 Canvas 渲染。

4. 将 `TerminalView` 的 `fontFamily` 从 `Consolas` 改为 `'JetBrainsMono Nerd Font', 'MesloLGS NF', 'Consolas', monospace`（依赖 issue #1 的 Nerd Font 注册）。

### Acceptance criteria

- [ ] 6 个 UI 主题在 `globals.css` 中各有 16 个 ANSI 色 CSS 变量（`--term-black` 到 `--term-bright-white`）+ 4 个语义色变量
- [ ] `TerminalView` 的 `readTerminalThemeFromCss()` 读取完整 20 个 CSS 变量构建 `ITheme`
- [ ] 切换 UI 主题时终端 16 色调色盘自动跟随，`ls`、`git status` 等 TUI 工具颜色正确
- [ ] `@xterm/addon-webgl` 加载成功，终端渲染使用 WebGL 加速
- [ ] WebGL addon 加载失败时自动降级为 Canvas 渲染，终端仍可用
- [ ] 终端字体改为 Nerd Font 优先级链，图标和 Powerline 符号正确显示
- [ ] typecheck + lint 通过
- [ ] 相关测试更新通过

### Blocked by

- #1 — Nerd Font 打包与系统级注册（终端字体依赖 Nerd Font 可用）

---

## Issue #3 — 新建终端主题 store，支持独立主题切换和内置 8 款主题

### What to build

在 follow-ui 模式基础上新增 `independent` 模式——用户可选择独立于 UI 主题的终端主题。

1. 新建 `useTerminalThemeStore`（Zustand store），管理：
   - `themeMode`: `'follow-ui' | 'independent'`
   - `themeId`: 当前独立主题 ID（independent 模式下生效）
   - `builtinThemes`: 8 款内置主题定义（Dracula / Nord / Tokyo Night / Catppuccin Mocha / Gruvbox Dark / Solarized Dark / One Dark / Snazzy），每个主题是完整的 xterm.js `ITheme` 对象
   - `setThemeMode(mode)` / `setTheme(themeId)` 方法

2. 修改 `TerminalView` 监听 `useTerminalThemeStore`：follow-ui 模式时从 CSS 变量读取调色盘（issue #2 的逻辑），independent 模式时从选中的内置主题定义读取 `ITheme` 对象。

3. 扩展 `settings-router`，新增持久化 procedures：`getTerminalThemeMode` / `setTerminalThemeMode` / `getTerminalThemeId` / `setTerminalThemeId`。主进程将设置持久化到 appData settings JSON。

4. 扩展 `AppearanceTab`，在 UI 主题区块下方新增「终端主题」区块：
   - 模式切换开关（跟随 UI / 独立）
   - independent 模式时展示 8 款内置主题卡片（色板预览 + 名称 + 描述）
   - 选中后实时预览（TerminalView 立即生效）

### Acceptance criteria

- [ ] `useTerminalThemeStore` 创建，包含 themeMode / themeId / 8 款内置主题 / setter 方法
- [ ] `TerminalView` 订阅 `useTerminalThemeStore`，follow-ui 模式读 CSS 变量，independent 模式读主题定义
- [ ] settings-router 新增 4 个 procedures，主进程持久化终端主题设置到 appData
- [ ] `AppearanceTab` 新增终端主题区块，含模式切换开关 + 8 款主题卡片
- [ ] 切换为 independent 模式后选择内置主题，终端立即应用新调色盘
- [ ] 切换为 follow-ui 模式后终端恢复跟随 UI 主题
- [ ] 应用重启后恢复上次选择的模式和主题
- [ ] typecheck + lint 通过
- [ ] 相关测试更新通过

### Blocked by

- #2 — 16 色 ANSI CSS 变量 + WebGL（follow-ui 模式是 independent 模式的基础）

---

## Issue #4 — 支持用户通过 JSON 文件导入自定义终端主题

### What to build

在 issue #3 的终端主题 store 基础上，新增用户自定义主题 JSON 导入功能。

1. settings-router 新增 procedures：
   - `importTerminalTheme(JSON)` — 验证 JSON 格式与 xterm.js `ITheme` 兼容，写入 `appData/terminal-themes/<name>.json`，返回分配的主题 ID
   - `listCustomTerminalThemes()` — 读取 `appData/terminal-themes/` 目录下所有 JSON，返回主题列表
   - `deleteCustomTheme(themeId)` — 删除指定自定义主题文件

   > **CSP 合规**：`index.html` 的 CSP 为 `default-src 'self'`，前端不能直接通过 `fetch('file://...')` 或 `<link>` 加载 `appData` 中的 JSON 文件。所有自定义主题的读写必须通过 tRPC procedure 在主进程完成，前端只接收主题数据对象（不涉及文件路径）。

2. `useTerminalThemeStore` 扩展：`customThemes` 列表 + `importTheme(file)` / `deleteCustomTheme(id)` 方法。自定义主题与内置主题在 UI 中并列展示。

3. `AppearanceTab` 终端主题区块扩展：
   - 自定义主题在 8 款内置主题之后展示
   - 「导入主题」按钮：接受 JSON 文件选择，导入后即时预览
   - 每个自定义主题卡片有删除按钮
   - 导入失败（格式不合法）时 toast 提示错误

### Acceptance criteria

- [ ] 用户可通过 AppearanceTab 导入 xterm.js `ITheme` 格式的 JSON 文件
- [ ] 导入的主题存到 `appData/terminal-themes/<name>.json`
- [ ] 自定义主题在 AppearanceTab 中与内置主题并列展示
- [ ] 选中自定义主题后终端立即应用
- [ ] 可删除自定义主题（删除后从列表移除，当前选中者回退为 follow-ui 或第一个内置主题）
- [ ] 格式不合法的 JSON 被拒绝并显示错误提示
- [ ] 应用重启后自定义主题列表从 appData 恢复
- [ ] typecheck + lint 通过
- [ ] 相关测试更新通过

### Blocked by

- #3 — useTerminalThemeStore + 内置主题 + 设置 UI（依赖主题 store 基础设施）

---

## Issue #5 — 照搬 officecli 模式打包 Starship 多平台二进制

### What to build

将 Starship（跨 shell Prompt 美化引擎，Rust 编写的单二进制）打包到 `resources/binaries/`，完全照搬现有 officecli 下载脚本的模式。

1. `package.json` 新增 `starshipVersion` 字段（固定版本号，如 `v1.21.1`）。

2. 新建 `scripts/download-starship.mjs` 下载脚本，参照 `scripts/download-officecli.mjs` 的模式：
   - 从 Starship GitHub Release 下载对应平台二进制（Linux x64/arm64、Windows x64、macOS x64/arm64）
   - 二进制放置在 `resources/binaries/`，命名约定 `starship-{platform}-{arch}[.exe]`
   - 若已存在则跳过（除非传 `--force`）
   - 下载失败不阻断构建，只打印警告（运行时降级——无 Starship 则不启用 Prompt 美化）
   - 下载完成后用 `starship --version` 验证可执行

3. `package.json` 新增 npm scripts：`download:starship`、`prebuild:starship`。构建流程（`package`、`package:win`、`package:linux`）中加入 `download:starship` 步骤。

4. 主进程新增 `resolveStarshipPath()` 函数，从 `resources/binaries/` 解析当前平台的 Starship 二进制路径，找不到时返回 null。

### Acceptance criteria

- [ ] `package.json` 新增 `starshipVersion` 字段
- [ ] `scripts/download-starship.mjs` 可从 GitHub Release 下载多平台 Starship 二进制
- [ ] `npm run download:starship` 成功下载，`--force` 可强制重新下载
- [ ] 下载的二进制用 `starship --version` 验证可执行
- [ ] 下载失败时不阻断构建
- [ ] 构建流程中加入 `download:starship` 步骤
- [ ] 主进程 `resolveStarshipPath()` 可正确解析当前平台二进制路径
- [ ] typecheck + lint 通过

### Blocked by

None — 可与 #1-#4 并行（独立基础设施）。

---

## Issue #6 — 交互式终端注入 zsh/Starship/zsh-autosuggestions，新增 enhanced 参数

### What to build

这是 Phase 2 的核心切片，实现 Enhanced Terminal——交互式终端的 Prompt 美化、命令预测和 Shell Integration 脚本注入。

#### 6a. zsh 配置文件打包

1. 在 `resources/terminal/zsh/` 目录下打包配置文件：
   - `.zshrc` — 主配置。先 `source "$HOME/.zshrc"`（若存在，保留用户自定义配置），再 source 打包的配置片段（osc133.zsh、zsh-autosuggestions），最后 `eval "$(starship init zsh)"` 初始化 Starship。此加载顺序确保 Starship 的 Prompt 渲染在 OSC 133;A 标记之后
   - `starship.toml` — Starship 配置（路径截断、git 分支/状态、执行时间、错误图标变色）
   - `osc133.zsh` — 自编写的 Shell Integration 脚本，参考 VS Code MIT 开源实现（`shellIntegration.zsh`）的核心 OSC 133 序列发送模式（`precmd` / `preexec` 钩子中发送 A/C/D 标记），精简为本项目所需的 3 标记版本（约 30-50 行）。不直接 copy VS Code 完整脚本（300+ 行，包含命令导航、Sticky Scroll、OSC 633 等不需要的功能）
   - `plugins/zsh-autosuggestions/` — zsh-autosuggestions 插件（通过 `download:zsh-plugins` 独立脚本 clone）

2. 新建 `scripts/download-zsh-plugins.mjs` 脚本，处理 zsh-autosuggestions 的 clone 和更新（参照 `download-officecli.mjs` 模式，已存在则跳过，支持 `--force`）。**不放入 `postinstall`**——`postinstall` 已有 `setup-agent.mjs` + `patch-native-modules.mjs`，再加 clone 步骤增加复杂度且依赖网络/ git，CI 离线环境可能失败。`download:zsh-plugins` 作为独立 npm script，在 `package` / `package:win` / `package:linux` 构建流程中调用。

3. `package.json` 新增 `download:zsh-plugins` npm script，构建流程中加入此步骤。

#### 6b. TerminalManager enhanced 参数

1. `TerminalCreateOptions` 新增 `enhanced?: boolean` 字段。

2. `TerminalManager.create()` 方法中，当 `enhanced: true` 时：
   - Linux/macOS：优先使用 zsh（检测 `/bin/zsh`、`/usr/bin/zsh`、用户 SHELL），设置 `ZDOTDIR` 指向 `resources/terminal/zsh/`，`STARSHIP_CONFIG` 指向打包的 `starship.toml`。**`ZDOTDIR` 设置后 zsh 从该目录读取 `.zshrc` 而非 `~/.zshrc`，因此打包的 `.zshrc` 必须显式 `source "$HOME/.zshrc"` 以保留用户自定义配置**
   - Windows：使用 PowerShell，设置 `STARSHIP_CONFIG` 环境变量
   - zsh 不存在时降级为 bash + Starship（无命令预测）
   - Starship 二进制不存在时降级为原始 shell（无 Prompt 美化），终端仍可用

3. `terminal-router.ts` 的 `create` procedure 需同步新增 `enhanced?: boolean` 字段，透传到 `terminalManager.create()`。当前 `terminal-store.ts` 的 `createTerminal` 调用 `trpc.terminal.create.mutate()`，需在此处传入 `enhanced: true`（交互式终端）。仿真终端调 `create()` 时不传 `enhanced`（保持 csh，无美化）。simulation-router 中 PTY 模式的 `create({ cwd, shell: simShell })` 调用不变。

#### 6c. Shell Integration 脚本

1. 编写 `osc133.zsh`（zsh 用）和 `osc133.ps1`（PowerShell 用）：
   - 命令开始时发送 `OSC 133;A` 序列
   - 命令输出前发送 `OSC 133;C` 序列
   - 命令完成时发送 `OSC 133;D;<exit_code>` 序列
   - 在 `.zshrc` 中 source osc133.zsh；PowerShell 通过 `-File` 参数加载 osc133.ps1

2. PowerShell 启动策略：用 `-NoProfile -ExecutionPolicy Bypass -File <path>/osc133.ps1` 启动（不加载用户 profile 避免冲突）。在 `osc133.ps1` 中先 `. $PROFILE`（若存在）加载用户配置，再注入 OSC 钩子。这样既保留用户自定义 PowerShell 配置，又避免 profile 与 OSC 钩子的加载顺序冲突。

#### 6d. 跨平台 shell 发现

1. 复用现有 `resolveInteractiveShell()` 函数（已 export），在 `enhanced` 模式下传入不同的 preferred 列表（优先 zsh），而非新建 `findInteractiveShell()` 函数（避免与现有 `resolveInteractiveShell()` 和内部 `findShell()` 命名混淆）：
   - Linux/macOS：优先 zsh → bash（不优先 csh）
   - Windows：PowerShell

   当前 `resolveInteractiveShell()` 的签名已支持 `preferred` 参数列表，只需传入 zsh 候选路径即可。

### Acceptance criteria

- [ ] `resources/terminal/zsh/` 目录包含 `.zshrc`、`starship.toml`、`osc133.zsh`
- [ ] `download:zsh-plugins` 成功 clone zsh-autosuggestions 到 `resources/terminal/zsh/plugins/`（不放入 postinstall）
- [ ] `package.json` 新增 `download:zsh-plugins` npm script，构建流程中加入此步骤
- [ ] `TerminalCreateOptions` 新增 `enhanced?: boolean` 字段
- [ ] `terminal-router.ts` 的 `create` procedure 新增 `enhanced` 字段并透传
- [ ] `.zshrc` 正确 source `~/.zshrc` → osc133.zsh → `starship init zsh`（加载顺序验证）
- [ ] `enhanced: true` 时 Linux/macOS 启动 zsh + Starship + zsh-autosuggestions，Prompt 显示路径/git 分支/图标
- [ ] `enhanced: true` 时 Windows 启动 PowerShell + Starship（无命令预测）
- [ ] zsh 不存在时降级为 bash + Starship，终端仍可用
- [ ] Starship 不存在时降级为原始 shell，终端仍可用
- [ ] 仿真终端不受影响（csh，无美化）
- [ ] Shell Integration 脚本正确发送 OSC 133 序列（可通过 xterm.js parser 验证）
- [ ] 命令预测（zsh-autosuggestions）在 zsh 终端中工作：输入 `git c` 时灰色显示 `git commit`
- [ ] typecheck + lint 通过
- [ ] 相关测试更新通过

### Blocked by

- #1 — Nerd Font 打包（Prompt 图标依赖 Nerd Font）
- #5 — Starship 二进制打包（依赖 Starship 可用）

---

## Issue #7 — TerminalView 解析 OSC 133 序列并渲染命令装饰器

### What to build

这是 Phase 3 的切片，在 issue #6 注入 Shell Integration 脚本的基础上，前端解析 OSC 133 序列并在命令边界渲染完整命令装饰器。

1. 在 `TerminalView` 中注册 xterm.js OSC 133 handler（`term.parser.registerOscHandler(133, ...)`），解析命令开始（A）、输出前（C）、完成（D + exit_code）三种序列，维护命令边界状态。

2. 使用 xterm.js Decoration API（`term.registerDecoration({ marker })`）在命令行上方/下方渲染 UI 组件。**必须使用 `marker` 方式（而非固定行号）**，确保终端 scroll 后装饰器位置自动跟随：
   - **退出码图标**：命令完成后在命令行末尾显示绿色 ✓（exit 0）或红色 ✗（exit ≠ 0）
   - **执行时间**：从命令开始到完成的时间差，显示在退出码图标旁边（如 `2.3s`）
   - **复制按钮**：点击复制命令行文本到剪贴板
   - **命令折叠**：长输出可收起/展开，点击装饰器切换折叠状态

3. 命令装饰器仅对 Enhanced Terminal（交互式终端，issue #6 注入了 osc133 脚本）生效。仿真终端不发送 OSC 133 序列，不渲染装饰器。

4. 装饰器使用 React 组件渲染在 xterm.js 的 Decoration DOM 元素上，与终端主题配色一致（用 CSS 变量语义色）。

5. **OutputBuffer restore 与 OSC 133 二次解析处理**：当前 `TerminalManager` 的 `outputBuffer` 会保存所有 PTY 输出（包括 OSC 133 转义序列）。当 `TerminalView` remount 时，`getOutputBuffer` 恢复的文本会重新写入 xterm.js，OSC 133 序列会被二次解析，导致命令装饰器状态混乱（重复创建 decoration、退出码重复显示）。解决方案：在 restore 前清空命令装饰器状态（`decorations.clear()` 或重置内部状态），让重新解析重建装饰器。

### Acceptance criteria

- [ ] `TerminalView` 注册 OSC 133 handler，正确解析 A/C/D 三种序列
- [ ] 命令完成后在命令行末尾显示退出码图标（✓ 绿 / ✗ 红）
- [ ] 显示命令执行时间（开始到完成的差值）
- [ ] 复制按钮可复制命令文本到剪贴板
- [ ] 长输出命令可折叠/展开，折叠时只显示命令行
- [ ] 装饰器视觉风格与终端主题一致（用 CSS 变量语义色）
- [ ] 仿真终端不显示命令装饰器（无 OSC 133 序列）
- [ ] 装饰器不干扰终端正常输入/输出（不写入 xterm.js buffer）
- [ ] 终端 resize 后装饰器位置正确（使用 marker 方式，scroll 后位置自动跟随）
- [ ] TerminalView remount（切换 tab 后切回）时，OutputBuffer restore 不产生重复/混乱的命令装饰器
- [ ] typecheck + lint 通过
- [ ] 相关测试更新通过

### Blocked by

- #6 — Enhanced Terminal（依赖 Shell Integration 脚本注入，才有 OSC 133 序列可解析）
