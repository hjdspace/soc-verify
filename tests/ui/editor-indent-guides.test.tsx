// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

// We mock @codemirror/view so we can verify ViewPlugin.define is used
// to construct the indent guides extension — this is the seam:
// "the extension is built via a ViewPlugin that renders indent guide lines."
const { mockViewPluginDefine } = vi.hoisted(() => ({
  mockViewPluginDefine: vi.fn(() => ({ __isViewPlugin: true })),
}));

vi.mock('@codemirror/view', () => ({
  ViewPlugin: {
    define: mockViewPluginDefine,
    fromClass: vi.fn(),
  },
  EditorView: {
    decoration: { from: vi.fn(() => vi.fn()), set: vi.fn(() => vi.fn()) },
  },
  Decoration: {
    widget: vi.fn(() => ({ range: vi.fn(() => ({ from: 0 })) })),
    set: vi.fn(() => ({ __decorationSet: true })),
  },
  WidgetType: class {
    toDOM() {
      const el = document.createElement('div');
      el.className = 'cm-indent-guide';
      return el;
    }
  },
}));

import { createIndentGuidesExtension } from '@renderer/components/editor/indent-guides';

describe('createIndentGuidesExtension', () => {
  it('returns a ViewPlugin-based extension', () => {
    const ext = createIndentGuidesExtension();
    expect(ext).toBeDefined();
    expect((ext as Record<string, unknown>).__isViewPlugin).toBe(true);
    expect(mockViewPluginDefine).toHaveBeenCalled();
  });

  it('passes a plugin factory function to ViewPlugin.define', () => {
    createIndentGuidesExtension();
    const calls = mockViewPluginDefine.mock.calls as unknown[][];
    const factoryArg = calls.length > 0 ? calls[calls.length - 1][0] : undefined;
    expect(typeof factoryArg).toBe('function');
  });
});
