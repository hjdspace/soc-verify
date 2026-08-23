import { useEffect, useState } from 'react';
import { Check, CircleGauge, Key, Pencil, RefreshCw, Save, Trash2, X, Zap } from 'lucide-react';
import { useSettingsStore } from '@renderer/stores/settings';
import { useSessionStore } from '@renderer/stores/session';
import { cn } from '@renderer/lib/utils';
import type { CredentialEntry } from '@shared/types';

/**
 * 模型配置 Tab — 凭据管理（增删改 + 应用到当前会话）+ 上下文窗口设置。
 */

// ── useCredentialForm hook ────────────────────────────────

type CredentialFormState = {
  providerId: string;
  label: string;
  apiKey: string;
  baseUrl: string;
  model: string;
};

const EMPTY_FORM: CredentialFormState = {
  providerId: '',
  label: '',
  apiKey: '',
  baseUrl: '',
  model: '',
};

/**
 * 凭据表单状态 + 操作 — 管理表单字段、编辑态、保存/应用/删除。
 *
 * 返回 `form` 对象 + `update(patch)` 统一更新接口，避免散落的 setter。
 */
function useCredentialForm() {
  const setCredential = useSettingsStore((s) => s.setCredential);
  const updateCredential = useSettingsStore((s) => s.updateCredential);
  const deleteCredential = useSettingsStore((s) => s.deleteCredential);
  const applyCredential = useSessionStore((s) => s.applyCredential);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);

  const [form, setForm] = useState<CredentialFormState>(EMPTY_FORM);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [applyingProviderId, setApplyingProviderId] = useState<string | null>(null);

  const isEditing = editingProviderId !== null;
  // In add mode: providerId + apiKey are required.
  // In edit mode: only providerId is required (apiKey optional — empty keeps existing).
  const canSave = isEditing
    ? form.providerId.trim().length > 0
    : form.providerId.trim().length > 0 && form.apiKey.trim().length > 0;

  const update = (patch: Partial<CredentialFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const reset = () => {
    setForm(EMPTY_FORM);
    setEditingProviderId(null);
  };

  const save = async () => {
    if (!canSave) return;
    if (isEditing) {
      await updateCredential({
        providerId: form.providerId.trim(),
        label: form.label.trim(),
        apiKey: form.apiKey.trim() || undefined,
        baseUrl: form.baseUrl.trim() || undefined,
        model: form.model.trim() || undefined,
      });
    } else {
      await setCredential({
        providerId: form.providerId.trim(),
        label: form.label.trim() || form.providerId.trim(),
        apiKey: form.apiKey.trim(),
        baseUrl: form.baseUrl.trim() || undefined,
        model: form.model.trim() || undefined,
      });
    }
    reset();
  };

  const edit = (c: CredentialEntry) => {
    setEditingProviderId(c.providerId);
    setForm({
      providerId: c.providerId,
      label: c.label,
      apiKey: '',
      baseUrl: c.baseUrl ?? '',
      model: c.model ?? '',
    });
  };

  const cancelEdit = () => {
    reset();
  };

  const apply = async (providerIdToApply: string) => {
    if (!currentSessionId) {
      console.warn('[CredentialsTab] apply: no currentSessionId — button should have been disabled');
      return;
    }
    if (applyingProviderId) {
      console.warn(`[CredentialsTab] apply: already applying "${applyingProviderId}", ignoring click`);
      return;
    }
    console.log(`[CredentialsTab] applyCredential: sessionId=${currentSessionId}, providerId=${providerIdToApply}`);
    setApplyingProviderId(providerIdToApply);
    try {
      await applyCredential(currentSessionId, providerIdToApply);
      console.log(`[CredentialsTab] applyCredential succeeded: providerId=${providerIdToApply}`);
    } catch (err) {
      console.error(`[CredentialsTab] applyCredential failed:`, err);
    } finally {
      setApplyingProviderId(null);
    }
  };

  const remove = (providerIdToDelete: string, e: React.MouseEvent) => {
    e.stopPropagation();
    void deleteCredential(providerIdToDelete);
  };

  return {
    form,
    update,
    isEditing,
    canSave,
    applyingProviderId,
    currentSessionId,
    save,
    edit,
    cancelEdit,
    apply,
    remove,
  };
}

// ── CredentialsTab component ──────────────────────────────

export function CredentialsTab() {
  const contextWindow = useSettingsStore((s) => s.contextWindow);
  const loadContextWindow = useSettingsStore((s) => s.loadContextWindow);
  const setContextWindow = useSettingsStore((s) => s.setContextWindow);
  const credentials = useSettingsStore((s) => s.credentials);
  const loadCredentials = useSettingsStore((s) => s.loadCredentials);

  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const currentSession = sessions.find((s) => s.id === currentSessionId);

  const {
    form,
    update,
    isEditing,
    canSave,
    applyingProviderId,
    currentSessionId: hookSessionId,
    save,
    edit,
    cancelEdit,
    apply,
    remove,
  } = useCredentialForm();

  useEffect(() => {
    loadCredentials();
    void loadContextWindow();
  }, [loadContextWindow, loadCredentials]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-md border border-border/60 bg-secondary/15 px-3 py-2.5">
        <CircleGauge className="h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground">模型上下文窗口</div>
          <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
            应与模型实际支持值一致，新建或重新加载 AI 会话后生效。
          </p>
        </div>
        <select
          aria-label="模型上下文窗口"
          value={contextWindow}
          onChange={(event) => void setContextWindow(Number(event.target.value))}
          className="h-7 rounded border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary"
        >
          <option value={32_000}>32k</option>
          <option value={64_000}>64k</option>
          <option value={128_000}>128k</option>
          <option value={200_000}>200k（默认）</option>
          <option value={256_000}>256k</option>
          <option value={1_000_000}>1M</option>
        </select>
      </div>

      {/* Existing credentials — click a card to apply the whole config */}
      <div>
        <div className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">已存储凭据</div>
        {credentials.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无凭据，请先配置 API Key</p>
        ) : (
          <div className="space-y-1">
            {credentials.map((c: CredentialEntry) => {
              const isCurrent = currentSession?.model?.providerId === c.providerId;
              const isApplying = applyingProviderId === c.providerId;
              const disabled = !hookSessionId || !!applyingProviderId;
              return (
                <div
                  key={c.providerId}
                  className={cn(
                    'flex items-center gap-2 rounded border bg-secondary/20 px-2 py-1.5 transition-colors',
                    isCurrent ? 'border-primary/40 bg-primary/5' : 'border-border/50',
                    !disabled && !isCurrent && 'hover:bg-accent/30',
                  )}
                >
                  <Key className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium">{c.label}</span>
                    <span className="ml-2 text-[10px] text-muted-foreground font-mono">{c.apiKeyMasked}</span>
                    {c.baseUrl && (
                      <span className="ml-2 text-[10px] text-muted-foreground/70 truncate">{c.baseUrl}</span>
                    )}
                  </div>
                  {isCurrent ? (
                    <span className="flex shrink-0 items-center gap-0.5 rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                      <Check className="h-2.5 w-2.5" />
                      当前
                    </span>
                  ) : (
                    <button
                      onClick={() => apply(c.providerId)}
                      disabled={disabled}
                      title={disabled ? (hookSessionId ? '正在切换...' : '请先创建 AI 会话') : '整体应用到当前会话'}
                      className={cn(
                        'flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors',
                        disabled
                          ? 'cursor-not-allowed bg-muted text-muted-foreground'
                          : 'bg-primary/10 text-primary hover:bg-primary/20',
                      )}
                    >
                      {isApplying ? <RefreshCw className="h-2.5 w-2.5 animate-spin" /> : <Zap className="h-2.5 w-2.5" />}
                      {isApplying ? '切换中' : '应用'}
                    </button>
                  )}
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      edit(c);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        edit(c);
                      }
                    }}
                    title="编辑凭据"
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Pencil className="h-3 w-3" />
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => remove(c.providerId, e)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        remove(c.providerId, e as unknown as React.MouseEvent);
                      }
                    }}
                    title="删除凭据"
                    className="shrink-0 rounded p-0.5 text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="h-3 w-3" />
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {!hookSessionId && credentials.length > 0 && (
          <p className="mt-1 text-[9px] text-muted-foreground/70">
            请先创建 AI 会话后再应用凭据
          </p>
        )}
      </div>

      {/* Add / Edit credential */}
      <div className="rounded-md border border-border/50 bg-secondary/20 p-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase text-muted-foreground">
            {isEditing ? '编辑凭据' : '添加凭据'}
          </span>
          {isEditing && (
            <button
              onClick={cancelEdit}
              className="text-muted-foreground hover:text-foreground"
              title="取消编辑"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <input
            type="text"
            value={form.providerId}
            onChange={(e) => update({ providerId: e.target.value })}
            placeholder="Provider ID (如 openai)"
            disabled={isEditing}
            className={cn(
              'rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary',
              isEditing && 'cursor-not-allowed opacity-60',
            )}
          />
          <input
            type="text"
            value={form.label}
            onChange={(e) => update({ label: e.target.value })}
            placeholder="标签（可选）"
            className="rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            type="password"
            value={form.apiKey}
            onChange={(e) => update({ apiKey: e.target.value })}
            placeholder={isEditing ? 'API Key（留空保持不变）' : 'API Key'}
            className="rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            type="text"
            value={form.baseUrl}
            onChange={(e) => update({ baseUrl: e.target.value })}
            placeholder="Base URL（可选）"
            className="rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            type="text"
            value={form.model}
            onChange={(e) => update({ model: e.target.value })}
            placeholder="模型名（可选，如 gpt-4o-mini）"
            className="rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="mt-1.5 flex justify-end gap-1">
          {isEditing && (
            <button
              onClick={cancelEdit}
              className="rounded px-2.5 py-1 text-[10px] text-muted-foreground hover:bg-secondary/50"
            >
              取消
            </button>
          )}
          <button
            onClick={save}
            disabled={!canSave}
            className={cn(
              'flex items-center gap-1 rounded px-2.5 py-1 text-[10px] font-medium transition-colors',
              canSave
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'cursor-not-allowed bg-muted text-muted-foreground',
            )}
          >
            <Save className="h-3 w-3" />
            {isEditing ? '更新' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
