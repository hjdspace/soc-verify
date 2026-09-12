import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Info, RefreshCw, Save } from 'lucide-react';
import { useSettingsStore } from '@renderer/stores/settings';
import { useProjectStore } from '@renderer/stores/project';
import { useSessionCoreStore } from '@renderer/stores/session-core';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

/**
 * 系统提示词 Tab — 展示引擎默认提示词（只读参考）+ 编辑自定义提示词
 * + 查看活动会话的 Effective System Prompt（pi 引擎，issue 06）。
 */

/** 选取当前项目最近一个已启动 runner 的会话（单一选择逻辑，供渲染与回调共用）。 */
function selectActiveRuntimeSession(
  sessions: Array<{ projectId: string; runtimeSessionId?: string; createdAt: number }>,
  projectId: string | null,
): { runtimeSessionId: string } | undefined {
  return sessions
    .filter((s) => s.projectId === projectId && s.runtimeSessionId)
    .sort((a, b) => b.createdAt - a.createdAt)[0] as { runtimeSessionId: string } | undefined;
}

/** 当前项目活动会话的 Effective System Prompt 查看区。 */
function EffectiveSystemPromptSection() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const sessions = useSessionCoreStore((s) => s.sessions);
  const [effectivePrompt, setEffectivePrompt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showEffective, setShowEffective] = useState(false);

  const activeSession = selectActiveRuntimeSession(sessions, currentProjectId);

  const loadEffectivePrompt = async () => {
    const runtimeSessionId = selectActiveRuntimeSession(
      useSessionCoreStore.getState().sessions,
      currentProjectId,
    )?.runtimeSessionId;
    if (!runtimeSessionId) {
      setEffectivePrompt(null);
      return;
    }
    setLoading(true);
    try {
      // 引擎不支持时返回 null
      setEffectivePrompt(await trpc.session.getSystemPrompt.query({ sessionId: runtimeSessionId }));
    } catch {
      setEffectivePrompt(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (showEffective) {
      void loadEffectivePrompt();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showEffective, activeSession?.runtimeSessionId]);

  return (
    <div className="rounded-md border border-border/60">
      <button
        onClick={() => setShowEffective((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-accent/40"
      >
        {showEffective ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="text-[10px] font-semibold uppercase text-muted-foreground">
          当前生效系统提示词（活动会话）
        </span>
        <Info className="ml-auto h-3 w-3 shrink-0 text-muted-foreground/60" />
      </button>
      {showEffective && (
        <div className="border-t border-border/60 px-2.5 py-2">
          <p className="mb-1.5 text-[10px] leading-relaxed text-muted-foreground">
            会话运行时的 Effective System Prompt = 引擎基础提示词 + 自定义提示词 + SoC Verify 应用规则。
            需要存在已启动的 AI 会话。
          </p>
          {!activeSession ? (
            <p className="rounded bg-muted/40 px-2 py-3 text-center text-[10px] text-muted-foreground">
              当前项目没有已启动的 AI 会话
            </p>
          ) : loading ? (
            <p className="rounded bg-muted/40 px-2 py-3 text-center text-[10px] text-muted-foreground">
              加载中...
            </p>
          ) : effectivePrompt ? (
            <pre className="max-h-72 overflow-auto rounded border border-border bg-background p-2 text-[9px] leading-relaxed text-foreground/80 whitespace-pre-wrap break-words font-mono">
              {effectivePrompt}
            </pre>
          ) : (
            <p className="rounded bg-muted/40 px-2 py-3 text-center text-[10px] text-muted-foreground">
              当前引擎不支持查看运行时提示词
            </p>
          )}
          <div className="mt-1.5 flex justify-end">
            <button
              onClick={() => void loadEffectivePrompt()}
              disabled={!activeSession}
              className={cn(
                'flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-accent hover:text-foreground',
                !activeSession && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground',
              )}
            >
              <RefreshCw className="h-2.5 w-2.5" />
              刷新
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function PromptTab() {
  const systemPrompt = useSettingsStore((s) => s.systemPrompt);
  const loadSystemPrompt = useSettingsStore((s) => s.loadSystemPrompt);
  const setSystemPrompt = useSettingsStore((s) => s.setSystemPrompt);
  const defaultSystemPrompt = useSettingsStore((s) => s.defaultSystemPrompt);
  const loadDefaultSystemPrompt = useSettingsStore((s) => s.loadDefaultSystemPrompt);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const [promptText, setPromptText] = useState('');
  const [showDefault, setShowDefault] = useState(false);

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

  // Load the default system prompt once on mount (it's static, doesn't depend on project).
  useEffect(() => {
    if (!defaultSystemPrompt) {
      loadDefaultSystemPrompt();
    }
  }, [defaultSystemPrompt, loadDefaultSystemPrompt]);

  const handleSave = async () => {
    if (!currentProjectId) return;
    await setSystemPrompt(currentProjectId, promptText);
  };

  return (
    <div className="space-y-3">
      {/* 当前生效系统提示词（活动会话运行时值，issue 06） */}
      <EffectiveSystemPromptSection />

      {/* 默认系统提示词（只读参考） */}
      <div className="rounded-md border border-border/60">
        <button
          onClick={() => setShowDefault((v) => !v)}
          className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-accent/40"
        >
          {showDefault ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="text-[10px] font-semibold uppercase text-muted-foreground">
            默认系统提示词（只读参考）
          </span>
          <Info className="ml-auto h-3 w-3 shrink-0 text-muted-foreground/60" />
        </button>
        {showDefault && (
          <div className="border-t border-border/60 px-2.5 py-2">
            <p className="mb-1.5 text-[10px] leading-relaxed text-muted-foreground">
              AI Agent 的内置系统提示词模板，由 pi 引擎提供。包含角色定义、工程原则、工具策略、执行工作流和交付契约。
              模板中的 <code className="rounded bg-muted px-0.5 py-0 text-[9px]">{'{{#if}}'}</code> / <code className="rounded bg-muted px-0.5 py-0 text-[9px]">{'{{toolRefs.xxx}}'}</code> 等为 Handlebars 动态片段，实际内容会随启用的工具、技能和规则变化。
            </p>
            {defaultSystemPrompt ? (
              <pre className="max-h-72 overflow-auto rounded border border-border bg-background p-2 text-[9px] leading-relaxed text-foreground/80 whitespace-pre-wrap break-words font-mono">
                {defaultSystemPrompt}
              </pre>
            ) : (
              <p className="rounded bg-muted/40 px-2 py-3 text-center text-[10px] text-muted-foreground">
                加载中...
              </p>
            )}
            <div className="mt-1.5 flex justify-end">
              <button
                onClick={() => loadDefaultSystemPrompt()}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <RefreshCw className="h-2.5 w-2.5" />
                刷新
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 自定义系统提示词（可编辑） */}
      <div className="space-y-2">
        <div className="text-[10px] font-semibold uppercase text-muted-foreground">自定义系统提示词</div>
        <p className="text-[10px] text-muted-foreground">
          此提示词将附加到每个 AI 会话的系统消息中，用于定制 AI 的行为和上下文。
        </p>
        <textarea
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          rows={10}
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
    </div>
  );
}
