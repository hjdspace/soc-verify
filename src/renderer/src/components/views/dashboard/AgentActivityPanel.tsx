import type { ChatMessage, SessionEntry, SubagentActivity } from '@renderer/stores/session';
import { useSessionStore } from '@renderer/stores/session';
import { cn } from '@renderer/lib/utils';

const pad2 = (n: number) => String(n).padStart(2, '0');

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

type AgentActivity =
  | { kind: 'main'; id: string; who: string; time: number; body: string }
  | { kind: 'sub'; id: string; who: string; time: number; body: string };

/** 主代理消息 → 活动项 */
function messageActivity(session: SessionEntry, msg: ChatMessage): AgentActivity {
  return { kind: 'main', id: msg.id, who: session.name, time: msg.timestamp, body: msg.content };
}

/** 子代理实时帧 → 活动项（running 状态优先展示） */
function subagentActivity(sub: SubagentActivity): AgentActivity {
  return {
    kind: 'sub',
    id: sub.id,
    who: `${sub.agent} · 子代理`,
    time: sub.startedAt,
    body: sub.lastIntent ?? sub.description ?? (sub.currentTool ? `正在调用 ${sub.currentTool}` : '运行中'),
  };
}

/**
 * AI Agent 活动流：当前（或最近）会话的最近消息 + 运行中的子代理帧。
 * 数据只读复用 session store，时间倒序展示。
 */
export function AgentActivityPanel() {
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);

  const session =
    sessions.find((s) => s.id === currentSessionId) ??
    [...sessions].sort((a, b) => b.createdAt - a.createdAt)[0] ??
    null;

  let activities: AgentActivity[] = [];
  if (session) {
    const subs = Object.values(session.subagents ?? {}).filter((s) => s.status === 'running');
    const msgs = session.messages
      .filter((m) => m.role === 'assistant' && m.content.trim().length > 0)
      .slice(-3)
      .reverse();
    activities = [
      ...subs.map(subagentActivity),
      ...msgs.map((m) => messageActivity(session, m)),
    ].slice(0, 4);
  }

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 text-xs font-semibold text-foreground">
        AI Agent 活动
        {activities.length > 0 && (
          <span className="rounded-full bg-primary/15 px-[7px] font-mono text-[10px] font-normal text-primary">
            {activities.length}
          </span>
        )}
      </div>
      {activities.length === 0 ? (
        <div className="px-3.5 py-6 text-center text-xs text-muted-foreground/70" data-testid="agent-panel-empty">
          {session ? '会话暂无消息' : '暂无 AI 会话 — 打开右侧 AI 面板开始对话'}
        </div>
      ) : (
        activities.map((a) => (
          <div key={a.id} className="flex gap-2.5 border-b border-border px-3.5 py-2.5 text-xs last:border-b-0">
            <span
              className={cn(
                'mt-px grid size-[22px] shrink-0 place-items-center rounded-md text-[10px] font-semibold',
                a.kind === 'main' ? 'bg-primary/15 text-primary' : 'bg-status-running/15 text-status-running-foreground',
              )}
            >
              {a.kind === 'main' ? 'AI' : '子'}
            </span>
            <div className="min-w-0">
              <div className="mb-0.5 font-semibold text-foreground">
                {a.who}
                <span className="ml-1.5 font-mono text-[10px] font-normal text-muted-foreground/70">
                  {formatTime(a.time)}
                </span>
              </div>
              <div className="line-clamp-2 text-muted-foreground" data-testid={`agent-activity-${a.id}`}>
                {a.body}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
