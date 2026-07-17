import { useState } from 'react';
import { Activity, X, CheckCircle2, XCircle, Loader2, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { useTaskStore, type Task } from '@renderer/stores/task';
import { cn } from '@renderer/lib/utils';

export function TaskPanel() {
  const tasks = useTaskStore((s) => s.tasks);
  const clearCompleted = useTaskStore((s) => s.clearCompleted);
  const cancelTask = useTaskStore((s) => s.cancelTask);
  const [expanded, setExpanded] = useState(true);

  const runningTasks = tasks.filter((t) => t.status === 'running');
  const completedTasks = tasks.filter((t) => t.status !== 'running');

  if (tasks.length === 0) return null;

  return (
    <div className="absolute bottom-12 right-2 z-30 w-80 overflow-hidden rounded-lg border border-border bg-popover shadow-xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b bg-secondary/30 px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5 text-primary" />
          <span className="text-xs font-semibold">后台任务</span>
          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">
            {runningTasks.length} 运行中
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={clearCompleted}
            title="清除已完成"
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Trash2 className="h-3 w-3" />
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {/* Task list */}
      {expanded && (
        <div className="max-h-64 overflow-y-auto p-1">
          {runningTasks.map((task) => (
            <TaskRow key={task.id} task={task} onCancel={cancelTask} />
          ))}
          {completedTasks.slice(0, 10).map((task) => (
            <TaskRow key={task.id} task={task} onCancel={cancelTask} />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskRow({ task, onCancel }: { task: Task; onCancel: (id: string) => void }) {
  const statusIcon = {
    running: <Loader2 className="h-3 w-3 animate-spin text-status-running-foreground" />,
    done: <CheckCircle2 className="h-3 w-3 text-status-pass-foreground" />,
    failed: <XCircle className="h-3 w-3 text-status-fail-foreground" />,
    cancelled: <X className="h-3 w-3 text-muted-foreground" />,
  };

  return (
    <div className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent/30">
      {statusIcon[task.status]}
      <div className="flex-1 min-w-0">
        <div className="truncate text-xs font-medium text-foreground">{task.name}</div>
        {task.status === 'running' && (
          <div className="mt-0.5 h-0.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                task.type === 'simulation' && 'bg-status-running-foreground',
                task.type === 'ai' && 'bg-violet-foreground',
                task.type === 'regression' && 'bg-status-pass-foreground',
                task.type === 'coverage' && 'bg-chart-4',
              )}
              style={{ width: `${task.progress}%` }}
            />
          </div>
        )}
      </div>
      <div className="flex items-center gap-1">
        <span className="text-[9px] text-muted-foreground">
          {task.type === 'simulation' && '仿真'}
          {task.type === 'ai' && 'AI'}
          {task.type === 'regression' && '回归'}
          {task.type === 'coverage' && '覆盖率'}
        </span>
        {task.status === 'running' && (
          <button
            onClick={() => onCancel(task.id)}
            className="rounded p-0.5 text-destructive hover:bg-destructive/10"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}
