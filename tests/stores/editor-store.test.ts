/**
 * Editor store 测试。
 *
 * 验证 vimEnabled / minimapEnabled 默认值、setter 状态更新、localStorage 持久化读写。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '@renderer/stores/editor';

describe('EditorStore', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset store to default state before each test
    useEditorStore.setState({ vimEnabled: false, minimapEnabled: false });
  });

  // ── vimEnabled ────────────────────────────────────────────────

  it('defaults vimEnabled to false', () => {
    expect(useEditorStore.getState().vimEnabled).toBe(false);
  });

  it('updates vimEnabled to true when setVimEnabled(true) is called', () => {
    useEditorStore.getState().setVimEnabled(true);
    expect(useEditorStore.getState().vimEnabled).toBe(true);
  });

  it('updates vimEnabled to false when setVimEnabled(false) is called', () => {
    useEditorStore.getState().setVimEnabled(true);
    useEditorStore.getState().setVimEnabled(false);
    expect(useEditorStore.getState().vimEnabled).toBe(false);
  });

  it('persists vimEnabled to localStorage key "socverify:editor"', () => {
    useEditorStore.getState().setVimEnabled(true);
    const raw = localStorage.getItem('socverify:editor');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { vimEnabled: boolean };
    expect(parsed.vimEnabled).toBe(true);
  });

  it('persists vimEnabled=false to localStorage', () => {
    useEditorStore.getState().setVimEnabled(true);
    useEditorStore.getState().setVimEnabled(false);
    const raw = localStorage.getItem('socverify:editor');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { vimEnabled: boolean };
    expect(parsed.vimEnabled).toBe(false);
  });

  it('restores vimEnabled from localStorage on initEditor()', () => {
    localStorage.setItem('socverify:editor', JSON.stringify({ vimEnabled: true }));
    useEditorStore.setState({ vimEnabled: false });
    useEditorStore.getState().initEditor();
    expect(useEditorStore.getState().vimEnabled).toBe(true);
  });

  it('restores vimEnabled=false from localStorage on initEditor()', () => {
    localStorage.setItem('socverify:editor', JSON.stringify({ vimEnabled: false }));
    useEditorStore.setState({ vimEnabled: true });
    useEditorStore.getState().initEditor();
    expect(useEditorStore.getState().vimEnabled).toBe(false);
  });

  it('defaults to false when localStorage is empty on initEditor()', () => {
    useEditorStore.setState({ vimEnabled: true });
    useEditorStore.getState().initEditor();
    expect(useEditorStore.getState().vimEnabled).toBe(false);
  });

  it('defaults to false when localStorage has invalid JSON on initEditor()', () => {
    localStorage.setItem('socverify:editor', 'not-valid-json{');
    useEditorStore.setState({ vimEnabled: true });
    useEditorStore.getState().initEditor();
    expect(useEditorStore.getState().vimEnabled).toBe(false);
  });

  // ── minimapEnabled ────────────────────────────────────────────

  it('defaults minimapEnabled to false', () => {
    expect(useEditorStore.getState().minimapEnabled).toBe(false);
  });

  it('updates minimapEnabled to true when setMinimapEnabled(true) is called', () => {
    useEditorStore.getState().setMinimapEnabled(true);
    expect(useEditorStore.getState().minimapEnabled).toBe(true);
  });

  it('updates minimapEnabled to false when setMinimapEnabled(false) is called', () => {
    useEditorStore.getState().setMinimapEnabled(true);
    useEditorStore.getState().setMinimapEnabled(false);
    expect(useEditorStore.getState().minimapEnabled).toBe(false);
  });

  it('persists minimapEnabled to localStorage key "socverify:editor"', () => {
    useEditorStore.getState().setMinimapEnabled(true);
    const raw = localStorage.getItem('socverify:editor');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { minimapEnabled: boolean };
    expect(parsed.minimapEnabled).toBe(true);
  });

  it('persists minimapEnabled=false to localStorage', () => {
    useEditorStore.getState().setMinimapEnabled(true);
    useEditorStore.getState().setMinimapEnabled(false);
    const raw = localStorage.getItem('socverify:editor');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { minimapEnabled: boolean };
    expect(parsed.minimapEnabled).toBe(false);
  });

  it('restores minimapEnabled from localStorage on initEditor()', () => {
    localStorage.setItem('socverify:editor', JSON.stringify({ minimapEnabled: true }));
    useEditorStore.setState({ minimapEnabled: false });
    useEditorStore.getState().initEditor();
    expect(useEditorStore.getState().minimapEnabled).toBe(true);
  });

  it('defaults minimapEnabled to false when localStorage is empty on initEditor()', () => {
    useEditorStore.setState({ minimapEnabled: true });
    useEditorStore.getState().initEditor();
    expect(useEditorStore.getState().minimapEnabled).toBe(false);
  });

  it('preserves both vimEnabled and minimapEnabled in localStorage', () => {
    useEditorStore.getState().setVimEnabled(true);
    useEditorStore.getState().setMinimapEnabled(true);
    const raw = localStorage.getItem('socverify:editor');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { vimEnabled: boolean; minimapEnabled: boolean };
    expect(parsed.vimEnabled).toBe(true);
    expect(parsed.minimapEnabled).toBe(true);
  });

  it('restores both vimEnabled and minimapEnabled from localStorage on initEditor()', () => {
    localStorage.setItem(
      'socverify:editor',
      JSON.stringify({ vimEnabled: true, minimapEnabled: true }),
    );
    useEditorStore.setState({ vimEnabled: false, minimapEnabled: false });
    useEditorStore.getState().initEditor();
    expect(useEditorStore.getState().vimEnabled).toBe(true);
    expect(useEditorStore.getState().minimapEnabled).toBe(true);
  });
});
