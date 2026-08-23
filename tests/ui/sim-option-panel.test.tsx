// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SimOptionField } from '@shared/plugin-types';

/**
 * SimOptionPanel（Issue #3）测试：
 * schema 加载与分组卡片渲染、字段值编辑联动、命令预览语法高亮 token、
 * 复制按钮反馈、运行仿真调用 startCaseRun、CASE 缺失警告与按钮禁用、
 * 预设加载下拉与保存、解析回归指令对话框、回归列表文件浏览。
 *
 * Mock 策略与 OptionDock.test.tsx 一致：
 * - trpc: project.getSimOptionsSchema / getSimOptionPresets / saveSimOptionPreset / simulation.pickRegrFile
 * - stores: ui / project / simulation / toast
 */

// ── Mock setup (hoisted) ──────────────────────────────────────

const mockSetSimOption = vi.fn();
const mockSetSimOptions = vi.fn();
const mockStartCaseRun = vi.fn().mockResolvedValue('run-1');

let mockSimOptions: Record<string, unknown> = {};

vi.mock('@renderer/stores/simulation', () => ({
  useSimulationStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      simOptions: mockSimOptions,
      setSimOption: mockSetSimOption,
      setSimOptions: mockSetSimOptions,
      startCaseRun: mockStartCaseRun,
    }),
  ),
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: vi.fn((selector: (s: { currentProjectId: string | null; selectedSubsys: string | null }) => unknown) =>
    selector({
      currentProjectId: 'test-project',
      selectedSubsys: null,
    }),
  ),
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: {
    getState: () => ({
      error: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
    }),
  },
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    project: {
      getSimOptionsSchema: { query: vi.fn().mockResolvedValue({ fields: [] }) },
      getSimOptionPresets: { query: vi.fn().mockResolvedValue({}) },
      saveSimOptionPreset: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
    },
    simulation: {
      pickRegrFile: { mutate: vi.fn().mockResolvedValue({ canceled: true, path: null }) },
    },
  },
}));

// Import after mocks
import { SimOptionPanel } from '@renderer/components/simulation/SimOptionPanel';
import { trpc } from '@renderer/lib/trpc';

// ── Test fixtures ──────────────────────────────────────────────

const mockSchemaFields: SimOptionField[] = [
  { key: 'base', label: 'BASE', type: 'string', default: '', group: '基础参数' },
  { key: 'block', label: 'BLOCK', type: 'string', default: '', group: '基础参数' },
  { key: 'case', label: 'CASE', type: 'string', default: '', group: '基础参数' },
  { key: 'seed', label: 'Random Seed', type: 'number', default: 0, group: '基础参数' },
  { key: 'waveform', label: 'Dump Waveform', type: 'boolean', default: false, group: '波形配置' },
  { key: 'simulator', label: 'Simulator', type: 'enum', enumValues: ['vcs', 'xrun', 'verilator'], default: 'vcs', group: '仿真参数' },
  { key: 'timeout', label: 'Timeout', type: 'string', default: '10000', description: 'Simulation timeout in ms', group: '仿真参数' },
  { key: 'regr_file', label: 'Regr File', type: 'string', default: '', group: '回归测试' },
];

const mockPresets: Record<string, Record<string, unknown>> = {
  'nightly': { base: 'top', block: 'usvp', seed: '12345', cov: true },
};

// ── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockSimOptions = {};
  vi.mocked(trpc.project.getSimOptionsSchema.query).mockResolvedValue({ fields: mockSchemaFields });
  vi.mocked(trpc.project.getSimOptionPresets.query).mockResolvedValue({});
  vi.mocked(trpc.simulation.pickRegrFile.mutate).mockResolvedValue({ canceled: true, path: null });
});

describe('SimOptionPanel schema 加载与分组渲染', () => {
  it('加载 schema 后渲染分组卡片', async () => {
    render(<SimOptionPanel />);

    // Wait for schema to load
    await screen.findByText('BASE');

    // Verify group headers are present
    expect(screen.getByText('基础参数')).toBeInTheDocument();
    expect(screen.getByText('波形配置')).toBeInTheDocument();
    expect(screen.getByText('仿真参数')).toBeInTheDocument();
    expect(screen.getByText('回归测试')).toBeInTheDocument();
  });

  it('标题显示字段数 badge', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('8');

    expect(screen.getByText('8')).toBeInTheDocument();
  });

  it('无 schema 时显示提示', async () => {
    vi.mocked(trpc.project.getSimOptionsSchema.query).mockResolvedValue({ fields: [] });

    render(<SimOptionPanel />);

    await screen.findByText('无仿真选项 schema（需 sim-option-schema 插件）');

    expect(screen.getByText('无仿真选项 schema（需 sim-option-schema 插件）')).toBeInTheDocument();
  });
});

describe('SimOptionPanel 标题动态显示用例名', () => {
  it('未指定 CASE 时标题为 "仿真 Option"', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    expect(screen.getByTestId('sim-option-title').textContent).toBe('仿真 Option');
  });

  it('指定 CASE 时标题显示 "仿真 Option · {caseName}"', async () => {
    mockSimOptions = { case: 'my_test_case' };

    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    expect(screen.getByTestId('sim-option-title').textContent).toBe('仿真 Option · my_test_case');
  });
});

describe('SimOptionPanel 字段渲染与编辑', () => {
  it('渲染 string 字段为 text input', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('Timeout');

    const input = screen.getByPlaceholderText('10000') as HTMLInputElement;
    expect(input.type).toBe('text');
  });

  it('渲染 number 字段为 number input', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('Random Seed');

    const numberInputs = document.querySelectorAll('input[type="number"]');
    expect(numberInputs.length).toBeGreaterThanOrEqual(1);
  });

  it('渲染 boolean 字段为 toggle button', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('Dump Waveform');

    expect(screen.getByText('Dump Waveform')).toBeInTheDocument();
  });

  it('渲染 enum 字段为 select dropdown', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('Simulator');

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select).toBeInTheDocument();

    expect(screen.getByRole('option', { name: 'vcs' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'xrun' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'verilator' })).toBeInTheDocument();
  });

  it('string 字段值变更时调用 setSimOption', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('Timeout');

    const input = screen.getByPlaceholderText('10000') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '30000' } });
    expect(mockSetSimOption).toHaveBeenCalledWith('timeout', '30000');
  });

  it('enum 字段值变更时调用 setSimOption', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('Simulator');

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'xrun' } });

    expect(mockSetSimOption).toHaveBeenCalledWith('simulator', 'xrun');
  });

  it('有 description 的字段显示 (?) 提示', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('Timeout');

    expect(screen.getByText('(?)')).toBeInTheDocument();
  });
});

describe('SimOptionPanel 命令预览', () => {
  it('渲染 runsim 命令预览', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    const cmdPreview = screen.getByTestId('sim-option-cmd-preview');
    expect(cmdPreview.textContent).toContain('runsim');
  });

  it('命令预览随 simOptions 变化（含 base/block/case）', async () => {
    mockSimOptions = { base: 'top', block: 'usvp', case: 'test_001' };

    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    const cmdPreview = screen.getByTestId('sim-option-cmd-preview');
    expect(cmdPreview.textContent).toContain('runsim');
    expect(cmdPreview.textContent).toContain('-base');
    expect(cmdPreview.textContent).toContain('top');
    expect(cmdPreview.textContent).toContain('-block');
    expect(cmdPreview.textContent).toContain('usvp');
    expect(cmdPreview.textContent).toContain('-case');
    expect(cmdPreview.textContent).toContain('test_001');
  });

  it('命令预览 token 分色：base/flag/value 三色 span', async () => {
    mockSimOptions = { base: 'top' };

    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    const cmdPreview = screen.getByTestId('sim-option-cmd-preview');
    // The runsim base token should have the base color class
    const baseSpan = cmdPreview.querySelector('.text-status-pass-foreground');
    expect(baseSpan).not.toBeNull();
    expect(baseSpan!.textContent?.trim()).toBe('runsim');

    // The -base flag token should have the flag color class
    const flagSpans = cmdPreview.querySelectorAll('.text-primary');
    expect(flagSpans.length).toBeGreaterThanOrEqual(1);

    // The "top" value token should have the value color class
    const valueSpans = cmdPreview.querySelectorAll('.text-violet-foreground');
    expect(valueSpans.length).toBeGreaterThanOrEqual(1);
  });
});

describe('SimOptionPanel 复制命令', () => {
  it('复制按钮点击后写入剪贴板并显示"已复制"', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    const copyBtn = screen.getByTestId('sim-option-copy');
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(screen.getByText('已复制')).toBeInTheDocument();
    });
    expect(writeText).toHaveBeenCalled();
  });
});

describe('SimOptionPanel 运行仿真', () => {
  it('渲染运行仿真按钮', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    expect(screen.getByTestId('sim-option-run')).toBeInTheDocument();
    expect(screen.getByText('运行仿真')).toBeInTheDocument();
  });

  it('未指定 CASE 时运行按钮禁用', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    expect(screen.getByTestId('sim-option-run')).toBeDisabled();
  });

  it('未指定 CASE 时显示警告提示', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    expect(screen.getByTestId('sim-option-no-case-hint')).toBeInTheDocument();
    expect(screen.getByText(/未指定 CASE 名称/)).toBeInTheDocument();
  });

  it('指定 CASE 后运行按钮启用，点击调用 startCaseRun', async () => {
    mockSimOptions = { case: 'test_001', base: 'top', block: 'usvp' };

    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    const runBtn = screen.getByTestId('sim-option-run');
    expect(runBtn).not.toBeDisabled();

    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(mockStartCaseRun).toHaveBeenCalledTimes(1);
    });
    expect(mockStartCaseRun).toHaveBeenCalledWith(
      'test-project',
      expect.objectContaining({ name: 'test_001', base: 'top', block: 'usvp' }),
    );
  });

  it('指定 CASE 时不显示警告提示', async () => {
    mockSimOptions = { case: 'test_001' };

    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    expect(screen.queryByTestId('sim-option-no-case-hint')).not.toBeInTheDocument();
  });
});

describe('SimOptionPanel 预设管理', () => {
  it('预设下拉显示已保存预设', async () => {
    vi.mocked(trpc.project.getSimOptionPresets.query).mockResolvedValue(mockPresets);

    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    // Click preset button to open dropdown
    fireEvent.click(screen.getByText('预设'));

    await screen.findByText('nightly');
    expect(screen.getByText('nightly')).toBeInTheDocument();
  });

  it('点击预设项后调用 setSimOptions 加载预设', async () => {
    vi.mocked(trpc.project.getSimOptionPresets.query).mockResolvedValue(mockPresets);

    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    fireEvent.click(screen.getByText('预设'));
    await screen.findByText('nightly');

    fireEvent.click(screen.getByText('nightly'));

    expect(mockSetSimOptions).toHaveBeenCalledWith(mockPresets['nightly']);
  });

  it('保存预设调用 saveSimOptionPreset.mutate', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    // Type preset name
    const presetInput = screen.getByPlaceholderText('预设名称') as HTMLInputElement;
    fireEvent.change(presetInput, { target: { value: 'my-preset' } });

    // Click save button (the one with Save icon)
    const saveBtn = screen.getByTitle('保存当前仿真选项为预设');
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(trpc.project.saveSimOptionPreset.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'test-project', name: 'my-preset' }),
      );
    });
  });

  it('无预设时下拉显示空状态', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    fireEvent.click(screen.getByText('预设'));

    await screen.findByText('暂无已保存的预设');
    expect(screen.getByText('暂无已保存的预设')).toBeInTheDocument();
  });
});

describe('SimOptionPanel 回归列表文件浏览', () => {
  it('regr_file 字段显示浏览按钮', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('Regr File');

    const browseBtn = screen.getByTitle('浏览选择回归列表文件');
    expect(browseBtn).toBeInTheDocument();
  });

  it('点击浏览按钮调用 pickRegrFile.mutate', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('Regr File');

    fireEvent.click(screen.getByTitle('浏览选择回归列表文件'));

    await waitFor(() => {
      expect(trpc.simulation.pickRegrFile.mutate).toHaveBeenCalledWith({ projectId: 'test-project' });
    });
  });

  it('选择文件后调用 setSimOption 更新 regr_file', async () => {
    vi.mocked(trpc.simulation.pickRegrFile.mutate).mockResolvedValue({ canceled: false, path: '/path/to/regression.list' });

    render(<SimOptionPanel />);

    await screen.findByText('Regr File');

    fireEvent.click(screen.getByTitle('浏览选择回归列表文件'));

    await waitFor(() => {
      expect(mockSetSimOption).toHaveBeenCalledWith('regr_file', '/path/to/regression.list');
    });
  });
});

describe('SimOptionPanel 解析回归指令', () => {
  it('回归测试卡片显示"解析指令"按钮', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('解析指令');

    expect(screen.getByText('解析指令')).toBeInTheDocument();
  });

  it('点击解析指令按钮打开对话框', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('解析指令');

    fireEvent.click(screen.getByText('解析指令'));

    expect(screen.getByText('解析回归指令')).toBeInTheDocument();
  });

  it('对话框中输入指令后点击解析调用 parseRunsimCommand 并合并结果', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('解析指令');
    fireEvent.click(screen.getByText('解析指令'));

    // Type the command text
    const textarea = screen.getByPlaceholderText(/可以直接粘贴从网页复制的完整回归指令/);
    fireEvent.change(textarea, { target: { value: 'runsim -base top -block usvp -case test_001' } });

    // Click parse button
    const parseBtn = screen.getByText('解析').closest('button')!;
    fireEvent.click(parseBtn);

    await waitFor(() => {
      expect(mockSetSimOptions).toHaveBeenCalledWith(
        expect.objectContaining({ base: 'top', block: 'usvp', case: 'test_001' }),
      );
    });
  });

  it('对话框可通过取消按钮关闭', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('解析指令');
    fireEvent.click(screen.getByText('解析指令'));

    expect(screen.getByText('解析回归指令')).toBeInTheDocument();

    fireEvent.click(screen.getByText('取消'));

    expect(screen.queryByText('解析回归指令')).not.toBeInTheDocument();
  });
});
