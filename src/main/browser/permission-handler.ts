/**
 * permission-handler — default permission policy for Browser sessions.
 *
 * Issue #10: 摄像头、麦克风、通知、地理位置和自动播放默认拒绝并提示。
 *             剪贴板只允许用户手势触发的读写。
 *
 * Policy: default-deny for all permissions. No permission is auto-granted.
 * The renderer can show a prompt if needed, but the main process always
 * starts from a denied state.
 */

/** Permissions that are explicitly denied by default. */
export const DENIED_PERMISSIONS = [
  'camera',
  'microphone',
  'audioCapture',
  'videoCapture',
  'notifications',
  'geolocation',
  'media-keysystem',
  'midi',
  'clipboard-read',
  'clipboard-sanitized-write',
  'openExternal',
  'fileSystem',
  'pointerLock',
  'fullscreen',
] as const;

/** Permission response: 'denied' or 'granted'. */
export type PermissionResponse = 'denied' | 'granted';

/**
 * Get the default permission response for a permission type.
 *
 * Returns 'denied' for all known and unknown permissions.
 * This is a default-deny policy: nothing is auto-granted.
 */
export function getDefaultPermissionResponse(_permission: string): PermissionResponse {
  // Default-deny: all permissions are denied, including unknown ones.
  // The renderer can show a user prompt if needed, but the main process
  // never auto-grants any permission.
  return 'denied';
}
