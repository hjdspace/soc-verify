import { argStr, argVal, tryParseJSON } from '@renderer/components/chat/tool-helpers';
import { StatusBadge } from '../shared/HostTableBody';
import { TerminalButton, useSimRunAction } from './useSimRunAction';

export function SimRunBody({ args, resultText }: { args: unknown; resultText: string }) {
  const parsed = tryParseJSON(resultText) as Record<string, unknown> | null;
  const caseId = argStr(args, 'caseId', 'case', 'testcase') ?? '';
  const subsys = argStr(args, 'subsys') ?? '';
  const status = parsed ? String(parsed.status ?? parsed.result ?? '') : '';
  const runId = parsed ? String(parsed.runId ?? parsed.run_id ?? '') : '';
  const seed = parsed ? String(parsed.seed ?? '') : '';
  const simTime = parsed ? String(parsed.simTime ?? parsed.sim_time ?? '') : '';
  const isError = parsed && 'error' in parsed;

  // Build a display command from the args
  const cmdParts = ['runsim', '-cmd', 'run'];
  if (caseId) cmdParts.push('-case', caseId);
  if (subsys) cmdParts.push('-subsys', subsys);
  const optionsVal = argVal(args, 'options');
  if (optionsVal && typeof optionsVal === 'object') {
    for (const [k, v] of Object.entries(optionsVal as Record<string, unknown>)) {
      if (v !== undefined && v !== null && v !== '') {
        cmdParts.push(`-${k}`, String(v));
      }
    }
  }
  const displayCommand = cmdParts.join(' ');

  const handleOpenInTerminal = useSimRunAction(caseId, subsys, optionsVal);

  return (
    <div className="px-2.5 py-2 text-[11px] leading-relaxed">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-semibold text-foreground">{subsys && caseId ? `${subsys}/${caseId}` : caseId || 'simulation'}</span>
        {status && <StatusBadge status={status} />}
      </div>
      <div className="mb-1.5 rounded border border-border/40 bg-background/50 px-2 py-1 font-mono text-[10px] text-violet-foreground break-all">
        <span className="text-muted-foreground/50">$ </span>{displayCommand}
      </div>
      {(runId || seed || simTime) && (
        <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground/60">
          {runId && <span>run_id: {runId}</span>}
          {seed && <span>seed: {seed}</span>}
          {simTime && <span>sim_time: {simTime}</span>}
        </div>
      )}
      {isError && (
        <div className="mt-1 text-status-fail-foreground">{String(parsed!.error)}</div>
      )}
      {!parsed && !isError && <pre className="mt-1 text-muted-foreground">{resultText}</pre>}
      {!isError && <TerminalButton onClick={handleOpenInTerminal} />}
    </div>
  );
}
