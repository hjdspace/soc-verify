/**
 * sysbase-wizard UI tests — Issue 6.
 *
 * Test seam: component rendering with mocked tRPC + Zustand store.
 *
 * Tests:
 *   - Step navigation: wizard renders all 9 steps, next/prev buttons work
 *   - Command preview: StepReview renders config summary + command preview
 *   - Step 8 (StepOptional): renders pinlist/dmalist/output fields
 */

// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ─── Mock store state ───────────────────────────────────────

const mockStoreState = {
  step: 0,
  totalSteps: 9,
  config: {
    subsys: 'apcpu_sys',
    instanceName: 'u_sys_apcpu',
    rtlFile: '/path/to/top.v',
    moduleName: 'apcpu_top',
    dutSpecPath: '/path/to/dut_spec.xlsx',
    miniExcelPath: '/path/to/mini.xlsx',
    ralDirs: ['/ral/dir1', '/ral/dir2'],
    clkDir: '/clk/dir',
    clk2Dir: '',
    modIoPath: '/path/to/modio.log',
    filelistPath: '/path/to/filelist.f',
    pinlistPath: '',
    dmalistPath: '',
    outputDir: './output',
  },
  scriptPath: '/script/sysbase_gen.py',
  rtlFiles: [],
  rtlLoading: false,
  rtlError: null,
  ralLoading: false,
  ralError: null,
  clkLoading: false,
  clkError: null,
  modIoLoading: false,
  modIoError: null,
  modIoLogs: [],
  runGenLoading: false,
  runGenError: null,
  runGenLogs: [],
  runGenStatus: 'idle' as const,
  configSaving: false,
  configLoading: false,
  loading: false,
  // Actions
  nextStep: vi.fn(() => { mockStoreState.step = Math.min(mockStoreState.step + 1, 8); }),
  prevStep: vi.fn(() => { mockStoreState.step = Math.max(mockStoreState.step - 1, 0); }),
  setStep: vi.fn((s: number) => { mockStoreState.step = Math.max(0, Math.min(s, 8)); }),
  updateConfig: vi.fn(),
  setScriptPath: vi.fn(),
  resetConfig: vi.fn(),
  loadConfigIntoStore: vi.fn(),
  setRtlFiles: vi.fn(),
  setRtlLoading: vi.fn(),
  setRtlError: vi.fn(),
  setRalLoading: vi.fn(),
  setRalError: vi.fn(),
  setClkLoading: vi.fn(),
  setClkError: vi.fn(),
  setModIoLoading: vi.fn(),
  setModIoError: vi.fn(),
  setModIoLogs: vi.fn(),
  addModIoLog: vi.fn(),
  clearModIoLogs: vi.fn(),
  setRunGenLoading: vi.fn(),
  setRunGenError: vi.fn(),
  setRunGenLogs: vi.fn(),
  addRunGenLog: vi.fn(),
  clearRunGenLogs: vi.fn(),
  setRunGenStatus: vi.fn(),
  setConfigSaving: vi.fn(),
  setConfigLoading: vi.fn(),
  canProceed: vi.fn(() => true),
};

// Mock the Zustand store
vi.mock('@renderer/stores/sysbase-gen', () => ({
  useSysbaseGenStore: vi.fn((selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState)),
}));

// Mock tRPC
vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    tools: {
      selectFiles: { mutate: vi.fn().mockResolvedValue({ paths: [] }) },
      sysbaseGen: {
        previewCommand: { query: vi.fn().mockResolvedValue({ command: 'python3 /script/sysbase_gen.py gen \\\n    -rtl     /path/to/top.v \\\n    -n       apcpu_sys' }) },
        runGen: { mutate: vi.fn().mockResolvedValue({ success: true, logs: [] }) },
        saveConfig: { mutate: vi.fn().mockResolvedValue({ success: true }) },
        loadConfig: { query: vi.fn().mockResolvedValue({ config: null, scriptPath: '/script/sysbase_gen.py' }) },
        listSavedConfigs: { query: vi.fn().mockResolvedValue({ configs: [] }) },
      },
    },
  },
}));

// Mock workbench store (used by StepDutSpec/StepMini)
vi.mock('@renderer/stores/workbench', () => ({
  useWorkbenchStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) => selector({ open: vi.fn() })),
}));

// ─── Imports after mocks ────────────────────────────────────

import { SysbaseEnvGen } from '@renderer/tools/sysbase-env-gen/SysbaseEnvGen';
import { StepReview } from '@renderer/tools/sysbase-env-gen/StepReview';
import { StepOptional } from '@renderer/tools/sysbase-env-gen/StepOptional';

// ─── Tests ──────────────────────────────────────────────────

describe('SysbaseEnvGen wizard', () => {
  beforeEach(() => {
    mockStoreState.step = 0;
    vi.clearAllMocks();
  });

  it('renders the wizard header with title', () => {
    render(<SysbaseEnvGen />);
    expect(screen.getByText('验证环境生成器')).toBeDefined();
  });

  it('renders all 9 step pills in the stepper', () => {
    render(<SysbaseEnvGen />);
    const stepLabels = ['选择 Subsys', 'RTL 顶层文件', 'DUT Spec', 'Mini Excel', 'RAL 目录', 'CLK 目录', 'Module IO', '可选项', '预览执行'];
    for (const label of stepLabels) {
      // Step labels may appear in stepper + heading + footer, so use getAllByText
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('shows step 1 content on initial render', () => {
    render(<SysbaseEnvGen />);
    // Step 1 is "选择 Subsys" — should show the step indicator (appears in content + footer)
    expect(screen.getAllByText('步骤 1 / 9').length).toBeGreaterThanOrEqual(1);
  });

  it('advances to next step when clicking 下一步', () => {
    render(<SysbaseEnvGen />);
    const nextBtn = screen.getByText('下一步');
    fireEvent.click(nextBtn);
    expect(mockStoreState.nextStep).toHaveBeenCalled();
  });

  it('goes to prev step when clicking 上一步', () => {
    mockStoreState.step = 1;
    render(<SysbaseEnvGen />);
    const prevBtn = screen.getByText('上一步');
    fireEvent.click(prevBtn);
    expect(mockStoreState.prevStep).toHaveBeenCalled();
  });

  it('disables 上一步 on first step', () => {
    mockStoreState.step = 0;
    render(<SysbaseEnvGen />);
    const prevBtn = screen.getByText('上一步').closest('button');
    expect(prevBtn?.disabled).toBe(true);
  });

  it('shows 执行生成 button on last step', () => {
    mockStoreState.step = 8;
    render(<SysbaseEnvGen />);
    // 执行生成 appears in both footer and StepReview component
    expect(screen.getAllByText('执行生成').length).toBeGreaterThanOrEqual(1);
  });

  it('shows 保存配置 and 加载配置 buttons in header', () => {
    render(<SysbaseEnvGen />);
    expect(screen.getByText('保存配置')).toBeDefined();
    expect(screen.getByText('加载配置')).toBeDefined();
  });
});

describe('StepReview (Step 9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the config summary table with parameter flags', () => {
    render(<StepReview />);
    // The config summary should show flags like -rtl, -n, -i, etc.
    expect(screen.getByText('配置摘要')).toBeDefined();
    expect(screen.getByText('-rtl')).toBeDefined();
    expect(screen.getByText('-n')).toBeDefined();
    expect(screen.getByText('-i')).toBeDefined();
    expect(screen.getByText('-mod_io')).toBeDefined();
    expect(screen.getByText('-o')).toBeDefined();
  });

  it('renders the command preview area', () => {
    render(<StepReview />);
    expect(screen.getByText('命令预览')).toBeDefined();
  });

  it('renders the 复制 button', () => {
    render(<StepReview />);
    expect(screen.getByText('复制')).toBeDefined();
  });

  it('renders the 执行生成 button', () => {
    render(<StepReview />);
    expect(screen.getByText('执行生成')).toBeDefined();
  });

  it('shows 待执行 status badge initially', () => {
    render(<StepReview />);
    expect(screen.getByText('待执行')).toBeDefined();
  });

  it('shows 未设置 for empty optional parameters', () => {
    // clk2Dir, pinlistPath, dmalistPath are empty in mock config
    render(<StepReview />);
    const unsetElements = screen.getAllByText('未设置');
    expect(unsetElements.length).toBeGreaterThanOrEqual(3);
  });

  it('shows 可选 badge for optional parameters', () => {
    render(<StepReview />);
    const optionalBadges = screen.getAllByText('可选');
    expect(optionalBadges.length).toBeGreaterThanOrEqual(3);
  });
});

describe('StepOptional (Step 8)', () => {
  it('renders pinlist, dmalist, and output dir fields', () => {
    render(<StepOptional />);
    expect(screen.getByText('Pinlist 文件路径')).toBeDefined();
    expect(screen.getByText('DMA List 文件路径')).toBeDefined();
    expect(screen.getByText('输出目录')).toBeDefined();
  });

  it('renders browse buttons for all fields', () => {
    render(<StepOptional />);
    const browseButtons = screen.getAllByText('浏览');
    expect(browseButtons.length).toBe(3);
  });

  it('marks output directory as required', () => {
    render(<StepOptional />);
    // The output dir should have a * (required marker)
    const outputDirLabel = screen.getByText('输出目录');
    const container = outputDirLabel.closest('div');
    expect(container?.textContent).toContain('*');
  });

  it('marks pinlist and dmalist as optional', () => {
    render(<StepOptional />);
    expect(screen.getAllByText('可选').length).toBeGreaterThanOrEqual(2);
  });
});
