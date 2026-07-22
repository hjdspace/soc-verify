/**
 * Coverage Manager（ADR 0006 + ADR 0007 + ADR 0008）。
 *
 * 以 Coverage Merge Session 为生命周期单位管理覆盖率数据。
 * 导入流程两步分离（ADR 0006）：
 *   1. CoverageReportGenerator 运行 EDA 命令生成文本报告
 *   2. CoverageParserPlugin 解析文本报告为层级 Coverage Tree
 *
 * 持久化布局：
 *   .socverify/coverage/
 *   ├── sessions.json              # session 元数据列表（ADR 0008）
 *   ├── <sessionId>.json           # 缓存的 CoverageData
 *   └── <sessionId>/reports/       # EDA 文本报告
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CoverageData,
  CoverageMergeSession,
  CoverageSummary,
  EdaToolConfig,
} from '@shared/types';
import { summarizeCoverage, DEFAULT_COVERAGE_TARGETS } from '@shared/types';
import type { PluginBackedCoverage } from '../host/plugin-discovery';
import { CoverageReportGenerator } from './coverage-report-generator';

const SOCVERIFY_DIR = '.socverify';
const COVERAGE_DIR = 'coverage';
const SESSIONS_FILE = 'sessions.json';

export interface CoverageManagerOptions {
  projectRoot: string;
  coverageAdapter: PluginBackedCoverage | null;
  reportGenerator?: CoverageReportGenerator;
}

/**
 * Manages coverage data for a project.
 * Parses coverage via plugin, caches results to .socverify/coverage/.
 */
export class CoverageManager {
  private projectRoot: string;
  private adapter: PluginBackedCoverage | null;
  private reportGenerator: CoverageReportGenerator | null;

  constructor(opts: CoverageManagerOptions) {
    this.projectRoot = opts.projectRoot;
    this.adapter = opts.coverageAdapter;
    this.reportGenerator = opts.reportGenerator ?? null;
  }

  setAdapter(adapter: PluginBackedCoverage | null): void {
    this.adapter = adapter;
  }

  setReportGenerator(gen: CoverageReportGenerator): void {
    this.reportGenerator = gen;
  }

  hasParser(): boolean {
    return this.adapter?.hasParser() ?? false;
  }

  // ─── 导入流程（ADR 0006 两步流水线） ─────────────────────────

  /**
   * 导入覆盖率数据：创建 session → 运行 EDA 命令（step 1）→ 插件解析（step 2）→ 缓存。
   * @param covMergeDir 用户指定的 cov_merge 目录
   * @param edaConfig EDA Tool Configuration（含命令模板）
   * @param targets 用户自定义目标（可选，缺省用 DEFAULT_COVERAGE_TARGETS）
   */
  async importCoverage(
    covMergeDir: string,
    edaConfig: EdaToolConfig,
    targets?: Partial<Record<string, number>>,
  ): Promise<{ sessionId: string; data: CoverageData }> {
    if (!this.adapter?.hasParser()) {
      throw new Error('No coverage-parser plugin loaded');
    }
    if (!this.reportGenerator) {
      throw new Error('No report generator configured');
    }

    const sessionId = this.generateSessionId();
    const reportDir = join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR, sessionId, 'reports');

    // Step 1: 平台运行 EDA 命令生成文本报告
    await this.reportGenerator.generate(edaConfig, covMergeDir, sessionId);

    // Step 2: 插件解析文本报告为层级 Coverage Tree
    const data = await this.adapter.parse(sessionId, reportDir);
    const enriched: CoverageData = {
      ...data,
      sessionId,
      source: {
        covMergeDir,
        edaTool: edaConfig.tool,
        reportGeneratedAt: Date.now(),
      },
      targets: targets ?? { ...DEFAULT_COVERAGE_TARGETS },
    };

    await this.cache(enriched);
    await this.appendSession({
      sessionId,
      covMergeDir,
      edaTool: edaConfig.tool,
      createdAt: Date.now(),
      reportDir,
    });

    return { sessionId, data: enriched };
  }

  // ─── Session 生命周期（ADR 0008） ─────────────────────────────

  async listSessions(): Promise<CoverageMergeSession[]> {
    try {
      const raw = await readFile(this.sessionsPath(), 'utf-8');
      const list = JSON.parse(raw) as CoverageMergeSession[];
      return Array.isArray(list) ? list.sort((a, b) => b.createdAt - a.createdAt) : [];
    } catch {
      return [];
    }
  }

  async getSession(sessionId: string): Promise<CoverageData | null> {
    return this.loadCached(sessionId);
  }

  /**
   * 返回扁平覆盖率摘要（root 节点 8 metric 百分比）。
   * sessionId 缺省时使用最近一个 session。用于仪表盘等简单消费方。
   */
  async getOverview(sessionId?: string): Promise<{ summary: CoverageSummary; sessionId: string }> {
    const data = await this.resolveSession(sessionId);
    return { summary: summarizeCoverage(data.root), sessionId: data.sessionId };
  }

  /**
   * 返回完整 CoverageData（层级树）。UI 视图通过此方法获取树。
   */
  async getTree(sessionId?: string): Promise<CoverageData> {
    return this.resolveSession(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const sessions = await this.listSessions();
    const next = sessions.filter((s) => s.sessionId !== sessionId);
    await this.writeSessions(next);
    // 缓存文件保留（可手动清理），不阻塞删除
  }

  // ─── 趋势（基于 session 序列，ADR 0008） ──────────────────────

  async getTrend(
    limit = 20,
  ): Promise<Array<{ sessionId: string; createdAt: number; summary: CoverageSummary }>> {
    const sessions = await this.listSessions();
    const limited = sessions.slice(0, limit);
    const trend: Array<{ sessionId: string; createdAt: number; summary: CoverageSummary }> = [];
    for (const session of limited) {
      const data = await this.loadCached(session.sessionId);
      if (data) {
        trend.push({
          sessionId: session.sessionId,
          createdAt: session.createdAt,
          summary: summarizeCoverage(data.root),
        });
      }
    }
    return trend;
  }

  // ─── 导出（Slice 7 重写，此处保留基础能力） ───────────────────

  async exportReport(
    sessionId: string,
    format: 'html' | 'json',
    outputPath: string,
  ): Promise<string> {
    const data = await this.resolveSession(sessionId);
    if (format === 'json') {
      await writeFile(outputPath, JSON.stringify(data, null, 2), 'utf-8');
      return outputPath;
    }
    const html = this.buildHtmlReport(data);
    await writeFile(outputPath, html, 'utf-8');
    return outputPath;
  }

  // ─── 内部实现 ─────────────────────────────────────────────────

  private buildHtmlReport(data: CoverageData): string {
    const summary = summarizeCoverage(data.root);
    const rows = this.renderTreeRows(data.root);
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Coverage Report - ${data.sessionId}</title>
<style>
body { font-family: sans-serif; margin: 20px; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: right; }
td:first-child { text-align: left; }
.depth-0 { font-weight: bold; }
</style></head>
<body>
<h1>Coverage Report</h1>
<p>Session: ${data.sessionId}</p>
<p>EDA Tool: ${data.source.edaTool}</p>
<h2>Overview</h2>
<table>
<tr><th>Metric</th><th>Coverage</th></tr>
<tr><td>Line</td><td>${summary.line.toFixed(1)}%</td></tr>
<tr><td>Branch</td><td>${summary.branch.toFixed(1)}%</td></tr>
<tr><td>Toggle</td><td>${summary.toggle.toFixed(1)}%</td></tr>
<tr><td>Condition</td><td>${summary.condition.toFixed(1)}%</td></tr>
<tr><td>FSM State</td><td>${summary.fsm_state.toFixed(1)}%</td></tr>
<tr><td>FSM Transition</td><td>${summary.fsm_transition.toFixed(1)}%</td></tr>
<tr><td>Functional</td><td>${summary.functional.toFixed(1)}%</td></tr>
<tr><td>Assertion</td><td>${summary.assertion.toFixed(1)}%</td></tr>
<tr><td><strong>Overall</strong></td><td><strong>${summary.overall.toFixed(1)}%</strong></td></tr>
</table>
<h2>Module Tree</h2>
<table>
<tr><th>Module</th><th>Line</th><th>Branch</th><th>Toggle</th><th>Cond</th><th>FSM-S</th><th>FSM-T</th><th>Func</th><th>Assert</th></tr>
${rows}
</table>
</body></html>`;
  }

  private renderTreeRows(node: CoverageData['root']): string {
    const pct = (n: number | null): string => (n === null ? 'N/A' : `${n.toFixed(1)}%`);
    const m = node.metrics;
    const indent = '  '.repeat(node.depth);
    const row = `<tr><td class="depth-${node.depth}">${indent}${node.name}</td>` +
      `<td>${pct(m.line.percentage)}</td><td>${pct(m.branch.percentage)}</td>` +
      `<td>${pct(m.toggle.percentage)}</td><td>${pct(m.condition.percentage)}</td>` +
      `<td>${pct(m.fsm_state.percentage)}</td><td>${pct(m.fsm_transition.percentage)}</td>` +
      `<td>${pct(m.functional.percentage)}</td><td>${pct(m.assertion.percentage)}</td></tr>`;
    const childRows = node.children.map((c) => this.renderTreeRows(c)).join('\n');
    return `${row}\n${childRows}`;
  }

  private async resolveSession(sessionId?: string): Promise<CoverageData> {
    if (sessionId) {
      const cached = await this.loadCached(sessionId);
      if (cached) return cached;
    }
    // 无 sessionId 或缓存未命中时，尝试最近 session
    const sessions = await this.listSessions();
    if (sessions.length === 0) {
      throw new Error('No coverage session available. Import coverage data first.');
    }
    const latest = sessions[0];
    const data = await this.loadCached(latest.sessionId);
    if (!data) {
      throw new Error(`Coverage data for session ${latest.sessionId} not found in cache`);
    }
    return data;
  }

  private generateSessionId(): string {
    const ts = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}` +
      `_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 6);
    return `merge_${stamp}_${rand}`;
  }

  private sessionsPath(): string {
    return join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR, SESSIONS_FILE);
  }

  private async appendSession(session: CoverageMergeSession): Promise<void> {
    const sessions = await this.listSessions();
    sessions.push(session);
    await this.writeSessions(sessions);
  }

  private async writeSessions(sessions: CoverageMergeSession[]): Promise<void> {
    const dir = join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(this.sessionsPath(), JSON.stringify(sessions, null, 2), 'utf-8');
  }

  private async loadCached(sessionId: string): Promise<CoverageData | null> {
    const filePath = join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR, `${sessionId}.json`);
    try {
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw) as CoverageData;
    } catch {
      return null;
    }
  }

  private async cache(data: CoverageData): Promise<void> {
    const dir = join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${data.sessionId}.json`);
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}


