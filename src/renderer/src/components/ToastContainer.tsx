import { useEffect, useState } from 'react';
import { X, AlertCircle, Info, CheckCircle2 } from 'lucide-react';
import { useToastStore } from '@renderer/stores/toast';
import { cn } from '@renderer/lib/utils';

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[9999] flex flex-col gap-2">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  onClose,
}: {
  toast: { id: string; type: 'error' | 'info' | 'success'; message: string; detail?: string };
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const Icon = toast.type === 'error' ? AlertCircle : toast.type === 'success' ? CheckCircle2 : Info;

  return (
    <div
      className={cn(
        'pointer-events-auto flex w-80 items-start gap-2 rounded-lg border p-3 shadow-xl backdrop-blur-sm transition-all',
        'animate-in slide-in-from-bottom-2',
        toast.type === 'error' && 'border-destructive/50 bg-destructive/10 text-foreground',
        toast.type === 'info' && 'border-border bg-popover text-foreground',
        toast.type === 'success' && 'border-status-pass/50 bg-status-pass/10 text-foreground',
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          toast.type === 'error' && 'text-destructive',
          toast.type === 'info' && 'text-muted-foreground',
          toast.type === 'success' && 'text-status-pass-foreground',
        )}
      />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold">{toast.message}</div>
        {toast.detail && (
          <div className="mt-0.5">
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-[10px] text-muted-foreground underline hover:text-foreground"
            >
              {expanded ? '收起详情' : '查看详情'}
            </button>
            {expanded && (
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-background/60 p-1.5 text-[10px] leading-relaxed whitespace-pre-wrap break-all">
                {toast.detail}
              </pre>
            )}
          </div>
        )}
      </div>
      <button
        onClick={onClose}
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
