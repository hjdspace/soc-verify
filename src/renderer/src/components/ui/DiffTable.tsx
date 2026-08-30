import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { PillButton } from './PillButton';

/**
 * DiffTable — AI 批量编辑采纳模式：提议 → 分阶段着色 → 逐行采纳 → Apply。
 * 提议以表格呈现，stage 状态机推进：0 原始 → 1 删除行红 tint 着色 →
 * 2（settled）新增行自底部 grid-rows 0fr→1fr 平滑展开 + 页脚 fade-up。
 * settled 后每条变更行即勾选控件（removal 红 mark / addition 绿 mark），
 * 点击或 Enter/Space 切换采纳（取消后褪回正常色），页脚实时统计
 * 「N 项删除 · M 项新增」，0 项时 Apply 禁用；Apply 后行交互冻结并
 * pop-in 绿色确认 pill。
 *
 * 视觉/交互参考 beautiful-ui: D:\AI\beautiful-ui\components\primitives\DiffTable.tsx
 * 样式类 .ap-diff-* 落 globals.css（颜色取全局语义变量，.ai-panel 内/外取值均正确）；
 * tint（14% 混卡面）在使用点 color-mix 就地计算（公共映射层约定）。
 * 参考实现的演示数据不移植；stage 延迟经 stageDelays 注入（UI 测试传 [0,0]）。
 */

export type DiffRow = {
  key: string;
  /** removal：原表行被删除；addition：新表行 */
  kind: 'removal' | 'addition';
  /** 各列内容，顺序与 columns 对齐（首列为行主标识） */
  cells: ReactNode[];
  /** 行 aria-label；缺省取首列字符串内容 */
  label?: string;
};

/** Apply 回调载荷：被采纳（将应用）的删除/新增行 key */
export type DiffApplyResult = {
  removals: string[];
  additions: string[];
};

type DiffTableProps = {
  /** 标题栏（如「AI 提议的 cfg 批量修改」） */
  title: ReactNode;
  /** 表头列名 */
  columns: string[];
  /** 列宽列表（grid-template-columns 各列值），缺省均分 */
  colWidths?: string[];
  /** 全部提议行（removal + addition）；空数组渲染 null */
  rows: DiffRow[];
  /** 应用回调；返回 Promise 时按钮 busy 直至 resolve，成功后冻结进 accepted 态 */
  onApply?: (result: DiffApplyResult) => void | Promise<void>;
  /** Apply 基础文案（默认「应用」，拼为「应用 N 项变更」） */
  applyLabel?: string;
  /** settled 后标题栏右侧操作提示 */
  hint?: string;
  /** stage 推进延迟 [删除行着色, settled]，默认 [180, 260]；测试可传 [0, 0] */
  stageDelays?: [number, number];
  className?: string;
};

const DEFAULT_STAGE_DELAYS: [number, number] = [180, 260];

/** stage 状态机：setTimeout 链逐级推进（0 → delays.length），参考实现 useStage 同款 */
function useStage(delays: number[]): number {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    if (stage >= delays.length) return;
    const t = setTimeout(() => setStage((s) => s + 1), delays[stage]);
    return () => clearTimeout(t);
  }, [stage, delays]);
  return stage;
}

/** 勾选块：采纳时 tone 底色 + 白勾，取消时灰底缩放 0.92 */
function IncludedMark({ included, tone }: { included: boolean; tone: 'red' | 'green' }) {
  return (
    <span
      aria-hidden
      className={cn('ap-diff-mark', included && `ap-diff-mark-${tone}`)}
      style={{ transform: included ? 'scale(1)' : 'scale(0.92)' }}
    >
      {included ? <Check className="size-3" strokeWidth={3} /> : null}
    </span>
  );
}

/** 行尾语义 pill（带彩色圆点），由调用方放入 cells 使用——分组/标签等行级元信息 */
export function DiffBadge({ dot, children }: { dot?: string; children: ReactNode }) {
  return (
    <span className="ap-diff-badge">
      {dot && <i style={{ background: dot }} />}
      <span>{children}</span>
    </span>
  );
}

export function DiffTable({
  title,
  columns,
  colWidths,
  rows,
  onApply,
  applyLabel = '应用',
  hint = '点击变更行以切换采纳',
  stageDelays = DEFAULT_STAGE_DELAYS,
  className,
}: DiffTableProps) {
  // 按值 memo 化 stage 延迟：调用方内联 stageDelays 字面量时，宿主重渲染
  // 不会重建数组身份、重置 setTimeout 链导致 stage 推进停滞（参考实现用
  // 模块常量规避同一问题）
  const [removalDelay, settledDelay] = stageDelays;
  const delays = useMemo(() => [removalDelay, settledDelay], [removalDelay, settledDelay]);
  const stage = useStage(delays);
  // 0 原始 · 1 删除行着色 · 2 settled（新增行展开 + 页脚 + 行交互）
  const tinted = stage >= 1;
  const settled = stage >= 2;
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  // 逐行采纳状态；缺省全部采纳（缺 key 视为采纳，兼容 rows 后续追加）
  const [edits, setEdits] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(rows.map((r) => [r.key, true])),
  );

  const isIncluded = (key: string): boolean => edits[key] ?? true;
  const toggleEdit = (key: string) =>
    setEdits((current) => ({ ...current, [key]: !(current[key] ?? true) }));

  const removalRows = useMemo(() => rows.filter((r) => r.kind === 'removal'), [rows]);
  const additionRows = useMemo(() => rows.filter((r) => r.kind === 'addition'), [rows]);
  const includedRemovals = removalRows.filter((r) => isIncluded(r.key)).map((r) => r.key);
  const includedAdditions = additionRows.filter((r) => isIncluded(r.key)).map((r) => r.key);
  const total = includedRemovals.length + includedAdditions.length;

  if (rows.length === 0) return null;

  const interactive = settled && !accepted && !busy;
  const gridCols = (colWidths ?? columns.map(() => '1fr')).join(' ');

  const handleApply = async () => {
    if (accepted || busy || total === 0) return;
    setBusy(true);
    try {
      await onApply?.({ removals: includedRemovals, additions: includedAdditions });
      setAccepted(true);
    } catch {
      // 失败保持未 accepted（行交互恢复、可重试）；错误上报由调用方负责
    } finally {
      setBusy(false);
    }
  };

  const rowAriaLabel = (row: DiffRow): string | undefined => {
    if (row.label) return row.label;
    const first = row.cells[0];
    return typeof first === 'string' || typeof first === 'number' ? String(first) : undefined;
  };

  /* 变更行共用的交互 props（removal/addition 两处渲染共享） */
  const interactiveRowProps = (row: DiffRow): {
    tabIndex: 0 | -1;
    role: 'checkbox';
    'aria-checked': boolean;
    'aria-label': string | undefined;
    onClick?: () => void;
    onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  } => ({
    role: 'checkbox',
    'aria-checked': isIncluded(row.key),
    'aria-label': rowAriaLabel(row),
    tabIndex: interactive ? 0 : -1,
    ...(interactive
      ? {
          onClick: () => toggleEdit(row.key),
          onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              toggleEdit(row.key);
            }
          },
        }
      : {}),
  });

  const renderCells = (row: DiffRow) => (
    <>
      {row.cells.map((cell, i) => (
        <span
          key={i}
          className={cn('ap-diff-cell', i === 0 && 'ap-diff-cell-main')}
        >
          {cell}
        </span>
      ))}
      <span className="ap-diff-markslot">
        <IncludedMark
          included={isIncluded(row.key)}
          tone={row.kind === 'removal' ? 'red' : 'green'}
        />
      </span>
    </>
  );

  return (
    <div className={cn('ap-diff-card', className)} data-testid="diff-table">
      <div className="ap-diff-bar">
        <span className="ap-diff-title">{title}</span>
        {settled && !accepted && <span className="ap-diff-hint">{hint}</span>}
      </div>

      <div role="table" aria-label={typeof title === 'string' ? title : undefined}>
        {/* 表头（含行尾 mark 占位列） */}
        <div role="row" className="ap-diff-grid ap-diff-head" style={{ gridTemplateColumns: gridCols }}>
          {columns.map((h) => (
            <span key={h} role="columnheader" className="ap-diff-th">
              {h}
            </span>
          ))}
          <span role="columnheader" className="ap-diff-th ap-diff-markslot" aria-hidden />
        </div>

        <div role="rowgroup">
          {/* 删除行：stage 1 起采纳中的行红 tint 着色（主列红字、次列删除线） */}
          {removalRows.map((row) => {
            const struck = tinted && isIncluded(row.key);
            return (
              <div
                key={row.key}
                data-testid={`diff-row-${row.key}`}
                className={cn(
                  'ap-diff-grid ap-diff-row',
                  struck && 'ap-diff-row-out',
                  interactive && 'ap-diff-row-interactive',
                )}
                style={{ gridTemplateColumns: gridCols }}
                {...interactiveRowProps(row)}
              >
                {renderCells(row)}
              </div>
            );
          })}

          {/* 新增行：settled 起自底部 grid-rows 0fr→1fr 平滑展开 */}
          {additionRows.length > 0 && (
            <div
              className="ap-diff-add"
              style={{ gridTemplateRows: settled ? '1fr' : '0fr', opacity: settled ? 1 : 0 }}
              data-testid="diff-additions"
            >
              <div className="ap-diff-add-clip">
                {additionRows.map((row) => (
                  <div
                    key={row.key}
                    data-testid={`diff-row-${row.key}`}
                    className={cn(
                      'ap-diff-grid ap-diff-row ap-diff-row-add',
                      isIncluded(row.key) && 'ap-diff-row-add-in',
                    )}
                    style={{ gridTemplateColumns: gridCols }}
                    {...interactiveRowProps(row)}
                  >
                    {renderCells(row)}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 页脚——统计跟随行级勾选实时变化；Apply 后冻结为确认 pill */}
      {settled && (
        <div
          className="ap-diff-footer"
          data-testid="diff-footer"
          style={{ animation: 'fade-up 180ms var(--ease-out-strong) both' }}
        >
          {accepted ? (
            <span
              className="ap-diff-applied"
              data-testid="diff-applied"
              style={{ animation: 'pop-in 180ms var(--ease-out-strong) both' }}
            >
              <span className="ap-diff-applied-dot">
                <Check className="size-2.5" strokeWidth={3} />
              </span>
              {total} 项变更已应用
            </span>
          ) : (
            <>
              <span className="ap-diff-stats" data-testid="diff-stats">
                {includedRemovals.length} 项删除 · {includedAdditions.length} 项新增
              </span>
              <PillButton
                variant="accent"
                size="sm"
                disabled={total === 0 || busy}
                onClick={() => void handleApply()}
              >
                {busy && <Loader2 className="size-3 animate-spin" />}
                {applyLabel} {total} 项变更
              </PillButton>
            </>
          )}
        </div>
      )}
    </div>
  );
}
