import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoverageData } from '@shared/plugin-types';
import type { CoverageSummary, CoverageBySubsys } from '@shared/types';
import type { PluginBackedCoverage } from '../omp/plugin-discovery';

const SOCVERIFY_DIR = '.socverify';
const COVERAGE_DIR = 'coverage';

export interface CoverageManagerOptions {
  projectRoot: string;
  coverageAdapter: PluginBackedCoverage | null;
}

/**
 * Manages coverage data for a project.
 * Parses coverage via plugin, caches results to .socverify/coverage/.
 */
export class CoverageManager {
  private projectRoot: string;
  private adapter: PluginBackedCoverage | null;

  constructor(opts: CoverageManagerOptions) {
    this.projectRoot = opts.projectRoot;
    this.adapter = opts.coverageAdapter;
  }

  setAdapter(adapter: PluginBackedCoverage | null): void {
    this.adapter = adapter;
  }

  hasParser(): boolean {
    return this.adapter?.hasParser() ?? false;
  }

  /**
   * Get coverage overview for a run (or latest cached if no runId).
   * Returns summary with 4 coverage types.
   */
  async getOverview(runId?: string): Promise<{ summary: CoverageSummary; runId: string }> {
    const data = await this.getOrParse(runId);
    const summary: CoverageSummary = {
      overall: data.overall,
      line: data.line ?? 0,
      toggle: data.toggle ?? 0,
      functional: data.functional ?? 0,
      assertion: data.assertion ?? 0,
    };
    return { summary, runId: data.runId };
  }

  /**
   * Get coverage broken down by subsystem.
   */
  async getBySubsys(runId?: string): Promise<{ items: CoverageBySubsys[]; runId: string }> {
    const data = await this.getOrParse(runId);
    const items: CoverageBySubsys[] = (data.bySubsys ?? []).map((s) => ({
      subsys: s.subsys,
      summary: {
        overall: s.overall,
        line: s.line,
        toggle: s.toggle,
        functional: s.functional,
        assertion: s.assertion,
      },
    }));
    return { items, runId: data.runId };
  }

  /**
   * Get raw coverage detail for a run.
   */
  async getDetail(runId?: string): Promise<CoverageData | null> {
    return this.getOrParse(runId);
  }

  /**
   * List all cached coverage runs.
   */
  async listCachedRuns(): Promise<string[]> {
    const dir = join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR);
    try {
      const files = await readdir(dir);
      return files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''));
    } catch {
      return [];
    }
  }

  /**
   * Get coverage data from cache or parse via plugin.
   */
  private async getOrParse(runId?: string): Promise<CoverageData> {
    // Try cache first
    if (runId) {
      const cached = await this.loadCached(runId);
      if (cached) return cached;
    }

    // Parse via plugin
    if (!this.adapter?.hasParser()) {
      throw new Error('No coverage-parser plugin loaded');
    }

    const data = await this.adapter.parse(runId ?? 'latest');

    // Cache the result
    await this.cache(data);

    return data;
  }

  private async loadCached(runId: string): Promise<CoverageData | null> {
    const filePath = join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR, `${runId}.json`);
    try {
      const data = await readFile(filePath, 'utf-8');
      return JSON.parse(data) as CoverageData;
    } catch {
      return null;
    }
  }

  private async cache(data: CoverageData): Promise<void> {
    const dir = join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${data.runId}.json`);
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
