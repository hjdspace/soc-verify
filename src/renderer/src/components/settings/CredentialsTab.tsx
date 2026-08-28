import { useEffect, useState, useCallback } from 'react';
import { Check, Key, Loader2, Pencil, Plus, RefreshCw, Save, Search, Trash2, X } from 'lucide-react';
import { useSettingsStore, type ApiModel } from '@renderer/stores/settings';
import { cn } from '@renderer/lib/utils';
import type { CredentialEntry, ConfiguredModel, OpenAiApiFormat } from '@shared/types';
import { DEFAULT_CONTEXT_WINDOW } from '@shared/context-management';

/**
 * 模型配置 Tab — 凭据管理（增删改）+ 每个凭据下的模型列表配置。
 *
 * 每个模型有独立的 contextWindow，不再使用全局上下文窗口。
 * 添加模型时可以从 API 获取模型列表供用户选择。
 * 每个凭据可选择 API 格式：Chat Completions 或 Responses。
 */

// ── Context window preset options ──────────────────────
const CONTEXT_WINDOW_OPTIONS = [
  { value: 32_000, label: '32k' },
  { value: 64_000, label: '64k' },
  { value: 128_000, label: '128k' },
  { value: 200_000, label: '200k' },
  { value: 256_000, label: '256k' },
  { value: 512_000, label: '512k' },
  { value: 1_000_000, label: '1M' },
];

// ── OpenAI API wire format options ─────────────────────
const API_FORMAT_OPTIONS: Array<{ value: OpenAiApiFormat; label: string; hint: string }> = [
  { value: 'openai-completions', label: 'Chat Completions (/chat/completions)', hint: '兼容绝大多数 OpenAI 兼容网关' },
  { value: 'openai-responses', label: 'Responses (/responses)', hint: '仅当后端实现了 Responses API 时选择' },
];

const DEFAULT_API_FORMAT: OpenAiApiFormat = 'openai-completions';

function apiFormatLabel(api: OpenAiApiFormat | undefined): string {
  return API_FORMAT_OPTIONS.find((o) => o.value === (api ?? DEFAULT_API_FORMAT))?.label ?? api!;
}

// ── useCredentialForm hook ────────────────────────────────

type CredentialFormState = {
  providerId: string;
  label: string;
  apiKey: string;
  baseUrl: string;
  api: OpenAiApiFormat;
  models: ConfiguredModel[];
};

const EMPTY_FORM: CredentialFormState = {
  providerId: '',
  label: '',
  apiKey: '',
  baseUrl: '',
  api: DEFAULT_API_FORMAT,
  models: [],
};

/**
 * 凭据表单状态 + 操作 — 管理表单字段、编辑态、保存/删除。
 */
function useCredentialForm() {
  const setCredential = useSettingsStore((s) => s.setCredential);
  const updateCredential = useSettingsStore((s) => s.updateCredential);
  const deleteCredential = useSettingsStore((s) => s.deleteCredential);
  const fetchModelsFromApi = useSettingsStore((s) => s.fetchModels);

  const [form, setForm] = useState<CredentialFormState>(EMPTY_FORM);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [fetchedModels, setFetchedModels] = useState<ApiModel[]>([]);

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
    setShowModelPicker(false);
    setFetchedModels([]);
    setModelSearch('');
  };

  const save = async () => {
    if (!canSave) return;
    if (isEditing) {
      await updateCredential({
        providerId: form.providerId.trim(),
        label: form.label.trim(),
        apiKey: form.apiKey.trim() || undefined,
        baseUrl: form.baseUrl.trim() || undefined,
        api: form.api,
        models: form.models,
      });
    } else {
      await setCredential({
        providerId: form.providerId.trim(),
        label: form.label.trim() || form.providerId.trim(),
        apiKey: form.apiKey.trim(),
        baseUrl: form.baseUrl.trim() || undefined,
        api: form.api,
        models: form.models,
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
      api: c.api ?? DEFAULT_API_FORMAT,
      models: c.models ?? [],
    });
  };

  const cancelEdit = () => {
    reset();
  };

  const remove = (providerIdToDelete: string, e: React.MouseEvent) => {
    e.stopPropagation();
    void deleteCredential(providerIdToDelete);
  };

  // ── Model management within the form ──

  const addModel = (model: ConfiguredModel) => {
    // Avoid duplicates
    if (form.models.some((m) => m.id === model.id)) return;
    setForm((prev) => ({ ...prev, models: [...prev.models, model] }));
  };

  const removeModel = (modelId: string) => {
    setForm((prev) => ({ ...prev, models: prev.models.filter((m) => m.id !== modelId) }));
  };

  const updateModelContextWindow = (modelId: string, contextWindow: number) => {
    setForm((prev) => ({
      ...prev,
      models: prev.models.map((m) => m.id === modelId ? { ...m, contextWindow } : m),
    }));
  };

  /** 切换模型的推理标记：决定 models.yml 是否声明 thinking 能力（思考强度下拉是否生效）。 */
  const toggleModelReasoning = (modelId: string) => {
    setForm((prev) => ({
      ...prev,
      models: prev.models.map((m) => m.id === modelId ? { ...m, reasoning: !m.reasoning } : m),
    }));
  };

  const fetchModels = useCallback(async () => {
    if (!form.providerId.trim() || (!form.apiKey.trim() && !isEditing)) return;
    setFetchingModels(true);
    try {
      // For edit mode with empty apiKey, the backend uses stored credentials
      const apiKey = form.apiKey.trim() || undefined;
      const baseUrl = form.baseUrl.trim() || undefined;
      const models = await fetchModelsFromApi(form.providerId.trim(), apiKey, baseUrl);
      setFetchedModels(models);
      setShowModelPicker(true);
    } finally {
      setFetchingModels(false);
    }
  }, [form.providerId, form.apiKey, form.baseUrl, isEditing, fetchModelsFromApi]);

  const filteredFetchedModels = fetchedModels.filter((m) =>
    m.id.toLowerCase().includes(modelSearch.toLowerCase()) ||
    m.name.toLowerCase().includes(modelSearch.toLowerCase()),
  );

  return {
    form,
    update,
    isEditing,
    canSave,
    fetchingModels,
    showModelPicker,
    modelSearch,
    fetchedModels: filteredFetchedModels,
    save,
    edit,
    cancelEdit,
    remove,
    addModel,
    removeModel,
    updateModelContextWindow,
    toggleModelReasoning,
    fetchModels,
    setShowModelPicker,
    setModelSearch,
  };
}

// ── CredentialsTab component ──────────────────────────────

export function CredentialsTab() {
  const credentials = useSettingsStore((s) => s.credentials);
  const loadCredentials = useSettingsStore((s) => s.loadCredentials);

  const {
    form,
    update,
    isEditing,
    canSave,
    fetchingModels,
    showModelPicker,
    modelSearch,
    fetchedModels,
    save,
    edit,
    cancelEdit,
    remove,
    addModel,
    removeModel,
    updateModelContextWindow,
    toggleModelReasoning,
    fetchModels,
    setShowModelPicker,
    setModelSearch,
  } = useCredentialForm();

  useEffect(() => {
    loadCredentials();
  }, [loadCredentials]);

  return (
    <div className="space-y-3">
      {/* Existing credentials */}
      <div>
        <div className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">已存储凭据</div>
        {credentials.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无凭据，请先配置 API Key</p>
        ) : (
          <div className="space-y-1">
            {credentials.map((c: CredentialEntry) => (
              <div
                key={c.providerId}
                className={cn(
                  'flex items-center gap-2 rounded border bg-secondary/20 px-2 py-1.5 transition-colors',
                  'border-border/50 hover:bg-accent/30',
                )}
              >
                <Key className="h-3 w-3 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium">{c.label}</span>
                  <span className="ml-2 text-[10px] text-muted-foreground font-mono">{c.apiKeyMasked}</span>
                  {c.baseUrl && (
                    <span className="ml-2 text-[10px] text-muted-foreground/70 truncate">{c.baseUrl}</span>
                  )}
                  <span
                    className={cn(
                      'ml-2 rounded px-1 py-px text-[9px]',
                      (c.api ?? 'openai-completions') === 'openai-responses'
                        ? 'bg-primary/10 text-primary'
                        : 'bg-muted text-muted-foreground',
                    )}
                    title={apiFormatLabel(c.api)}
                  >
                    {(c.api ?? 'openai-completions') === 'openai-responses' ? 'Responses' : 'Chat Completions'}
                  </span>
                  {c.models.length > 0 && (
                    <span className="ml-2 text-[10px] text-primary/70">{c.models.length} 个模型</span>
                  )}
                </div>
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
            ))}
          </div>
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
          <div className="col-span-2 flex items-center gap-1.5">
            <select
              aria-label="API 格式"
              value={form.api}
              onChange={(e) => update({ api: e.target.value as OpenAiApiFormat })}
              className="h-6 min-w-0 flex-1 rounded border border-input bg-background px-1.5 text-[10px] text-foreground outline-none focus:ring-1 focus:ring-primary"
            >
              {API_FORMAT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <span className="shrink-0 text-[9px] text-muted-foreground/70">
              {API_FORMAT_OPTIONS.find((o) => o.value === form.api)?.hint}
            </span>
          </div>
        </div>

        {/* Model list configuration */}
        <div className="mt-2 rounded border border-border/40 bg-background/40 p-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase text-muted-foreground">
              模型列表 ({form.models.length})
            </span>
            <button
              onClick={fetchModels}
              disabled={fetchingModels || (!form.providerId.trim()) || (!form.apiKey.trim() && !isEditing)}
              title="从 API 获取模型列表"
              className={cn(
                'flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors',
                (fetchingModels || !form.providerId.trim() || (!form.apiKey.trim() && !isEditing))
                  ? 'cursor-not-allowed bg-muted text-muted-foreground'
                  : 'bg-primary/10 text-primary hover:bg-primary/20',
              )}
            >
              {fetchingModels ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <RefreshCw className="h-2.5 w-2.5" />}
              从 API 获取
            </button>
          </div>

          {/* Model picker dropdown */}
          {showModelPicker && fetchedModels.length > 0 && (
            <div className="mb-2 rounded border border-border bg-popover shadow-sm">
              <div className="flex items-center gap-1 border-b border-border/50 px-2 py-1">
                <Search className="h-3 w-3 text-muted-foreground" />
                <input
                  type="text"
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  placeholder="搜索模型..."
                  className="flex-1 bg-transparent text-[10px] outline-none"
                  autoFocus
                />
                <button
                  onClick={() => setShowModelPicker(false)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
              <div className="max-h-32 overflow-y-auto">
                {fetchedModels.map((m) => {
                  const alreadyAdded = form.models.some((fm) => fm.id === m.id);
                  return (
                    <button
                      key={m.id}
                      onClick={() => {
                        if (!alreadyAdded) {
                          addModel({
                            id: m.id,
                            name: m.name,
                            contextWindow: DEFAULT_CONTEXT_WINDOW,
                          });
                        }
                      }}
                      disabled={alreadyAdded}
                      className={cn(
                        'flex w-full items-center gap-1.5 px-2 py-1 text-left text-[10px] hover:bg-accent',
                        alreadyAdded && 'cursor-not-allowed opacity-50',
                      )}
                    >
                      {alreadyAdded ? (
                        <Check className="h-2.5 w-2.5 text-muted-foreground" />
                      ) : (
                        <Plus className="h-2.5 w-2.5 text-primary" />
                      )}
                      <span className="font-medium text-foreground">{m.name}</span>
                      <span className="text-muted-foreground">{m.id}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Configured models list */}
          {form.models.length === 0 ? (
            <p className="text-[10px] text-muted-foreground/70">
              暂未配置模型。点击"从 API 获取"选择模型，或手动添加。
            </p>
          ) : (
            <div className="space-y-1">
              {form.models.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-1.5 rounded border border-border/40 bg-secondary/10 px-1.5 py-1"
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-[10px] font-medium text-foreground">{m.name}</span>
                    <span className="ml-1.5 text-[9px] text-muted-foreground font-mono">{m.id}</span>
                  </div>
                  <select
                    aria-label="上下文窗口"
                    value={m.contextWindow}
                    onChange={(e) => updateModelContextWindow(m.id, Number(e.target.value))}
                    className="h-5 rounded border border-input bg-background px-1 text-[9px] text-foreground outline-none focus:ring-1 focus:ring-primary"
                  >
                    {CONTEXT_WINDOW_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                    {/* Include the current value if it's not in the preset list */}
                    {!CONTEXT_WINDOW_OPTIONS.some((opt) => opt.value === m.contextWindow) && (
                      <option value={m.contextWindow}>{(m.contextWindow / 1000).toFixed(0)}k</option>
                    )}
                  </select>
                  <button
                    onClick={() => toggleModelReasoning(m.id)}
                    title="标记为推理模型后，可在 AI 输入框选择思考强度（off/minimal…max）"
                    aria-pressed={m.reasoning === true}
                    className={cn(
                      'h-5 shrink-0 rounded border px-1 text-[9px] transition-colors',
                      m.reasoning
                        ? 'border-primary/60 bg-primary/15 text-primary'
                        : 'border-border bg-background text-muted-foreground hover:text-foreground',
                    )}
                  >
                    推理
                  </button>
                  <button
                    onClick={() => removeModel(m.id)}
                    title="移除模型"
                    className="shrink-0 rounded p-0.5 text-destructive hover:bg-destructive/10"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Manual model add (without API fetch) */}
          <button
            onClick={() => {
              const id = prompt('输入模型 ID（如 gpt-4o-mini）');
              if (!id) return;
              addModel({
                id,
                name: id,
                contextWindow: DEFAULT_CONTEXT_WINDOW,
              });
            }}
            className="mt-1.5 flex items-center gap-1 text-[9px] text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-2.5 w-2.5" />
            手动添加模型
          </button>
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
