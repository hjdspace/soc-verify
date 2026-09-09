// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RegressionItem, RegressionList } from '@shared/types';

/**
 * 回归发起流程（ADR 0029）测试：
 *
 * Part A — regression store 行为：runRegression 提交后不再自动打开终端
 * Tab / 不导航（监控闭环留在回归页，终端按需打开）。
 *
 * Part B — RunConfigModal 行为：item 搜索/选中、entry 只读预览、
 * 选项表单（tag/nt/fm/cov/regrWork/merge/-m）、命令预览联动与复制、
 * 运行调用 runRegression 后关闭模态、group 引用解析与 tag 聚合。
 *
 * store 用真实 zustand（trpc/toast/project mock），模态直连真实 store。
 */

const runMutate = vi.hoisted(() => vi.fn());
const parseGroupQuery = vi.hoisted(() => vi.fn());
const parseListQuery = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    regression: {
      run: { mutate: runMutate },
      parseGroup: { query: parseGroupQuery },
      parseList: { query: parseListQuery },
      discover: { query: vi.fn().mockResolvedValue([]) },
      getHistory: { query: vi.fn().mockResolvedValue([]) },
      getActiveRuns: { query: vi.fn().mockResolvedValue([]) },
      getRunTerminal: { query: vi.fn().mockResolvedValue({ terminalId: null }) },
      abort: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
    },
  },
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: {
    getState: () => ({
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
    }),
  },
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: (selector: (s: { currentProjectId: string | null; projects: unknown[] }) => unknown) =>
    selector({ currentProjectId: 'proj-1', projects: [] }),
}));

import { useRegressionStore } from '@renderer/stores/regression';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { RunConfigModal } from '@renderer/components/views/regression/RunConfigModal';

function makeList(partial: Partial<RegressionList> & { filePath: string }): RegressionList {
  return {
    type: 'list',
    subsys: 'alu',
    block: '',
    entries: [],
    tagSet: [],
    onCount: 0,
    offCount: 0,
    ...partial,
  };
}

function makeEntry(caseName: string, tags: string[], priority: 'H' | 'M' | 'L' | '' = '') {
  return {
    enabled: true,
    block: 'alu',
    caseName,
    seed: 'rand',
    iterative: '1',
    tags,
    priority,
    config: '',
    cfgDef: '',
    envBase: '',
    plusargs: '',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useRegressionStore.setState({
    discovery: [],
    discoveryLoading: false,
    discoveryError: null,
    parsedLists: new Map(),
    parsingListPath: null,
    parsedGroups: new Map(),
    history: [],
    historyLoading: false,
    activeRegressions: [],
    activeRunsInitialized: false,
  });
  useWorkbenchStore.setState({ tabs: [], activeTabId: null });
  runMutate.mockResolvedValue({ runId: 'regr_1', terminalId: 'term-1', command: 'runsim -regr x' });
});

// ═══ Part A: store 行为 ═══════════════════════════════════

describe('regression store runRegression（ADR 0029 决策 4）', () => {
  it('提交回归调用 mutation 并刷新历史，返回提交成功', async () => {
    await expect(
      useRegressionStore.getState().runRegression('proj-1', '/env/alu/regression/alu.lst', 'alu', {
        tags: ['smoke'],
      }),
    ).resolves.toBe(true);

    expect(runMutate).toHaveBeenCalledWith({
      projectId: 'proj-1',
      filePath: '/env/alu/regression/alu.lst',
      subsys: 'alu',
      options: { tags: ['smoke'] },
    });
  });

  it('提交后不再自动打开终端 Tab、不导航到 workspace（终端按需打开）', async () => {
    await useRegressionStore.getState().runRegression('proj-1', '/env/alu/regression/alu.lst', 'alu', {});

    expect(useWorkbenchStore.getState().tabs).toHaveLength(0);
  });

  it('提交失败返回 false（模态保持打开供用户修正）', async () => {
    runMutate.mockRejectedValueOnce(new Error('boom'));

    await expect(
      useRegressionStore.getState().runRegression('proj-1', '/env/alu/regression/alu.lst', 'alu', {}),
    ).resolves.toBe(false);
  });
});

// ═══ Part B: RunConfigModal ═══════════════════════════════

const listA = makeList({
  filePath: '/env/alu/regression/alu_mini.lst',
  entries: [makeEntry('alu_case_a', ['smoke'], 'H'), makeEntry('alu_case_b', ['nightly'])],
  tagSet: ['smoke', 'nightly'],
  onCount: 2,
});
const listB = makeList({
  filePath: '/env/alu/regression/alu_full.lst',
  entries: [],
  tagSet: ['nightly'],
  onCount: 10,
});
const groupG = {
  type: 'group' as const,
  filePath: '/env/alu/regression/alu_all.grp',
  subsys: 'alu',
  block: '',
  refPaths: ['/env/alu/regression/alu_mini.lst'],
};

function renderModal(items: RegressionItem[]) {
  return render(<RunConfigModal subsys="alu" items={items} onClose={vi.fn()} />);
}

describe('RunConfigModal item 列表', () => {
  it('渲染子系统全部 item（文件名 + 类型 + ON 用例数与行数）', () => {
    renderModal([listA, groupG]);

    expect(screen.getByTestId('reg-run-item-alu_mini.lst')).toBeInTheDocument();
    expect(screen.getByTestId('reg-run-item-alu_all.grp')).toBeInTheDocument();
    expect(screen.getByTestId('reg-run-item-alu_mini.lst').textContent).toContain('2 ON · 2 行');
  });

  it('搜索按文件名过滤 item', () => {
    renderModal([listA, listB, groupG]);

    fireEvent.change(screen.getByTestId('reg-run-search'), { target: { value: 'full' } });

    expect(screen.getByTestId('reg-run-item-alu_full.lst')).toBeInTheDocument();
    expect(screen.queryByTestId('reg-run-item-alu_mini.lst')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reg-run-item-alu_all.grp')).not.toBeInTheDocument();
  });

  it('tag 过滤：点击候选标签只显示包含该标签的列表，再点取消', () => {
    renderModal([listA, listB, groupG]);

    fireEvent.click(screen.getByTestId('reg-run-tagfilter-smoke'));

    expect(screen.getByTestId('reg-run-item-alu_mini.lst')).toBeInTheDocument();
    expect(screen.queryByTestId('reg-run-item-alu_full.lst')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('reg-run-tagfilter-smoke'));

    expect(screen.getByTestId('reg-run-item-alu_full.lst')).toBeInTheDocument();
  });

  it('type 过滤：只看列表 / 只看组', () => {
    renderModal([listA, groupG]);

    fireEvent.click(screen.getByTestId('reg-run-filter-list'));
    expect(screen.getByTestId('reg-run-item-alu_mini.lst')).toBeInTheDocument();
    expect(screen.queryByTestId('reg-run-item-alu_all.grp')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('reg-run-filter-group'));
    expect(screen.queryByTestId('reg-run-item-alu_mini.lst')).not.toBeInTheDocument();
    expect(screen.getByTestId('reg-run-item-alu_all.grp')).toBeInTheDocument();
  });
});

describe('RunConfigModal 选中与 entry 预览', () => {
  it('选中 list 后展开 entry 只读预览（case/tag/优先级列）', () => {
    renderModal([listA]);

    fireEvent.click(screen.getByTestId('reg-run-item-alu_mini.lst'));

    fireEvent.click(screen.getByTestId('reg-run-entry-toggle'));

    const table = screen.getByTestId('reg-run-entry-table');
    expect(table.textContent).toContain('alu_case_a');
    expect(table.textContent).toContain('alu_case_b');
    expect(table.textContent).toContain('smoke');
    expect(table.textContent).toContain('H');
  });

  it('选中 group 后解析引用并聚合 tagSet（parseGroup + parseList）', async () => {
    parseGroupQuery.mockResolvedValue({
      refPaths: ['/env/alu/regression/alu_mini.lst'],
      resolved: [{ path: '/env/alu/regression/alu_mini.lst', type: 'list' }],
    });
    parseListQuery.mockResolvedValue({
      entries: [],
      tagSet: ['grp_tag'],
      onCount: 2,
      offCount: 0,
    });

    renderModal([groupG]);
    fireEvent.click(screen.getByTestId('reg-run-item-alu_all.grp'));

    await waitFor(() => {
      expect(parseGroupQuery).toHaveBeenCalledWith({ filePath: groupG.filePath, projectRoot: undefined });
    });
    await waitFor(() => {
      expect(parseListQuery).toHaveBeenCalledWith({ filePath: '/env/alu/regression/alu_mini.lst' });
    });
    // 聚合 tagSet 出现在三态标签选择器
    await waitFor(() => {
      expect(screen.getByTestId('reg-run-tag-grp_tag')).toBeInTheDocument();
    });
  });

  it('unreadable 引用不再触发注定失败的 parseList（修复「无法读取文件」误报）', async () => {
    parseGroupQuery.mockResolvedValue({
      refPaths: ['$PROJ_DIR/dv/missing.lst'],
      resolved: [{ path: '/proj/x/dv/missing.lst', type: 'unreadable' }],
    });

    renderModal([groupG]);
    fireEvent.click(screen.getByTestId('reg-run-item-alu_all.grp'));

    await waitFor(() => {
      expect(parseGroupQuery).toHaveBeenCalled();
    });
    // 只有 type=list 的引用才下发 parseList；unreadable 静默跳过
    expect(parseListQuery).not.toHaveBeenCalled();
    // 引用清单中 unreadable 以失败色 + 计数提示呈现
    await waitFor(() => {
      expect(screen.getByTestId('reg-run-unreadable-count')).toHaveTextContent('1 个引用无法读取');
    });
  });

  it('左栏过滤标签默认折叠（仅前 12 个），展开按钮显示全部', () => {
    // 零填充保证字典序 = 生成序（tag_02 > tag_29 之类不会乱序）
    const manyTags = Array.from({ length: 30 }, (_, i) => `tag_${String(i).padStart(2, '0')}`);
    const bigList = makeList({ filePath: '/env/alu/regression/big.lst', tagSet: manyTags, onCount: 30 });

    renderModal([bigList]);

    // 折叠态：前 12 个可见，tag_12+ 不可见
    expect(screen.getByTestId('reg-run-tagfilter-tag_00')).toBeInTheDocument();
    expect(screen.getByTestId('reg-run-tagfilter-tag_11')).toBeInTheDocument();
    expect(screen.queryByTestId('reg-run-tagfilter-tag_12')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('reg-run-tagfilter-toggle'));

    // 展开态：全部可见
    expect(screen.getByTestId('reg-run-tagfilter-tag_12')).toBeInTheDocument();
    expect(screen.getByTestId('reg-run-tagfilter-tag_29')).toBeInTheDocument();
  });
});

describe('RunConfigModal 选项与命令预览', () => {
  it('默认预览只有 runsim -regr <file>', () => {
    renderModal([listA]);
    fireEvent.click(screen.getByTestId('reg-run-item-alu_mini.lst'));

    expect(screen.getByTestId('reg-run-cmd-preview').textContent).toBe(
      'runsim -regr /env/alu/regression/alu_mini.lst',
    );
  });

  it('三态标签 chip：点选 → 只跑（-tag），再点 → 排除（-nt），三 点 → 复原', () => {
    renderModal([listA]);
    fireEvent.click(screen.getByTestId('reg-run-item-alu_mini.lst'));

    const tag = screen.getByTestId('reg-run-tag-smoke');

    // 第一态：只跑
    fireEvent.click(tag);
    expect(screen.getByTestId('reg-run-cmd-preview').textContent).toContain('-tag smoke');

    // 第二态：排除
    fireEvent.click(tag);
    expect(screen.getByTestId('reg-run-cmd-preview').textContent).toContain('-nt smoke');
    expect(screen.getByTestId('reg-run-cmd-preview').textContent).not.toContain('-tag smoke');

    // 第三态：复原
    fireEvent.click(tag);
    expect(screen.getByTestId('reg-run-cmd-preview').textContent).not.toContain('-tag smoke');
    expect(screen.getByTestId('reg-run-cmd-preview').textContent).not.toContain('-nt smoke');
  });

  it('不同标签可分别处于只跑 / 排除两态（-tag 与 -nt 同时出现）', () => {
    renderModal([listA]);
    fireEvent.click(screen.getByTestId('reg-run-item-alu_mini.lst'));

    fireEvent.click(screen.getByTestId('reg-run-tag-smoke')); // sel
    fireEvent.click(screen.getByTestId('reg-run-tag-smoke')); // exc

    expect(screen.getByTestId('reg-run-cmd-preview').textContent).toContain('-nt smoke');
  });

  it('重置按钮清空全部标签状态', () => {
    renderModal([listA]);
    fireEvent.click(screen.getByTestId('reg-run-item-alu_mini.lst'));

    fireEvent.click(screen.getByTestId('reg-run-tag-smoke'));
    fireEvent.click(screen.getByTestId('reg-run-tag-clear'));

    expect(screen.getByTestId('reg-run-cmd-preview').textContent).toBe(
      'runsim -regr /env/alu/regression/alu_mini.lst',
    );
  });

  it('-m DE TAG 输入联动预览', () => {
    renderModal([listA]);
    fireEvent.click(screen.getByTestId('reg-run-item-alu_mini.lst'));

    fireEvent.change(screen.getByTestId('reg-run-dashboard'), { target: { value: 'DE123' } });

    expect(screen.getByTestId('reg-run-cmd-preview').textContent).toContain('-m DE123');
  });

  it('-merge 未勾选 -cov 时禁用，勾选 -cov 后启用；启用后预览含 -cov -merge', () => {
    renderModal([listA]);
    fireEvent.click(screen.getByTestId('reg-run-item-alu_mini.lst'));

    const mergeToggle = screen.getByTestId('reg-run-merge');
    expect(mergeToggle).toBeDisabled();

    fireEvent.click(screen.getByTestId('reg-run-cov'));
    expect(mergeToggle).not.toBeDisabled();

    fireEvent.click(mergeToggle);
    expect(screen.getByTestId('reg-run-cmd-preview').textContent).toContain('-cov -merge');
  });

  it('复制按钮把命令写入剪贴板', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderModal([listA]);
    fireEvent.click(screen.getByTestId('reg-run-item-alu_mini.lst'));

    fireEvent.click(screen.getByTestId('reg-run-copy'));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('runsim -regr /env/alu/regression/alu_mini.lst');
    });
  });
});

describe('RunConfigModal 运行', () => {
  it('点击运行调用 runRegression（含三态标签选项）并关闭模态', async () => {
    const onClose = vi.fn();
    const runSpy = vi.spyOn(useRegressionStore.getState(), 'runRegression').mockResolvedValue(true);
    render(<RunConfigModal subsys="alu" items={[listA]} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('reg-run-item-alu_mini.lst'));
    fireEvent.click(screen.getByTestId('reg-run-tag-smoke'));
    fireEvent.click(screen.getByTestId('reg-run-confirm'));

    await waitFor(() => {
      expect(runSpy).toHaveBeenCalledWith('proj-1', listA.filePath, 'alu', { tags: ['smoke'] });
    });
    expect(onClose).toHaveBeenCalled();
    runSpy.mockRestore();
  });

  it('提交失败时不关闭模态（用户可修正选项重试）', async () => {
    const onClose = vi.fn();
    const runSpy = vi.spyOn(useRegressionStore.getState(), 'runRegression').mockResolvedValue(false);
    render(<RunConfigModal subsys="alu" items={[listA]} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('reg-run-item-alu_mini.lst'));
    fireEvent.click(screen.getByTestId('reg-run-confirm'));

    await waitFor(() => {
      expect(runSpy).toHaveBeenCalled();
    });
    expect(onClose).not.toHaveBeenCalled();
    runSpy.mockRestore();
  });

  it('未选中 item 时运行按钮禁用', () => {
    renderModal([listA]);

    expect(screen.getByTestId('reg-run-confirm')).toBeDisabled();
  });
});
