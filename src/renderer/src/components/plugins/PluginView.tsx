import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { PluginViewContribution } from '@shared/plugin-types';

type PluginViewProps = {
  projectId: string;
  pluginId: string;
  view: PluginViewContribution;
};

type PluginCommandMessage = {
  type: 'socverify:command';
  command: string;
  args?: unknown[];
  requestId?: string;
};

export function PluginView({ projectId, pluginId, view }: PluginViewProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const handleMessage = async (event: MessageEvent<PluginCommandMessage>) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = event.data;
      if (!message || message.type !== 'socverify:command' || !message.command) return;

      setRunning(true);
      setError(null);
      try {
        const response = await trpc.project.invokePluginCommand.mutate({
          projectId,
          command: message.command,
          args: message.args ?? [],
        });
        frameRef.current?.contentWindow?.postMessage({
          type: 'socverify:command-result',
          requestId: message.requestId,
          result: response.result,
        }, '*');
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        setError(messageText);
        frameRef.current?.contentWindow?.postMessage({
          type: 'socverify:command-result',
          requestId: message.requestId,
          error: messageText,
        }, '*');
      } finally {
        setRunning(false);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [projectId]);

  if (!view.html) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
        <AlertCircle className="h-4 w-4" />
        插件视图没有可渲染的 HTML：{pluginId}/{view.id}
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-background">
      {running && (
        <div className="pointer-events-none absolute right-3 top-3 z-10 rounded border border-border bg-background/90 p-1.5">
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        </div>
      )}
      {error && (
        <div className="flex shrink-0 items-center gap-1 border-b border-status-fail/30 bg-status-fail/5 px-3 py-1.5 text-[11px] text-status-fail-foreground">
          <AlertCircle className="h-3 w-3" />
          {error}
        </div>
      )}
      <iframe
        ref={frameRef}
        title={view.name}
        srcDoc={view.html}
        sandbox="allow-scripts allow-forms"
        className="min-h-0 flex-1 border-0 bg-background"
      />
    </div>
  );
}
