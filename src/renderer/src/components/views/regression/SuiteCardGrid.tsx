/**
 * 回归套件卡片网格（Issue #6 / Plan Slice 5）。
 *
 * 「套件」映射决策：一张卡 = discovery 的一个子系统分组（{ subsys, items }）。
 * discovery 顶层结构即按子系统分组，history 亦携带 subsys 字段——卡片状态色
 * 取该子系统最近一次运行的状态；通过率在 RegressionHistoryEntry 中无通过/
 * 失败计数字段，占位显示「—」，不伪造百分比（原型中的 smoke/nightly 等套件
 * 名仅为示意，实际按 discovery 真实结构渲染）。
 * meta（list/group 计数、ON 用例数）来自 discovery 真实字段。
 */

import type { RegressionHistoryEntry } from '@shared/types';
import { Layers } from 'lucide-react';
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
};

/** 最近一次运行状态 → 卡片状态文字 / 状态点色（与 RegressionPanel HistoryRow 同映射） */
function suiteState(latest: RegressionHistoryEntry | null): {
  label: string;
  textClass: string;
  dotClass: string;
} {
  if (!latest) {
    return { label: '未运行', textClass: 'text-muted-foreground/70', dotClass: 'bg-muted-foreground/40' };
  }
  switch (latest.status) {
    case 'running':
      return {
        label: '运行中',
        textClass: 'text-status-running-foreground',
        dotClass: 'bg-status-running animate-pulse',
      };
    case 'completed':
      return { label: '通过', textClass: 'text-status-pass-foreground', dotClass: 'bg-status-pass' };
    case 'failed':
      return { label: '失败', textClass: 'text-status-fail-foreground', dotClass: 'bg-status-fail' };
    case 'aborted':
      return { label: '已停止', textClass: 'text-status-aborted-foreground', dotClass: 'bg-status-aborted' };
  }
}

/** 运行提交时间（原型 hist-time 风格：今天 HH:MM / MM-DD HH:MM） */
export function formatRunTime(ts: number): string {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === new Date().toDateString()) return `今天 ${hm}`;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}

function SuiteCard({ suite }: { suite: SuiteCardData }) {
  const state = suiteState(suite.latest);
  const metaParts = [
    `${suite.listCount} list`,
    ...(suite.groupCount > 0 ? [`${suite.groupCount} grp`] : []),
    `${suite.onCount} ON 用例`,
  ];

  return (
    <div
      className="rounded-xl border border-border bg-card px-4 py-3 transition-[border-color,transform] duration-150 hover:-translate-y-px hover:border-primary/40"
      data-testid={`reg-suite-card-${suite.subsys}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="truncate font-mono text-[12.5px] font-semibold text-foreground">{suite.subsys}</span>
        <span
          className={cn('ml-auto flex shrink-0 items-center gap-1 text-[10px] font-medium', state.textClass)}
          data-testid={`reg-suite-state-${suite.subsys}`}
        >
          <span className={cn('size-1.5 rounded-full', state.dotClass)} />
          {state.label}
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
          {suite.latest ? `最近运行 ${formatRunTime(suite.latest.submittedAt)}` : '尚未运行'}
        </span>
      </div>
    </div>
  );
}

/** 套件卡片网格（原型 .suite-grid：repeat(4,1fr)，窄窗降级 2 列） */
export function SuiteCardGrid({ suites }: { suites: SuiteCardData[] }) {
  return (
    <div className="mb-3 grid grid-cols-2 gap-3 xl:grid-cols-4">
      {suites.map((suite) => (
        <SuiteCard key={suite.subsys} suite={suite} />
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
