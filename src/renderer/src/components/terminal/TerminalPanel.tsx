/**
 * TerminalPanel — Wrapper that combines SimControlToolbar + TerminalView.
 *
 * When the terminal tab is associated with a simulation run (title starts
 * with "sim:"), the SimControlToolbar is displayed above the terminal view.
 * Otherwise, just the TerminalView is rendered.
 *
 * Used by CenterArea and BottomPanel to render terminal content.
 */

import { TerminalView } from './TerminalView';
import { SimControlToolbar } from './SimControlToolbar';
import { useSimulationStore, type SimulationRunRecord } from '@renderer/stores/simulation';
import { useTerminalStore } from '@renderer/stores/terminal';

interface TerminalPanelProps {
  terminalId: string;
  /** Tab title — used to determine if this is a simulation terminal. */
  tabTitle: string;
}

export function TerminalPanel({ terminalId, tabTitle }: TerminalPanelProps) {
  const activeRuns = useSimulationStore((s) => s.activeRuns);
  const createTabForSession = useTerminalStore((s) => s.createTabForSession);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);

  // Find the simulation run associated with this terminal
  const simRun: SimulationRunRecord | undefined = activeRuns.find(
    (r) => r.terminalId === terminalId,
  );

  // Only show the toolbar for simulation terminals
  const isSimTerminal = tabTitle.startsWith('sim:') || tabTitle.includes('✓') || tabTitle.includes('✗');
  const showToolbar = isSimTerminal && simRun;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {showToolbar && simRun && (
        <SimControlToolbar
          key={terminalId}
          terminalId={terminalId}
          command={simRun.command ?? ''}
          cwd={simRun.cwd ?? ''}
          caseId={simRun.caseId}
          caseName={simRun.caseName}
          subsys={simRun.subsys}
          isRunning={simRun.status === 'running' || simRun.status === 'pending'}
          onRerun={(newTerminalId) => {
            // The new terminal tab is already created by the toolbar
            // Just activate it
            const tabId = useTerminalStore.getState().tabs.find(
              (t) => t.terminalId === newTerminalId,
            )?.id;
            if (tabId) setActiveTab(tabId);
          }}
        />
      )}
      <div className="min-h-0 flex-1">
        <TerminalView terminalId={terminalId} />
      </div>
    </div>
  );
}
