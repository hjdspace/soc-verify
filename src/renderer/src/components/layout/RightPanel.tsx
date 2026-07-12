import { useEffect, useRef, useState } from 'react';
import { Plus, Send, Square, MessageSquare, Trash2, ChevronDown } from 'lucide-react';
import { useSessionStore, type ChatMessage } from '@renderer/stores/session';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';

export function RightPanel() {
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const createSession = useSessionStore((s) => s.createSession);
  const destroySession = useSessionStore((s) => s.destroySession);
  const switchSession = useSessionStore((s) => s.switchSession);
  const inputMessage = useSessionStore((s) => s.inputMessage);
  const setInputMessage = useSessionStore((s) => s.setInputMessage);
  const sendMessage = useSessionStore((s) => s.sendMessage);
  const abortSession = useSessionStore((s) => s.abortSession);
  const isSending = useSessionStore((s) => s.isSending);

  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const currentProject = useProjectStore((s) =>
    s.projects.find((p) => p.id === s.currentProjectId),
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [showSessionList, setShowSessionList] = useState(false);

  const currentSession = sessions.find((s) => s.id === currentSessionId);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentSession?.messages]);

  const handleCreateSession = async () => {
    if (!currentProjectId || !currentProject) return;
    await createSession(currentProjectId, currentProject.rootPath);
  };

  const handleSend = async () => {
    if (!inputMessage.trim()) return;
    await sendMessage(inputMessage);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l bg-sidebar">
      {/* ── 会话管理栏 ──────────────────────────────── */}
      <div className="flex items-center justify-between border-b px-2 py-1.5">
        <div className="relative">
          <button
            onClick={() => setShowSessionList(!showSessionList)}
            className="flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-semibold transition-colors hover:bg-accent"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            {currentSession?.name ?? 'AI Agent'}
            <ChevronDown className="h-3 w-3 opacity-50" />
          </button>

          {showSessionList && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setShowSessionList(false)}
              />
              <div className="absolute left-0 top-8 z-50 w-64 overflow-hidden rounded-md border border-border bg-popover shadow-xl">
                {sessions.map((sess) => (
                  <div
                    key={sess.id}
                    className={cn(
                      'flex items-center justify-between px-3 py-1.5 text-xs transition-colors hover:bg-accent',
                      sess.id === currentSessionId && 'bg-accent/50',
                    )}
                    onClick={() => {
                      switchSession(sess.id);
                      setShowSessionList(false);
                    }}
                  >
                    <span className="truncate">{sess.name}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        destroySession(sess.id);
                      }}
                      className="ml-2 rounded p-0.5 opacity-50 hover:opacity-100"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <button
          onClick={handleCreateSession}
          disabled={!currentProjectId}
          title="新建会话"
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* ── 消息列表 ────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {!currentSession ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <p className="text-xs text-muted-foreground">
              {currentProjectId ? '点击 + 创建 AI 会话' : '请先打开项目'}
            </p>
          </div>
        ) : currentSession.messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <p className="text-xs text-muted-foreground">
              开始与 AI Agent 对话，让它辅助你的验证工作
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {currentSession.messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* ── 输入框 ──────────────────────────────────── */}
      <div className="border-t p-2">
        <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-2">
          <textarea
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={currentSessionId ? '输入消息...' : '请先创建会话'}
            disabled={!currentSessionId}
            rows={3}
            className="resize-none bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">
              Enter 发送 · Shift+Enter 换行
            </span>
            {isSending ? (
              <button
                onClick={abortSession}
                className="flex items-center gap-1 rounded bg-destructive/10 px-2 py-1 text-[10px] text-destructive transition-colors hover:bg-destructive/20"
              >
                <Square className="h-3 w-3" />
                中止
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!inputMessage.trim() || !currentSessionId}
                className="flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-30"
              >
                <Send className="h-3 w-3" />
                发送
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

// ── 消息气泡组件 ───────────────────────────────────────

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'tool') {
    return <ToolCard message={message} />;
  }

  const isUser = message.role === 'user';

  return (
    <div
      className={cn(
        'flex flex-col gap-0.5',
        isUser ? 'items-end' : 'items-start',
      )}
    >
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs',
          isUser
            ? 'bg-primary/15 text-foreground'
            : 'bg-background text-foreground',
        )}
      >
        <div className="whitespace-pre-wrap break-words">
          {message.content || (message.isStreaming ? '...' : '')}
          {message.isStreaming && (
            <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-foreground" />
          )}
        </div>
      </div>
    </div>
  );
}

// ── 工具调用卡片 ───────────────────────────────────────

function ToolCard({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-md border border-border/60 bg-secondary/30 p-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <div className="flex h-5 w-5 items-center justify-center rounded bg-primary/10">
          <Square className="h-2.5 w-2.5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-semibold text-foreground">
            {message.toolName ?? 'tool'}
          </div>
        </div>
        <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-1 border-t border-border/40 pt-1.5">
          {message.toolArgs != null && (
            <div>
              <div className="text-[9px] uppercase text-muted-foreground">参数</div>
              <pre className="mt-0.5 overflow-x-auto rounded bg-background/50 p-1 text-[10px]">
                {JSON.stringify(message.toolArgs, null, 2)}
              </pre>
            </div>
          )}
          {message.toolResult != null && (
            <div>
              <div className="text-[9px] uppercase text-muted-foreground">结果</div>
              <pre className="mt-0.5 overflow-x-auto rounded bg-background/50 p-1 text-[10px]">
                {typeof message.toolResult === 'string'
                  ? message.toolResult
                  : JSON.stringify(message.toolResult, null, 2)}
              </pre>
            </div>
          )}
          {!message.toolResult && (
            <div className="text-[10px] text-muted-foreground">执行中...</div>
          )}
        </div>
      )}
    </div>
  );
}
