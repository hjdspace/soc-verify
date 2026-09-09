// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SimOptionField } from '@shared/plugin-types';

/**
 * SimOptionPanel（Issue #3）测试：
 * schema 加载与分组卡片渲染、字段值编辑联动、预设加载下拉与保存。
 *
 * 回归测试分组已删除（ADR 0029：回归发起收敛到回归页）；
 * 但「解析回归指令」按钮已恢复——粘贴 runsim 指令自动提取参数填入
 * Option 字段（含回归参数，存入 simOptions），见独立 describe。
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
      getCaseSubsys: { query: vi.fn().mockResolvedValue({ subsys: null }) },
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
  vi.mocked(trpc.project.getCaseSubsys.query).mockResolvedValue({ subsys: null });
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

describe('SimOptionPanel 解析回归指令', () => {
  it('点击按钮打开解析对话框', async () => {
    render(<SimOptionPanel />);

    fireEvent.click(await screen.findByTestId('sim-option-parse-btn'));

    expect(screen.getByTestId('sim-parse-dialog')).toBeInTheDocument();
  });

  it('无输入文本时解析按钮 disabled', async () => {
    render(<SimOptionPanel />);

    fireEvent.click(await screen.findByTestId('sim-option-parse-btn'));

    const parseBtn = screen.getByRole('button', { name: '解析' }) as HTMLButtonElement;
    expect(parseBtn.disabled).toBe(true);
  });

  it('粘贴完整回归指令解析后合并参数到 simOptions 并关闭对话框', async () => {
    mockSimOptions = { base: 'old_base', cl: false };

    render(<SimOptionPanel />);

    fireEvent.click(await screen.findByTestId('sim-option-parse-btn'));

    const textarea = screen.getByPlaceholderText(/可以直接粘贴从网页复制的完整回归指令/);
    fireEvent.change(textarea, {
      target: {
        value:
          '_regression_platform noise_ runsim -base top -block udtb/usvp -case apcpu_hello_world -seed 123 -fsdb -cl',
      },
    });

    fireEvent.click(screen.getByRole('button', { name: '解析' }));

    // 解析值覆盖同名字段（base/cl），其余参数全部提取
    expect(mockSetSimOptions).toHaveBeenCalledWith({
      base: 'top',
      cl: true,
      block: 'udtb/usvp',
      case: 'apcpu_hello_world',
      seed: '123',
      fsdb: true,
    });
    await waitFor(() => {
      expect(screen.queryByTestId('sim-parse-dialog')).not.toBeInTheDocument();
    });
  });

  it('关闭对话框时清空输入文本', async () => {
    render(<SimOptionPanel />);

    fireEvent.click(await screen.findByTestId('sim-option-parse-btn'));

    const textarea = screen.getByPlaceholderText(/可以直接粘贴从网页复制的完整回归指令/);
    fireEvent.change(textarea, { target: { value: 'runsim -base top' } });

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(screen.queryByTestId('sim-parse-dialog')).not.toBeInTheDocument();

    // 再次打开时文本已清空
    fireEvent.click(screen.getByTestId('sim-option-parse-btn'));
    const reopened = screen.getByPlaceholderText(
      /可以直接粘贴从网页复制的完整回归指令/,
    ) as HTMLTextAreaElement;
    expect(reopened.value).toBe('');
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

  it('enum 字段旁边有 + 按钮可切换到自定义输入模式', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('Simulator');

    // 点击 + 按钮切换到自定义输入模式
    const addBtn = screen.getByTitle('输入自定义值');
    fireEvent.click(addBtn);

    // 应出现自定义输入框
    const customInput = screen.getByPlaceholderText('输入自定义值') as HTMLInputElement;
    expect(customInput).toBeInTheDocument();

    // 输入自定义值后调用 setSimOption
    fireEvent.change(customInput, { target: { value: 'sdf=npg_custom' } });
    expect(mockSetSimOption).toHaveBeenCalledWith('simulator', 'sdf=npg_custom');
  });

  it('enum 自定义值不在预设列表时自动进入输入模式', async () => {
    mockSimOptions = { simulator: 'sdf=custom_corner' };

    render(<SimOptionPanel />);

    await screen.findByText('BASE');
    // 仿真参数组默认收起，先展开（值不在预设列表的 Simulator 在该组内）
    fireEvent.click(screen.getByRole('button', { name: /仿真参数/ }));

    // 值不在预设列表中 → 自动进入自定义模式
    const customInput = screen.getByPlaceholderText('输入自定义值') as HTMLInputElement;
    expect(customInput).toBeInTheDocument();
    expect(customInput.value).toBe('sdf=custom_corner');
  });

  it('enum 自定义模式切回 select 模式时清空不在列表中的值', async () => {
    mockSimOptions = { simulator: 'sdf=custom_corner' };

    render(<SimOptionPanel />);

    await screen.findByText('BASE');
    fireEvent.click(screen.getByRole('button', { name: /仿真参数/ }));

    // 当前在自定义模式（值不在预设中），点击切回按钮
    const revertBtn = screen.getByTitle('切回预设列表');
    fireEvent.click(revertBtn);

    // 应回到 select 模式，且值被清空
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(mockSetSimOption).toHaveBeenCalledWith('simulator', '');
  });

  it('description 不常驻，收进 label/控件悬停 tooltip（省行高）', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('Timeout');

    // 描述不再作为常驻文本渲染
    expect(screen.queryByText('Simulation timeout in ms')).not.toBeInTheDocument();
    // 全量描述进 tooltip：label 与控件悬停均可看
    expect(screen.getAllByTitle(/Simulation timeout in ms/).length).toBeGreaterThan(0);
    // 旧版 (?) 常驻提示也不出现
    expect(screen.queryByText('(?)')).not.toBeInTheDocument();
  });

  it('label 尾部 CLI flag 剥离为独立 chip，label 只保留语义名', async () => {
    vi.mocked(trpc.project.getSimOptionsSchema.query).mockResolvedValue({
      fields: [
        { key: 'rundir', label: '工作目录 (-rundir)', type: 'string', group: '基础参数' },
      ],
    });

    render(<SimOptionPanel />);

    // label 只渲染语义名；flag (-rundir) 以独立元素跟随其后
    expect((await screen.findByText('工作目录')).textContent).toBe('工作目录');
    expect(screen.getByText('-rundir')).toBeInTheDocument();
    // flag 与 key 互为镜像，tooltip 去重后只剩 key（label 与控件各自携带）
    expect(screen.getAllByTitle('rundir').length).toBeGreaterThan(0);
  });

  it('boolean 字段渲染为 switch 角色，点击翻转并回调 setSimOption', async () => {
    render(<SimOptionPanel />);

    // 波形配置组默认收起，先展开
    fireEvent.click(await screen.findByRole('button', { name: /波形配置/ }));
    const sw = await screen.findByRole('switch', { name: 'Dump Waveform' });
    expect(sw.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(sw);

    expect(mockSetSimOption).toHaveBeenCalledWith('waveform', true);
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

  it('启动前按用例名解析真实子系统，不误用全局选中的子系统', async () => {
    // 场景：树上最后点击的子系统是 ai_sys（全局 selectedSubsys），但
    // CASE 字段填的是 top 子系统的用例 —— 应以 cases 表解析结果为准
    mockSimOptions = { case: 'test_top_ap_mini' };
    vi.mocked(trpc.project.getCaseSubsys.query).mockResolvedValue({ subsys: 'top' });

    render(<SimCommandBar />);

    fireEvent.click(screen.getByTestId('sim-option-run'));

    await waitFor(() => {
      expect(mockStartCaseRun).toHaveBeenCalledTimes(1);
    });
    expect(trpc.project.getCaseSubsys.query).toHaveBeenCalledWith({
      projectId: 'test-project',
      caseName: 'test_top_ap_mini',
    });
    expect(mockStartCaseRun).toHaveBeenCalledWith(
      'test-project',
      expect.objectContaining({ name: 'test_top_ap_mini', subsys: 'top' }),
    );
  });

  it('cases 表查不到用例时回退到全局选中的子系统', async () => {
    mockSimOptions = { case: 'unscanned_case' };
    vi.mocked(trpc.project.getCaseSubsys.query).mockResolvedValue({ subsys: null });

    render(<SimCommandBar />);

    fireEvent.click(screen.getByTestId('sim-option-run'));

    await waitFor(() => {
      expect(mockStartCaseRun).toHaveBeenCalledTimes(1);
    });
    expect(mockStartCaseRun).toHaveBeenCalledWith(
      'test-project',
      expect.objectContaining({ name: 'unscanned_case', subsys: '' }),
    );
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

describe('SimOptionPanel 可折叠卡片（方案 5）', () => {
  it('默认仅第一组展开，其余收起（aria-expanded）', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    const headers = screen.getAllByRole('button', { name: /项/ });
    const expanded = headers.map((h) => h.getAttribute('aria-expanded'));
    // 第一组（基础参数）展开，其余收起
    expect(expanded[0]).toBe('true');
    expect(expanded.slice(1).every((v) => v === 'false')).toBe(true);
  });

  it('点击收起的卡头展开该组（aria-expanded 翻转，收起区 inert 解除）', async () => {
    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    const header = screen.getByRole('button', { name: /波形配置/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');

    // 收起时字段区 inert（挡键盘焦点）；展开后可交互
    const sw = screen.getByRole('switch', { name: 'Dump Waveform' });
    expect(sw.closest('[inert]')).toBeNull();
  });

  it('收起卡片头部显示已配置项摘要 chips', async () => {
    mockSimOptions = { simulator: 'vcs', timeout: '10000' };

    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    // 仿真参数组收起，摘要 chips 显示组内非空值（Simulator: vcs）
    const header = screen.getByRole('button', { name: /仿真参数/ });
    expect(header.textContent).toContain('vcs');
  });

  it('boolean true 在摘要中显示 ✓，空值不出现', async () => {
    mockSimOptions = { waveform: true };

    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    // 波形配置组收起：Dump Waveform → ✓；未启用的项不进摘要
    const header = screen.getByRole('button', { name: /波形配置/ });
    expect(header.textContent).toContain('✓');
  });

  it('展开的卡片不显示摘要 chips', async () => {
    mockSimOptions = { base: 'top' };

    render(<SimOptionPanel />);

    await screen.findByText('BASE');

    // 基础参数展开：字段区直接可见，卡头不出现摘要 chip
    const header = screen.getByRole('button', { name: /基础参数/ });
    expect(header.textContent).not.toContain('top');
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

    // 保存行收在预设下拉菜单底部，先打开菜单
    fireEvent.click(screen.getByText('预设'));

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
