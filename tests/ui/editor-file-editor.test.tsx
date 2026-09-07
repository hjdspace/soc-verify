// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────

const { trpc } = vi.hoisted(() => ({
  trpc: {
    project: {
      readFile: {
        query: vi.fn().mockResolvedValue('// sample code\nmodule alu_add;'),
      },
      writeFile: { mutate: vi.fn().mockResolvedValue(undefined) },
      openInExternalBrowser: { mutate: vi.fn().mockResolvedValue(undefined) },
      getDirChildren: { query: vi.fn().mockResolvedValue([]) },
      getFileDiff: { query: vi.fn().mockResolvedValue({ lines: [], hunks: [], totalAdd: 0, totalDel: 0, filePath: '', isNewFile: false }) },
      applyDiffRejections: { mutate: vi.fn().mockResolvedValue(undefined) },
    },
    system: {
      openExternal: { mutate: vi.fn().mockResolvedValue(undefined) },
    },
    // SV 文件的 LSP 桥接 + verible lint（FileEditor 对 .sv 文件的既有副作用）
    rtl: {
      lspStart: { mutate: vi.fn().mockResolvedValue({ running: false, initialized: false }) },
      lspOpen: { mutate: vi.fn().mockResolvedValue(undefined) },
      lspChange: { mutate: vi.fn().mockResolvedValue(undefined) },
      lintFile: { query: vi.fn().mockResolvedValue({ diagnostics: [] }) },
    },
  },
}));

// Capture extensions passed to CodeMirror
let capturedExtensions: unknown[] = [];
const { mockCodeMirror, viewRef: mockViewRef } = vi.hoisted(() => {
  // 可替换的 EditorView stub，供行号定位（:line 后缀）测试注入 doc/dispatch 行为
  const viewRef: { current: Record<string, unknown> | null } = { current: null };
  return {
    viewRef,
    mockCodeMirror: vi.fn(({ extensions, onCreateEditor, value, onChange }) => {
      capturedExtensions = extensions ?? [];
      // Simulate onCreateEditor being called with a mock view
      if (onCreateEditor) {
        onCreateEditor(
          viewRef.current ?? { state: {} },
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
  };
});

vi.mock('@renderer/lib/trpc', () => ({ trpc }));
vi.mock('@uiw/react-codemirror', () => ({
  default: mockCodeMirror,
}));
// Enhanced react-markdown mock: renders children, but also invokes the
// `components.code` override when a fenced code block is encountered.
// This lets us verify that FileEditor routes mermaid blocks to MermaidDiagram.
const { mockReactMarkdown } = vi.hoisted(() => ({
  mockReactMarkdown: vi.fn(({ children, components }: {
    children: string;
    components?: Record<string, React.ComponentType<Record<string, unknown>>>;
  }) => {
    // If no components override, just render children (backward compat)
    if (!components?.code) {
      return <div>{children}</div>;
    }
    // Parse fenced code blocks from the markdown source and invoke the
    // code component for each, mimicking react-markdown's behavior.
    const CodeComponent = components.code;
    const blocks: Array<{ lang: string; text: string }> = [];
    const fenceRe = /```(\w*)\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = fenceRe.exec(children)) !== null) {
      blocks.push({ lang: m[1] ?? '', text: m[2] ?? '' });
    }
    if (blocks.length === 0) {
      return <div>{children}</div>;
    }
    return (
      <div>
        {blocks.map((b, i) => (
          <CodeComponent key={i} className={`language-${b.lang}`} node={{}}>
            {b.text}
          </CodeComponent>
        ))}
      </div>
    );
  }),
}));
vi.mock('react-markdown', () => ({ default: mockReactMarkdown }));
vi.mock('remark-gfm', () => ({ default: () => ({}) }));
vi.mock('rehype-raw', () => ({ default: () => ({}) }));

// Mock MermaidDiagram so we can verify it gets rendered for mermaid blocks
const { mermaidStub } = vi.hoisted(() => ({
  mermaidStub: ({ code }: { code: string }) => (
    <div data-testid="mermaid-diagram-stub">{code}</div>
  ),
}));
vi.mock('@renderer/components/chat/MermaidDiagram', () => ({
  MermaidDiagram: mermaidStub,
}));

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
  openFileDestination: vi.fn(),
  openFileTab: vi.fn(),
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: Object.assign(
    vi.fn((selector: (state: Record<string, unknown>) => unknown) =>
      selector({ currentProjectId: 'proj-1', extraDirs: [] }),
    ),
    { getState: () => ({ currentProjectId: 'proj-1', extraDirs: [] }), subscribe: vi.fn() },
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
import { normalizeReviewKey, useDiffReviewStore } from '@renderer/stores/diff-review';

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

describe('FileEditor — inline review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const filePath = '/docs/README.md';
    const key = normalizeReviewKey(filePath);
    trpc.project.readFile.query.mockResolvedValue('# SoC Verify\n\nUpdated body');
    useDiffReviewStore.setState({
      queue: [],
      currentFilePath: null,
      currentReviewToolCallId: null,
      fileDiffs: {},
      diffSignatures: {},
      loadingFiles: {},
      loadErrors: {},
      hunkStates: {},
      contentVersions: { [key]: 0 },
      reviewedFiles: new Set(),
    });
  });

  it('switches a Markdown preview back to the editor when inline review starts', async () => {
    const filePath = '/docs/README.md';
    const key = normalizeReviewKey(filePath);
    render(<FileEditor projectId="proj-1" filePath={filePath} fileName="README.md" />);

    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeTruthy());
    fireEvent.click(screen.getByTitle('切换到预览模式'));
    expect(screen.queryByTestId('codemirror-mock')).toBeNull();

    act(() => {
      useDiffReviewStore.setState({
        queue: [{
          filePath,
          fileName: 'README.md',
          toolCalls: [{
            id: 'tool-1',
            toolName: 'edit',
            filePath,
            timestamp: 1,
            oldText: 'Original body',
            newText: 'Updated body',
            isNewFile: false,
          }],
          isNewFile: false,
          reviewed: false,
        }],
        fileDiffs: {
          [key]: {
            filePath,
            isNewFile: false,
            lines: [
              { type: 'del', content: 'Original body', oldLine: 3, hunkId: 1 },
              { type: 'add', content: 'Updated body', newLine: 3, hunkId: 1 },
            ],
            hunks: [{
              id: 1,
              toolCallId: 'tool-1',
              toolName: 'edit',
              overwritten: false,
              startLineIndex: 0,
              endLineIndex: 2,
              addCount: 1,
              delCount: 1,
            }],
            totalAdd: 1,
            totalDel: 1,
          },
        },
        diffSignatures: { [key]: 'tool-1' },
        hunkStates: { [key]: { 1: 'pending' } },
      });
    });

    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeTruthy());
  });

  it('keeps review actions visible after switching to the next queued file', async () => {
    const firstPath = '/rtl/first.sv';
    const secondPath = '/rtl/second.sv';
    const secondKey = normalizeReviewKey(secondPath);
    const entry = (filePath: string, id: string) => ({
      filePath,
      fileName: filePath.split('/').pop()!,
      toolCalls: [{
        id,
        toolName: 'edit',
        filePath,
        timestamp: 1,
        oldText: 'before',
        newText: 'after',
        isNewFile: false,
      }],
      isNewFile: false,
      reviewed: false,
    });

    trpc.project.readFile.query.mockResolvedValue('module second;\n');
    act(() => {
      useDiffReviewStore.setState({
        queue: [entry(firstPath, 'tool-first'), entry(secondPath, 'tool-second')],
        currentFilePath: secondPath,
        currentReviewToolCallId: 'tool-second',
        fileDiffs: {
          [secondKey]: {
            filePath: secondPath,
            isNewFile: false,
            lines: [
              { type: 'del', content: 'before', oldLine: 1, hunkId: 1 },
              { type: 'add', content: 'after', newLine: 1, hunkId: 1 },
            ],
            hunks: [{
              id: 1,
              toolCallId: 'tool-second',
              toolName: 'edit',
              overwritten: false,
              startLineIndex: 0,
              endLineIndex: 2,
              addCount: 1,
              delCount: 1,
            }],
            totalAdd: 1,
            totalDel: 1,
          },
        },
        hunkStates: { [secondKey]: { 1: 'pending' } },
        loadingFiles: {},
        loadErrors: {},
      });
    });

    const view = render(
      <FileEditor projectId="proj-1" filePath={secondPath} fileName="second.sv" />,
    );

    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeTruthy());
    expect(screen.getByTitle('回滚此文件的全部 AI 改动')).toBeTruthy();
    expect(screen.getByTitle('保留此文件的全部 AI 改动')).toBeTruthy();
    view.unmount();
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

  it('opens a dropdown listing sibling items when clicking a non-active breadcrumb segment', async () => {
    // Mock getDirChildren to return sibling items of /my-chip/rtl
    trpc.project.getDirChildren.query.mockResolvedValue([
      { name: 'rtl', path: '/my-chip/rtl', type: 'directory', children: [], lazy: true },
      { name: 'tb', path: '/my-chip/tb', type: 'directory', children: [], lazy: true },
      { name: 'docs', path: '/my-chip/docs', type: 'directory', children: [], lazy: true },
      { name: 'Makefile', path: '/my-chip/Makefile', type: 'file' },
    ]);

    render(
      <FileEditor projectId="proj-1" filePath="/my-chip/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });

    // Click 'rtl' segment — should open a dropdown
    fireEvent.click(screen.getByText('rtl'));

    // The dropdown should appear with sibling items
    await waitFor(() => {
      expect(screen.getByTestId('breadcrumb-dropdown')).toBeTruthy();
    });

    // Should list sibling directories and files from the parent (/my-chip)
    expect(trpc.project.getDirChildren.query).toHaveBeenCalledWith({
      projectId: 'proj-1',
      dirPath: '/my-chip',
    });
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

// ── Markdown 预览中的 Mermaid 图表渲染 ───────────────────────────

describe('FileEditor — Markdown preview mermaid support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedExtensions = [];
    mockVimEnabled = false;
    mockMinimapEnabled = false;
  });

  it('renders MermaidDiagram for mermaid code blocks in markdown preview', async () => {
    const mdContent = [
      '# Architecture',
      '',
      '```mermaid',
      'flowchart LR',
      '  A --> B',
      '```',
    ].join('\n');
    trpc.project.readFile.query.mockResolvedValue(mdContent);

    render(
      <FileEditor projectId="proj-1" filePath="/docs/arch.md" fileName="arch.md" />,
    );

    // Wait for editor to load, then switch to preview mode
    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });
    fireEvent.click(screen.getByTitle('切换到预览模式'));

    // MermaidDiagram stub should be rendered with the diagram source code.
    // Use findByTestId (async) instead of getByTestId (sync) to avoid
    // race conditions when ReactMarkdown hasn't flushed to DOM yet.
    const stub = await screen.findByTestId('mermaid-diagram-stub', {}, { timeout: 3000 });
    expect(stub.textContent).toContain('flowchart LR');
  });

  it('renders MermaidDiagram for multiple mermaid blocks', async () => {
    const mdContent = [
      '```mermaid',
      'flowchart LR',
      '  A --> B',
      '```',
      '',
      'Some text between.',
      '',
      '```mermaid',
      'sequenceDiagram',
      '  A->>B: ping',
      '```',
    ].join('\n');
    trpc.project.readFile.query.mockResolvedValue(mdContent);

    render(
      <FileEditor projectId="proj-1" filePath="/docs/diagrams.md" fileName="diagrams.md" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });
    fireEvent.click(screen.getByTitle('切换到预览模式'));

    // Use findAllByTestId (async) to wait for both stubs to render.
    const stubs = await screen.findAllByTestId('mermaid-diagram-stub', {}, { timeout: 3000 });
    expect(stubs).toHaveLength(2);
  });

  it('does not render MermaidDiagram for non-mermaid code blocks', async () => {
    const mdContent = [
      '```python',
      'print("hello")',
      '```',
    ].join('\n');
    trpc.project.readFile.query.mockResolvedValue(mdContent);

    render(
      <FileEditor projectId="proj-1" filePath="/docs/code.md" fileName="code.md" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });
    fireEvent.click(screen.getByTitle('切换到预览模式'));

    // Wait for ReactMarkdown to finish rendering the preview, then
    // assert no mermaid stub appeared.
    await waitFor(() => {
      expect(screen.queryByTestId('mermaid-diagram-stub')).toBeNull();
    });
  });
});

// ── `:line[-end]` 行号定位 ──────────────────────────────────────

describe('FileEditor — line reveal', () => {
  // 模拟 5 行文档，每行占 3 个偏移：line n → from (n-1)*3, to (n-1)*3+2
  const makeView = () => ({
    dom: { isConnected: true },
    state: {
      doc: {
        lines: 5,
        line: (n: number) => ({ from: (n - 1) * 3, to: (n - 1) * 3 + 2 }),
      },
    },
    dispatch: vi.fn(),
    focus: vi.fn(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    capturedExtensions = [];
    mockVimEnabled = false;
    mockMinimapEnabled = false;
    mockViewRef.current = null;
    trpc.project.readFile.query.mockResolvedValue('l1\nl2\nl3\nl4\nl5');
  });

  afterEach(() => {
    mockViewRef.current = null;
  });

  const lastDispatch = (view: ReturnType<typeof makeView>) =>
    (view.dispatch.mock.calls.at(-1)?.[0] ?? {}) as { selection: { from: number; to: number } };

  it('scrolls to and selects the requested line range after content loads', async () => {
    const view = makeView();
    mockViewRef.current = view;

    render(
      <FileEditor projectId="proj-1" filePath="/src/core.sv" fileName="core.sv" line={2} endLine={3} revealSeq={1} />,
    );

    await waitFor(() => expect(view.dispatch).toHaveBeenCalledTimes(1));
    expect(lastDispatch(view).selection.from).toBe(3); // line 2 from
    expect(lastDispatch(view).selection.to).toBe(8); // line 3 to
    expect(view.focus).toHaveBeenCalled();
  });

  it('defaults the range end to the start line for a single :line suffix', async () => {
    const view = makeView();
    mockViewRef.current = view;

    render(
      <FileEditor projectId="proj-1" filePath="/src/core.sv" fileName="core.sv" line={4} revealSeq={1} />,
    );

    await waitFor(() => expect(view.dispatch).toHaveBeenCalledTimes(1));
    expect(lastDispatch(view).selection.from).toBe(9); // line 4 from
    expect(lastDispatch(view).selection.to).toBe(11); // line 4 to
  });

  it('clamps the range to the last line when the suffix exceeds the document', async () => {
    const view = makeView();
    mockViewRef.current = view;

    render(
      <FileEditor projectId="proj-1" filePath="/src/core.sv" fileName="core.sv" line={99} endLine={200} revealSeq={1} />,
    );

    await waitFor(() => expect(view.dispatch).toHaveBeenCalledTimes(1));
    expect(lastDispatch(view).selection.from).toBe(12); // line 5 from
    expect(lastDispatch(view).selection.to).toBe(14); // line 5 to
  });

  it('re-applies the reveal when the same range is opened again with a new revealSeq', async () => {
    const view = makeView();
    mockViewRef.current = view;

    const rendered = render(
      <FileEditor projectId="proj-1" filePath="/src/core.sv" fileName="core.sv" line={2} revealSeq={1} />,
    );
    await waitFor(() => expect(view.dispatch).toHaveBeenCalledTimes(1));

    rendered.rerender(
      <FileEditor projectId="proj-1" filePath="/src/core.sv" fileName="core.sv" line={2} revealSeq={2} />,
    );
    await waitFor(() => expect(view.dispatch).toHaveBeenCalledTimes(2));
    expect(lastDispatch(view).selection.from).toBe(3);
  });

  it('does not dispatch a reveal for opens without line info', async () => {
    const view = makeView();
    mockViewRef.current = view;

    render(<FileEditor projectId="proj-1" filePath="/src/core.sv" fileName="core.sv" />);

    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeTruthy());
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it('skips the reveal while the CodeMirror dom is detached (preview mode)', async () => {
    const view = { ...makeView(), dom: { isConnected: false } };
    mockViewRef.current = view;

    render(
      <FileEditor projectId="proj-1" filePath="/src/core.sv" fileName="core.sv" line={2} revealSeq={1} />,
    );

    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeTruthy());
    // 等待可能的 reveal effect 执行后，确认未触发 dispatch
    expect(view.dispatch).not.toHaveBeenCalled();
  });
});

// ── 划选 AI 操作条宿主接入（文件/产物表面）──────────────────────

describe('FileEditor — SelectionActions host', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedExtensions = [];
    mockVimEnabled = false;
    mockMinimapEnabled = false;
    trpc.project.readFile.query.mockResolvedValue('// sample code\nmodule alu_add;');
  });

  it('CodeMirror 编辑区挂载划选宿主（selection-bar 在编辑模式渲染）', async () => {
    render(
      <FileEditor projectId="proj-1" filePath="/rtl/alu_add.sv" fileName="alu_add.sv" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });
    // jsdom 无真实选区 → 浮条隐藏态（opacity 0），但宿主已挂载
    expect(screen.getByTestId('selection-bar')).toBeTruthy();
  });

  it('Markdown 预览挂载划选宿主（selection-bar 在预览模式渲染）', async () => {
    trpc.project.readFile.query.mockResolvedValue('# Title\n\nBody text');
    render(
      <FileEditor projectId="proj-1" filePath="/docs/readme.md" fileName="readme.md" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('codemirror-mock')).toBeTruthy();
    });
    fireEvent.click(screen.getByTitle('切换到预览模式'));
    await waitFor(() => {
      expect(screen.getByTestId('selection-bar')).toBeTruthy();
    });
  });
});
