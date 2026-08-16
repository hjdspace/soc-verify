import { useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  Check,
  Cpu,
  FileOutput,
  Info,
  Loader2,
  RefreshCw,
  Save,
} from 'lucide-react';
import { useKbStore, type KbConvertEngineId, type KbSettings } from '@renderer/stores/kb';
import { useSettingsStore } from '@renderer/stores/settings';
import { cn } from '@renderer/lib/utils';

/**
 * 知识库设置 Tab — 转换引擎切换 + AI 分类模型显式配置。
 *
 * 两类配置均带「自动」默认值，不改动既有自动推导逻辑：
 *  - 引擎默认 anydoc；切换后仅影响后续新上传文档的转换
 *  - AI 模型默认自动（跟随 AI Agent 面板的凭证与模型选择）
 */

const INPUT_CLASS =
  'rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary';

export function KbSettingsTab() {
  const kbSettings = useKbStore((s) => s.kbSettings);
  const kbEngines = useKbStore((s) => s.kbEngines);
  const kbSettingsLoading = useKbStore((s) => s.kbSettingsLoading);
  const loadKbSettings = useKbStore((s) => s.loadKbSettings);
  const updateKbSettings = useKbStore((s) => s.updateKbSettings);

  const credentials = useSettingsStore((s) => s.credentials);
  const loadCredentials = useSettingsStore((s) => s.loadCredentials);
  const modelsByProvider = useSettingsStore((s) => s.modelsByProvider);
  const modelsLoadingByProvider = useSettingsStore((s) => s.modelsLoadingByProvider);
  const fetchModelsForProvider = useSettingsStore((s) => s.fetchModelsForProvider);

  // 本地编辑副本（保存时整体提交，与 TV 配置保存模式一致）
  const [draft, setDraft] = useState<KbSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadKbSettings();
    void loadCredentials();
  }, [loadKbSettings, loadCredentials]);

  useEffect(() => {
    if (kbSettings && !draft) {
      setDraft({ convertEngine: kbSettings.convertEngine, llm: { ...kbSettings.llm } });
    }
  }, [kbSettings, draft]);

  // 切换凭证后自动拉取该凭证的模型列表（供 datalist 选择）
  useEffect(() => {
    const providerId = draft?.llm.providerId;
    if (providerId && !modelsByProvider[providerId] && !modelsLoadingByProvider[providerId]) {
      void fetchModelsForProvider(providerId);
    }
  }, [draft?.llm.providerId, modelsByProvider, modelsLoadingByProvider, fetchModelsForProvider]);

  const dirty = useMemo(() => {
    if (!kbSettings || !draft) return false;
    return (
      kbSettings.convertEngine !== draft.convertEngine
      || (kbSettings.llm.providerId ?? '') !== (draft.llm.providerId ?? '')
      || (kbSettings.llm.model ?? '') !== (draft.llm.model ?? '')
    );
  }, [kbSettings, draft]);

  if (kbSettingsLoading && !kbSettings) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!kbSettings || !draft) {
    return (
      <div className="flex h-40 flex-col items-center justify-center text-center">
        <BookOpen className="mb-3 h-8 w-8 text-muted-foreground/50" />
        <p className="text-xs text-muted-foreground">知识库设置加载失败，请重试</p>
      </div>
    );
  }

  const selectedProviderId = draft.llm.providerId ?? '';
  const models = selectedProviderId ? modelsByProvider[selectedProviderId] ?? [] : [];
  const modelsLoading = selectedProviderId ? modelsLoadingByProvider[selectedProviderId] === true : false;

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateKbSettings(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* ── 转换引擎 ── */}
      <section>
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
          <FileOutput className="h-3 w-3" />
          文档转换引擎
        </div>
        <div className="grid grid-cols-1 gap-2">
          {kbEngines.map((engine) => {
            const active = draft.convertEngine === engine.id;
            return (
              <button
                key={engine.id}
                type="button"
                onClick={() => setDraft({ ...draft, convertEngine: engine.id as KbConvertEngineId })}
                className={cn(
                  'rounded-md border p-2.5 text-left transition-colors',
                  active ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent',
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
                      active ? 'border-primary' : 'border-muted-foreground/40',
                    )}
                  >
                    {active && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
                  </span>
                  <span className="text-xs font-medium">{engine.label}</span>
                  {active && (
                    <span className="rounded border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                      当前
                    </span>
                  )}
                </div>
                <p className="mt-1 pl-5.5 text-[11px] leading-relaxed text-muted-foreground">
                  {engine.description}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1 pl-5.5">
                  {engine.supportedExtensions.map((ext) => (
                    <span
                      key={ext}
                      className="rounded border border-border bg-secondary/40 px-1 py-px font-mono text-[9px] text-muted-foreground"
                    >
                      {ext}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
          切换引擎只影响之后新上传的文档；已转换文档不变，可通过重试/重新上传用新引擎重转。
        </p>
      </section>

      {/* ── AI 分类模型 ── */}
      <section>
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
          <Cpu className="h-3 w-3" />
          AI 分类 / 摘要模型
        </div>
        <div className="space-y-2.5 rounded-md border border-border/50 bg-secondary/20 p-2.5">
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">凭证</label>
            <select
              value={selectedProviderId}
              onChange={(e) => setDraft({ ...draft, llm: { ...draft.llm, providerId: e.target.value, model: '' } })}
              className={cn(INPUT_CLASS, 'w-full')}
            >
              <option value="">自动（跟随 AI Agent 面板）</option>
              {credentials.map((c) => (
                <option key={c.providerId} value={c.providerId}>
                  {c.label || c.providerId}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-[11px] text-muted-foreground">模型</label>
              <button
                type="button"
                onClick={() => selectedProviderId && void fetchModelsForProvider(selectedProviderId)}
                disabled={!selectedProviderId || modelsLoading}
                className="flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {modelsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                刷新模型列表
              </button>
            </div>
            <input
              list="kb-llm-model-options"
              value={draft.llm.model ?? ''}
              onChange={(e) => setDraft({ ...draft, llm: { ...draft.llm, model: e.target.value } })}
              placeholder="自动（凭证模型 / 会话模型 / 端点第一个可用模型）"
              disabled={!selectedProviderId}
              className={cn(INPUT_CLASS, 'w-full font-mono disabled:cursor-not-allowed disabled:opacity-50')}
            />
            <datalist id="kb-llm-model-options">
              {models.map((m) => (
                <option key={m.id} value={m.id} />
              ))}
            </datalist>
          </div>

          <div className="flex items-start gap-1.5 rounded border border-border/60 bg-secondary/15 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              默认自动：复用 AI Agent 面板当前使用的凭证与模型（凭证模型 → 会话模型 →
              端点第一个可用模型）。显式指定后，知识库上传/重分类始终使用此凭证与模型。
            </span>
          </div>
        </div>
      </section>

      {/* ── 保存 ── */}
      <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-3">
        {dirty && <span className="text-[10px] text-muted-foreground">有未保存的修改</span>}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!dirty || saving}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded px-3 text-xs font-medium transition-colors',
            dirty && !saving
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'cursor-not-allowed bg-muted text-muted-foreground',
          )}
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : dirty ? <Save className="h-3 w-3" /> : <Check className="h-3 w-3" />}
          保存设置
        </button>
      </div>
    </div>
  );
}
