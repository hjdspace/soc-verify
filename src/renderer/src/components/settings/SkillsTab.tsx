import { useEffect, useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, FileText, Folder, Info, Package, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useSettingsStore } from '@renderer/stores/settings';
import { cn } from '@renderer/lib/utils';
import { MarkdownRenderer } from '@renderer/components/chat/MarkdownRenderer';
import type { SkillInfo, CreateSkillInput } from '@shared/types';

/**
 * Skill 管理 Tab — 列出已安装技能（内置/用户/项目级），支持创建和卸载。
 */

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

export function SkillsTab() {
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
