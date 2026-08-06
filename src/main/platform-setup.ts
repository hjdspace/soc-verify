import { app } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Chromium 日志级别抑制 ──────────────────────────────────────────
// Chromium 在 Windows 上通过 NetworkChangeNotifierWin 使用
// WSALookupServiceBegin (Winsock API) 轮询网络接口变化。
// 当网络适配器变化、VPN 连接/断开、无线网络扫描等发生时，
// WSA 查找操作会被取消（错误码 10108 = WSAECANCELLED），
// Chromium 以 LOG(ERROR) 级别记录此日志，导致控制台持续刷屏。
//
// 这是良性日志——WSA 查询被取消是网络变化检测的正常行为，
// 不影响应用功能。设置 Chromium 日志级别为 FATAL (3) 来抑制。
//
// 注意：此设置仅影响 Chromium 内部 LOG() 输出，
//       不影响应用的 console.log / console.error / console.warn。
// log-level: 0=INFO, 1=WARNING, 2=ERROR, 3=FATAL
app.commandLine.appendSwitch('log-level', '3');

// ── Linux 中文输入法（IME）环境变量处理 ─────────────────────────────
// Electron/Chromium 在 Linux 上通过 GTK/XIM 协议与输入法框架通信，
// 依赖 GTK_IM_MODULE / QT_IM_MODULE / XMODIFIERS 环境变量。
// AppImage 的环境变量继承链不完整（尤其从桌面图标启动时），
// 导致中文输入法无法在渲染进程的输入框中工作。
//
// 策略：
//   1. 若环境变量已正确设置 → 不干预
//   2. 若未设置 → 自动检测 IBus/Fcitx 并设置对应变量
//   3. 若检测不到 → 默认回退到 IBus（RHEL/Rocky 系默认）
function setupLinuxIme(): void {
  if (process.platform !== 'linux') return;

  // 如果已经正确设置了，不要覆盖用户配置
  const alreadyConfigured = process.env['GTK_IM_MODULE'] && process.env['XMODIFIERS'];
  if (alreadyConfigured) return;

  // 检测系统正在使用的输入法框架
  let imModule = 'ibus'; // RHEL/Rocky 系默认
  try {
    const env = process.env;
    // 优先检查环境变量中的线索
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

  // 仅在未设置时写入，避免覆盖用户已有配置
  if (!process.env['GTK_IM_MODULE']) {
    process.env['GTK_IM_MODULE'] = imModule;
  }
  if (!process.env['QT_IM_MODULE']) {
    process.env['QT_IM_MODULE'] = imModule;
  }
  if (!process.env['XMODIFIERS']) {
    process.env['XMODIFIERS'] = `@im=${imModule}`;
  }

  console.log(`[ime] set GTK_IM_MODULE=${process.env['GTK_IM_MODULE']}, QT_IM_MODULE=${process.env['QT_IM_MODULE']}, XMODIFIERS=${process.env['XMODIFIERS']}`);
}

// ── Linux D-Bus 会话总线处理 ───────────────────────────────────────
// Chromium/IBus 都需要 D-Bus session bus 才能正常工作。
// AppImage 从桌面启动时 DBUS_SESSION_BUS_ADDRESS 可能未设置，
// 需要自动检测已有的 session bus 地址——必须连接到 IBus 所在的总线，
// 而不是新建一个空总线（否则 IBus 输入法不工作）。
//
// 策略（优先级从高到低）：
//   1. 若 DBUS_SESSION_BUS_ADDRESS 已设置且有效 → 正常使用
//   2. 检测 systemd 管理的 session bus socket (/run/user/<uid>/bus)
//   3. 检测传统 D-Bus socket (/run/user/<uid>/dbus/session_bus_socket)
//   4. 从 ~/.dbus/session-bus/ 目录读取（远程 X11 / Exceed / XDMCP 环境）
//   5. 从 X11 root window 属性获取（部分远程 X11 环境）
//   6. 通过 `dbus-launch --autolaunch` 获取或启动 session bus
//   7. 通过 `dbus-launch` 启动全新会话总线（最后手段）
//   8. 若以上都不可用 → 抑制 Chromium D-Bus 错误日志
function setupLinuxDbus(): void {
  if (process.platform !== 'linux') return;

  const currentAddr = process.env['DBUS_SESSION_BUS_ADDRESS'];
  if (currentAddr && currentAddr.startsWith('unix:')) {
    return;
  }

  // ── 2. 检测 systemd 管理的 session bus socket ──
  try {
    let uid: string | number;
    const getuid = process.getuid;
    if (typeof getuid === 'function') {
      uid = getuid.call(process);
    } else {
      uid = execSync('id -u', { encoding: 'utf-8', timeout: 2000 }).trim();
    }

    const systemdBusPath = `/run/user/${uid}/bus`;
    if (existsSync(systemdBusPath)) {
      process.env['DBUS_SESSION_BUS_ADDRESS'] = `unix:path=${systemdBusPath}`;
      console.log(`[dbus] using systemd session bus at ${systemdBusPath}`);
      return;
    }

    const legacyBusPath = `/run/user/${uid}/dbus/session_bus_socket`;
    if (existsSync(legacyBusPath)) {
      process.env['DBUS_SESSION_BUS_ADDRESS'] = `unix:path=${legacyBusPath}`;
      console.log(`[dbus] using legacy session bus at ${legacyBusPath}`);
      return;
    }
  } catch {
    // uid 检测失败，继续尝试其他方法
  }

  // ── 3. 从 ~/.dbus/session-bus/ 目录读取 session bus 地址 ──
  // dbus-launch 在启动 session bus 后会在此目录存储地址信息。
  // 远程 X11 环境（Exceed / XDMCP / SSH -X）中，环境变量和 X11 属性
  // 可能都没有 D-Bus 地址，但这个文件里一定有。
  try {
    const homeDir = process.env['HOME'];
    if (homeDir) {
      const sessionBusDir = join(homeDir, '.dbus', 'session-bus');
      if (existsSync(sessionBusDir)) {
        const files = readdirSync(sessionBusDir);
        // 按修改时间降序排列（最新的在前）
        const sortedFiles = files
          .map(f => ({
            name: f,
            path: join(sessionBusDir, f),
            mtime: statSync(join(sessionBusDir, f)).mtime.getTime()
          }))
          .sort((a, b) => b.mtime - a.mtime);

        for (const file of sortedFiles) {
          try {
            const content = readFileSync(file.path, 'utf-8');
            const match = content.match(/^DBUS_SESSION_BUS_ADDRESS=(.+?);?\s*$/m);
            if (match) {
              let addr = match[1].replace(/;$/, '').trim();
              if ((addr.startsWith("'") && addr.endsWith("'")) ||
                  (addr.startsWith('"') && addr.endsWith('"'))) {
                addr = addr.slice(1, -1);
              }
              if (addr.startsWith('unix:')) {
                // 验证对应的 PID 是否仍然存活
                const pidMatch = content.match(/^DBUS_SESSION_BUS_PID=(\d+)/m);
                if (pidMatch) {
                  const pid = parseInt(pidMatch[1], 10);
                  try {
                    // 信号 0 不实际发送信号，仅检查进程是否存在
                    process.kill(pid, 0);
                    process.env['DBUS_SESSION_BUS_ADDRESS'] = addr;
                    console.log(`[dbus] using session bus from ~/.dbus/session-bus/${file.name} (pid=${pid})`);
                    return;
                  } catch {
                    console.log(`[dbus] session bus in ${file.name} has dead pid=${pid}, skipping`);
                    continue;
                  }
                }
                // 没有 PID 信息，直接使用地址
                process.env['DBUS_SESSION_BUS_ADDRESS'] = addr;
                console.log(`[dbus] using session bus from ~/.dbus/session-bus/${file.name}`);
                return;
              }
            }
          } catch {
            // 文件读取失败，跳过
          }
        }
      }
    }
  } catch {
    // 目录读取失败，继续尝试其他方法
  }

  // ── 4. 从 X11 root window 属性获取 D-Bus 地址 ──
  // 在远程 X11 环境中，dbus-launch 可能将地址存储在 X11 属性中
  try {
    const xpropOutput = execSync('xprop -root DBUS_SESSION_BUS_ADDRESS', {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // 输出格式: DBUS_SESSION_BUS_ADDRESS(STRING) = "unix:abstract=/tmp/dbus-XXX,guid=XXX"
    const match = xpropOutput.match(/=\s*"(.+?)"/);
    if (match && match[1].startsWith('unix:')) {
      process.env['DBUS_SESSION_BUS_ADDRESS'] = match[1];
      console.log(`[dbus] using session bus from X11 root window property`);
      return;
    }
  } catch {
    // xprop not available or property not set
  }

  // ── 4. 尝试通过 `dbus-launch --autolaunch` 获取或启动 session bus ──
  // --autolaunch 会优先从 X11 属性查找已有总线，找到则返回其地址；
  // 找不到才启动新总线。比 --sh-syntax 更安全。
  try {
    const output = execSync('dbus-launch --autolaunch --sh-syntax', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    for (const line of output.split('\n')) {
      const match = line.match(/^(DBUS_SESSION_BUS_\w+)=(.+?);?\s*$/);
      if (match) {
        let value = match[2].replace(/;$/, '').trim();
        if ((value.startsWith("'") && value.endsWith("'")) ||
            (value.startsWith('"') && value.endsWith('"'))) {
          value = value.slice(1, -1);
        }
        process.env[match[1]] = value;
      }
    }
    if (process.env['DBUS_SESSION_BUS_ADDRESS']) {
      console.log('[dbus] using session bus via dbus-launch --autolaunch');
      return;
    }
  } catch {
    // dbus-launch --autolaunch not available or failed
  }

  // ── 5. 最后手段：通过 `dbus-launch` 启动全新的会话总线 ──
  // 仅在没有已有 session bus 的极端环境（无 X11 的纯 SSH）中使用
  try {
    const output = execSync('dbus-launch --sh-syntax', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    for (const line of output.split('\n')) {
      const match = line.match(/^(DBUS_SESSION_BUS_\w+)=(.+?);?\s*$/);
      if (match) {
        let value = match[2].replace(/;$/, '').trim();
        if ((value.startsWith("'") && value.endsWith("'")) ||
            (value.startsWith('"') && value.endsWith('"'))) {
          value = value.slice(1, -1);
        }
        process.env[match[1]] = value;
      }
    }
    console.log('[dbus] started new session bus via dbus-launch');
    return;
  } catch {
    // dbus-launch not available or failed
  }

  // ── 6. 完全无 D-Bus 可用 → 抑制错误日志 ──
  app.commandLine.appendSwitch('log-level', '3');
  console.log('[dbus] no session bus available; suppressing Chromium D-Bus error logs');
}

/**
 * Linux 平台环境设置：IME 输入法 + D-Bus 会话总线。
 *
 * 深模块：仅在 Linux 平台生效，内部封装 8 级回退策略。
 * 调用方只需一行 `setupLinuxPlatform()`，不需要知道 IMe/D-Bus 细节。
 */
export function setupLinuxPlatform(): void {
  setupLinuxIme();
  setupLinuxDbus();
}

// ── 图标路径解析 ──────────────────────────────────────────────────

/** Resolve tray icon path: prefers build/icons PNG, falls back to icon.ico */
export function resolveTrayIcon(): string {
  const png32 = join(__dirname, '../../build/icons/32x32.png');
  const png16 = join(__dirname, '../../build/icons/16x16.png');
  const ico = join(__dirname, '../../build/icon.ico');
  if (existsSync(png32)) return png32;
  if (existsSync(png16)) return png16;
  return ico;
}

/** Resolve window icon path: prefers icon.ico (native Windows multi-resolution), falls back to large PNG */
export function resolveWindowIcon(): string {
  const ico = join(__dirname, '../../build/icon.ico');
  const png256 = join(__dirname, '../../build/icons/256x256.png');
  const png128 = join(__dirname, '../../build/icons/128x128.png');
  if (existsSync(ico)) return ico;
  if (existsSync(png256)) return png256;
  if (existsSync(png128)) return png128;
  return resolveTrayIcon();
}
