import { app, Tray, Menu, nativeImage, BrowserWindow } from 'electron';
import { resolveTrayIcon } from './platform-setup';
import { clearClosePref } from './close-prefs';

// ── 系统托盘管理 ───────────────────────────────────────────────────
// 深模块：封装托盘创建 + 右键菜单 + 点击行为。
// 外部只需 `createTray(win)`，不需要知道图标路径、菜单模板、关闭偏好。

/** External quit flag — set by tray "退出" to allow window close. */
let isQuitting = false;

export function getIsQuitting(): boolean {
  return isQuitting;
}

export function setIsQuitting(value: boolean): void {
  isQuitting = value;
}

/** Create system tray with context menu */
export function createTray(win: BrowserWindow): Tray {
  const iconPath = resolveTrayIcon();
  const image = nativeImage.createFromPath(iconPath);
  const t = new Tray(image);
  t.setToolTip('SoC Verify');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        win.show();
        win.focus();
      }
    },
    {
      label: '隐藏窗口',
      click: () => win.hide()
    },
    { type: 'separator' },
    {
      label: '重置关闭偏好',
      click: () => {
        clearClosePref();
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  t.setContextMenu(contextMenu);

  // Click toggles window visibility
  t.on('click', () => {
    if (win.isVisible() && win.isFocused()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });

  return t;
}
