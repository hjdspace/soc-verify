import { app } from 'electron';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

// ── 关闭方式偏好持久化 ───────────────────────────────────────────
// 用户可选择「完全关闭」或「最小化到托盘」，并记住选择以免每次询问。

export type CloseAction = 'close' | 'tray';

function getClosePrefPath(): string {
  return join(app.getPath('userData'), 'close-pref.json');
}

export function loadClosePref(): CloseAction | null {
  try {
    const data = readFileSync(getClosePrefPath(), 'utf-8');
    const parsed = JSON.parse(data) as { action?: string };
    if (parsed.action === 'close' || parsed.action === 'tray') return parsed.action;
    return null;
  } catch {
    return null;
  }
}

export function saveClosePref(action: CloseAction): void {
  try {
    writeFileSync(getClosePrefPath(), JSON.stringify({ action }, null, 2), 'utf-8');
  } catch (e) {
    console.error('[close-pref] failed to save:', e);
  }
}

export function clearClosePref(): void {
  try {
    const prefPath = getClosePrefPath();
    if (existsSync(prefPath)) unlinkSync(prefPath);
  } catch {
    // ignore errors
  }
}
