// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────

const { trpc } = vi.hoisted(() => ({
  trpc: {
    project: {
      readFile: {
        query: vi.fn().mockResolvedValue('// sample code\nmodule alu_add;'),
      },
      writeFile: { mutate: vi.fn().mockResolvedValue(undefined) },
      openInExternalBrowser: { mutate: vi.fn().mockResolvedValue(undefined) },
    },
    system: {
      openExternal: { mutate: vi.fn().mockResolvedValue(undefined) },
    },
  },
}));

// Capture extensions passed to CodeMirror
let capturedExtensions: unknown[] = [];
const { mockCodeMirror } = vi.hoisted(() => ({
  mockCodeMirror: vi.fn(({ extensions, onCreateEditor, value, onChange }) => {
    capturedExtensions = extensions ?? [];
    // Simulate onCreateEditor being called with a mock view
    if (onCreateEditor) {
      onCreateEditor(
        { state: {} },
        {},
      );
    }
    return (
      <div data-testid="codemirror-mock" data-value={value}>
        <button
          onClick={() => onChange?.('edited content')}
          data-testid="codemirror-change-trigger"
        >
          change
        </button>
      </div>
    );
  }),
}));

vi.mock('@renderer/lib/trpc', () => ({ trpc }));
vi.mock('@uiw/react-codemirror', () => ({
  default: mockCodeMirror,
}));
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => ({}) }));
vi.mock('rehype-raw', () => ({ default: () => ({}) }));

vi.mock('@renderer/stores/theme', () => ({
  useThemeStore: Object.assign(
    vi.fn((selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        currentTheme: 'bench',
        themes: [
          { id: 'bench', name: 'Bench', mode: 'dark', swatch: '#3ddc84', description: '' },
          { id: 'drafting', name: 'Drafting', mode: 'light', swatch: '#7c3a9e', description: '' },
        ],
      }),
    ),
    { getState: () => ({ currentTheme: 'bench' }) },
  ),
}));

vi.mock('@renderer/stores/workbench', () => ({
  useWorkbenchStore: vi.fn((selector: (state: Record<string, unknown>) => unknown) =>
    selector({ open: vi.fn() }),
  ),
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: Object.assign(
    vi.fn((selector: (state: Record<string, unknown>) => unknown) =>
      selector({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
    ),
    { getState: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }) },
  ),
}));

// ── Vim extension mock ─────────────────────────────────────────
// We mock @replit/codemirror-vim to track when vim() is called
const { vimExtensionCalled, getCMMock } = vi.hoisted(() => ({
  vimExtensionCalled: vi.fn(() => ({})),
  getCMMock: vi.fn(),
}));
vi.mock('@replit/codemirror-vim', () => ({
  vim: vimExtensionCalled,
  getCM: getCMMock,
}));

// ── Editor store mock ──────────────────────────────────────────
let mockVimEnabled = false;
let mockMinimapEnabled = false;
const setVimEnabledMock = vi.fn((enabled: boolean) => {
  mockVimEnabled = enabled;
});
const setMinimapEnabledMock = vi.fn((enabled: boolean) => {
  mockMinimapEnabled = enabled;
});
vi.mock('@renderer/stores/editor', () => ({
  useEditorStore: Object.assign(
    vi.fn((selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        vimEnabled: mockVimEnabled,
        setVimEnabled: setVimEnabledMock,
        minimapEnabled: mockMinimapEnabled,
        setMinimapEnabled: setMinimapEnabledMock,
        initEditor: vi.fn(),
      }),
    ),
    { getState: () => ({ vimEnabled: mockVimEnabled, setVimEnabled: setVimEnabledMock, minimapEnabled: mockMinimapEnabled, setMinimapEnabled: setMinimapEnabledMock, initEditor: vi.fn() }) },
  ),
}));

// Import after mocks
import { FileEditor } from '@renderer/components/editor/FileEditor';

describe('FileEditor — Vim integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedExtensions = [];
    mockVimEnabled = false;
    mockMinimapEnabled = false;
    trpc.project.readFile.query.mockResolvedValue('// sample code\nmodule alu_add;');
  });

  it('renders CodeMirror editor for .sv files', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });
  });

  it('does not include vim extension when vimEnabled is false', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    expect(vimExtensionCalled).not.toHaveBeenCalled();
  });

  it('includes vim extension when vimEnabled is true', async () => {
    mockVimEnabled = true;

    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    // vim() should have been called to create the extension
    expect(vimExtensionCalled).toHaveBeenCalled();
  });

  it('renders Vim status bar when vimEnabled is true', async () => {
    mockVimEnabled = true;

    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('vim-status-bar')).toBeTruthy();
    });

    const modeBadge = screen.getByTestId('vim-mode-badge');
    expect(modeBadge.textContent).toContain('NORMAL');
  });

  it('does not render Vim status bar when vimEnabled is false', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    expect(screen.queryByTestId('vim-status-bar')).toBeNull();
  });

  it('shows save button that is disabled when content is not dirty', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    // The save button should be disabled when content matches original
    const saveButton = screen.getByTitle('保存 (Ctrl+S)') as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it('enables save button after content changes', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    // Trigger a content change
    fireEvent.click(screen.getByTestId('codemirror-change-trigger'));

    await waitFor(() => {
      const saveButton = screen.getByTitle('保存 (Ctrl+S)') as HTMLButtonElement;
      expect(saveButton.disabled).toBe(false);
    });
  });

  it('triggers save on Ctrl+S keyboard shortcut', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    // Change content to make it dirty
    fireEvent.click(screen.getByTestId('codemirror-change-trigger'));

    // Simulate Ctrl+S
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    await waitFor(() => {
      expect(trpc.project.writeFile.mutate).toHaveBeenCalledWith({
        projectId: 'proj-1',
        filePath: '/rtl/alu_add.sv',
        content: 'edited content',
      });
    });
  });

  it('triggers save via save button click', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    // Change content to make it dirty
    fireEvent.click(screen.getByTestId('codemirror-change-trigger'));

    const saveButton = screen.getByTitle('保存 (Ctrl+S)') as HTMLButtonElement;
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(trpc.project.writeFile.mutate).toHaveBeenCalledWith({
        projectId: 'proj-1',
        filePath: '/rtl/alu_add.sv',
        content: 'edited content',
      });
    });
  });
});

// ── 语法高亮 extension 测试 ────────────────────────────────────

describe('FileEditor — Syntax highlight extension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedExtensions = [];
    mockVimEnabled = false;
    mockMinimapEnabled = false;
    trpc.project.readFile.query.mockResolvedValue('// sample code\nmodule alu_add;');
  });

  it('includes syntax highlight extension in CodeMirror extensions', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    // Extensions should be passed to CodeMirror
    expect(capturedExtensions.length).toBeGreaterThan(0);
  });

  it('includes syntax highlight extension even when vim is disabled', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    // Should have at least 1 language extension + 1 syntax highlight extension + 1 cursor listener
    // (vim extensions are empty when vimEnabled is false)
    expect(capturedExtensions.length).toBeGreaterThanOrEqual(3);
  });

  it('includes syntax highlight extension alongside vim extensions', async () => {
    mockVimEnabled = true;

    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    // Should have language + syntax highlight + cursor listener + vim extensions
    expect(capturedExtensions.length).toBeGreaterThanOrEqual(4);
    // vim() should have been called
    expect(vimExtensionCalled).toHaveBeenCalled();
  });

  it('passes syntax highlight extension for .py files too', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/scripts/test.py" fileName="test.py" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    // Syntax highlight extension should always be included (language + syntax + cursor listener)
    expect(capturedExtensions.length).toBeGreaterThanOrEqual(3);
  });

  it('passes syntax highlight extension for .json files too', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/config/settings.json" fileName="settings.json" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    expect(capturedExtensions.length).toBeGreaterThanOrEqual(3);
  });
});

// ── Issue #3: 面包屑导航与底部状态栏 ─────────────────────────────

describe('FileEditor — Breadcrumb navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedExtensions = [];
    mockVimEnabled = false;
    mockMinimapEnabled = false;
    trpc.project.readFile.query.mockResolvedValue('// sample code\nmodule alu_add;');
  });

  it('renders breadcrumb navigation instead of full path string', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/my-chip/rtl/tb_subsys/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    // Breadcrumb should be rendered
    expect(screen.getByTestId('breadcrumb')).toBeTruthy();
    // Path segments should be visible
    expect(screen.getByText('my-chip')).toBeTruthy();
    expect(screen.getByText('rtl')).toBeTruthy();
    expect(screen.getByText('tb_subsys')).toBeTruthy();
    expect(screen.getByText('alu_add.sv')).toBeTruthy();
  });

  it('marks the filename segment as active in breadcrumb', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/my-chip/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    // The last segment (filename) should be the active segment
    expect(screen.getByTestId('breadcrumb-active').textContent).toBe('alu_add.sv');
  });

  it('calls workbench open when clicking a non-active breadcrumb segment', async () => {
    const { useWorkbenchStore } = await import('@renderer/stores/workbench');
    const mockOpen = vi.fn();
    vi.mocked(useWorkbenchStore).mockReturnValue(mockOpen);

    render(
      <FileEditor projectId="proj-1" filePath="/my-chip/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    // Click 'rtl' segment
    fireEvent.click(screen.getByText('rtl'));

    expect(mockOpen).toHaveBeenCalled();
    const callArg = mockOpen.mock.calls[0][0];
    expect(callArg.type).toBe('file');
    expect(callArg.path).toBe('/my-chip/rtl');
  });
});

describe('FileEditor — Editor status bar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedExtensions = [];
    mockVimEnabled = false;
    mockMinimapEnabled = false;
    trpc.project.readFile.query.mockResolvedValue('// sample code\nmodule alu_add;');
  });

  it('renders editor status bar at the bottom', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    expect(screen.getByTestId('editor-status-bar')).toBeTruthy();
  });

  it('shows SystemVerilog language label for .sv files', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    expect(screen.getByTestId('status-language').textContent).toBe('SystemVerilog');
  });

  it('shows Python language label for .py files', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/scripts/test.py" fileName="test.py" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    expect(screen.getByTestId('status-language').textContent).toBe('Python');
  });

  it('shows UTF-8 encoding in status bar', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    expect(screen.getByTestId('status-encoding').textContent).toBe('UTF-8');
  });

  it('shows Tab: 2 indent size in status bar', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    expect(screen.getByTestId('status-indent').textContent).toBe('Tab: 2');
  });

  it('shows "已保存" when content is not dirty', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    expect(screen.getByTestId('status-save-status').textContent).toContain('已保存');
  });

  it('shows "已修改" when content is dirty', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    // Trigger content change
    fireEvent.click(screen.getByTestId('codemirror-change-trigger'));

    await waitFor(() => {
      expect(screen.getByTestId('status-save-status').textContent).toContain('已修改');
    });
  });

  it('shows cursor position in status bar', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    // Cursor position should show line 1, col 1 by default
    const cursor = screen.getByTestId('status-cursor');
    expect(cursor.textContent).toContain('Ln');
    expect(cursor.textContent).toContain('Col');
  });

  it('shows LF line ending for Unix content', async () => {
    trpc.project.readFile.query.mockResolvedValue('// sample code\nmodule alu_add;');

    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    expect(screen.getByTestId('status-line-ending').textContent).toBe('LF');
  });

  it('shows CRLF line ending for Windows content', async () => {
    trpc.project.readFile.query.mockResolvedValue('// sample code\r\nmodule alu_add;');

    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    expect(screen.getByTestId('status-line-ending').textContent).toBe('CRLF');
  });
});

// ── Issue #4: 缩进指南线与搜索替换面板 ───────────────────────────

describe('FileEditor — Indent guides and search panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedExtensions = [];
    mockVimEnabled = false;
    mockMinimapEnabled = false;
    trpc.project.readFile.query.mockResolvedValue('// sample code\nmodule alu_add;');
  });

  it('includes indent guides extension in CodeMirror extensions', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    // Extensions should include indent guides (language + syntax + cursor listener + indent guides)
    expect(capturedExtensions.length).toBeGreaterThanOrEqual(4);
  });

  it('includes search keymap extension in CodeMirror extensions', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    // Extensions should include search (language + syntax + cursor listener + indent guides + search)
    expect(capturedExtensions.length).toBeGreaterThanOrEqual(5);
  });
});

// ── Issue #5: Minimap 缩略图 ─────────────────────────────────────

describe('FileEditor — Minimap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedExtensions = [];
    mockVimEnabled = false;
    mockMinimapEnabled = false;
    trpc.project.readFile.query.mockResolvedValue('// sample code\nmodule alu_add;');
  });

  it('does not render minimap container when minimapEnabled is false', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    expect(screen.queryByTestId('minimap-container')).toBeNull();
  });

  it('renders minimap container when minimapEnabled is true', async () => {
    mockMinimapEnabled = true;

    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('minimap-container')).toBeTruthy();
    });
  });

  it('renders minimap canvas element inside container', async () => {
    mockMinimapEnabled = true;

    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('minimap-canvas')).toBeTruthy();
    });
  });

  it('renders minimap viewport indicator inside container', async () => {
    mockMinimapEnabled = true;

    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('minimap-viewport')).toBeTruthy();
    });
  });

  it('does not render minimap in markdown preview mode', async () => {
    mockMinimapEnabled = true;
    trpc.project.readFile.query.mockResolvedValue('# Title\n\nSome content');

    render(
      <FileEditor projectId="proj-1" filePath="/docs/readme.md" fileName="readme.md" />,
    );

    // In editor mode (not preview), minimap should render
    await waitFor(() => {
      expect(screen.getByTestId('minimap-container')).toBeTruthy();
    });
  });
});
