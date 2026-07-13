import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RegressionSuite, RegressionResult } from '@shared/types';
import type { SimulationRunOptions } from '@shared/plugin-types';
import type { PluginBackedSimulation } from '../host/plugin-discovery';

const SOCVERIFY_DIR = '.socverify';
const REGRESSION_DIR = 'regressions';

export interface RegressionManagerOptions {
  projectRoot: string;
  simulationAdapter: PluginBackedSimulation | null;
}

/**
 * Manages regression suites: CRUD, batch execution, and result comparison.
 */
export class RegressionManager {
  private projectRoot: string;
  private simulation: PluginBackedSimulation | null;

  constructor(opts: RegressionManagerOptions) {
    this.projectRoot = opts.projectRoot;
    this.simulation = opts.simulationAdapter;
  }

  setSimulationAdapter(adapter: PluginBackedSimulation | null): void {
    this.simulation = adapter;
  }

  // ── CRUD ──────────────────────────────────────────────

  async createSuite(name: string, caseIds: string[], options: Record<string, unknown>): Promise<RegressionSuite> {
    const suite: RegressionSuite = {
      name,
      caseIds,
      options,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.saveSuite(suite);
    return suite;
  }

  async updateSuite(name: string, updates: Partial<Pick<RegressionSuite, 'caseIds' | 'options'>>): Promise<RegressionSuite | null> {
    const existing = await this.getSuite(name);
    if (!existing) return null;
    const updated: RegressionSuite = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };
    await this.saveSuite(updated);
    return updated;
  }

  async deleteSuite(name: string): Promise<void> {
    const { unlink } = await import('node:fs/promises');
    const filePath = join(this.projectRoot, SOCVERIFY_DIR, REGRESSION_DIR, `${name}.json`);
    try {
      await unlink(filePath);
    } catch {
      // Best-effort
    }
  }

  async getSuite(name: string): Promise<RegressionSuite | null> {
    const filePath = join(this.projectRoot, SOCVERIFY_DIR, REGRESSION_DIR, `${name}.json`);
    try {
      const data = await readFile(filePath, 'utf-8');
      return JSON.parse(data) as RegressionSuite;
    } catch {
      return null;
    }
  }

  async listSuites(): Promise<RegressionSuite[]> {
    const dir = join(this.projectRoot, SOCVERIFY_DIR, REGRESSION_DIR);
    try {
      const files = await readdir(dir);
      const suites: RegressionSuite[] = [];
      for (const f of files.filter((f) => f.endsWith('.json'))) {
        try {
          const data = await readFile(join(dir, f), 'utf-8');
          suites.push(JSON.parse(data) as RegressionSuite);
        } catch {
          // Skip unreadable files
        }
      }
      return suites.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  // ── Execution ────────────────────────────────────────

  async runSuite(name: string): Promise<{ runId: string; results: RegressionResult }> {
    const suite = await this.getSuite(name);
    if (!suite) throw new Error(`Regression suite not found: ${name}`);
    if (!this.simulation?.hasRunner()) throw new Error('No simulation-runner plugin loaded');

    const runId = `reg_${Date.now()}`;
    const results: RegressionResult = {
      suiteName: name,
      runId,
      totalCases: suite.caseIds.length,
      passed: 0,
      failed: 0,
      duration: 0,
      timestamp: Date.now(),
      results: [],
    };

    const startTime = Date.now();

    for (const caseId of suite.caseIds) {
      try {
        const opts: SimulationRunOptions = {
          caseId,
          subsys: '',
          options: suite.options,
        };
        const handle = await this.simulation.run(opts);
        const status = await this.simulation.getStatus(handle.runId);
        const isPass = status.status === 'pass';
        if (isPass) results.passed++;
        else results.failed++;
        results.results.push({
          caseId,
          caseName: caseId,
          status: status.status,
          duration: 0,
        });
      } catch (err) {
        results.failed++;
        results.results.push({
          caseId,
          caseName: caseId,
          status: 'error' as const,
          duration: 0,
        });
      }
    }

    results.duration = Date.now() - startTime;

    // Save result
    await this.saveResult(results);

    return { runId, results };
  }

  // ── Results ──────────────────────────────────────────

  async getResult(runId: string): Promise<RegressionResult | null> {
    const filePath = join(this.projectRoot, SOCVERIFY_DIR, REGRESSION_DIR, `${runId}.result.json`);
    try {
      const data = await readFile(filePath, 'utf-8');
      return JSON.parse(data) as RegressionResult;
    } catch {
      return null;
    }
  }

  async getHistory(suiteName?: string): Promise<RegressionResult[]> {
    const dir = join(this.projectRoot, SOCVERIFY_DIR, REGRESSION_DIR);
    try {
      const files = await readdir(dir);
      const results: RegressionResult[] = [];
      for (const f of files.filter((f) => f.endsWith('.result.json'))) {
        try {
          const data = await readFile(join(dir, f), 'utf-8');
          const result = JSON.parse(data) as RegressionResult;
          if (!suiteName || result.suiteName === suiteName) {
            results.push(result);
          }
        } catch {
          // Skip unreadable files
        }
      }
      return results.sort((a, b) => b.timestamp - a.timestamp);
    } catch {
      return [];
    }
  }

  async compareRuns(runId1: string, runId2: string): Promise<{
    run1: RegressionResult | null;
    run2: RegressionResult | null;
    newFailures: Array<{ caseId: string; caseName: string }>;
    fixed: Array<{ caseId: string; caseName: string }>;
    unchanged: Array<{ caseId: string; caseName: string; status: string }>;
  }> {
    const run1 = await this.getResult(runId1);
    const run2 = await this.getResult(runId2);

    const map1 = new Map(run1?.results.map((r) => [r.caseId, r.status]) ?? []);
    const map2 = new Map(run2?.results.map((r) => [r.caseId, r.status]) ?? []);

    const newFailures: Array<{ caseId: string; caseName: string }> = [];
    const fixed: Array<{ caseId: string; caseName: string }> = [];
    const unchanged: Array<{ caseId: string; caseName: string; status: string }> = [];

    for (const [caseId, status2] of map2) {
      const status1 = map1.get(caseId);
      if (!status1) continue;
      if (status1 === 'pass' && status2 !== 'pass') {
        newFailures.push({ caseId, caseName: caseId });
      } else if (status1 !== 'pass' && status2 === 'pass') {
        fixed.push({ caseId, caseName: caseId });
      } else {
        unchanged.push({ caseId, caseName: caseId, status: status2 });
      }
    }

    return { run1, run2, newFailures, fixed, unchanged };
  }

  // ── Persistence ──────────────────────────────────────

  private async saveSuite(suite: RegressionSuite): Promise<void> {
    const dir = join(this.projectRoot, SOCVERIFY_DIR, REGRESSION_DIR);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${suite.name}.json`);
    await writeFile(filePath, JSON.stringify(suite, null, 2), 'utf-8');
  }

  private async saveResult(result: RegressionResult): Promise<void> {
    const dir = join(this.projectRoot, SOCVERIFY_DIR, REGRESSION_DIR);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${result.runId}.result.json`);
    await writeFile(filePath, JSON.stringify(result, null, 2), 'utf-8');
  }
}
