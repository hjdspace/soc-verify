/**
 * 失败聚类面板（Issue #6 / Plan Slice 5）。
 *
 * TODO(regression-view): 失败聚类数据源暂缺（Plan §7「失败聚类：暂无」）——
 * 聚类 chip（聚类名 + 波形相似度 + 失败计数）依赖 AI 波形/日志聚类接口，
 * 就绪前本面板只渲染「待分类」占位状态，禁止编造聚类数据。
 */

import { Shapes } from 'lucide-react';

export function FailureClusterPanel() {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 text-xs font-semibold text-foreground">
        失败聚类
        <span
          className="rounded-full bg-secondary px-[7px] text-[10.5px] font-normal text-muted-foreground"
          data-testid="reg-cluster-badge"
        >
          待分类
        </span>
      </div>
      <div
        className="flex flex-1 flex-col items-center gap-2 px-3.5 py-10 text-muted-foreground"
        data-testid="reg-cluster-placeholder"
      >
        <Shapes className="size-6 opacity-30" />
        <span className="text-xs">聚类数据源待接入</span>
        <span className="max-w-[220px] text-center text-[11px] leading-relaxed text-muted-foreground/80">
          失败用例的波形 / 日志聚类分析暂未接入，就绪后按「聚类 · 相似度 · 计数」展示
        </span>
      </div>
    </div>
  );
}
