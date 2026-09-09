/**
 * 回归套件卡片网格（Issue #6 / Plan Slice 5；发起入口见 ADR 0029）。
 *
 * 「套件」映射决策：一张卡 = discovery 的一个子系统分组（{ subsys, items }）。
 * discovery 顶层结构即按子系统分组，history 亦携带 subsys 字段——卡片状态色
 * 取该子系统最近一次运行的状态；通过率在 RegressionHistoryEntry 中无通过/
 * 失败计数字段，占位显示「—」，不伪造百分比（原型中的 smoke/nightly 等套件
 * 名仅为示意，实际按 discovery 真实结构渲染）。
 * meta（list/group 计数、ON 用例数）来自 discovery 真实字段。
 * 卡片是回归发起唯一入口：整卡可点击打开运行配置模态；运行中显示聚合
 * 「N 运行中」+ 最新 run 进度，终止 / 打开终端按钮就地操作（不导航）。
 */

import type { ActiveRegressionRun, RegressionHistoryEntry } from '@shared/types';
import { Layers, Square, Terminal } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

export type SuiteCardData = {
  subsys: string;
  /** 回归列表（.lst）数量 */
  listCount: number;
  /** 回归组（.grp）数量 */
  groupCount: number;
  /** 启用（ON）用例总数，来自 discovery 对各 list.onCount 的聚合 */
  onCount: number;
  /** 该子系统最近一次运行（null = 从未运行） */
  latest: RegressionHistoryEntry | null;
  /** 该子系统运行中的回归（tracker 事件流同步） */
  active: ActiveRegressionRun[];
};

export type SuiteCardActions = {
  /** 打开运行配置模态（卡片点击） */
  onOpen: (subsys: string) => void;
  /** 终止该子系统最新提交的运行中回归 */
  onAbort: (runId: string) => void;
  /** 按需打开运行中回归的终端 */
  onOpenTerminal: (runId: string) => void;
};

/** 最近一次运行状态 → 卡片状态文字 / 状态点色 / 状态条色（与 RegressionPanel HistoryRow 同映射） */
function suiteState(latest: RegressionHistoryEntry | null): {
  label: string;
  textClass: string;
  dotClass: string;
  barClass: string;
} {
  if (!latest) {
    return {
      label: '未运行',
      textClass: 'text-muted-foreground/70',
      dotClass: 'bg-muted-foreground/40',
      barClass: 'bg-border',
    };
  }
  switch (latest.status) {
    case 'running':
      return {
        label: '运行中',
        textClass: 'text-status-running-foreground',
        dotClass: 'bg-status-running animate-pulse',
        barClass: 'bg-status-running animate-pulse',
      };
    case 'completed':
      return {
        label: '通过',
        textClass: 'text-status-pass-foreground',
        dotClass: 'bg-status-pass',
        barClass: 'bg-status-pass',
      };
    case 'failed':
      return {
        label: '失败',
        textClass: 'text-status-fail-foreground',
        dotClass: 'bg-status-fail',
        barClass: 'bg-status-fail',
      };
    case 'aborted':
      return {
        label: '已停止',
        textClass: 'text-status-aborted-foreground',
        dotClass: 'bg-status-aborted',
        barClass: 'bg-status-aborted',
      };
  }
}

/** 运行提交时间（原型 hist-time 风格：今天 HH:MM / MM-DD HH:MM） */
export function formatRunTime(ts: number): string {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === new Date().toDateString()) return `今天 ${hm}`;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}

function SuiteCard({
  suite,
  actions,
}: {
  suite: SuiteCardData;
  actions: SuiteCardActions;
}) {
  const activeCount = suite.active.length;
  const hasActive = activeCount > 0;
  // 最新提交的运行中回归（终止 / 进度展示对象；多开时历史表看全部）
  const latestActive = hasActive
    ? suite.active.reduce((a, b) => (b.submittedAt >= a.submittedAt ? b : a))
    : null;
  const state = suiteState(suite.latest);
  const stateLabel = hasActive ? `${activeCount} 运行中` : state.label;
  const stateDot = hasActive ? 'bg-status-running animate-pulse' : state.dotClass;
  const stateText = hasActive ? 'text-status-running-foreground' : state.textClass;
  const stateBar = hasActive ? 'bg-status-running animate-pulse' : state.barClass;
  const metaParts = [
    `${suite.listCount} list`,
    ...(suite.groupCount > 0 ? [`${suite.groupCount} grp`] : []),
    `${suite.onCount} ON 用例`,
  ];
  // 运行中有 x/y 进度时状态条按比例填充，否则整条状态色
  const progressPct =
    latestActive?.completed !== undefined && latestActive.total
      ? Math.min(100, Math.round((latestActive.completed / latestActive.total) * 100))
      : null;

  return (
    <div
      className="relative cursor-pointer overflow-hidden rounded-xl border border-border bg-card px-4 pt-3 transition-[border-color,transform] duration-150 hover:-translate-y-px hover:border-primary/40"
      onClick={() => actions.onOpen(suite.subsys)}
      data-testid={`reg-suite-card-${suite.subsys}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="truncate font-mono text-[12.5px] font-semibold text-foreground">{suite.subsys}</span>
        <span
          className={cn('ml-auto flex shrink-0 items-center gap-1 text-[10px] font-medium', stateText)}
          data-testid={`reg-suite-state-${suite.subsys}`}
        >
          <span className={cn('size-1.5 rounded-full', stateDot)} />
          {stateLabel}
        </span>
      </div>
      {/* 通过率：RegressionHistoryEntry 无通过/失败计数字段，占位「—」不造假 */}
      <div
        className="mb-0.5 font-mono text-xl font-semibold text-muted-foreground"
        data-testid={`reg-suite-rate-${suite.subsys}`}
      >
        —
      </div>
      <div className="text-[10.5px] leading-relaxed text-muted-foreground">
        <span className="block">{metaParts.join(' · ')}</span>
        <span className="block">
          {hasActive && latestActive
            ? latestActive.completed !== undefined && latestActive.total !== undefined
              ? `进度 ${latestActive.completed}/${latestActive.total}`
              : '运行中…'
            : suite.latest
              ? `最近运行 ${formatRunTime(suite.latest.submittedAt)}`
              : '尚未运行'}
        </span>
      </div>
      {hasActive && (
        <div className="mt-1.5 flex items-center gap-1 border-t border-border/50 pb-3 pt-1.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (latestActive) actions.onOpenTerminal(latestActive.runId);
            }}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="打开回归终端"
            data-testid={`reg-suite-terminal-${suite.subsys}`}
          >
            <Terminal className="h-3 w-3" />
            终端
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (latestActive) actions.onAbort(latestActive.runId);
            }}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-status-fail-foreground"
            title="终止最新提交的回归"
            data-testid={`reg-suite-abort-${suite.subsys}`}
          >
            <Square className="h-2.5 w-2.5" />
            终止
          </button>
        </div>
      )}
      {!hasActive && <div className="pb-3" />}
      {/* 底部状态条：一眼分类（状态色），运行中按 x/y 进度填充（原型方案 1 .suite-bar） */}
      <div
        className="absolute inset-x-0 bottom-0 h-[3px] bg-border/40"
        data-testid={`reg-suite-bar-${suite.subsys}`}
      >
        <div
          className={cn('h-full transition-[width] duration-300', stateBar)}
          style={progressPct !== null ? { width: `${progressPct}%` } : undefined}
        />
      </div>
    </div>
  );
}

/** 套件卡片网格（原型 .suite-grid：repeat(4,1fr)，窄窗降级 2 列） */
export function SuiteCardGrid({
  suites,
  actions,
}: {
  suites: SuiteCardData[];
  actions: SuiteCardActions;
}) {
  return (
    <div className="mb-3 grid grid-cols-2 gap-3 xl:grid-cols-4">
      {suites.map((suite) => (
        <SuiteCard key={suite.subsys} suite={suite} actions={actions} />
      ))}
    </div>
  );
}

/** 套件网格骨架屏（discovery 首次加载，参照原型 .sk-line shimmer） */
export function SuiteCardGridSkeleton() {
  return (
    <div className="mb-3 grid grid-cols-2 gap-3 xl:grid-cols-4" data-testid="reg-suite-skeleton">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3">
          <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
          <div className="h-6 w-14 animate-pulse rounded bg-muted" />
          <div className="h-2.5 w-5/6 animate-pulse rounded bg-muted" />
          <div className="h-2.5 w-2/5 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

/** 套件网格空状态（未发现回归列表） */
export function SuiteCardGridEmpty() {
  return (
    <div
      className="mb-3 flex flex-col items-center gap-2 rounded-xl border border-border bg-card px-4 py-10 text-muted-foreground"
      data-testid="reg-suite-empty"
    >
      <Layers className="size-6 opacity-30" />
      <span className="text-xs">未发现回归列表</span>
      <span className="text-[11px] opacity-60">配置 PROJ_ENV 后扫描回归目录，或点击右上角刷新重试</span>
    </div>
  );
}
