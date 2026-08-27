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
  /** runsim 命令（终端仿真来源有值，用于重新仿真） */
  command?: string;
  /** 仿真工作目录（终端仿真来源有值，用于重新仿真） */
  cwd?: string;
}
