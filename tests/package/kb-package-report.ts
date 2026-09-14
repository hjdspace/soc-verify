/**
 * issue 30 — 打包验收门禁报告（spec §11 / §Testing Decisions / A01–A22）。
 *
 * 报告落 `.scratch/llm-wiki/spikes/30-package/{report.json,report.md}`
 * （.scratch 已 gitignore，属本地证据；可用 KB_PACKAGE_REPORT_DIR 覆盖）。
 *
 * 报告必须能独立回答：
 *  - 测量环境（CPU/内存/SSD/Electron 版本）与固定数据规模生成参数；
 *  - 每项门禁的**实测值**与判定（不是组件存在性检查）；
 *  - 未达标项定位到具体责任票，不以降低数据规模假装通过；
 *  - A01–A22 责任票证据矩阵 + 各实施票验证记录的存在性核对。
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { formatBytes, type LatencyStats, type MemoryPeak } from './kb-package-perf';
import type { PackageFixtureParams } from './kb-package-fixture';
import type { PackagedApp } from './kb-package-gui';
import type { GraphScenarioResult } from './kb-package-gui';
import type { RealModelJourneyResult, ModelCallRecord } from './kb-journey-real-model';

const execFileAsync = promisify(execFile);

/** 门禁报告目录（三处使用者共享的单一来源；.scratch 已 gitignore） */
export function packageReportDir(repoRoot: string): string {
  return process.env.KB_PACKAGE_REPORT_DIR
    ?? join(repoRoot, '.scratch', 'llm-wiki', 'spikes', '30-package');
}

// ── 环境 ────────────────────────────────────────────────────────

export type EnvironmentInfo = {
  os: string;
  osRelease: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryBytes: number;
  /** best-effort：物理磁盘型号与总线类型（Get-PhysicalDisk），失败为 null */
  disks: Array<{ model: string; busType: string; mediaType: string }> | null;
  driveFreeBytes: Record<string, number>;
  node: string;
  gateRuntime: string;
};

export async function collectEnvironment(): Promise<EnvironmentInfo> {
  const cpus = os.cpus();
  const env: EnvironmentInfo = {
    os: `${os.platform()} ${os.arch()}`,
    osRelease: os.release(),
    cpuModel: cpus[0]?.model?.trim() ?? '(unknown)',
    cpuCores: cpus.length,
    totalMemoryBytes: os.totalmem(),
    disks: null,
    driveFreeBytes: {},
    node: process.versions.node,
    gateRuntime: `vitest/node ${process.versions.node}`,
  };

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-Command', "Get-PhysicalDisk | Select-Object FriendlyName,BusType,MediaType | ConvertTo-Json -Compress"],
      { timeout: 15_000 },
    );
    const parsed = JSON.parse(stdout) as Array<{ FriendlyName: string; BusType: string; MediaType: string }> | Record<string, string>;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    env.disks = list.map((d) => ({
      model: String(d.FriendlyName ?? ''),
      busType: String(d.BusType ?? ''),
      mediaType: String(d.MediaType ?? ''),
    }));
  } catch {
    env.disks = null; // 探测失败如实记录
  }

  for (const drive of ['C:\\', 'D:\\']) {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-PSDrive '${drive[0]}').Free`],
        { timeout: 10_000 },
      );
      env.driveFreeBytes[drive] = Number(stdout.trim()) || 0;
    } catch {
      // ignore
    }
  }
  return env;
}

// ── A01–A22 责任票证据矩阵 ──────────────────────────────────────

export type AcceptanceRow = {
  id: string;
  scenario: string;
  tickets: string;
  /** 可核对的证据入口（测试文件 / 本票门禁产物） */
  evidence: string[];
};

/**
 * 责任票映射与证据入口以仓库 README「验收与故事覆盖」为基准；
 * evidence 只引用实际存在的文件/命令，门禁会核对存在性。
 */
export const ACCEPTANCE_MATRIX: AcceptanceRow[] = [
  { id: 'A01', scenario: '同路径/等价路径导入身份', tickets: '01, 02', evidence: ['tests/kb-source-import.test.ts', 'tests/kb-source-identity.test.ts'] },
  { id: 'A02', scenario: '修订保留与转换失败', tickets: '02, 15, 17', evidence: ['tests/kb-source-import.test.ts', 'tests/kb-source-refs.test.ts', 'tests/kb-compile-cache.test.ts'] },
  { id: 'A03', scenario: 'PDF/DOCX 提图与兜底', tickets: '02, 11', evidence: ['tests/kb-converter.test.ts', 'tests/kb-pdf-assets.test.ts', 'tests/kb-pdf-asset-store.test.ts'] },
  { id: 'A04', scenario: '视觉指纹复用与失败重试', tickets: '12, 13', evidence: ['tests/kb-vision.test.ts', 'tests/kb-llm-vision.test.ts', 'tests/kb-compile-vision.test.ts'] },
  { id: 'A05', scenario: '长手册 coverage 与断点恢复', tickets: '10, 29', evidence: ['tests/kb-compile-long.test.ts', 'tests/kb-long-source-checkpoint.test.ts', 'tests/kb-quality-benchmark.test.ts'] },
  { id: 'A06', scenario: '流分片/截断完整性', tickets: '05, 08, 09', evidence: ['tests/kb-compile.test.ts', 'tests/kb-compile-repair.test.ts', 'tests/wiki-hunks.test.ts'] },
  { id: 'A07', scenario: '路径围栏与 schema 约束', tickets: '01, 04, 05', evidence: ['tests/kb-path-guard.test.ts', 'tests/kb-wiki-guard.test.ts', 'tests/kb-wiki-schema.test.ts'] },
  { id: 'A08', scenario: '来源合并与异常收缩', tickets: '16, 17', evidence: ['tests/kb-compile-merge.test.ts', 'tests/kb-page-merge.test.ts'] },
  { id: 'A09', scenario: '并发发布 stale 处理', tickets: '06, 07, 16', evidence: ['tests/kb-publish.test.ts', 'tests/kb-publish-multipage.test.ts'] },
  { id: 'A10', scenario: '候选集部分发布', tickets: '05, 07', evidence: ['tests/kb-candidate-set.test.ts', 'tests/kb-staged-router.test.ts'] },
  { id: 'A11', scenario: '事务崩溃恢复', tickets: '01, 06, 07', evidence: ['tests/kb-atomic-commit.test.ts'] },
  { id: 'A12', scenario: '队列暂停/取消/重启/切库', tickets: '03, 09, 10, 13, 17, 30', evidence: ['tests/kb-ingest-queue.test.ts', 'tests/kb-queue-router.test.ts', 'tests/kb-compile-queue.test.ts', '本票真实模型旅程（pause + 重启恢复零模型调用）'] },
  { id: 'A13', scenario: '页面回滚与历史证据', tickets: '15, 19, 20', evidence: ['tests/kb-page-rollback.test.ts', 'tests/kb-wiki-read.test.ts'] },
  { id: 'A14', scenario: '固定候选检索与图扩展', tickets: '14, 23, 24, 29, 30', evidence: ['tests/kb-wiki-search.test.ts', 'tests/kb-issue24-hybrid-search.test.ts', 'tests/kb-quality-benchmark.test.ts', '本票固定规模 p95 实测'] },
  { id: 'A15', scenario: '向量覆盖与重建中断', tickets: '22, 24', evidence: ['tests/kb-issue22-e2e.test.ts', 'tests/kb-vector-store.test.ts', 'tests/kb-text-chunker.test.ts'] },
  { id: 'A16', scenario: '嵌入降级与错误区分', tickets: '21, 22, 24', evidence: ['tests/kb-embedding-endpoint.test.ts', 'tests/kb-embedding-service.test.ts', 'tests/kb-embedding-fingerprint.test.ts'] },
  { id: 'A17', scenario: '链接解析与歧义', tickets: '04, 23, 25, 26', evidence: ['tests/kb-wikilink.test.ts', 'tests/kb-wiki-graph.test.ts', 'tests/kb-structural-lint.test.ts'] },
  { id: 'A18', scenario: '语义检查与修复复核', tickets: '25, 26, 27, 29', evidence: ['tests/kb-semantic-lint.test.ts', 'tests/kb-finding-store.test.ts', 'tests/kb-lint-fixes.test.ts'] },
  { id: 'A19', scenario: '保存问答去重与引用', tickets: '18', evidence: ['tests/kb-save-query.test.ts', '本票真实模型旅程（保存问答→发布）'] },
  { id: 'A20', scenario: 'Host Tool 边界与分页', tickets: '14, 15, 28', evidence: ['tests/kb-host-tools.test.ts', 'tests/kb-read-gate.test.ts'] },
  { id: 'A21', scenario: '旧格式/离线/目录边界', tickets: '01, 20, 28', evidence: ['tests/kb-source-disposal.test.ts', 'tests/kb-wiki-catalog.test.ts'] },
  { id: 'A22', scenario: '打包 Electron（无 CDN/无 WebGL/原生 SDK）', tickets: '11, 21, 26, 30', evidence: ['scripts/kb-package-gate/runtime.cjs（打包运行时探针）', '本票 CDP 打包 GUI 门禁', 'npm run smoke:kb-graph（issue 26）'] },
];

/** 门禁核对矩阵引用的文件是否存在 */
export function verifyAcceptanceEvidence(repoRoot: string): Array<{ id: string; missing: string[] }> {
  const problems: Array<{ id: string; missing: string[] }> = [];
  for (const row of ACCEPTANCE_MATRIX) {
    const missing = row.evidence
      .filter((e) => e.endsWith('.test.ts') || e.endsWith('.cjs') || e.endsWith('.mjs'))
      .filter((e) => !existsSync(join(repoRoot, e)));
    if (missing.length > 0) problems.push({ id: row.id, missing });
  }
  return problems;
}

// ── 实施票验证记录核对 ──────────────────────────────────────────

export type TicketHandoverRecord = {
  ticket: number;
  file: string;
  hasHandover: boolean;
  status: string;
};

export function collectTicketHandovers(issuesDir: string): TicketHandoverRecord[] {
  const records: TicketHandoverRecord[] = [];
  for (let n = 1; n <= 29; n++) {
    const found = findIssueFile(issuesDir, n);
    if (!found) {
      records.push({ ticket: n, file: `(未找到 ${String(n).padStart(2, '0')}-*.md)`, hasHandover: false, status: 'missing' });
      continue;
    }
    const content = readFileSync(found, 'utf-8');
    const status = content.match(/\*\*Status:\*\*\s*(\S+)/)?.[1] ?? 'unknown';
    records.push({
      ticket: n,
      file: found,
      // 交接标题在各票中写法不一：交接/实现记录/实际交付/完成交接/完成记录/
      // 实施记录——统一按「结果性记录节存在」判定
      hasHandover: /^##\s*(交接|实现|交付|完成|实施|实际)/m.test(content),
      status,
    });
  }
  return records;
}

function findIssueFile(issuesDir: string, n: number): string | null {
  const prefix = `${String(n).padStart(2, '0')}-`;
  try {
    const entries = readdirSync(issuesDir);
    const hit = entries.find((e) => e.startsWith(prefix) && e.endsWith('.md'));
    return hit ? join(issuesDir, hit) : null;
  } catch {
    return null;
  }
}

// ── 报告结构 ────────────────────────────────────────────────────

export type GateThresholds = {
  keywordP95Ms: number;
  graphFirstFrameMs: number;
};

export const GATE_THRESHOLDS: GateThresholds = {
  keywordP95Ms: 1000, // spec：缓存热关键词查询 p95 ≤ 1 秒（初始目标）
  graphFirstFrameMs: 3000, // spec：图首个可交互画面 ≤ 3 秒
};

export type PackageGateReport = {
  issue: number;
  generatedAt: string;
  environment: EnvironmentInfo;
  package: (Pick<PackagedApp, 'exePath' | 'asarPath' | 'exeBytes'> & { exeMtimeIso: string; version?: string | null; productName: string }) | null;
  fixture: {
    params: PackageFixtureParams;
    pageCount: number;
    edgeCount: number;
    sourceCount: number;
    parsedBytes: number;
    sourceBytes: number;
    wikiBytes: number;
    generateMs: number;
  } | null;
  measurements: {
    keywordLatency: {
      stats: LatencyStats;
      byKind: Record<string, LatencyStats>;
      warmupPasses: number;
      measuredPasses: number;
      passMs: number[];
      memoryPeak: MemoryPeak;
      allQueriesHit: boolean;
      zeroHitQueries: string[];
      note: string;
    } | null;
    cancelLatency: {
      source: string;
      cancelAckMs: number;
      lateResultRejected: boolean;
      note: string;
    } | null;
    packagedRuntime: Record<string, unknown> | null;
    gui: GraphScenarioResult[] | null;
    journey: Omit<RealModelJourneyResult, 'modelCalls'> & { modelCallsSummary: ModelCallRecord[] } | null;
  };
  gates: Array<{ id: string; name: string; met: boolean; actual: string; threshold: string; ticket: string | null }>;
  findings: Array<{ severity: 'blocker' | 'high' | 'info'; id: string; message: string; ticket: string }>;
  acceptanceMatrix: Array<{ id: string; tickets: string; evidence: string[]; evidenceMissing?: string[] }>;
  ticketHandovers: TicketHandoverRecord[];
  commands: string[];
};

export function buildReport(parts: {
  environment: EnvironmentInfo;
  packagedApp: PackagedApp | null;
  packageVersion?: string | null;
  fixture: PackageGateReport['fixture'];
  measurements: PackageGateReport['measurements'];
  findings: PackageGateReport['findings'];
  commands: string[];
  issuesDir: string;
  repoRoot: string;
}): PackageGateReport {
  const gates: PackageGateReport['gates'] = [];
  const kw = parts.measurements.keywordLatency;
  gates.push({
    id: 'keyword-p95',
    name: '缓存热关键词查询 p95',
    met: Boolean(kw && kw.stats.p95Ms <= GATE_THRESHOLDS.keywordP95Ms && kw.allQueriesHit),
    actual: kw ? `${kw.stats.p95Ms} ms（${kw.stats.samples} 样本，全部命中=${kw.allQueriesHit}）` : '未测量',
    threshold: `≤ ${GATE_THRESHOLDS.keywordP95Ms} ms`,
    ticket: kw && kw.stats.p95Ms > GATE_THRESHOLDS.keywordP95Ms ? '14' : null,
  });

  const guiScenarios = parts.measurements.gui ?? [];
  const guiWarm = guiScenarios.filter((g) => !g.adjacencyDegraded && g.firstFrameMs !== null);
  const guiCold = guiWarm[0];
  const guiRestart = guiWarm[1];
  // 门禁按 spec 口径从严：以「首次打开」判定；重启后的暖缓存数值作为诊断记录
  const firstFrameOk = Boolean((guiCold?.firstFrameMs ?? Infinity) <= GATE_THRESHOLDS.graphFirstFrameMs);
  gates.push({
    id: 'graph-first-frame',
    name: '图首个可交互画面（实际安装包，1000 页）',
    met: firstFrameOk,
    actual: [
      guiCold?.firstFrameMs != null ? `首次打开 ${guiCold.firstFrameMs}ms` : '首次打开未测量',
      guiRestart?.firstFrameMs != null ? `（重启后暖缓存 ${guiRestart.firstFrameMs}ms，仅诊断）` : null,
    ]
      .filter(Boolean)
      .join('，'),
    threshold: `≤ ${GATE_THRESHOLDS.graphFirstFrameMs} ms`,
    ticket: firstFrameOk ? null : '23',
  });

  const fx = parts.fixture;
  gates.push({
    id: 'fixture-scale',
    name: '固定规模（1000 页 / 10000 边 / 约 50MB parsed）',
    met: Boolean(fx && fx.pageCount === 1000 && fx.edgeCount >= 10000 && fx.parsedBytes >= 45 * 1024 * 1024),
    actual: fx ? `${fx.pageCount} 页 / ${fx.edgeCount} 边 / ${formatBytes(fx.parsedBytes)} parsed` : '未生成',
    threshold: '1000 页 / ≥10000 边 / ≈50MB',
    ticket: null,
  });

  const pr = parts.measurements.packagedRuntime as { ok?: boolean } | null;
  gates.push({
    id: 'packaged-runtime',
    name: '安装包内 LanceDB / PDF 运行时 / 本地转换 / 图布局可启动与重开，无 CDN',
    met: Boolean(pr?.ok),
    actual: pr ? `ok=${pr.ok}（详见 packagedRuntime 报告）` : '未执行（需要 dist/win-unpacked）',
    threshold: '全部检查通过且零外联',
    ticket: pr && !pr.ok ? '30' : null,
  });

  const guiOk = (parts.measurements.gui ?? []).every((g) => g.ok);
  gates.push({
    id: 'packaged-gui',
    name: '打包 GUI：图视图首帧/无 WebGL 降级/窗口响应/无模型请求',
    met: Boolean(parts.measurements.gui?.length) && guiOk,
    actual: parts.measurements.gui
      ? `${parts.measurements.gui.filter((g) => g.ok).length}/${parts.measurements.gui.length} 场景通过`
      : '未执行',
    threshold: '全部场景通过',
    ticket: !guiOk ? '30' : null,
  });

  const journey = parts.measurements.journey;
  gates.push({
    id: 'real-model-journey',
    name: '真实模型图文旅程（导入→审阅→查询→保存问答）',
    met: Boolean(journey?.ok),
    actual: journey ? `${journey.steps.filter((s) => s.ok).length}/${journey.steps.length} 步通过` : '未执行',
    threshold: '全部步骤通过（模型延迟单独计）',
    ticket: journey && !journey.ok ? '30' : null,
  });

  const matrix = ACCEPTANCE_MATRIX.map((row) => {
    const missing = verifyAcceptanceEvidence(parts.repoRoot).find((p) => p.id === row.id)?.missing;
    return { id: row.id, tickets: row.tickets, evidence: row.evidence, ...(missing?.length ? { evidenceMissing: missing } : {}) };
  });

  return {
    issue: 30,
    generatedAt: new Date().toISOString(),
    environment: parts.environment,
    package: parts.packagedApp
      ? {
          exePath: parts.packagedApp.exePath,
          asarPath: parts.packagedApp.asarPath,
          exeBytes: parts.packagedApp.exeBytes,
          exeMtimeIso: parts.packagedApp.exeMtimeIso,
          version: parts.packageVersion ?? null,
          productName: 'SoC Verify',
        }
      : null,
    fixture: parts.fixture,
    measurements: parts.measurements,
    gates,
    findings: parts.findings,
    acceptanceMatrix: matrix,
    ticketHandovers: collectTicketHandovers(parts.issuesDir),
    commands: parts.commands,
  };
}

// ── 渲染与落盘 ──────────────────────────────────────────────────

export function renderMarkdown(report: PackageGateReport): string {
  const lines: string[] = [];
  const p = (s = '') => lines.push(s);

  p(`# 30 — 验收安装包完整旅程与固定规模性能（门禁报告）`);
  p();
  p(`生成时间：${report.generatedAt}`);
  p();
  p(`## 环境（固定测试机记录）`);
  p();
  p(`| 项 | 值 |`);
  p(`| --- | --- |`);
  p(`| OS | ${report.environment.os} ${report.environment.osRelease} |`);
  p(`| CPU | ${report.environment.cpuModel} × ${report.environment.cpuCores} |`);
  p(`| 内存 | ${formatBytes(report.environment.totalMemoryBytes)} |`);
  p(
    `| SSD | ${report.environment.disks
      ? report.environment.disks.map((d) => `${d.model} (${d.busType}/${d.mediaType})`).join('；')
      : '（Get-PhysicalDisk 探测失败，见 driveFree）'} |`,
  );
  p(`| 门禁运行时 | ${report.environment.gateRuntime} |`);
  p(`| Electron（打包产物） | ${report.package ? '见打包产物节' : '未打包'} |`);
  p();
  p(`## 打包产物（被测对象）`);
  p();
  if (report.package) {
    p(`- 路径：\`${report.package.exePath}\``);
    p(`- 版本：${report.package.version ?? '(unknown)'}，大小 ${formatBytes(report.package.exeBytes)}，构建时间 ${report.package.exeMtimeIso}`);
    p(`- app.asar：\`${report.package.asarPath}\``);
  } else {
    p(`- **未找到打包产物**（门禁要求实际安装包，不验收 dev 产物）`);
  }
  p();
  p(`## 固定规模 fixture（生成参数原样记录）`);
  p();
  if (report.fixture) {
    p(`| 参数 | 值 |`);
    p(`| --- | --- |`);
    p(`| seed | ${report.fixture.params.seed} |`);
    p(`| 页数 | ${report.fixture.pageCount}（目标 ${report.fixture.params.pageCount}） |`);
    p(`| 图边数（生产图快照实测） | ${report.fixture.edgeCount}（目标 ≥${report.fixture.params.targetEdges}） |`);
    p(`| parsed 全文 | ${formatBytes(report.fixture.parsedBytes)}（目标 ≈${formatBytes(report.fixture.params.parsedBytesTarget)}，${report.fixture.sourceCount} 个来源） |`);
    p(`| 原件 raw/sources | ${formatBytes(report.fixture.sourceBytes)} |`);
    p(`| wiki/ | ${formatBytes(report.fixture.wikiBytes)} |`);
    p(`| 生成耗时 | ${report.fixture.generateMs} ms |`);
  } else {
    p(`未生成。`);
  }
  p();
  p(`## 门禁判定`);
  p();
  p(`| 门禁 | 判定 | 实测 | 阈值 | 责任票 |`);
  p(`| --- | --- | --- | --- | --- |`);
  for (const g of report.gates) {
    p(`| ${g.name} | ${g.met ? '✅' : '❌'} | ${g.actual} | ${g.threshold} | ${g.ticket ?? '—'} |`);
  }
  p();
  p(`## 关键实测`);
  p();
  const kw = report.measurements.keywordLatency;
  if (kw) {
    p(`### 缓存热关键词检索（生产 searchWiki，keyword 模式）`);
    p();
    p(`- ${kw.warmupPasses} 轮预热 + ${kw.measuredPasses} 轮计时 × ${report.fixture?.params.pageCount ?? 1000} 页查询集`);
    p(`- p50=${kw.stats.p50Ms}ms，**p95=${kw.stats.p95Ms}ms**，max=${kw.stats.maxMs}ms（${kw.stats.samples} 样本）`);
    p(`- 单轮查询集：${kw.passMs.map((v) => `${v}ms`).join(' / ')}`);
    p(`- 分类别：${Object.entries(kw.byKind).map(([k, v]) => `${k} p95=${v.p95Ms}ms`).join('，')}`);
    p(`- 计时期间内存峰值：RSS ${formatBytes(kw.memoryPeak.rssPeakBytes)}，heap ${formatBytes(kw.memoryPeak.heapUsedPeakBytes)}`);
    p(`- 查询覆盖：${kw.allQueriesHit ? '全部查询有命中（测的是真实检索路径）' : `存在零命中查询：${kw.zeroHitQueries.join('、')}`}`);
    p(`- 口径：${kw.note}`);
    p();
  }
  const cl = report.measurements.cancelLatency;
  if (cl) {
    p(`### 取消响应（真实模型调用进行中）`);
    p();
    p(`- 来源：${cl.source}`);
    p(`- 取消确认耗时：**${cl.cancelAckMs}ms**；迟到结果拒绝提交：${cl.lateResultRejected ? '是' : '否'}`);
    p(`- 口径：${cl.note}`);
    p();
  }
  const j = report.measurements.journey;
  if (j) {
    p(`### 真实模型旅程（模型延迟单独计）`);
    p();
    p(`- 模型：${j.credentials ? `compile=${j.credentials.compile.providerId}/${j.credentials.compile.model}` : 'n/a'}${j.credentials?.vision ? `，vision=${j.credentials.vision.providerId}/${j.credentials.vision.model}` : ''}`);
    p(`- 步骤：${j.steps.map((s) => `${s.ok ? '✅' : '❌'}${s.name}${s.ms !== undefined ? `(${s.ms}ms)` : ''}`).join(' → ')}`);
    p(`- 模型调用 ${j.modelCallsSummary.length} 次：${j.modelCallsSummary.map((c) => `${c.role}/${c.model} ${c.ms}ms`).join('，') || '无'}`);
    if (j.cancelProbe) {
      p(`- 真实取消：ack=${j.cancelProbe.cancelAckMs}ms，任务回 queued=${j.cancelProbe.taskBackToQueued}，重启恢复后模型调用=${j.cancelProbe.modelCallsAfterAttach}（0 = 不重耗模型）`);
    }
    if (j.query) p(`- 查询「${j.query.text}」命中 ${j.query.hits} 条，首个：${j.query.firstHitTitle ?? '无'}`);
    p(`- 结论：${j.ok ? '旅程完整走通' : `未走通：${j.failures.join('；')}`}`);
    p();
  }
  const gui = report.measurements.gui;
  if (gui?.length) {
    p(`### 打包 GUI 场景（CDP 驱动实际安装包）`);
    p();
    for (const g of gui) {
      p(`- 场景${g.adjacencyDegraded ? '（无 WebGL）' : ''}：${g.ok ? '✅' : '❌'}${g.firstFrameMs !== null ? `，首帧 ${g.firstFrameMs}ms` : ''}，画布 ${g.canvasCount}，rAF 最大间隙 ${g.maxRafGapMs ?? 'n/a'}ms，heap ${g.heapUsedBytes !== null ? formatBytes(g.heapUsedBytes) : 'n/a'}，外联 ${g.requests.remote.length}，模型请求 ${g.requests.model.length}`);
      for (const c of g.checks.filter((c) => !c.ok)) p(`  - ❌ ${c.name}：${JSON.stringify(c.detail)?.slice(0, 200)}`);
      for (const f of g.failures) p(`  - 失败：${String(f).slice(0, 300)}`);
    }
    p();
  }
  const pr = report.measurements.packagedRuntime as { checks?: Array<{ name: string; ok: boolean; detail?: unknown }>; metrics?: Record<string, unknown>; runtime?: Record<string, unknown>; ok?: boolean; outboundAttempts?: unknown[] } | null;
  if (pr) {
    p(`### 打包运行时探针（ELECTRON_RUN_AS_NODE 驱动打包 exe）`);
    p();
    p(`- 运行时：${JSON.stringify(pr.runtime)}`);
    p(`- 结论：${pr.ok ? '✅ 全部通过' : '❌ 有失败'}`);
    for (const c of pr.checks ?? []) p(`  - ${c.ok ? '✅' : '❌'} ${c.name}${c.detail !== undefined ? `：${JSON.stringify(c.detail)?.slice(0, 200)}` : ''}`);
    p(`- 指标：${JSON.stringify(pr.metrics)}`);
    p(`- 出网尝试：${JSON.stringify(pr.outboundAttempts)}`);
    p();
  }
  p(`## 失败定位（不以降低数据规模假装通过）`);
  p();
  if (report.findings.length === 0) {
    p(`无。`);
  } else {
    for (const f of report.findings) {
      p(`- **[${f.severity}] ${f.id}** → issue ${f.ticket}：${f.message}`);
    }
  }
  p();
  p(`## A01–A22 责任票证据矩阵`);
  p();
  p(`| 验收 | 场景 | 责任票 | 证据入口 |`);
  p(`| --- | --- | --- | --- |`);
  for (const row of ACCEPTANCE_MATRIX) {
    const missing = report.acceptanceMatrix.find((m) => m.id === row.id)?.evidenceMissing;
    p(`| ${row.id} | ${row.scenario} | ${row.tickets} | ${row.evidence.join('、')}${missing?.length ? `（⚠️ 缺失：${missing.join('、')}）` : ''} |`);
  }
  p();
  p(`## 实施票验证记录核对（01–29 交接）`);
  p();
  const missingHandover = report.ticketHandovers.filter((t) => !t.hasHandover);
  p(`- ${report.ticketHandovers.length - missingHandover.length}/${report.ticketHandovers.length} 张票的交接记录（含 typecheck/lint/测试证据）存在。`);
  if (missingHandover.length > 0) {
    p(`- 缺失：${missingHandover.map((t) => `${t.ticket}(${t.status})`).join('、')}`);
  }
  p(`- 本票（HEAD）验证命令见下节；按票验收以各票交接记录为准，不重复全量测试。`);
  p();
  p(`## 基准命令与步骤（可复现）`);
  p();
  p('```bash');
  for (const c of report.commands) p(c);
  p('```');
  p();
  return lines.join('\n');
}

export function writeReport(dir: string, report: PackageGateReport): { jsonPath: string; mdPath: string } {
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, 'report.json');
  const mdPath = join(dir, 'report.md');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
  writeFileSync(mdPath, renderMarkdown(report), 'utf-8');
  return { jsonPath, mdPath };
}
