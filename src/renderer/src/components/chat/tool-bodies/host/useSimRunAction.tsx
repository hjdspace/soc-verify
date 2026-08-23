import { useCallback } from 'react';
import { Terminal } from 'lucide-react';
import { useProjectStore } from '@renderer/stores/project';
import { useTerminalStore } from '@renderer/stores/terminal';
import { useToastStore } from '@renderer/stores/toast';
import { trpc } from '@renderer/lib/trpc';

/** Encapsulates the "open in terminal" side-effect for SimRunBody. */
export function useSimRunAction(caseId: string, subsys: string, optionsVal: unknown) {
  return useCallback(() => {
    const projectId = useProjectStore.getState().currentProjectId;
    if (!projectId) {
      useToastStore.getState().warning('未打开项目', '需要先打开项目才能在终端中运行仿真。');
      return;
    }
    trpc.simulation.runInTerminal.mutate({
      projectId,
      options: {
        caseId,
        caseName: caseId,
        subsys,
        options: (typeof optionsVal === 'object' && optionsVal !== null ? optionsVal : {}) as Record<string, unknown>,
      },
    })
      .then((result) => {
        useTerminalStore.getState().createTabForSession(
          result.terminalId,
          `sim: ${caseId}`,
          result.cwd,
          (result as { backend?: string }).backend === 'log-mode',
          (result as { warning?: string | null }).warning ?? null,
        );
      })
      .catch((err) => {
        useToastStore.getState().error('终端启动失败', err instanceof Error ? err.message : String(err));
      });
  }, [caseId, subsys, optionsVal]);
}

/** Props for the terminal button, extracted for reuse. */
export function TerminalButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="mt-1.5 flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title="在终端中运行此仿真命令"
    >
      <Terminal className="h-2.5 w-2.5" />
      在终端中运行
    </button>
  );
}
