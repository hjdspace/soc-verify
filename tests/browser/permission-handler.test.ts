/**
 * permission-handler tests — default permission policy for Browser sessions.
 *
 * Seam: pure function getDefaultPermissionResponse(permissionType).
 *
 * Tests verify:
 * - Camera, microphone, notifications, geolocation, autoplay → 'denied'
 * - Clipboard read/write → 'denied' (must be user-gesture triggered)
 * - File system access → 'denied'
 * - Unknown permissions → 'denied' (default-deny policy)
 */
import { describe, it, expect } from 'vitest';
import { getDefaultPermissionResponse, DENIED_PERMISSIONS } from '../../src/main/browser/permission-handler';

describe('getDefaultPermissionResponse', () => {
  it('denies camera', () => {
    expect(getDefaultPermissionResponse('camera')).toBe('denied');
  });

  it('denies microphone', () => {
    expect(getDefaultPermissionResponse('microphone')).toBe('denied');
  });

  it('denies notifications', () => {
    expect(getDefaultPermissionResponse('notifications')).toBe('denied');
  });

  it('denies geolocation', () => {
    expect(getDefaultPermissionResponse('geolocation')).toBe('denied');
  });

  it('denies media-keysystem (autoplay DRM)', () => {
    expect(getDefaultPermissionResponse('media-keysystem')).toBe('denied');
  });

  it('denies audio capture', () => {
    expect(getDefaultPermissionResponse('audioCapture')).toBe('denied');
  });

  it('denies video capture', () => {
    expect(getDefaultPermissionResponse('videoCapture')).toBe('denied');
  });

  it('denies midi', () => {
    expect(getDefaultPermissionResponse('midi')).toBe('denied');
  });

  it('denies clipboard-read', () => {
    expect(getDefaultPermissionResponse('clipboard-read')).toBe('denied');
  });

  it('denies clipboard-sanitized-write', () => {
    expect(getDefaultPermissionResponse('clipboard-sanitized-write')).toBe('denied');
  });

  it('denies unknown permissions (default-deny)', () => {
    expect(getDefaultPermissionResponse('some-future-permission')).toBe('denied');
  });

  it('denies openExternal', () => {
    expect(getDefaultPermissionResponse('openExternal')).toBe('denied');
  });

  it('DENIED_PERMISSIONS set contains all expected permissions', () => {
    expect(DENIED_PERMISSIONS).toContain('camera');
    expect(DENIED_PERMISSIONS).toContain('microphone');
    expect(DENIED_PERMISSIONS).toContain('notifications');
    expect(DENIED_PERMISSIONS).toContain('geolocation');
    expect(DENIED_PERMISSIONS).toContain('media-keysystem');
    expect(DENIED_PERMISSIONS).toContain('clipboard-read');
    expect(DENIED_PERMISSIONS).toContain('clipboard-sanitized-write');
  });
});
