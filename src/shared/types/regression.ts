import type { SimulationStatus } from './simulation';

export interface RegressionSuite {
  name: string;
  caseIds: string[];
  options: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface RegressionResult {
  suiteName: string;
  runId: string;
  totalCases: number;
  passed: number;
  failed: number;
  duration: number;
  timestamp: number;
  results: Array<{
    caseId: string;
    caseName: string;
    status: SimulationStatus;
    duration: number;
  }>;
}
