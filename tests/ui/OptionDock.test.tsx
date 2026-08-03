// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SimOptionField } from '@shared/plugin-types';

// Mock the tRPC client before importing the component.
// vi.mock is hoisted by Vitest — factory must be self-contained.
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

// Mock the UI store
vi.mock('@renderer/stores/ui', () => ({
  useUiStore: vi.fn((selector: (s: { optionDockExpanded: boolean; toggleOptionDock: () => void }) => unknown) =>
    selector({
      optionDockExpanded: true,
      toggleOptionDock: () => {},
    }),
  ),
}));

// Mock the project store
vi.mock('@renderer/stores/project', () => ({
  useProjectStore: vi.fn((selector: (s: { currentProjectId: string | null; selectedSubsys: string | null }) => unknown) =>
    selector({
      currentProjectId: 'test-project',
      selectedSubsys: null,
    }),
  ),
}));

// Mock the simulation store
const mockSetSimOption = vi.fn();
const mockSetSimOptions = vi.fn();
const mockStartCaseRun = vi.fn().mockResolvedValue('run-1');
vi.mock('@renderer/stores/simulation', () => ({
  useSimulationStore: vi.fn((selector: (s: {
    simOptions: Record<string, unknown>;
    setSimOption: typeof mockSetSimOption;
    setSimOptions: typeof mockSetSimOptions;
    startCaseRun: typeof mockStartCaseRun;
  }) => unknown) =>
    selector({
      simOptions: {},
      setSimOption: mockSetSimOption,
      setSimOptions: mockSetSimOptions,
      startCaseRun: mockStartCaseRun,
    }),
  ),
}));

// Mock the toast store
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

// Import after mocks are set up
import { OptionDock } from '@renderer/components/layout/OptionDock';
import { trpc } from '@renderer/lib/trpc';
import { generateRunsimCommand, tokenizeRunsimCommand, parseRunsimCommand } from '@renderer/lib/runsim-command';

const mockSchemaFields: SimOptionField[] = [
  { key: 'base', label: 'BASE', type: 'string', default: '', group: '基础参数' },
  { key: 'block', label: 'BLOCK', type: 'string', default: '', group: '基础参数' },
  { key: 'case', label: 'CASE', type: 'string', default: '', group: '基础参数' },
  { key: 'seed', label: 'Random Seed', type: 'number', default: 0, group: '基础参数' },
  { key: 'waveform', label: 'Dump Waveform', type: 'boolean', default: false, group: '波形配置' },
  { key: 'simulator', label: 'Simulator', type: 'enum', enumValues: ['vcs', 'xrun', 'verilator'], default: 'vcs', group: '仿真参数' },
  { key: 'timeout', label: 'Timeout', type: 'string', default: '10000', description: 'Simulation timeout in ms', group: '仿真参数' },
];

describe('OptionDock dynamic form rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(trpc.project.getSimOptionsSchema.query).mockResolvedValue({ fields: mockSchemaFields });
    vi.mocked(trpc.project.getSimOptionPresets.query).mockResolvedValue({});
  });

  it('renders the dock header with expand/collapse toggle', async () => {
    render(<OptionDock />);

    await screen.findByText('仿真 Option');

    const header = screen.getByText('仿真 Option');
    expect(header).toBeInTheDocument();
  });

  it('shows field count badge when schema has fields', async () => {
    render(<OptionDock />);

    await screen.findByText('7');

    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('renders string field as text input', async () => {
    render(<OptionDock />);

    await screen.findByText('Timeout');

    expect(screen.getByText('Timeout')).toBeInTheDocument();

    const input = screen.getByPlaceholderText('10000') as HTMLInputElement;
    expect(input.type).toBe('text');
  });

  it('renders number field as number input', async () => {
    render(<OptionDock />);

    await screen.findByText('Random Seed');

    expect(screen.getByText('Random Seed')).toBeInTheDocument();

    const numberInputs = document.querySelectorAll('input[type="number"]');
    expect(numberInputs.length).toBeGreaterThanOrEqual(1);
  });

  it('renders boolean field as toggle button', async () => {
    render(<OptionDock />);

    await screen.findByText('Dump Waveform');

    expect(screen.getByText('Dump Waveform')).toBeInTheDocument();
  });

  it('renders enum field as select dropdown with options', async () => {
    render(<OptionDock />);

    await screen.findByText('Simulator');

    expect(screen.getByText('Simulator')).toBeInTheDocument();

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select).toBeInTheDocument();

    const vcsOption = screen.getByRole('option', { name: 'vcs' }) as HTMLOptionElement;
    const xrunOption = screen.getByRole('option', { name: 'xrun' }) as HTMLOptionElement;
    const verilatorOption = screen.getByRole('option', { name: 'verilator' }) as HTMLOptionElement;

    expect(vcsOption).toBeInTheDocument();
    expect(xrunOption).toBeInTheDocument();
    expect(verilatorOption).toBeInTheDocument();
  });

  it('shows description hint for fields with descriptions', async () => {
    render(<OptionDock />);

    await screen.findByText('Timeout');

    expect(screen.getByText('(?)')).toBeInTheDocument();
  });

  it('calls setSimOption when string input value changes', async () => {
    render(<OptionDock />);

    await screen.findByText('Timeout');

    const input = screen.getByPlaceholderText('10000') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '30000' } });
    expect(mockSetSimOption).toHaveBeenCalledWith('timeout', '30000');
  });

  it('calls setSimOption when enum select value changes', async () => {
    render(<OptionDock />);

    await screen.findByText('Simulator');

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'xrun' } });

    expect(mockSetSimOption).toHaveBeenCalledWith('simulator', 'xrun');
  });

  it('shows message when no schema is available', async () => {
    vi.mocked(trpc.project.getSimOptionsSchema.query).mockResolvedValue({ fields: [] });

    render(<OptionDock />);

    await screen.findByText('无仿真选项 schema（需 sim-option-schema 插件）');

    expect(screen.getByText('无仿真选项 schema（需 sim-option-schema 插件）')).toBeInTheDocument();
  });

  it('renders command preview bar with runsim command', async () => {
    render(<OptionDock />);

    await screen.findByText('BASE');

    // The command preview should contain "runsim" text
    const cmdElements = screen.getAllByText('runsim');
    expect(cmdElements.length).toBeGreaterThanOrEqual(1);
  });

  it('renders run simulation button', async () => {
    render(<OptionDock />);

    await screen.findByText('BASE');

    const runButton = screen.getByText('运行仿真');
    expect(runButton).toBeInTheDocument();
  });

  it('disables run button when no CASE is specified', async () => {
    render(<OptionDock />);

    await screen.findByText('BASE');

    const runButton = screen.getByText('运行仿真').closest('button');
    expect(runButton).toBeDisabled();
  });

  it('shows CASE missing hint when no case is set', async () => {
    render(<OptionDock />);

    // Wait for schema to load first
    await screen.findByText('BASE');

    // The hint text is inside a div with an SVG icon
    expect(screen.getByText(/未指定 CASE 名称/)).toBeInTheDocument();
  });
});

describe('generateRunsimCommand', () => {
  it('returns just "runsim" for empty options', () => {
    expect(generateRunsimCommand({})).toBe('runsim');
  });

  it('builds basic mode command with base, block, case', () => {
    const cmd = generateRunsimCommand({ base: 'top', block: 'usvp', case: 'test_001' });
    expect(cmd).toBe('runsim -base top -block usvp -case test_001');
  });

  it('appends boolean flags correctly', () => {
    const cmd = generateRunsimCommand({ base: 'top', block: 'usvp', case: 'test_001', fsdb: true, cov: true });
    expect(cmd).toBe('runsim -base top -block usvp -case test_001 -fsdb -cov');
  });

  it('appends string flags with values', () => {
    const cmd = generateRunsimCommand({ base: 'top', block: 'usvp', case: 'test_001', seed: '12345', bq: 'lsf' });
    expect(cmd).toBe('runsim -base top -block usvp -case test_001 -seed 12345 -bq lsf');
  });

  it('uses regression mode when regr_file is set', () => {
    const cmd = generateRunsimCommand({ regr_file: 'regression.list', fm: true, tag: 'nightly' });
    expect(cmd).toBe('runsim -regr regression.list -fm -tag nightly');
  });

  it('adds -R for sim_only mode', () => {
    const cmd = generateRunsimCommand({ base: 'top', block: 'usvp', case: 'test_001', sim_only: true });
    expect(cmd).toContain('-R');
    expect(cmd).not.toContain('-C');
  });

  it('adds -C for compile_only mode', () => {
    const cmd = generateRunsimCommand({ base: 'top', block: 'usvp', case: 'test_001', compile_only: true });
    expect(cmd).toContain('-C');
    expect(cmd).not.toContain('-R');
  });

  it('appends other_options at the end', () => {
    const cmd = generateRunsimCommand({ base: 'top', block: 'usvp', case: 'test_001', other_options: '-verbose' });
    expect(cmd).toBe('runsim -base top -block usvp -case test_001 -verbose');
  });
});

describe('tokenizeRunsimCommand', () => {
  it('tokenizes simple command', () => {
    const tokens = tokenizeRunsimCommand('runsim -base top -block usvp');
    expect(tokens).toHaveLength(5);
    expect(tokens[0]).toEqual({ type: 'base', text: 'runsim' });
    expect(tokens[1]).toEqual({ type: 'flag', text: '-base' });
    expect(tokens[2]).toEqual({ type: 'value', text: 'top' });
    expect(tokens[3]).toEqual({ type: 'flag', text: '-block' });
    expect(tokens[4]).toEqual({ type: 'value', text: 'usvp' });
  });

  it('handles quoted values as single tokens', () => {
    const tokens = tokenizeRunsimCommand('runsim -simarg "+notimingchecks"');
    expect(tokens).toHaveLength(3);
    expect(tokens[2]).toEqual({ type: 'value', text: '"+notimingchecks"' });
  });

  it('handles single command with no flags', () => {
    const tokens = tokenizeRunsimCommand('runsim');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({ type: 'base', text: 'runsim' });
  });
});

describe('parseRunsimCommand', () => {
  it('returns empty object for empty text', () => {
    expect(parseRunsimCommand('')).toEqual({});
    expect(parseRunsimCommand('   ')).toEqual({});
  });

  it('returns empty object when no runsim command found', () => {
    expect(parseRunsimCommand('hello world')).toEqual({});
  });

  it('parses basic command parameters', () => {
    const result = parseRunsimCommand('runsim -base top -block usvp -case test_001');
    expect(result.base).toBe('top');
    expect(result.block).toBe('usvp');
    expect(result.case).toBe('test_001');
  });

  it('parses regression command parameters', () => {
    const result = parseRunsimCommand('runsim -regr regression.list -fm -tag nightly -m DETAG');
    expect(result.regr_file).toBe('regression.list');
    expect(result.fm).toBe(true);
    expect(result.tag).toBe('nightly');
    expect(result.dashboard).toBe('DETAG');
  });

  it('extracts runsim command from surrounding text', () => {
    const result = parseRunsimCommand('请执行以下回归指令：\nrunsim -base top -block usvp -case test_001 -fsdb');
    expect(result.base).toBe('top');
    expect(result.block).toBe('usvp');
    expect(result.case).toBe('test_001');
    expect(result.fsdb).toBe(true);
  });

  it('parses boolean flags correctly', () => {
    const result = parseRunsimCommand('runsim -cl -cov -upf -dump_mem -dump_sva');
    expect(result.cl).toBe(true);
    expect(result.cov).toBe(true);
    expect(result.upf).toBe(true);
    expect(result.dump_mem).toBe(true);
    expect(result.dump_sva).toBe(true);
  });

  it('parses sim_only (-R) and compile_only (-C) flags', () => {
    const result = parseRunsimCommand('runsim -base top -block usvp -case test_001 -R');
    expect(result.sim_only).toBe(true);
    expect(result.compile_only).toBeUndefined();

    const result2 = parseRunsimCommand('runsim -base top -block usvp -case test_001 -C');
    expect(result2.compile_only).toBe(true);
    expect(result2.sim_only).toBeUndefined();
  });

  it('parses quoted simarg value', () => {
    const result = parseRunsimCommand('runsim -simarg "+notimingchecks +define+DEBUG"');
    expect(result.simarg).toBe('+notimingchecks +define+DEBUG');
  });

  it('parses fsdb with dump_level value', () => {
    const result = parseRunsimCommand('runsim -fsdb tb_top.chip_top');
    expect(result.fsdb).toBe(true);
    expect(result.dump_level).toBe('tb_top.chip_top');
  });

  it('parses fsdb without dump_level value', () => {
    const result = parseRunsimCommand('runsim -fsdb -cov');
    expect(result.fsdb).toBe(true);
    expect(result.cov).toBe(true);
    expect(result.dump_level).toBeUndefined();
  });

  it('cleans HTML tags from pasted text', () => {
    const result = parseRunsimCommand('<span>runsim</span> -base top -block usvp');
    expect(result.base).toBe('top');
    expect(result.block).toBe('usvp');
  });

  it('handles unknown flags gracefully', () => {
    const result = parseRunsimCommand('runsim -base top -unknown_flag value -case test');
    expect(result.base).toBe('top');
    expect(result.case).toBe('test');
  });

  it('parses dump_mem as boolean flag (not string value)', () => {
    const result = parseRunsimCommand('runsim -base top -dump_mem');
    expect(result.dump_mem).toBe(true);
  });
});
