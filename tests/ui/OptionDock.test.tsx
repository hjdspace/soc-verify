// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SimOptionField } from '@shared/plugin-types';

// Mock the tRPC client before importing the component
vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    project: {
      getSimOptionsSchema: {
        query: vi.fn().mockResolvedValue({ fields: [] }),
      },
      getSimOptionPresets: {
        query: vi.fn().mockResolvedValue({}),
      },
      saveSimOptionPreset: {
        mutate: vi.fn().mockResolvedValue({ ok: true }),
      },
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
vi.mock('@renderer/stores/simulation', () => ({
  useSimulationStore: vi.fn((selector: (s: { simOptions: Record<string, unknown>; setSimOption: typeof mockSetSimOption; setSimOptions: typeof mockSetSimOptions }) => unknown) =>
    selector({
      simOptions: {},
      setSimOption: mockSetSimOption,
      setSimOptions: mockSetSimOptions,
    }),
  ),
}));

// Import after mocks are set up
import { OptionDock } from '@renderer/components/layout/OptionDock';
import { trpc } from '@renderer/lib/trpc';

const mockSchemaFields: SimOptionField[] = [
  { key: 'seed', label: 'Random Seed', type: 'number', default: 0 },
  { key: 'waveform', label: 'Dump Waveform', type: 'boolean', default: false },
  { key: 'simulator', label: 'Simulator', type: 'enum', enumValues: ['vcs', 'xrun', 'verilator'], default: 'vcs' },
  { key: 'timeout', label: 'Timeout', type: 'string', default: '10000', description: 'Simulation timeout in ms' },
];

describe('OptionDock dynamic form rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(trpc.project.getSimOptionsSchema.query).mockResolvedValue({ fields: mockSchemaFields });
    vi.mocked(trpc.project.getSimOptionPresets.query).mockResolvedValue({});
  });

  it('renders the dock header with expand/collapse toggle', async () => {
    render(<OptionDock />);

    // Wait for schema to load
    await screen.findByText('仿真 Option');

    const header = screen.getByText('仿真 Option');
    expect(header).toBeInTheDocument();
  });

  it('shows field count badge when schema has fields', async () => {
    render(<OptionDock />);

    // Wait for schema to load and badge to appear
    await screen.findByText('4');

    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('renders string field as text input', async () => {
    render(<OptionDock />);

    await screen.findByText('Timeout');

    const label = screen.getByText('Timeout');
    expect(label).toBeInTheDocument();

    // Find the text input by its placeholder (schema default value)
    const input = screen.getByPlaceholderText('10000') as HTMLInputElement;
    expect(input.type).toBe('text');
  });

  it('renders number field as number input', async () => {
    render(<OptionDock />);

    await screen.findByText('Random Seed');

    const label = screen.getByText('Random Seed');
    expect(label).toBeInTheDocument();

    // Find number input by its type
    const numberInputs = document.querySelectorAll('input[type="number"]');
    expect(numberInputs.length).toBeGreaterThanOrEqual(1);
  });

  it('renders boolean field as toggle button', async () => {
    render(<OptionDock />);

    await screen.findByText('Dump Waveform');

    const label = screen.getByText('Dump Waveform');
    expect(label).toBeInTheDocument();
  });

  it('renders enum field as select dropdown with options', async () => {
    render(<OptionDock />);

    await screen.findByText('Simulator');

    const label = screen.getByText('Simulator');
    expect(label).toBeInTheDocument();

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select).toBeInTheDocument();

    // Check that enum values are options
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

    // The description is shown as a (?) hint
    expect(screen.getByText('(?)')).toBeInTheDocument();
  });

  it('calls setSimOption when string input value changes', async () => {
    render(<OptionDock />);

    await screen.findByText('Timeout');

    // Find the Timeout field's text input by its placeholder
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
});
