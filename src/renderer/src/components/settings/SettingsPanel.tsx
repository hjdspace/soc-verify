import { useEffect, useState } from 'react';
import { X, Key, Package, Server, FileText, Plus, Trash2, Save, Download, Upload, Palette, Check, Cpu, RefreshCw, Zap, Info, BookOpen, Folder, ChevronDown, ChevronRight, Pencil } from 'lucide-react';
import { useSettingsStore } from '@renderer/stores/settings';
import { useProjectStore } from '@renderer/stores/project';
import { useUiStore } from '@renderer/stores/ui';
import { useThemeStore } from '@renderer/stores/theme';
import { useSessionStore } from '@renderer/stores/session';
import { cn } from '@renderer/lib/utils';
import { MarkdownRenderer } from '@renderer/components/chat/MarkdownRenderer';
import type { CredentialEntry, SkillInfo, CreateSkillInput } from '@shared/types';

type SettingsTab = 'credentials' | 'skills' | 'mcp' | 'prompt' | 'appearance';

export function SettingsPanel() {
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const [tab, setTab] = useState<SettingsTab>('credentials');

  if (!settingsOpen) return null;

  const tabs: Array<{ id: SettingsTab; label: string; icon: typeof Key }> = [
    { id: 'credentials', label: '模型配置', icon: Cpu },
    { id: 'skills', label: 'Skill 管理', icon: Package },
    { id: 'mcp', label: 'MCP 配置', icon: Server },
    { id: 'prompt', label: '系统提示词', icon: FileText },
    { id: 'appearance', label: '外观', icon: Palette },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex h-[520px] w-[680px] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <h2 className="text-sm font-semibold">设置</h2>
          <button
            onClick={() => setSettingsOpen(false)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors',
                tab === t.id
                  ? 'border-b border-primary text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <t.icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'credentials' && <CredentialsTab />}
          {tab === 'skills' && <SkillsTab />}
          {tab === 'mcp' && <McpTab />}
          {tab === 'prompt' && <PromptTab />}
        </div>
      </div>
    </div>
  );
}

// ── Appearance Tab ───────────────────────────────────────

function AppearanceTab() {
  const currentTheme = useThemeStore((s) => s.currentTheme);
  const themes = useThemeStore((s) => s.themes);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <div className="space-y-3">
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">主题</div>
      <div className="grid grid-cols-2 gap-2">
        {themes.map((theme) => (
          <button
            key={theme.id}
            onClick={() => setTheme(theme.id)}
            className={cn(
              'flex items-center gap-3 rounded-md border p-2.5 text-left transition-colors',
              currentTheme === theme.id
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-accent',
            )}
          >
            {/* 色板预览 */}
            <span
              className="h-8 w-8 shrink-0 rounded-md border border-border"
              style={{ backgroundColor: theme.swatch }}
            />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-foreground">{theme.name}</div>
              <div className="truncate text-[10px] text-muted-foreground">
                {theme.description}
              </div>
            </div>
            {currentTheme === theme.id && (
              <Check className="h-4 w-4 shrink-0 text-primary" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Credentials Tab (with inline model switcher) ───────

function CredentialsTab() {
  const credentials = useSettingsStore((s) => s.credentials);
  const loadCredentials = useSettingsStore((s) => s.loadCredentials);
  const setCredential = useSettingsStore((s) => s.setCredential);
  const updateCredential = useSettingsStore((s) => s.updateCredential);
  const deleteCredential = useSettingsStore((s) => s.deleteCredential);

  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const currentSession = useSessionStore((s) =>
    s.sessions.find((sess) => sess.id === s.currentSessionId),
  );
  const applyCredential = useSessionStore((s) => s.applyCredential);
  const [applyingProviderId, setApplyingProviderId] = useState<string | null>(null);

  const [providerId, setProviderId] = useState('');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);

  useEffect(() => {
    loadCredentials();
  }, [loadCredentials]);

  const isEditing = editingProviderId !== null;
  // In add mode: providerId + apiKey are required.
  // In edit mode: only providerId is required (apiKey optional — empty keeps existing).
  const canSave = isEditing
    ? providerId.trim().length > 0
    : providerId.trim().length > 0 && apiKey.trim().length > 0;

  const resetForm = () => {
    setProviderId('');
    setLabel('');
    setApiKey('');
    setBaseUrl('');
    setEditingProviderId(null);
  };

  const handleSave = async () => {
    if (!canSave) return;
    if (isEditing) {
      await updateCredential({
        providerId: providerId.trim(),
        label: label.trim(),
        apiKey: apiKey.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
      });
    } else {
      await setCredential({
        providerId: providerId.trim(),
        label: label.trim() || providerId.trim(),
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || undefined,
      });
    }
    resetForm();
  };

  const handleEdit = (c: CredentialEntry) => {
    setEditingProviderId(c.providerId);
    setProviderId(c.providerId);
    setLabel(c.label);
    setApiKey('');
    setBaseUrl(c.baseUrl ?? '');
  };

  const handleCancelEdit = () => {
    resetForm();
  };

  const handleApplyCredential = async (providerIdToApply: string) => {
    if (!currentSessionId) {
      console.warn('[SettingsPanel] handleApplyCredential: no currentSessionId — button should have been disabled');
      return;
    }
    if (applyingProviderId) {
      console.warn(`[SettingsPanel] handleApplyCredential: already applying "${applyingProviderId}", ignoring click`);
      return;
    }
    console.log(`[SettingsPanel] applyCredential: sessionId=${currentSessionId}, providerId=${providerIdToApply}`);
    setApplyingProviderId(providerIdToApply);
    try {
      await applyCredential(currentSessionId, providerIdToApply);
      console.log(`[SettingsPanel] applyCredential succeeded: providerId=${providerIdToApply}`);
    } catch (err) {
      console.error(`[SettingsPanel] applyCredential failed:`, err);
    } finally {
      setApplyingProviderId(null);
    }
  };

  const handleDelete = (providerIdToDelete: string, e: React.MouseEvent) => {
    e.stopPropagation();
    void deleteCredential(providerIdToDelete);
  };

  return (
    <div className="space-y-3">
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
              const disabled = !currentSessionId || !!applyingProviderId;
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
                      onClick={() => handleApplyCredential(c.providerId)}
                      disabled={disabled}
                      title={disabled ? (currentSessionId ? '正在切换...' : '请先创建 AI 会话') : '整体应用到当前会话'}
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
                      handleEdit(c);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        handleEdit(c);
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
                    onClick={(e) => handleDelete(c.providerId, e)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleDelete(c.providerId, e as unknown as React.MouseEvent);
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
        {!currentSessionId && credentials.length > 0 && (
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
              onClick={handleCancelEdit}
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
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            placeholder="Provider ID (如 openai)"
            disabled={isEditing}
            className={cn(
              'rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary',
              isEditing && 'cursor-not-allowed opacity-60',
            )}
          />
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="标签（可选）"
            className="rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={isEditing ? 'API Key（留空保持不变）' : 'API Key'}
            className="rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="Base URL（可选）"
            className="rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="mt-1.5 flex justify-end gap-1">
          {isEditing && (
            <button
              onClick={handleCancelEdit}
              className="rounded px-2.5 py-1 text-[10px] text-muted-foreground hover:bg-secondary/50"
            >
              取消
            </button>
          )}
          <button
            onClick={handleSave}
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

// ── Skills Tab ───────────────────────────────────────────

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  builtin: { label: '内置', color: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  user: { label: '用户级', color: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  project: { label: '项目级', color: 'bg-purple-500/15 text-purple-600 dark:text-purple-400' },
};

function SkillSourceBadge({ source }: { source: string }) {
  const info = SOURCE_LABELS[source] ?? { label: source, color: 'bg-muted text-muted-foreground' };
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-medium', info.color)}>
      {info.label}
    </span>
  );
}

function SkillCard({ skill, onUninstall }: {
  skill: SkillInfo;
  onUninstall: (name: string) => void;
}) {
  const canDelete = skill.source === 'user';
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const readSkillContent = useSettingsStore((s) => s.readSkillContent);

  const handleToggle = async () => {
    if (!expanded && content === null) {
      setLoading(true);
      const text = await readSkillContent(skill.filePath);
      setContent(text);
      setLoading(false);
    }
    setExpanded(!expanded);
  };

  return (
    <div className="rounded border border-border/50 bg-secondary/20">
      <div
        className="flex cursor-pointer items-start gap-2 px-2 py-1.5 hover:bg-secondary/30"
        onClick={handleToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleToggle();
          }
        }}
      >
        <Package className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-mono font-medium">{skill.name}</span>
            <SkillSourceBadge source={skill.source} />
          </div>
          {skill.description && (
            <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{skill.description}</p>
          )}
        </div>
        {loading && <RefreshCw className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-muted-foreground" />}
        {!loading && (
          <ChevronRight className={cn('mt-0.5 h-3 w-3 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
        )}
        {canDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onUninstall(skill.name);
            }}
            className="shrink-0 rounded p-0.5 text-destructive hover:bg-destructive/10"
            title="卸载技能"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
      {expanded && content !== null && (
        <div className="border-t border-border/30 px-2 py-2">
          <div className="mb-1 flex items-center gap-1 text-[9px] text-muted-foreground/70">
            <FileText className="h-2.5 w-2.5" />
            <span className="font-mono">{skill.filePath}</span>
          </div>
          <div className="markdown-body max-h-64 overflow-auto text-[11px] leading-relaxed text-foreground/80">
            <MarkdownRenderer content={content} />
          </div>
        </div>
      )}
    </div>
  );
}

function CreateSkillForm({ onCreate }: {
  onCreate: (input: CreateSkillInput) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [expanded, setExpanded] = useState(false);

  const nameValid = /^[a-z0-9][a-z0-9-]{0,63}$/.test(name.trim());
  const canSubmit = nameValid && description.trim() && body.trim();

  const handleSubmit = async () => {
    if (!canSubmit) return;
    onCreate({ name: name.trim(), description: description.trim(), body: body.trim() });
    setName('');
    setDescription('');
    setBody('');
    setExpanded(false);
  };

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="flex w-full items-center gap-1.5 rounded border border-dashed border-border/50 px-2 py-1.5 text-xs text-muted-foreground hover:bg-secondary/30"
      >
        <Pencil className="h-3 w-3" />
        创建新技能
      </button>
    );
  }

  return (
    <div className="space-y-1.5 rounded border border-border/50 bg-secondary/20 p-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase text-muted-foreground">创建新技能</span>
        <button
          onClick={() => setExpanded(false)}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="技能名称（kebab-case，如 my-skill）"
          className={cn(
            'w-full rounded border bg-background px-2 py-1 text-xs outline-none focus:ring-1',
            name && !nameValid
              ? 'border-destructive focus:ring-destructive'
              : 'border-border focus:ring-primary',
          )}
        />
        {name && !nameValid && (
          <p className="mt-0.5 text-[10px] text-destructive">
            仅允许小写字母、数字和连字符（1-64 字符，以字母或数字开头）
          </p>
        )}
      </div>
      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="技能描述（一行，用于技能发现）"
        className="w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="技能内容（Markdown 格式，无需包含 frontmatter）"
        rows={4}
        className="w-full resize-y rounded border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-1 focus:ring-primary"
      />
      <div className="flex justify-end gap-1">
        <button
          onClick={() => setExpanded(false)}
          className="rounded px-2 py-1 text-[10px] text-muted-foreground hover:bg-secondary/50"
        >
          取消
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={cn(
            'flex items-center gap-1 rounded px-2.5 py-1 text-[10px] font-medium transition-colors',
            canSubmit
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'cursor-not-allowed bg-muted text-muted-foreground',
          )}
        >
          <Plus className="h-3 w-3" />
          创建
        </button>
      </div>
    </div>
  );
}

function SkillDirectoryList({ directories }: {
  directories: NonNullable<ReturnType<typeof useSettingsStore.getState>['skillInstallInfo']>['directories'];
}) {
  return (
    <div className="space-y-1">
      {directories.map((dir) => (
        <div key={dir.path} className="flex items-center gap-1.5 text-[11px]">
          <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">{dir.label}</span>
          <span
            className={cn(
              'ml-auto truncate font-mono text-[10px]',
              dir.exists ? 'text-foreground/70' : 'text-muted-foreground/50',
            )}
            title={dir.path}
          >
            {dir.path}
          </span>
          <span
            className={cn(
              'shrink-0 rounded px-1 py-0.5 text-[9px]',
              dir.exists
                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {dir.exists ? '存在' : '不存在'}
          </span>
        </div>
      ))}
    </div>
  );
}

function SkillsTab() {
  const skills = useSettingsStore((s) => s.skills);
  const loadSkills = useSettingsStore((s) => s.loadSkills);
  const createSkill = useSettingsStore((s) => s.createSkill);
  const uninstallSkill = useSettingsStore((s) => s.uninstallSkill);
  const skillInstallInfo = useSettingsStore((s) => s.skillInstallInfo);
  const loadSkillInstallInfo = useSettingsStore((s) => s.loadSkillInstallInfo);

  const [showGuidance, setShowGuidance] = useState(false);

  useEffect(() => {
    loadSkills();
    loadSkillInstallInfo();
  }, [loadSkills, loadSkillInstallInfo]);

  // Group skills by source
  const builtinSkills = skills.filter((s) => s.source === 'builtin');
  const userSkills = skills.filter((s) => s.source === 'user');
  const projectSkills = skills.filter((s) => s.source === 'project');

  return (
    <div className="space-y-3">
      {/* Installed Skills */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase text-muted-foreground">
            已安装技能（{skills.length}）
          </span>
          <button
            onClick={() => { loadSkills(); loadSkillInstallInfo(); }}
            className="text-muted-foreground hover:text-foreground"
            title="刷新"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
        {skills.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂未发现任何技能</p>
        ) : (
          <div className="space-y-2">
            {builtinSkills.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] text-muted-foreground/70">内置技能（{builtinSkills.length}）</div>
                {builtinSkills.map((s) => (
                  <SkillCard key={s.filePath} skill={s} onUninstall={uninstallSkill} />
                ))}
              </div>
            )}
            {userSkills.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] text-muted-foreground/70">用户级技能（{userSkills.length}）</div>
                {userSkills.map((s) => (
                  <SkillCard key={s.filePath} skill={s} onUninstall={uninstallSkill} />
                ))}
              </div>
            )}
            {projectSkills.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] text-muted-foreground/70">项目级技能（{projectSkills.length}）</div>
                {projectSkills.map((s) => (
                  <SkillCard key={s.filePath} skill={s} onUninstall={uninstallSkill} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create Skill */}
      <CreateSkillForm onCreate={createSkill} />

      {/* Guidance & Directory Info */}
      <div className="rounded-md border border-border/50 bg-secondary/20">
        <button
          onClick={() => setShowGuidance(!showGuidance)}
          className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[10px] font-semibold uppercase text-muted-foreground hover:bg-secondary/30"
        >
          {showGuidance ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <Info className="h-3 w-3" />
          技能安装指南
        </button>
        {showGuidance && (
          <div className="space-y-2 border-t border-border/30 px-2 py-2">
            {skillInstallInfo && (
              <>
                <div>
                  <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                    <BookOpen className="h-3 w-3" />
                    如何安装技能
                  </div>
                  <pre className="whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                    {skillInstallInfo.guidance}
                  </pre>
                </div>
                <div>
                  <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                    <Folder className="h-3 w-3" />
                    技能扫描目录
                  </div>
                  <SkillDirectoryList directories={skillInstallInfo.directories} />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── MCP Tab ──────────────────────────────────────────────

function McpTab() {
  const setMcpConfig = useSettingsStore((s) => s.setMcpConfig);
  const loadMcpServers = useSettingsStore((s) => s.loadMcpServers);
  const mcpServers = useSettingsStore((s) => s.mcpServers);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  const [configText, setConfigText] = useState('{\n  "servers": []\n}');

  useEffect(() => {
    loadMcpServers();
  }, [loadMcpServers]);

  const handleSave = async () => {
    if (!currentProjectId) return;
    try {
      const config = JSON.parse(configText);
      await setMcpConfig(currentProjectId, config);
    } catch {
      // JSON parse error handled by toast
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">已配置 MCP 服务器</div>
        {mcpServers.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无 MCP 服务器</p>
        ) : (
          <div className="space-y-1">
            {mcpServers.map((s) => (
              <div key={s} className="flex items-center gap-2 rounded border border-border/50 bg-secondary/20 px-2 py-1.5">
                <Server className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs font-mono">{s}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-md border border-border/50 bg-secondary/20 p-2">
        <div className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">MCP 配置 (JSON)</div>
        <textarea
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          rows={8}
          className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-1 focus:ring-primary"
        />
        <div className="mt-1.5 flex justify-end">
          <button
            onClick={handleSave}
            disabled={!currentProjectId}
            className={cn(
              'flex items-center gap-1 rounded px-2.5 py-1 text-[10px] font-medium transition-colors',
              currentProjectId
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'cursor-not-allowed bg-muted text-muted-foreground',
            )}
          >
            <Save className="h-3 w-3" />
            保存配置
          </button>
        </div>
      </div>
    </div>
  );
}

// ── System Prompt Tab ────────────────────────────────────

function PromptTab() {
  const systemPrompt = useSettingsStore((s) => s.systemPrompt);
  const loadSystemPrompt = useSettingsStore((s) => s.loadSystemPrompt);
  const setSystemPrompt = useSettingsStore((s) => s.setSystemPrompt);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const [promptText, setPromptText] = useState('');

  useEffect(() => {
    if (currentProjectId) {
      loadSystemPrompt(currentProjectId).then(() => {
        setPromptText(useSettingsStore.getState().systemPrompt);
      });
    }
  }, [currentProjectId, loadSystemPrompt]);

  useEffect(() => {
    setPromptText(systemPrompt);
  }, [systemPrompt]);

  const handleSave = async () => {
    if (!currentProjectId) return;
    await setSystemPrompt(currentProjectId, promptText);
  };

  return (
    <div className="space-y-2">
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">自定义系统提示词</div>
      <p className="text-[10px] text-muted-foreground">
        此提示词将附加到每个 AI 会话的系统消息中，用于定制 AI 的行为和上下文。
      </p>
      <textarea
        value={promptText}
        onChange={(e) => setPromptText(e.target.value)}
        rows={12}
        placeholder="输入自定义系统提示词..."
        className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
      />
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={!currentProjectId}
          className={cn(
            'flex items-center gap-1 rounded px-2.5 py-1 text-[10px] font-medium transition-colors',
            currentProjectId
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'cursor-not-allowed bg-muted text-muted-foreground',
          )}
        >
          <Save className="h-3 w-3" />
          保存
        </button>
      </div>
    </div>
  );
}
