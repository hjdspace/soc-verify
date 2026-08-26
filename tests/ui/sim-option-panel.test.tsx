// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SimOptionField } from '@shared/plugin-types';

/**
 * SimOptionPanel（Issue #3）测试：
 * schema 加载与分组卡片渲染、字段值编辑联动、预设加载下拉与保存。
 *
 * 回归测试卡片已删除：回归发起统一收敛到回归页（ADR 0029），
 * 相关测试断言回归分组/解析指令/回归文件浏览不再出现。
 *
 * 命令预览 / 复制 / 运行仿真 / CASE 缺失警告 已移至 SimCommandBar
 * 组件（位于 SimulationView 中栏底部），相关测试见下方独立 describe。
 *
 * Mock 策略：
 * - trpc: project.getSimOptionsSchema / getSimOptionPresets / saveSimOptionPreset
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
  },
}));

// Mock BorderBeam via the visual wrapper
vi.mock('@renderer/components/visual', () => ({
  BorderBeam: ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
    createElement('div', {
      'data-testid': 'border-beam',
      'data-active': String(props.active ?? true),
      'data-size': props.size ?? 'md',
      'data-colorvariant': props.colorVariant ?? 'colorful',
      'data-theme': props.theme ?? 'dark',
    }, children),
}));

// Import after mocks
import { SimOptionPanel } from '@renderer/components/simulation/SimOptionPanel';
import { SimCommandBar } from '@renderer/components/simulation/SimCommandBar';
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
  });

  it('回归测试分组不再渲染（ADR 0029：回归发起收敛到回归页）', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    expect(screen.queryByText('回归测试')).not.toBeInTheDocument();
    expect(screen.queryByText('解析指令')).not.toBeInTheDocument();
    expect(screen.queryByTitle('浏览选择回归列表文件')).not.toBeInTheDocument();
  });

  it('标题显示字段数 badge', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('7');

    expect(screen.getByText('7')).toBeInTheDocument();
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

describe('SimCommandBar 命令预览', () => {
  it('渲染 runsim 命令预览', () => {
    render(<SimCommandBar />);

    const cmdPreview = screen.getByTestId('sim-option-cmd-preview');
    expect(cmdPreview.textContent).toContain('runsim');
  });

  it('命令预览随 simOptions 变化（含 base/block/case）', () => {
    mockSimOptions = { base: 'top', block: 'usvp', case: 'test_001' };

    render(<SimCommandBar />);

    const cmdPreview = screen.getByTestId('sim-option-cmd-preview');
    expect(cmdPreview.textContent).toContain('runsim');
    expect(cmdPreview.textContent).toContain('-base');
    expect(cmdPreview.textContent).toContain('top');
    expect(cmdPreview.textContent).toContain('-block');
    expect(cmdPreview.textContent).toContain('usvp');
    expect(cmdPreview.textContent).toContain('-case');
    expect(cmdPreview.textContent).toContain('test_001');
  });

  it('命令预览 token 分色：base/flag/value 三色 span', () => {
    mockSimOptions = { base: 'top' };

    render(<SimCommandBar />);

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

describe('SimCommandBar 复制命令', () => {
  it('复制按钮点击后写入剪贴板并显示"已复制"', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<SimCommandBar />);

    const copyBtn = screen.getByTestId('sim-option-copy');
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(screen.getByText('已复制')).toBeInTheDocument();
    });
    expect(writeText).toHaveBeenCalled();
  });
});

describe('SimCommandBar 运行仿真', () => {
  it('渲染运行仿真按钮', () => {
    render(<SimCommandBar />);

    expect(screen.getByTestId('sim-option-run')).toBeInTheDocument();
    expect(screen.getByText('运行仿真')).toBeInTheDocument();
  });

  it('未指定 CASE 时运行按钮禁用', () => {
    render(<SimCommandBar />);

    expect(screen.getByTestId('sim-option-run')).toBeDisabled();
  });

  it('未指定 CASE 时显示警告提示', () => {
    render(<SimCommandBar />);

    expect(screen.getByTestId('sim-option-no-case-hint')).toBeInTheDocument();
    expect(screen.getByText(/未指定 CASE 名称/)).toBeInTheDocument();
  });

  it('指定 CASE 后运行按钮启用，点击调用 startCaseRun', async () => {
    mockSimOptions = { case: 'test_001', base: 'top', block: 'usvp' };

    render(<SimCommandBar />);

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

  it('指定 CASE 时不显示警告提示', () => {
    mockSimOptions = { case: 'test_001' };

    render(<SimCommandBar />);

    expect(screen.queryByTestId('sim-option-no-case-hint')).not.toBeInTheDocument();
  });
});

describe('SimCommandBar BorderBeam 集成', () => {
  it('BorderBeam 使用 size=pulse-inner, colorVariant=ocean, theme=dark', () => {
    mockSimOptions = { case: 'test_001' };
    render(<SimCommandBar />);
    const beam = screen.getByTestId('border-beam');
    expect(beam.getAttribute('data-size')).toBe('pulse-inner');
    expect(beam.getAttribute('data-colorvariant')).toBe('ocean');
    expect(beam.getAttribute('data-theme')).toBe('dark');
  });

  it('有 CASE 且未运行时 BorderBeam active=true', () => {
    mockSimOptions = { case: 'test_001' };
    render(<SimCommandBar />);
    const beam = screen.getByTestId('border-beam');
    expect(beam.getAttribute('data-active')).toBe('true');
  });

  it('无 CASE 时 BorderBeam active=false', () => {
    mockSimOptions = {};
    render(<SimCommandBar />);
    const beam = screen.getByTestId('border-beam');
    expect(beam.getAttribute('data-active')).toBe('false');
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
