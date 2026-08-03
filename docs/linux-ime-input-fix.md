# Electron AppImage 在 Linux 上无法输入中文（IME）的解决方案

> 本文档记录了 SoC Verify 项目在 Rocky 8 / 远程 X11 环境下中文输入法无法工作的完整 debug 过程和最终修复方案。
> 可作为其他 Electron AppImage 项目解决类似问题的参考。

## 问题现象

| 环境 | 详情 |
|------|------|
| 操作系统 | Rocky Linux 8 |
| 连接方式 | 远程 X11（Exceed / XDMCP / SSH -X） |
| 输入法 | IBus（系统自带） |
| DISPLAY | `hostname:display.screen`（远程 X11 转发） |

- ✅ VSCode 的 AI 插件输入框可以输入中文
- ❌ Electron AppImage 的 AI Agent panel 输入框无法输入中文
- ❌ AppImage 启动时有大量 `dbus/bus.cc ERROR` 日志

## 根本原因

问题由 **三个独立因素** 叠加导致：

### 因素 1：IME 环境变量缺失

Electron/Chromium 在 Linux 上通过 GTK/XIM 协议与输入法框架通信，依赖以下环境变量：

| 环境变量 | 作用 |
|----------|------|
| `GTK_IM_MODULE` | GTK 输入法模块选择（ibus / fcitx / xim） |
| `QT_IM_MODULE` | Qt 输入法模块选择 |
| `XMODIFIERS` | X11 输入法修饰符（`@im=ibus`） |

AppImage 从桌面图标启动时，环境变量继承链不完整。这些变量只在 `.bashrc` / `.xprofile` 中设置，非登录 shell 启动的进程拿不到。

VSCode 能输入中文是因为它的启动脚本或 `.desktop` 文件正确传递了这些变量。

### 因素 2：D-Bus session bus 地址缺失

IBus 通过 D-Bus session bus 与 Chromium 通信。需要 `DBUS_SESSION_BUS_ADDRESS` 环境变量。

在远程 X11 环境中：
- 没有 systemd 用户会话 → `/run/user/<uid>/` 不存在
- `DBUS_SESSION_BUS_ADDRESS` 环境变量未设置
- D-Bus 地址存储在 `~/.dbus/session-bus/` 目录的文件中

VSCode 能找到地址（通过 libdbus 自动发现机制），AppImage 不能。

### 因素 3：代码中的 `dbus-launch` 启动了新总线

原代码在检测到 `DBUS_SESSION_BUS_ADDRESS` 未设置时，直接调用 `dbus-launch` 启动了一个**全新的、独立的** D-Bus session bus。IBus 绑定在系统原有的总线上，不在这个新总线上，所以 Chromium 连到了一个空总线——D-Bus 报错消失了但 IBus 输入法不工作。

## Debug 过程

### 步骤 1：设置 IME 环境变量

```bash
# 确认输入法框架
ps aux | grep -E 'ibus|fcitx' | grep -v grep

# 设置 IME 环境变量
export GTK_IM_MODULE=ibus
export QT_IM_MODULE=ibus
export XMODIFIERS=@im=ibus
./app.AppImage
```

**结果**：仍然无法输入中文。

### 步骤 2：排查 D-Bus 连接

```bash
# 检查 D-Bus 环境变量
echo $DBUS_SESSION_BUS_ADDRESS
# 输出为空 — 未设置

# 检查 systemd session bus
ls -la /run/user/$(id -u)/bus
# No such file or directory — 远程 X11 无 systemd 用户会话

# 检查 X11 root window 属性
xprop -root DBUS_SESSION_BUS_ADDRESS
# no such atom on any window — X11 属性中也没有
```

**发现**：`~/.dbus/session-bus/` 目录中有文件，D-Bus 地址存储在这里。

### 步骤 3：用 dbus-launch 启动新总线

```bash
dbus-launch
# 输出: DBUS_SESSION_BUS_ADDRESS=unix:abstract=/tmp/dbus-XXX,guid=XXX
#       DBUS_SESSION_BUS_PID=12345

export DBUS_SESSION_BUS_ADDRESS="unix:abstract=/tmp/dbus-XXX,guid=XXX"
./app.AppImage
```

**结果**：D-Bus 报错消失了，但仍然无法输入中文——因为新总线上没有 IBus 服务。

### 步骤 4：重新配置 IBus + 使用正确地址

```bash
# 重新配置 IBus（修复 D-Bus 连接）
ibus-setup

# 获取 IBus 所在总线的地址
dbus-launch --autolaunch
# 或查看 ibus-daemon 进程的环境变量
cat /proc/$(pgrep ibus-daemon)/environ | tr '\0' '\n' | grep DBUS

# 用正确地址启动
export DBUS_SESSION_BUS_ADDRESS="<IBus所在总线的地址>"
export GTK_IM_MODULE=ibus
export QT_IM_MODULE=ibus
export XMODIFIERS=@im=ibus
./app.AppImage --no-sandbox
```

**结果**：✅ 可以输入中文了！

## 代码修复方案

在 Electron 主进程入口文件中添加两个初始化函数，在 `app.whenReady()` 之前执行。

### 1. `setupLinuxIme()` — 自动设置 IME 环境变量

```typescript
function setupLinuxIme(): void {
  if (process.platform !== 'linux') return;

  // 如果已经正确设置了，不要覆盖用户配置
  const alreadyConfigured = process.env['GTK_IM_MODULE'] && process.env['XMODIFIERS'];
  if (alreadyConfigured) return;

  // 检测系统正在使用的输入法框架
  let imModule = 'ibus'; // RHEL/Rocky 系默认
  try {
    const env = process.env;
    if (env['XMODIFIERS']?.includes('fcitx') || env['GTK_IM_MODULE'] === 'fcitx') {
      imModule = 'fcitx';
    } else if (env['XMODIFIERS']?.includes('ibus') || env['GTK_IM_MODULE'] === 'ibus') {
      imModule = 'ibus';
    } else {
      // 通过检测运行中的进程来判断
      const psOutput = execSync('ps -e -o comm=', {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      if (psOutput.includes('fcitx')) {
        imModule = 'fcitx';
      } else if (psOutput.includes('ibus')) {
        imModule = 'ibus';
      }
    }
  } catch {
    // 检测失败时使用默认值 ibus
  }

  if (!process.env['GTK_IM_MODULE']) process.env['GTK_IM_MODULE'] = imModule;
  if (!process.env['QT_IM_MODULE']) process.env['QT_IM_MODULE'] = imModule;
  if (!process.env['XMODIFIERS']) process.env['XMODIFIERS'] = `@im=${imModule}`;
}
```

### 2. `setupLinuxDbus()` — 多层 D-Bus 地址发现

```typescript
function setupLinuxDbus(): void {
  if (process.platform !== 'linux') return;

  // 1. 环境变量已设置
  const currentAddr = process.env['DBUS_SESSION_BUS_ADDRESS'];
  if (currentAddr && currentAddr.startsWith('unix:')) return;

  // 2. systemd socket (/run/user/<uid>/bus)
  //    — 本地桌面环境
  try {
    const uid = process.getuid?.() ?? parseInt(
      execSync('id -u', { encoding: 'utf-8', timeout: 2000 }).trim()
    );
    const systemdBusPath = `/run/user/${uid}/bus`;
    if (existsSync(systemdBusPath)) {
      process.env['DBUS_SESSION_BUS_ADDRESS'] = `unix:path=${systemdBusPath}`;
      return;
    }
  } catch {}

  // 3. ~/.dbus/session-bus/ 目录
  //    — 远程 X11 环境（关键！）
  try {
    const homeDir = process.env['HOME'];
    if (homeDir) {
      const sessionBusDir = join(homeDir, '.dbus', 'session-bus');
      if (existsSync(sessionBusDir)) {
        const files = readdirSync(sessionBusDir)
          .map(f => ({
            name: f,
            path: join(sessionBusDir, f),
            mtime: statSync(join(sessionBusDir, f)).mtime.getTime()
          }))
          .sort((a, b) => b.mtime - a.mtime);

        for (const file of files) {
          const content = readFileSync(file.path, 'utf-8');
          const match = content.match(/^DBUS_SESSION_BUS_ADDRESS=(.+?);?\s*$/m);
          if (match) {
            let addr = match[1].replace(/;$/, '').trim();
            // 去除引号
            if ((addr.startsWith("'") && addr.endsWith("'")) ||
                (addr.startsWith('"') && addr.endsWith('"'))) {
              addr = addr.slice(1, -1);
            }
            if (addr.startsWith('unix:')) {
              // 验证 PID 存活
              const pidMatch = content.match(/^DBUS_SESSION_BUS_PID=(\d+)/m);
              if (pidMatch) {
                const pid = parseInt(pidMatch[1], 10);
                try {
                  process.kill(pid, 0); // 检查进程存活
                  process.env['DBUS_SESSION_BUS_ADDRESS'] = addr;
                  return;
                } catch { continue; } // 死 PID，跳过
              }
              process.env['DBUS_SESSION_BUS_ADDRESS'] = addr;
              return;
            }
          }
        }
      }
    }
  } catch {}

  // 4. X11 root window 属性 (xprop)
  try {
    const xpropOutput = execSync('xprop -root DBUS_SESSION_BUS_ADDRESS', {
      encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
    });
    const match = xpropOutput.match(/=\s*"(.+?)"/);
    if (match && match[1].startsWith('unix:')) {
      process.env['DBUS_SESSION_BUS_ADDRESS'] = match[1];
      return;
    }
  } catch {}

  // 5. dbus-launch --autolaunch（从 X11/文件自动发现）
  // 6. dbus-launch --sh-syntax（最后手段，启动新总线）
  // 7. 抑制日志
}
```

### 调用顺序

```typescript
// 在 app.whenReady() 之前、模块顶层调用
setupLinuxIme();
setupLinuxDbus();
```

## D-Bus 地址发现策略优先级

| 优先级 | 方法 | 适用环境 |
|--------|------|----------|
| 1 | `DBUS_SESSION_BUS_ADDRESS` 环境变量 | 终端启动 / 已正确配置的桌面 |
| 2 | `/run/user/<uid>/bus` (systemd) | 本地桌面（Ubuntu/CentOS/Rocky） |
| 3 | `~/.dbus/session-bus/` 目录文件 | **远程 X11 / Exceed / XDMCP** ★ |
| 4 | `xprop -root` (X11 root window 属性) | 部分远程 X11 环境 |
| 5 | `dbus-launch --autolaunch` | 自动发现或启动 |
| 6 | `dbus-launch --sh-syntax` | 最后手段（会启动新总线） |
| 7 | `--log-level=3` 抑制日志 | 完全无 D-Bus |

## 桌面永久解决方案

### 方案 A：代码层面（推荐，重新打包 AppImage）

将上述两个函数加入 Electron 主进程入口文件，重新打包 AppImage。代码会在 Chromium 初始化前自动设置环境变量和 D-Bus 地址，桌面图标启动也能正常工作。

### 方案 B：系统层面（不修改代码）

#### 1. 配置 IBus

```bash
# 运行 IBus 配置工具
ibus-setup
```

#### 2. 设置全局环境变量

在 `~/.xprofile` 或 `~/.xinitrc` 中添加（X11 会话启动时执行）：

```bash
export GTK_IM_MODULE=ibus
export QT_IM_MODULE=ibus
export XMODIFIERS=@im=ibus
```

#### 3. 创建 .desktop 文件

```ini
[Desktop Entry]
Name=Your App
Exec=env GTK_IM_MODULE=ibus QT_IM_MODULE=ibus XMODIFIERS=@im=ibus /path/to/app.AppImage
Type=Application
Icon=your-app
Categories=Development;
```

#### 4. 确保 D-Bus session bus 可用

```bash
# 如果 dbus-launch 不在 PATH 中
# Rocky 8: yum install dbus-tools

# 确认 ~/.dbus/session-bus/ 目录存在
ls ~/.dbus/session-bus/
```

## 给其他 AI 的修复指南

如果你的 Electron 项目在 Linux 上有类似的中文输入法问题，按以下步骤修复：

1. **在主进程入口文件顶部**（`app.whenReady()` 之前）添加 `setupLinuxIme()` 和 `setupLinuxDbus()` 两个函数
2. **调用顺序**：先 `setupLinuxIme()`，再 `setupLinuxDbus()`
3. **关键点**：
   - `setupLinuxIme()` 必须在 Chromium 初始化前设置 `GTK_IM_MODULE` 等变量
   - `setupLinuxDbus()` 必须优先发现已有的 session bus（特别是 `~/.dbus/session-bus/`），而不是用 `dbus-launch` 启动新总线
   - 新总线没有 IBus 服务，必须连接到 IBus 所在的已有总线
4. **远程 X11 环境**的特殊处理：`~/.dbus/session-bus/` 目录是 D-Bus 地址的存储位置，需要遍历文件、验证 PID 存活、找到活跃的总线

## 排查命令速查表

```bash
# 确认输入法框架
ps aux | grep -E 'ibus|fcitx' | grep -v grep

# 确认 IME 环境变量
echo "GTK_IM_MODULE=$GTK_IM_MODULE"
echo "QT_IM_MODULE=$QT_IM_MODULE"
echo "XMODIFIERS=$XMODIFIERS"

# 确认 D-Bus 地址
echo "DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS"

# 检查 systemd session bus
ls /run/user/`id -u`/bus 2>/dev/null

# 检查 ~/.dbus/session-bus/
ls ~/.dbus/session-bus/ 2>/dev/null
cat ~/.dbus/session-bus/* 2>/dev/null | grep DBUS_SESSION_BUS_ADDRESS

# 检查 X11 属性
xprop -root DBUS_SESSION_BUS_ADDRESS 2>/dev/null

# 查看 ibus-daemon 进程的 D-Bus 地址
cat /proc/`pgrep ibus-daemon`/environ 2>/dev/null | tr '\0' '\n' | grep DBUS

# 检查 GTK immodule
ls /usr/lib64/gtk-3.0/3.0.0/immodules/ 2>/dev/null
cat /usr/lib64/gtk-3.0/3.0.0/immodules.cache 2>/dev/null | grep ibus
```
