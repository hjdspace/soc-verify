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

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CoverageData,
  CoverageMergeSession,
  CoverageSummary,
  CoverageNode,
  EdaToolConfig,
  CoverageMetric,
  CoverageGap,
  CoverageDelta,
  CoverageTriage,
  CoverageExclusion,
  TriageCause,
  TriageConfidence,
  ExclusionStatus,
} from '@shared/types';
import {
  summarizeCoverage,
  detectGaps,
  calculateDelta,
  DEFAULT_COVERAGE_TARGETS,
  COVERAGE_METRICS,
} from '@shared/types';
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

  // ─── AI Host Tools 支持（ADR 0009 摘要优先策略） ───────────────

  /**
   * 返回覆盖率摘要 + 最差 N 个模块（ADR 0009 摘要优先策略）。
   * 供 AI Host Tool get_coverage 消费，避免返回整个树超出 context window。
   */
  async getCoverageSummary(
    sessionId?: string,
    worstN = 5,
  ): Promise<{
    sessionId: string;
    summary: CoverageSummary;
    worstModules: Array<{
      name: string;
      path: string;
      metrics: CoverageNode['metrics'];
      deficit: number; // 最差 metric 的 deficit (target - actual)，无目标用 0
    }>;
    targets: Partial<Record<CoverageMetric, number>>;
  }> {
    const data = await this.resolveSession(sessionId);
    const targets = await this.getTargets(data.sessionId);
    const summary = summarizeCoverage(data.root);

    // 遍历所有节点，计算每个节点最差 metric 的 deficit
    const allNodes: CoverageNode[] = [];
    const walk = (node: CoverageNode): void => {
      allNodes.push(node);
      for (const child of node.children) walk(child);
    };
    walk(data.root);

    const worstModules = allNodes
      .map((node) => {
        let maxDeficit = 0;
        for (const metric of COVERAGE_METRICS) {
          const target = targets[metric];
          const pct = node.metrics[metric].percentage;
          if (target === undefined || pct === null) continue;
          const deficit = target - pct;
          if (deficit > maxDeficit) maxDeficit = deficit;
        }
        return {
          name: node.name,
          path: node.path,
          metrics: node.metrics,
          deficit: maxDeficit,
        };
      })
      .sort((a, b) => b.deficit - a.deficit)
      .slice(0, worstN);

    return { sessionId: data.sessionId, summary, worstModules, targets };
  }

  /**
   * 返回指定模块及其直接子模块的覆盖率（ADR 0009 按需下钻）。
   * 供 AI Host Tool get_coverage_detail 消费。
   * modulePath 格式如 "top/cpu_core" 或 "top/cpu_core/u_reg"。
   */
  async getCoverageDetail(
    modulePath: string,
    sessionId?: string,
  ): Promise<{
    sessionId: string;
    module: CoverageNode | null;
    children: CoverageNode[];
    targets: Partial<Record<CoverageMetric, number>>;
  }> {
    const data = await this.resolveSession(sessionId);
    const targets = await this.getTargets(data.sessionId);

    // 递归查找 modulePath 对应的节点
    const findNode = (node: CoverageNode, path: string): CoverageNode | null => {
      if (node.path === path) return node;
      for (const child of node.children) {
        const found = findNode(child, path);
        if (found) return found;
      }
      return null;
    };

    const module = findNode(data.root, modulePath);
    const children = module ? module.children : [];

    return { sessionId: data.sessionId, module, children, targets };
  }

  async deleteSession(sessionId: string): Promise<void> {
    const sessions = await this.listSessions();
    const next = sessions.filter((s) => s.sessionId !== sessionId);
    await this.writeSessions(next);
    // 清理缓存文件与 triage/exclusion 元数据（best-effort，不阻塞删除）
    await this.safeDelete(this.cachePath(sessionId));
    await this.safeDelete(this.triagePath(sessionId));
    await this.safeDelete(this.exclusionPath(sessionId));
  }

  // ─── Target 管理（PRD US-11） ─────────────────────────────────

  /**
   * 返回指定 session 的有效目标（session 自定义覆盖默认值）。
   * sessionId 缺省时仅返回 DEFAULT_COVERAGE_TARGETS。
   * assertion 始终无默认目标（行业惯例）。
   */
  async getTargets(sessionId?: string): Promise<Partial<Record<CoverageMetric, number>>> {
    if (!sessionId) return { ...DEFAULT_COVERAGE_TARGETS };
    const data = await this.loadCached(sessionId);
    if (!data) return { ...DEFAULT_COVERAGE_TARGETS };
    return { ...DEFAULT_COVERAGE_TARGETS, ...data.targets };
  }

  /**
   * 设置指定 session 的覆盖率目标（覆盖式）。
   * 持久化到缓存文件 CoverageData.targets。
   */
  async setTargets(
    sessionId: string,
    targets: Partial<Record<CoverageMetric, number>>,
  ): Promise<Partial<Record<CoverageMetric, number>>> {
    const data = await this.resolveSession(sessionId);
    const merged = { ...DEFAULT_COVERAGE_TARGETS, ...data.targets, ...targets };
    const updated: CoverageData = { ...data, targets: merged };
    await this.cache(updated);
    return merged;
  }

  // ─── Gap 检测（ADR 0007 决策 5 + PRD US-12） ─────────────────

  /**
   * 列出指定 session 中所有低于 Target 的 Gap。
   * sessionId 缺省时使用最近一个 session。
   */
  async listGaps(sessionId?: string): Promise<{ sessionId: string; gaps: CoverageGap[] }> {
    const data = await this.resolveSession(sessionId);
    const targets = await this.getTargets(data.sessionId);
    return { sessionId: data.sessionId, gaps: detectGaps(data.root, targets) };
  }

  // ─── Delta 计算（PRD US-15） ─────────────────────────────────

  /**
   * 计算两个 session 之间的覆盖率变化（逐 metric）。
   * delta = after − before；正值表示提升，负值表示退化。
   */
  async getDelta(
    sessionIdBefore: string,
    sessionIdAfter: string,
  ): Promise<{ before: CoverageSummary; after: CoverageSummary; deltas: CoverageDelta[] }> {
    const before = await this.resolveSession(sessionIdBefore);
    const after = await this.resolveSession(sessionIdAfter);
    const beforeSummary = summarizeCoverage(before.root);
    const afterSummary = summarizeCoverage(after.root);
    return {
      before: beforeSummary,
      after: afterSummary,
      deltas: calculateDelta(beforeSummary, afterSummary),
    };
  }

  // ─── Triage CRUD（PRD US-16, US-17；本切片仅手动标注） ────────

  /**
   * 添加一条 Triage 标注。返回带 id/triagedAt 的新条目。
   */
  async addTriage(input: {
    sessionId: string;
    nodePath: string;
    metric: CoverageMetric;
    gap: CoverageGap;
    cause?: TriageCause;
    confidence?: TriageConfidence;
    note?: string;
    triagedBy?: string;
  }): Promise<CoverageTriage> {
    const entry: CoverageTriage = {
      id: this.generateId('triage'),
      sessionId: input.sessionId,
      nodePath: input.nodePath,
      metric: input.metric,
      gap: input.gap,
      cause: input.cause,
      confidence: input.confidence,
      note: input.note,
      triagedAt: Date.now(),
      triagedBy: input.triagedBy,
    };
    const list = await this.loadTriage(input.sessionId);
    list.push(entry);
    await this.saveTriage(input.sessionId, list);
    return entry;
  }

  /**
   * 列出指定 session（缺省=所有 session）的 Triage 条目。
   */
  async listTriage(sessionId?: string): Promise<CoverageTriage[]> {
    if (sessionId) return this.loadTriage(sessionId);
    // 遍历所有 session 聚合
    const sessions = await this.listSessions();
    const all: CoverageTriage[] = [];
    for (const s of sessions) {
      const list = await this.loadTriage(s.sessionId);
      all.push(...list);
    }
    return all.sort((a, b) => (b.triagedAt ?? 0) - (a.triagedAt ?? 0));
  }

  async deleteTriage(id: string): Promise<void> {
    const all = await this.listTriage();
    const target = all.find((t) => t.id === id);
    if (!target) return;
    const remaining = (await this.loadTriage(target.sessionId)).filter((t) => t.id !== id);
    await this.saveTriage(target.sessionId, remaining);
  }

  // ─── Exclusion 工作流（PRD US-18, US-19；需人工审批） ─────────

  /**
   * 发起排除请求（status=pending）。不可自动排除，必须经过 approve。
   */
  async requestExclusion(input: {
    sessionId: string;
    nodePath: string;
    metric: CoverageMetric;
    reason: string;
    requestedBy: string;
  }): Promise<CoverageExclusion> {
    const entry: CoverageExclusion = {
      id: this.generateId('excl'),
      sessionId: input.sessionId,
      nodePath: input.nodePath,
      metric: input.metric,
      reason: input.reason,
      status: 'pending',
      requestedBy: input.requestedBy,
      requestedAt: Date.now(),
    };
    const list = await this.loadExclusions(input.sessionId);
    list.push(entry);
    await this.saveExclusions(input.sessionId, list);
    return entry;
  }

  /** 审批通过：将 pending → approved。 */
  async approveExclusion(id: string, approver: string): Promise<CoverageExclusion> {
    return this.updateExclusion(id, (e) => ({
      ...e,
      status: 'approved' as ExclusionStatus,
      approvedBy: approver,
      approvedAt: Date.now(),
    }));
  }

  /** 驳回：将 pending → rejected，并记录原因。 */
  async rejectExclusion(id: string, approver: string, reason: string): Promise<CoverageExclusion> {
    return this.updateExclusion(id, (e) => ({
      ...e,
      status: 'rejected' as ExclusionStatus,
      approvedBy: approver,
      approvedAt: Date.now(),
      rejectionReason: reason,
    }));
  }

  /**
   * 列出指定 session（缺省=所有 session）的 Exclusion 条目。
   * status 缺省返回全部状态。
   */
  async listExclusions(
    sessionId?: string,
    status?: ExclusionStatus,
  ): Promise<CoverageExclusion[]> {
    let list: CoverageExclusion[];
    if (sessionId) {
      list = await this.loadExclusions(sessionId);
    } else {
      const sessions = await this.listSessions();
      list = [];
      for (const s of sessions) {
        list.push(...(await this.loadExclusions(s.sessionId)));
      }
    }
    const filtered = status ? list.filter((e) => e.status === status) : list;
    return filtered.sort((a, b) => b.requestedAt - a.requestedAt);
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

  // ─── Triage / Exclusion 持久化 ──────────────────────────────

  private cachePath(sessionId: string): string {
    return join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR, `${sessionId}.json`);
  }

  private triagePath(sessionId: string): string {
    return join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR, `${sessionId}-triage.json`);
  }

  private exclusionPath(sessionId: string): string {
    return join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR, `${sessionId}-exclusions.json`);
  }

  private async loadTriage(sessionId: string): Promise<CoverageTriage[]> {
    try {
      const raw = await readFile(this.triagePath(sessionId), 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as CoverageTriage[]) : [];
    } catch {
      return [];
    }
  }

  private async saveTriage(sessionId: string, list: CoverageTriage[]): Promise<void> {
    const dir = join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(this.triagePath(sessionId), JSON.stringify(list, null, 2), 'utf-8');
  }

  private async loadExclusions(sessionId: string): Promise<CoverageExclusion[]> {
    try {
      const raw = await readFile(this.exclusionPath(sessionId), 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as CoverageExclusion[]) : [];
    } catch {
      return [];
    }
  }

  private async saveExclusions(sessionId: string, list: CoverageExclusion[]): Promise<void> {
    const dir = join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(this.exclusionPath(sessionId), JSON.stringify(list, null, 2), 'utf-8');
  }

  /**
   * 按 id 查找并就地更新 Exclusion 条目。
   * 仅允许从 pending 流转；已 approved/rejected 的条目不可再改状态。
   */
  private async updateExclusion(
    id: string,
    mutator: (e: CoverageExclusion) => CoverageExclusion,
  ): Promise<CoverageExclusion> {
    const sessions = await this.listSessions();
    for (const s of sessions) {
      const list = await this.loadExclusions(s.sessionId);
      const idx = list.findIndex((e) => e.id === id);
      if (idx === -1) continue;
      const current = list[idx];
      if (current.status !== 'pending') {
        throw new Error(`Exclusion ${id} is already ${current.status}; cannot change`);
      }
      const updated = mutator(current);
      list[idx] = updated;
      await this.saveExclusions(s.sessionId, list);
      return updated;
    }
    throw new Error(`Exclusion ${id} not found`);
  }

  private generateId(prefix: string): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${ts}_${rand}`;
  }

  private async safeDelete(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch {
      // best-effort：文件不存在或被占用均忽略
    }
  }
}


