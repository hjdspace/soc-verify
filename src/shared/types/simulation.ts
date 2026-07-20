export type SimulationStatus = 'pending' | 'running' | 'pass' | 'fail' | 'error' | 'aborted';

export interface CompileError {
  file: string;
  line: number;
  column?: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface SimulationHistoryEntry {
  runId: string;
  caseId: string;
  caseName: string;
  subsys: string;
  options: Record<string, unknown>;
  status: SimulationStatus;
  startTime: number;
  endTime: number;
  duration: number;
  compileErrors?: CompileError[];
}
