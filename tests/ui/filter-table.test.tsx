// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  FilterCollapseRow,
  FilterStatusPill,
  StatusFilterChips,
} from '@renderer/components/ui/FilterTable';
import { HistoryTable } from '@renderer/components/views/regression/HistoryTable';
import type { RegressionHistoryEntry } from '@shared/types';

/**
 * 状态 chips 筛选（issues #7，参考 beautiful-ui FilterTable）：
 * 断言外部行为——计数徽标由数据实时派生（非写死）、chip 受控切换、
 * 未匹配行折叠（inline style + 挂载不卸载 + inert 移出交互）、
 * HistoryTable 接入后筛选生效且行序（排序）保留。CSS 过渡本身不做断言。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ─── StatusFilterChips ──────────────────────────────────────────

type DemoStatus = 'todo' | 'progress' | 'done';

const DEMO_FILTERS = [
  { key: 'all' as const, label: '全部' },
  { key: 'todo' as const, label: '待办', dot: 'var(--status-aborted)' },
  { key: 'progress' as const, label: '进行中', dot: 'var(--status-running)' },
  { key: 'done' as const, label: '完成', dot: 'var(--status-pass)' },
];

const ONE_TODO: DemoStatus[] = ['todo'];

function chip(key: string): HTMLElement {
  return screen.getByTestId(`ft-chip-${key}`);
}

describe('StatusFilterChips', () => {
  it('计数徽标由 items 经 statusOf 实时派生：all=总数，各状态=命中数，无命中为 0', () => {
    const items: DemoStatus[] = ['todo', 'todo', 'progress', 'done'];
    render(
      <StatusFilterChips
        filters={DEMO_FILTERS}
        items={items}
        statusOf={(s) => s}
        value="all"
        onChange={() => {}}
      />,
    );
    expect(chip('all')).toHaveTextContent('4');
    expect(chip('todo')).toHaveTextContent('2');
    expect(chip('progress')).toHaveTextContent('1');
    expect(chip('done')).toHaveTextContent('1');
  });

  it('items 变化后计数随之重算（数据派生而非首次渲染固化）', () => {
    const items: DemoStatus[] = ['todo', 'progress'];
    const { rerender } = render(
      <StatusFilterChips
        filters={DEMO_FILTERS}
        items={items}
        statusOf={(s) => s}
        value="all"
        onChange={() => {}}
      />,
    );
    expect(chip('done')).toHaveTextContent('0');
    rerender(
      <StatusFilterChips
        filters={DEMO_FILTERS}
        items={[...items, 'done']}
        statusOf={(s) => s}
        value="all"
        onChange={() => {}}
      />,
    );
    expect(chip('done')).toHaveTextContent('1');
  });

  it('aria-pressed 反映受控选中态，点击上报 onChange', () => {
    const onChange = vi.fn();
    render(
      <StatusFilterChips
        filters={DEMO_FILTERS}
        items={ONE_TODO}
        statusOf={(s) => s}
        value="progress"
        onChange={onChange}
      />,
    );
    expect(chip('progress')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('todo')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip('todo'));
    expect(onChange).toHaveBeenCalledWith('todo');
  });

  it('dot 定义渲染彩色圆点（inline 注入语义变量），无 dot 的 chip 不渲染圆点', () => {
    render(
      <StatusFilterChips
        filters={DEMO_FILTERS}
        items={[]}
        statusOf={(s) => s}
        value="all"
        onChange={() => {}}
      />,
    );
    const dot = chip('todo').querySelector('.ap-ft-dot');
    expect(dot).not.toBeNull();
    expect(dot!.getAttribute('style')).toContain('var(--status-aborted)');
    expect(chip('all').querySelector('.ap-ft-dot')).toBeNull();
  });
});

// ─── FilterCollapseRow ──────────────────────────────────────────

describe('FilterCollapseRow', () => {
  it('shown=true：grid-rows 1fr + opacity 1，内容可交互（无 inert）', () => {
    render(
      <FilterCollapseRow shown testId="row-a">
        <button>内容</button>
      </FilterCollapseRow>,
    );
    const row = screen.getByTestId('row-a');
    expect(row.style.gridTemplateRows).toBe('1fr');
    expect(row.style.opacity).toBe('1');
    expect(row).toHaveAttribute('data-shown', 'true');
    expect(row).not.toHaveAttribute('inert');
  });

  it('shown=false：grid-rows 0fr + opacity 0，子内容保持挂载且 inert（移出交互）', () => {
    render(
      <FilterCollapseRow shown={false} testId="row-b">
        <button>被折叠的内容</button>
      </FilterCollapseRow>,
    );
    const row = screen.getByTestId('row-b');
    expect(row.style.gridTemplateRows).toBe('0fr');
    expect(row.style.opacity).toBe('0');
    expect(row).toHaveAttribute('data-shown', 'false');
    expect(row).toHaveAttribute('inert');
    // 挂载不卸载：折叠后内容仍在 DOM（切回时平滑展开）
    expect(screen.getByText('被折叠的内容')).toBeInTheDocument();
  });

  it('className 落在外层 grid 行上（宿主承载 border 类）', () => {
    render(
      <FilterCollapseRow shown className="border-b border-border" testId="row-c">
        <span>x</span>
      </FilterCollapseRow>,
    );
    expect(screen.getByTestId('row-c')).toHaveClass('border-b', 'border-border');
  });
});

// ─── FilterStatusPill ───────────────────────────────────────────

describe('FilterStatusPill', () => {
  it('data-tone 标注语义 tone，--ft-pill-base 注入语义状态变量', () => {
    render(<FilterStatusPill tone="pass">通过</FilterStatusPill>);
    const pill = screen.getByText('通过');
    expect(pill).toHaveAttribute('data-tone', 'pass');
    expect(pill.getAttribute('style')).toContain('--ft-pill-base');
    expect(pill.getAttribute('style')).toContain('var(--status-pass)');
  });
});

// ─── HistoryTable 接入 ──────────────────────────────────────────

let seq = 0;
function entry(status: RegressionHistoryEntry['status'], submittedAt: number): RegressionHistoryEntry {
  seq += 1;
  return {
    runId: `run-${seq}`,
    filePath: `/proj/view/dv/case_${seq}.sv`,
    subsys: `subsys_${seq}`,
    command: 'runsim -regr',
    options: {},
    submittedAt,
    status,
    exitCode: null,
    stdoutTail: '',
  };
}

/** 按提交时间降序（宿主 RegressionView 的既有排序），run-1 最新在前 */
const ENTRIES: RegressionHistoryEntry[] = [
  entry('completed', 4000),
  entry('failed', 3000),
  entry('running', 2000),
  entry('aborted', 1000),
];

describe('HistoryTable 状态筛选接入', () => {
  it('chips 计数由 entries 派生；点击状态 chip 后不匹配行折叠、匹配行展开，行序不变', () => {
    render(<HistoryTable entries={ENTRIES} loading={false} onOpen={() => {}} />);

    expect(chip('all')).toHaveTextContent('4');
    expect(chip('completed')).toHaveTextContent('1');
    expect(chip('failed')).toHaveTextContent('1');
    expect(chip('running')).toHaveTextContent('1');
    expect(chip('aborted')).toHaveTextContent('1');

    fireEvent.click(chip('failed'));
    // 行序（排序）保留：DOM 顺序仍为 entries 传入顺序，仅可见性变化
    const shownFlags = ENTRIES.map(
      (e) => screen.getByTestId(`reg-hist-shell-${e.runId}`).dataset.shown,
    );
    expect(shownFlags).toEqual(['false', 'true', 'false', 'false']);
    const failedShell = screen.getByTestId(`reg-hist-shell-${ENTRIES[1]!.runId}`);
    expect(failedShell.style.gridTemplateRows).toBe('1fr');
    const firstShell = screen.getByTestId(`reg-hist-shell-${ENTRIES[0]!.runId}`);
    expect(firstShell.style.gridTemplateRows).toBe('0fr');
    // 折叠行保持挂载：内容仍在 DOM（inert 已移出交互）
    expect(screen.getByTestId(`reg-hist-row-${ENTRIES[0]!.runId}`)).toBeInTheDocument();
  });

  it('切回「全部」后所有行恢复展开', () => {
    render(<HistoryTable entries={ENTRIES} loading={false} onOpen={() => {}} />);
    fireEvent.click(chip('failed'));
    fireEvent.click(chip('all'));
    for (const e of ENTRIES) {
      const shell = screen.getByTestId(`reg-hist-shell-${e.runId}`);
      expect(shell.dataset.shown).toBe('true');
      expect(shell.style.gridTemplateRows).toBe('1fr');
    }
  });

  it('当前状态 0 命中时显示无匹配提示，切回命中态提示消失', () => {
    render(<HistoryTable entries={[entry('running', 9000)]} loading={false} onOpen={() => {}} />);
    fireEvent.click(chip('failed'));
    expect(screen.getByTestId('reg-hist-no-match')).toBeInTheDocument();
    fireEvent.click(chip('running'));
    expect(screen.queryByTestId('reg-hist-no-match')).not.toBeInTheDocument();
  });

  it('分隔线跟随可见末行：末条被折叠时可见末行无边框，避免与容器描边成双线', () => {
    render(<HistoryTable entries={ENTRIES} loading={false} onOpen={() => {}} />);
    const rowCls = (e: RegressionHistoryEntry) =>
      screen.getByTestId(`reg-hist-row-${e.runId}`).className;
    // 全量态：末行（aborted）无边框，其余有
    expect(rowCls(ENTRIES[3]!)).not.toContain('border-b');
    expect(rowCls(ENTRIES[0]!)).toContain('border-b');
    // 筛选 failed：末条 aborted 被折叠，可见末行变为 failed——无边框
    fireEvent.click(chip('failed'));
    expect(rowCls(ENTRIES[1]!)).not.toContain('border-b');
    expect(rowCls(ENTRIES[0]!)).toContain('border-b');
  });
});
