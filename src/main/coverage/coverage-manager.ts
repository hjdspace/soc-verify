import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoverageData } from '@shared/plugin-types';
import type { CoverageSummary, CoverageBySubsys } from '@shared/types';
import type { PluginBackedCoverage } from '../host/plugin-discovery';

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

  async getDetail(runId?: string): Promise<CoverageData | null> {
    return this.getOrParse(runId);
  }

  async listCachedRuns(): Promise<string[]> {
    const dir = join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR);
    try {
      const files = await readdir(dir);
      return files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
    } catch {
      return [];
    }
  }

  async getTrend(limit = 20): Promise<Array<{ runId: string; summary: CoverageSummary }>> {
    const runIds = await this.listCachedRuns();
    const limited = runIds.slice(0, limit);
    const trend: Array<{ runId: string; summary: CoverageSummary }> = [];
    for (const runId of limited) {
      try {
        const data = await this.loadCached(runId);
        if (data) {
          trend.push({
            runId,
            summary: {
              overall: data.overall,
              line: data.line ?? 0,
              toggle: data.toggle ?? 0,
              functional: data.functional ?? 0,
              assertion: data.assertion ?? 0,
            },
          });
        }
      } catch {
        // Skip unreadable files
      }
    }
    return trend;
  }

  async getUncovered(
    runId: string,
    type: 'line' | 'toggle' | 'functional' | 'assertion',
  ): Promise<Array<{ file: string; line?: number; signal?: string; description: string }>> {
    const data = await this.getOrParse(runId);
    const uncovered = (data as CoverageData & { uncovered?: Record<string, unknown[]> }).uncovered;
    if (!uncovered || !uncovered[type]) return [];
    return uncovered[type].map((item) => {
      const obj = item as Record<string, unknown>;
      return {
        file: typeof obj.file === 'string' ? obj.file : '',
        line: typeof obj.line === 'number' ? obj.line : undefined,
        signal: typeof obj.signal === 'string' ? obj.signal : undefined,
        description: typeof obj.description === 'string' ? obj.description : JSON.stringify(item),
      };
    });
  }

  async exportReport(runId: string, format: 'html' | 'json', outputPath: string): Promise<string> {
    const data = await this.getOrParse(runId);
    if (format === 'json') {
      await writeFile(outputPath, JSON.stringify(data, null, 2), 'utf-8');
      return outputPath;
    }
    const html = this.buildHtmlReport(data);
    await writeFile(outputPath, html, 'utf-8');
    return outputPath;
  }

  private buildHtmlReport(data: CoverageData): string {
    const rows = (data.bySubsys ?? [])
      .map(
        (s) =>
          `<tr><td>${s.subsys}</td><td>${s.line.toFixed(1)}%</td><td>${s.toggle.toFixed(1)}%</td><td>${s.functional.toFixed(1)}%</td><td>${s.assertion.toFixed(1)}%</td><td>${s.overall.toFixed(1)}%</td></tr>`,
      )
      .join('\n');
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Coverage Report - ${data.runId}</title></head>
<body>
<h1>Coverage Report</h1>
<p>Run ID: ${data.runId}</p>
<h2>Overview</h2>
<table><tr><th>Type</th><th>Coverage</th></tr>
<tr><td>Line</td><td>${(data.line ?? 0).toFixed(1)}%</td></tr>
<tr><td>Toggle</td><td>${(data.toggle ?? 0).toFixed(1)}%</td></tr>
<tr><td>Functional</td><td>${(data.functional ?? 0).toFixed(1)}%</td></tr>
<tr><td>Assertion</td><td>${(data.assertion ?? 0).toFixed(1)}%</td></tr>
<tr><td><strong>Overall</strong></td><td><strong>${data.overall.toFixed(1)}%</strong></td></tr>
</table>
<h2>By Subsystem</h2>
<table><tr><th>Subsystem</th><th>Line</th><th>Toggle</th><th>Functional</th><th>Assertion</th><th>Overall</th></tr>
${rows}
</table>
</body></html>`;
  }

  private async getOrParse(runId?: string): Promise<CoverageData> {
    if (runId) {
      const cached = await this.loadCached(runId);
      if (cached) return cached;
    }
    if (!this.adapter?.hasParser()) {
      throw new Error('No coverage-parser plugin loaded');
    }
    const data = await this.adapter.parse(runId ?? 'latest');
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
