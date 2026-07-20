export type CoverageType = 'line' | 'toggle' | 'functional' | 'assertion';

export interface CoverageSummary {
  overall: number;
  line: number;
  toggle: number;
  functional: number;
  assertion: number;
}

export interface CoverageBySubsys {
  subsys: string;
  summary: CoverageSummary;
}
