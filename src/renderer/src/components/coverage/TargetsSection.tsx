/**
 * 覆盖率目标编辑区（CoveragePanel 目标 Tab，issues #8 真实场景接入）。
 *
 * 7 种 metric 有行业默认目标（assertion 无默认，行业惯例），项目级设置覆盖默认值。
 * 目标数值由 ScrubField 承载（拖拽手柄 / ↑↓ 方向键 Shift ×10 / 直接输入三路改值），
 * 偏离行业默认时 accent-tint 高亮，调回默认值即视为未设置（draft 移除该项）。
 *
 * 保存链路不变：coverage-gaps store 的 setTargets → trpc.coverage.setTarget。
 */

import { useEffect, useState } from 'react';
import { MoveHorizontal } from 'lucide-react';
import { useCoverageGapsStore } from '@renderer/stores/coverage';
import { COVERAGE_METRICS, DEFAULT_COVERAGE_TARGETS } from '@shared/types';
import type { CoverageMetric } from '@shared/types';
import { ScrubField } from '@renderer/components/ui/ScrubField';

export const METRIC_LABELS: Record<CoverageMetric, string> = {
  line: 'Line',
  branch: 'Branch',
  toggle: 'Toggle',
  condition: 'Condition',
  fsm_state: 'FSM State',
  fsm_transition: 'FSM Trans',
  functional: 'Functional',
  assertion: 'Assertion',
};

export function TargetsSection({
  currentProjectId,
  currentSessionId,
}: {
  currentProjectId: string | null;
  currentSessionId: string | null;
}) {
  const targets = useCoverageGapsStore((s) => s.targets);
  const loadTargets = useCoverageGapsStore((s) => s.loadTargets);
  const setTargets = useCoverageGapsStore((s) => s.setTargets);
  const [draft, setDraft] = useState<Partial<Record<CoverageMetric, number>>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (currentProjectId) loadTargets(currentProjectId, currentSessionId ?? undefined);
  }, [currentProjectId, currentSessionId, loadTargets]);

  useEffect(() => {
    setDraft({ ...targets });
  }, [targets]);

  const handleSave = async () => {
    if (!currentProjectId || !currentSessionId) return;
    setSaving(true);
    await setTargets(currentProjectId, currentSessionId, draft);
    setSaving(false);
  };

  return (
    <div className="space-y-3">
      <div className="text-[10px] text-muted-foreground">
        7 种 metric 有行业默认目标；assertion 无默认目标（行业惯例）。项目级设置会覆盖默认值。
        目标可拖拽手柄、按 ↑↓（Shift ×10）或直接输入调整；偏离行业默认时高亮，调回默认即视为未设置。
        {currentSessionId && <span className="ml-2">当前 session: <span className="font-mono">{currentSessionId}</span></span>}
      </div>
      <div className="rounded border border-border bg-card p-3">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left">Metric</th>
              <th className="px-2 py-1 text-right">行业默认</th>
              <th className="px-2 py-1 text-right">本项目目标</th>
            </tr>
          </thead>
          <tbody>
            {COVERAGE_METRICS.map((m) => {
              const def = DEFAULT_COVERAGE_TARGETS[m];
              // assertion 无行业默认：以 0 为基准（0 = 未设置，保存时剔除）
              const baseline = def ?? 0;
              const cur = draft[m];
              return (
                <tr key={m} className="border-t border-border">
                  <td className="px-2 py-1">{METRIC_LABELS[m]}</td>
                  <td className="px-2 py-1 text-right font-mono text-muted-foreground">
                    {def === undefined ? '—' : `${def}%`}
                  </td>
                  <td className="px-2 py-1 text-right">
                    <div className="flex justify-end">
                      <ScrubField
                        label={`${METRIC_LABELS[m]} 目标`}
                        handle={<MoveHorizontal className="h-3 w-3" />}
                        value={cur ?? baseline}
                        defaultValue={baseline}
                        min={0}
                        max={100}
                        step={1}
                        suffix="%"
                        onChange={(v) => {
                          setDraft((d) => {
                            const next = { ...d };
                            if (v === baseline) delete next[m];
                            else next[m] = v;
                            return next;
                          });
                        }}
                        className="w-28"
                        testId={`cov-target-${m}`}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={!currentSessionId || saving}
          className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
          data-testid="cov-target-save"
        >
          {saving ? '保存中...' : '保存目标'}
        </button>
      </div>
    </div>
  );
}
