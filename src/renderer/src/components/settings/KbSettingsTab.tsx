import { useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  Check,
  Cpu,
  Eye,
  Info,
  Loader2,
  RefreshCw,
  Save,
  ShieldCheck,
} from 'lucide-react';
import { useKbStore, type KbSettings } from '@renderer/stores/kb';
import { useSettingsStore } from '@renderer/stores/settings';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

/**
 * 知识库设置 Tab — AI 分类模型 + 视觉模型的角色化显式配置（issue 12）。
 *
 * 转换引擎已固定为 anydoc（MarkItDown 引擎已移除）。角色配置相互独立：
 *  - llm：AI 分类模型，默认自动（跟随 AI Agent 面板的凭证与模型选择）
 *  - vision：图像解读模型，必须显式选择凭证与模型（文本 chat 成功不代表
 *    支持图片输入，不自动跟随 llm 角色），并提供图片能力独立验证按钮
 *    （发送 1x1 PNG 真实请求，用户主动触发的真实网络调用）
 */

const INPUT_CLASS =
  'rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary';

type VisionVerifyState =
  | { kind: 'idle' }
  | { kind: 'verifying' }
  | { kind: 'ok'; model: string; sample: string }
  | { kind: 'error'; message: string };

export function KbSettingsTab() {
  const kbSettings = useKbStore((s) => s.kbSettings);
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
  const [verify, setVerify] = useState<VisionVerifyState>({ kind: 'idle' });

  useEffect(() => {
    void loadKbSettings();
    void loadCredentials();
  }, [loadKbSettings, loadCredentials]);

  useEffect(() => {
    if (kbSettings && !draft) {
      setDraft({
        convertEngine: 'anydoc',
        llm: { ...kbSettings.llm },
        ...(kbSettings.vision ? { vision: { ...kbSettings.vision } } : {}),
      });
    }
  }, [kbSettings, draft]);

  // 切换凭证后自动拉取该凭证的模型列表（供 datalist 选择；llm/vision 共用缓存）
  useEffect(() => {
    for (const providerId of [draft?.llm.providerId, draft?.vision?.providerId]) {
      if (providerId && !modelsByProvider[providerId] && !modelsLoadingByProvider[providerId]) {
        void fetchModelsForProvider(providerId);
      }
    }
  }, [draft?.llm.providerId, draft?.vision?.providerId, modelsByProvider, modelsLoadingByProvider, fetchModelsForProvider]);

  const roleDirty = (
    a: { providerId?: string; model?: string } | undefined,
    b: { providerId?: string; model?: string } | undefined,
  ): boolean =>
    (a?.providerId ?? '') !== (b?.providerId ?? '') || (a?.model ?? '') !== (b?.model ?? '');

  const dirty = useMemo(() => {
    if (!kbSettings || !draft) return false;
    return roleDirty(kbSettings.llm, draft.llm) || roleDirty(kbSettings.vision, draft.vision);
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

  const visionProviderId = draft.vision?.providerId ?? '';
  const visionModels = visionProviderId ? modelsByProvider[visionProviderId] ?? [] : [];
  const visionModelsLoading = visionProviderId ? modelsLoadingByProvider[visionProviderId] === true : false;

  const handleSave = async (): Promise<boolean> => {
    setSaving(true);
    try {
      return await updateKbSettings(draft);
    } finally {
      setSaving(false);
    }
  };

  /**
   * 验证图片能力：配置需先落盘（主进程按已保存设置解析 vision 角色），
   * 有未保存修改时先保存再验证；验证发送 1x1 PNG 真实请求。
   */
  const handleVerify = async () => {
    setVerify({ kind: 'verifying' });
    try {
      if (dirty) {
        const ok = await handleSave();
        if (!ok) {
          setVerify({ kind: 'error', message: '设置保存失败，请先修正后重试' });
          return;
        }
      }
      const r = await trpc.kb.verifyVisionModel.mutate({});
      if (r.ok) {
        setVerify({ kind: 'ok', model: r.model, sample: r.sample });
      } else {
        setVerify({ kind: 'error', message: r.error.message });
      }
    } catch (err) {
      setVerify({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="space-y-5">
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
              value={draft.llm.providerId ?? ''}
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
                onClick={() => (draft.llm.providerId ?? '') && void fetchModelsForProvider(draft.llm.providerId!)}
                disabled={!draft.llm.providerId || modelsLoadingByProvider[draft.llm.providerId ?? ''] === true}
                className="flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {modelsLoadingByProvider[draft.llm.providerId ?? ''] === true ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                刷新模型列表
              </button>
            </div>
            <input
              list="kb-llm-model-options"
              value={draft.llm.model ?? ''}
              onChange={(e) => setDraft({ ...draft, llm: { ...draft.llm, model: e.target.value } })}
              placeholder="自动（凭证模型 / 会话模型 / 端点第一个可用模型）"
              disabled={!draft.llm.providerId}
              className={cn(INPUT_CLASS, 'w-full font-mono disabled:cursor-not-allowed disabled:opacity-50')}
            />
            <datalist id="kb-llm-model-options">
              {(modelsByProvider[draft.llm.providerId ?? ''] ?? []).map((m) => (
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

      {/* ── 视觉模型（issue 12）：必须显式配置 + 图片能力独立验证 ── */}
      <section>
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
          <Eye className="h-3 w-3" />
          视觉模型（图像解读）
        </div>
        <div className="space-y-2.5 rounded-md border border-border/50 bg-secondary/20 p-2.5">
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">凭证</label>
            <select
              value={visionProviderId}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  vision: { providerId: e.target.value, model: '' },
                })
              }
              className={cn(INPUT_CLASS, 'w-full')}
            >
              <option value="">未配置（含图像的来源编译将被阻止）</option>
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
                onClick={() => visionProviderId && void fetchModelsForProvider(visionProviderId)}
                disabled={!visionProviderId || visionModelsLoading}
                className="flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {visionModelsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                刷新模型列表
              </button>
            </div>
            <input
              list="kb-vision-model-options"
              value={draft.vision?.model ?? ''}
              onChange={(e) => setDraft({ ...draft, vision: { ...draft.vision, providerId: visionProviderId, model: e.target.value } })}
              placeholder="自动（凭证第一个配置模型 / 端点第一个可用模型）"
              disabled={!visionProviderId}
              className={cn(INPUT_CLASS, 'w-full font-mono disabled:cursor-not-allowed disabled:opacity-50')}
            />
            <datalist id="kb-vision-model-options">
              {visionModels.map((m) => (
                <option key={m.id} value={m.id} />
              ))}
            </datalist>
          </div>

          <div className="flex items-start gap-1.5 rounded border border-border/60 bg-secondary/15 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              图像解读与文本模型相互独立：文本对话成功不代表端点支持图片输入，
              因此不自动跟随分类模型。编译含图像的来源前需在此显式配置。
              取消勾选改为「仅按文字继续」可生成标部分产出的不完整提案。
            </span>
          </div>

          {/* 图片能力独立验证（用户主动触发的真实网络调用） */}
          <div className="flex items-center justify-between gap-2 border-t border-border/40 pt-2">
            <button
              type="button"
              onClick={() => void handleVerify()}
              disabled={!visionProviderId || verify.kind === 'verifying'}
              data-testid="verify-vision-model"
              title="发送一张最小测试图片验证端点图片输入能力（真实网络请求）"
              className={cn(
                'flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors',
                visionProviderId && verify.kind !== 'verifying'
                  ? 'bg-secondary text-secondary-foreground hover:bg-accent'
                  : 'cursor-not-allowed bg-muted text-muted-foreground',
              )}
            >
              {verify.kind === 'verifying' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ShieldCheck className="h-3 w-3" />
              )}
              {verify.kind === 'verifying' ? '验证中…' : '验证图片能力'}
            </button>
            {verify.kind === 'ok' && (
              <span data-testid="vision-verify-ok" className="flex items-center gap-1 text-[10px] text-green-600 dark:text-green-400">
                <Check className="h-3 w-3" />
                {verify.model} 支持图片输入
              </span>
            )}
            {verify.kind === 'error' && (
              <span data-testid="vision-verify-error" className="min-w-0 flex-1 truncate text-right text-[10px] text-red-500" title={verify.message}>
                {verify.message}
              </span>
            )}
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
