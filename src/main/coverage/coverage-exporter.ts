/**
 * 覆盖率报告导出生成器（Slice 7 / GitHub Issue #9）。
 *
 * 纯函数模块，只负责生成 HTML / JSON 内容字符串，不触碰文件系统。
 * 文件写入由 router 层用 `node:fs/promises` 的 `writeFile` 完成。
 *
 * 设计要点：
 *   - HTML 报告为独立可打开文件（所有 CSS 内联在 `<style>` 标签中，不依赖外部资源）
 *   - 布局参考仪表盘视图：概览卡片（8 metric + overall）+ 树表格（可展开折叠）+ 未覆盖项
 *   - 颜色编码与 UI 一致：pass 绿 / warn 黄 / fail 红 / na 灰
 *   - JSON 导出包含完整 Coverage Tree + 8 metric × Triplet + Target + Gap + Delta
 */

import type {
  CoverageData,
  CoverageNode,
  CoverageMetric,
  CoverageTriplet,
  CoverageGap,
  CoverageDelta,
  UncoveredItem,
} from '@shared/types';
import {
  COVERAGE_METRICS,
  DEFAULT_COVERAGE_TARGETS,
  summarizeCoverage,
  detectGaps,
} from '@shared/types';

// ─── 常量 ────────────────────────────────────────────────────────

const METRIC_LABELS: Record<CoverageMetric, string> = {
  line: 'Line',
  branch: 'Branch',
  toggle: 'Toggle',
  condition: 'Condition',
  fsm_state: 'FSM State',
  fsm_transition: 'FSM Trans',
  functional: 'Functional',
  assertion: 'Assertion',
};

type Status = 'pass' | 'warn' | 'fail' | 'na';

// ─── 颜色分类（与 CoverageTreeTable / CoverageDashboard 保持一致） ──

/**
 * 根据 metric、百分比和目标值分类覆盖率状态。
 * - percentage === null → na（灰）
 * - 无目标（assertion）: >= 90 pass; >= 80 warn; 否则 fail
 * - 有目标: >= target pass; >= target-5 warn; 否则 fail
 */
function classify(
  metric: CoverageMetric,
  percentage: number | null,
  target: number | undefined,
): Status {
  if (percentage === null) return 'na';
  if (target === undefined) {
    if (percentage >= 90) return 'pass';
    if (percentage >= 80) return 'warn';
    return 'fail';
  }
  if (percentage >= target) return 'pass';
  if (percentage >= target - 5) return 'warn';
  return 'fail';
}

// ─── 辅助函数 ────────────────────────────────────────────────────

function pctStr(n: number | null): string {
  return n === null ? 'N/A' : `${n.toFixed(1)}%`;
}

function tripletStr(t: CoverageTriplet): string {
  if (t.percentage === null) return '';
  const covered = t.covered ?? '?';
  const total = t.total ?? '?';
  return `${covered}/${total}`;
}

/** HTML 文本转义，防止模块名/描述中的特殊字符破坏结构。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 格式化时间戳为可读日期字符串。 */
function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

// ─── 内联 CSS ────────────────────────────────────────────────────

/**
 * 导出 HTML 用的内联样式。采用干净的浅色主题，便于浏览器直接打开与打印。
 * 颜色编码与 UI 一致：pass 绿 / warn 黄 / fail 红 / na 灰。
 */
const REPORT_CSS = `
:root {
  --bg: #f8fafc;
  --surface: #ffffff;
  --surface-2: #f1f5f9;
  --border: #e2e8f0;
  --border-strong: #cbd5e1;
  --fg: #0f172a;
  --fg-dim: #475569;
  --fg-faint: #94a3b8;
  --c-pass: #10b981;
  --c-warn: #eab308;
  --c-fail: #ef4444;
  --c-na: #9ca3af;
  --c-accent: #3b82f6;
  --shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
  --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --mono: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); font-family: var(--sans); padding: 28px 32px; font-size: 13px; line-height: 1.5; }
.header { margin-bottom: 22px; }
.header h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; margin-bottom: 4px; }
.header .meta { font-size: 11px; color: var(--fg-dim); font-family: var(--mono); }
.header .meta span { margin-right: 14px; }
.section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--fg-faint); margin: 22px 0 12px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); }

/* 概览卡片 */
.ov-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.ov-card { padding: 14px 16px; }
.ov-card .ov-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.ov-card .ov-label { font-size: 11px; font-weight: 600; color: var(--fg-dim); }
.ov-card .ov-badge { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
.ov-card .ov-badge.pass { color: var(--c-pass); background: rgba(16, 185, 129, 0.12); }
.ov-card .ov-badge.warn { color: var(--c-warn); background: rgba(234, 179, 8, 0.12); }
.ov-card .ov-badge.fail { color: var(--c-fail); background: rgba(239, 68, 68, 0.12); }
.ov-card .ov-badge.na { color: var(--c-na); background: var(--surface-2); }
.ov-card .ov-value { font-family: var(--mono); font-size: 22px; font-weight: 700; line-height: 1.1; }
.ov-card .ov-value.pass { color: var(--c-pass); }
.ov-card .ov-value.warn { color: var(--c-warn); }
.ov-card .ov-value.fail { color: var(--c-fail); }
.ov-card .ov-value.na { color: var(--c-na); }
.ov-card .ov-count { font-size: 10px; color: var(--fg-faint); font-family: var(--mono); margin-top: 3px; }
.ov-card .ov-bar { margin-top: 8px; height: 4px; border-radius: 2px; background: var(--surface-2); overflow: hidden; }
.ov-card .ov-bar-fill { height: 100%; border-radius: 2px; }
.ov-card .ov-bar-fill.pass { background: var(--c-pass); }
.ov-card .ov-bar-fill.warn { background: var(--c-warn); }
.ov-card .ov-bar-fill.fail { background: var(--c-fail); }
.ov-card .ov-bar-fill.na { background: var(--c-na); }
.ov-card .ov-target { font-size: 9px; color: var(--fg-faint); margin-top: 5px; }
.ov-overall { grid-column: 1 / -1; padding: 14px 18px; background: var(--surface-2); display: flex; align-items: center; justify-content: space-between; }
.ov-overall .ov-label { font-size: 12px; }
.ov-overall .ov-value { font-size: 24px; color: var(--fg); }

/* 树表格 */
.tree-card { padding: 0; overflow: hidden; }
.tree-toolbar { padding: 10px 14px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; }
.tree-toolbar .btn { background: var(--surface-2); border: 1px solid var(--border); color: var(--fg-dim); font-size: 11px; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-family: var(--sans); }
.tree-toolbar .btn:hover { color: var(--fg); border-color: var(--border-strong); }
.tree-table { width: 100%; border-collapse: collapse; }
.tree-table thead th { background: var(--surface-2); color: var(--fg-faint); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; padding: 8px; text-align: right; border-bottom: 1px solid var(--border); position: sticky; top: 0; }
.tree-table thead th:first-child { text-align: left; padding-left: 14px; }
.tree-table tbody td { padding: 5px 8px; text-align: right; border-bottom: 1px solid var(--border); font-family: var(--mono); font-size: 11px; color: var(--fg-dim); }
.tree-table tbody td:first-child { text-align: left; padding-left: 14px; font-family: var(--sans); color: var(--fg); font-size: 12px; }
.tree-toggle { display: inline-flex; align-items: center; cursor: pointer; user-select: none; }
.chev { width: 11px; height: 11px; margin-right: 4px; transition: transform 0.15s; color: var(--fg-faint); flex-shrink: 0; display: inline-block; }
.chev.open { transform: rotate(90deg); }
.chev.empty { visibility: hidden; }
.cov-cell { display: inline-flex; flex-direction: column; align-items: flex-end; line-height: 1.25; }
.cov-cell .pct { font-weight: 600; }
.cov-cell .cnt { font-size: 9px; color: var(--fg-faint); }
.cov-cell.pass .pct { color: var(--c-pass); }
.cov-cell.warn .pct { color: var(--c-warn); }
.cov-cell.fail .pct { color: var(--c-fail); }
.cov-cell.na .pct { color: var(--c-na); }
.cov-cell.na .cnt { display: none; }

/* 未覆盖项 */
.uncov-card { padding: 16px; }
.uncov-list { display: flex; flex-direction: column; gap: 5px; max-height: 320px; overflow-y: auto; }
.uc-item { display: flex; align-items: center; gap: 10px; padding: 7px 11px; border-radius: 7px; background: var(--surface-2); font-size: 11px; }
.uc-item .uc-mod { color: var(--c-accent); font-family: var(--mono); min-width: 160px; font-weight: 500; }
.uc-item .uc-file { color: var(--fg-dim); font-family: var(--mono); }
.uc-item .uc-desc { color: var(--fg-dim); margin-left: auto; }
.uc-item .uc-tag { font-size: 9px; font-weight: 700; padding: 2px 7px; border-radius: 10px; background: rgba(239, 68, 68, 0.12); color: var(--c-fail); text-transform: uppercase; letter-spacing: 0.04em; }
.uc-empty { text-align: center; padding: 18px; color: var(--fg-faint); font-size: 11px; }

/* Delta 对比表 */
.delta-table { width: 100%; border-collapse: collapse; }
.delta-table th, .delta-table td { padding: 8px 12px; text-align: right; border-bottom: 1px solid var(--border); font-family: var(--mono); font-size: 12px; }
.delta-table th { background: var(--surface-2); color: var(--fg-faint); font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
.delta-table th:first-child, .delta-table td:first-child { text-align: left; font-family: var(--sans); }
.delta-table .delta-up { color: var(--c-pass); font-weight: 600; }
.delta-table .delta-down { color: var(--c-fail); font-weight: 600; }
.delta-table .delta-zero { color: var(--fg-faint); }

.legend { display: flex; gap: 16px; margin-top: 10px; font-size: 10px; color: var(--fg-faint); }
.legend span { display: flex; align-items: center; gap: 5px; }
.legend i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.legend .dot-pass { background: var(--c-pass); }
.legend .dot-warn { background: var(--c-warn); }
.legend .dot-fail { background: var(--c-fail); }
.legend .dot-na { background: var(--c-na); }

.footer { margin-top: 28px; padding-top: 14px; border-top: 1px solid var(--border); font-size: 10px; color: var(--fg-faint); text-align: center; }
`.trim();

// ─── 片段渲染 ────────────────────────────────────────────────────

/** 渲染单个节点的树表格行（含后代）。返回 HTML 字符串。 */
function renderTreeRows(
  node: CoverageNode,
  ancestors: string,
  targets: Partial<Record<CoverageMetric, number>>,
): string {
  const ancestorAttr = ancestors ? ` data-ancestors="${escapeHtml(ancestors)}"` : ' data-ancestors=""';
  const hasChildren = node.children.length > 0;
  const indent = node.depth * 18;
  const chevHtml = hasChildren
    ? `<span class="chev open" data-chev="${escapeHtml(node.path)}"></span>`
    : `<span class="chev empty"></span>`;
  const nameHtml = hasChildren
    ? `<span class="tree-toggle" data-path="${escapeHtml(node.path)}" onclick="toggle('${escapeHtml(node.path)}')">${chevHtml}${escapeHtml(node.name)}</span>`
    : `${chevHtml}${escapeHtml(node.name)}`;

  const cells = COVERAGE_METRICS.map((m) => {
    const t = node.metrics[m];
    const status = classify(m, t.percentage, targets[m]);
    const cnt = tripletStr(t);
    return `<td><span class="cov-cell ${status}"><span class="pct">${pctStr(t.percentage)}</span>${cnt ? `<span class="cnt">${escapeHtml(cnt)}</span>` : ''}</span></td>`;
  }).join('');

  const row = `<tr data-path="${escapeHtml(node.path)}" data-depth="${node.depth}"${ancestorAttr}>` +
    `<td><span style="display:inline-block;width:${indent}px"></span>${nameHtml}</td>${cells}</tr>`;

  // 子节点 ancestors = 当前 ancestors + 当前 path
  const childAncestors = ancestors ? `${ancestors} ${node.path}` : node.path;
  const childRows = node.children
    .map((c) => renderTreeRows(c, childAncestors, targets))
    .join('');
  return `${row}${childRows}`;
}

/** 渲染概览卡片网格（8 metric + overall）。 */
function renderOverviewCards(
  root: CoverageNode,
  targets: Partial<Record<CoverageMetric, number>>,
  overview: ReturnType<typeof summarizeCoverage> | null,
): string {
  const cards = COVERAGE_METRICS.map((m) => {
    const t = root.metrics[m];
    const status = classify(m, t.percentage, targets[m]);
    const target = targets[m];
    const targetLine = target !== undefined
      ? `目标 ${target}%`
      : '无目标';
    const cnt = tripletStr(t);
    return `<div class="ov-card">
      <div class="ov-top">
        <span class="ov-label">${METRIC_LABELS[m]}</span>
        <span class="ov-badge ${status}">${status}</span>
      </div>
      <div class="ov-value ${status}">${pctStr(t.percentage)}</div>
      <div class="ov-count">${cnt || '—'}</div>
      <div class="ov-bar"><div class="ov-bar-fill ${status}" style="width:${t.percentage ?? 0}%"></div></div>
      <div class="ov-target">${targetLine}</div>
    </div>`;
  }).join('');

  const overall = overview
    ? `<div class="ov-overall"><span class="ov-label">总体覆盖率（8 项均值）</span><span class="ov-value">${overview.overall.toFixed(1)}%</span></div>`
    : '';

  return `<div class="ov-grid">${cards}${overall}</div>`;
}

/** 渲染未覆盖项列表（所有 metric 合并展示）。 */
function renderUncoveredList(data: CoverageData): string {
  const uncovered = data.uncovered;
  if (!uncovered) {
    return `<div class="uncov-card"><div class="uc-empty">暂无未覆盖项数据</div></div>`;
  }
  const items: Array<{ metric: CoverageMetric; item: UncoveredItem }> = [];
  for (const m of COVERAGE_METRICS) {
    const list = uncovered[m];
    if (list) for (const item of list) items.push({ metric: m, item });
  }
  if (items.length === 0) {
    return `<div class="uncov-card"><div class="uc-empty">全部覆盖</div></div>`;
  }
  const rows = items.map(({ metric, item }) => {
    const fileHtml = item.file
      ? `<span class="uc-file">${escapeHtml(item.file)}${item.line !== undefined ? `:${item.line}` : ''}</span>`
      : '';
    const signalHtml = item.signal ? `<span class="uc-file">${escapeHtml(item.signal)}</span>` : '';
    return `<div class="uc-item">
      <span class="uc-mod">${escapeHtml(item.module)}</span>
      ${fileHtml}${signalHtml}
      <span class="uc-desc">${escapeHtml(item.description)} · ${METRIC_LABELS[metric]}</span>
      <span class="uc-tag">GAP</span>
    </div>`;
  }).join('');
  return `<div class="uncov-card"><div class="uncov-list">${rows}</div></div>`;
}

/** 渲染 Gap 列表（用于 JSON 之外的可读 HTML，可选）。 */
function renderGapList(gaps: CoverageGap[]): string {
  if (gaps.length === 0) return '';
  const rows = gaps.map((g) => {
    return `<div class="uc-item">
      <span class="uc-mod">${escapeHtml(g.nodeName)}</span>
      <span class="uc-file">${METRIC_LABELS[g.metric]}</span>
      <span class="uc-desc">实际 ${g.actual.toFixed(1)}% / 目标 ${g.target}%</span>
      <span class="uc-tag">−${g.deficit.toFixed(1)}</span>
    </div>`;
  }).join('');
  return `<div class="section-title">覆盖率缺口（${gaps.length}）</div><div class="uncov-card"><div class="uncov-list">${rows}</div></div>`;
}

/** 展开/折叠所有行用的内联脚本。 */
const TOGGLE_SCRIPT = `
function toggle(path) {
  var row = document.querySelector('tr[data-path="' + path + '"]');
  if (!row) return;
  var collapsed = row.getAttribute('data-collapsed') === '1';
  row.setAttribute('data-collapsed', collapsed ? '0' : '1');
  // 切换 chevron 方向
  var chev = row.querySelector('.chev');
  if (chev) chev.classList.toggle('open', collapsed);
  // 隐藏/显示所有后代（ancestors 包含 path 的行）
  var allRows = document.querySelectorAll('tbody tr[data-ancestors]');
  allRows.forEach(function(r) {
    var anc = (r.getAttribute('data-ancestors') || '').split(' ').filter(Boolean);
    if (anc.indexOf(path) === -1) return;
    // 检查从 path 到该行的链路上是否有任意祖先折叠
    var hidden = false;
    for (var i = 0; i < anc.length; i++) {
      var aRow = document.querySelector('tr[data-path="' + anc[i] + '"]');
      if (aRow && aRow.getAttribute('data-collapsed') === '1') { hidden = true; break; }
      if (anc[i] === path) break;
    }
    r.style.display = hidden ? 'none' : '';
  });
}
function expandAll() {
  document.querySelectorAll('tbody tr[data-collapsed="1"]').forEach(function(r) {
    r.setAttribute('data-collapsed', '0');
    var chev = r.querySelector('.chev'); if (chev) chev.classList.add('open');
  });
  document.querySelectorAll('tbody tr').forEach(function(r) { r.style.display = ''; });
}
function collapseAll() {
  document.querySelectorAll('tbody tr[data-depth]').forEach(function(r) {
    var d = parseInt(r.getAttribute('data-depth'), 10);
    if (d > 0) r.style.display = 'none';
  });
  document.querySelectorAll('tbody tr[data-collapsed="0"]').forEach(function(r) {
    var d = parseInt(r.getAttribute('data-depth'), 10);
    if (d === 0) {
      r.setAttribute('data-collapsed', '1');
      var chev = r.querySelector('.chev'); if (chev) chev.classList.remove('open');
    }
  });
}
`.trim();

// ─── 公共 API ────────────────────────────────────────────────────

export type HtmlReportOptions = {
  title?: string;
};

/**
 * 生成独立 HTML 覆盖率报告。
 *
 * 所有 CSS 内联在 `<style>` 标签中，浏览器可直接打开，不依赖外部资源。
 * 布局：概览卡片（8 metric + overall）+ 树表格（可展开折叠，纯 JS）+ 未覆盖项 + Gap 列表。
 */
export function generateHtmlReport(
  data: CoverageData,
  opts?: HtmlReportOptions,
): string {
  const title = opts?.title ?? `覆盖率报告 · ${data.sessionId}`;
  const effectiveTargets: Partial<Record<CoverageMetric, number>> = {
    ...DEFAULT_COVERAGE_TARGETS,
    ...data.targets,
  };
  const summary = summarizeCoverage(data.root);
  const gaps = detectGaps(data.root, effectiveTargets);

  const overviewCards = renderOverviewCards(data.root, effectiveTargets, summary);
  const treeRows = renderTreeRows(data.root, '', effectiveTargets);
  const uncovered = renderUncoveredList(data);
  const gapList = renderGapList(gaps);

  const generatedAt = formatDate(data.source.reportGeneratedAt);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="header">
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">
    <span>Session: ${escapeHtml(data.sessionId)}</span>
    <span>EDA Tool: ${escapeHtml(data.source.edaTool)}</span>
    <span>cov_merge: ${escapeHtml(data.source.covMergeDir)}</span>
    <span>报告生成时间: ${escapeHtml(generatedAt)}</span>
  </div>
</div>

<div class="section-title">概览</div>
<div class="card" style="padding:14px">${overviewCards}</div>

<div class="section-title">模块层级覆盖率</div>
<div class="card tree-card">
  <div class="tree-toolbar">
    <button class="btn" onclick="expandAll()">全部展开</button>
    <button class="btn" onclick="collapseAll()">全部折叠</button>
  </div>
  <table class="tree-table">
    <thead><tr>
      <th>模块</th>
      ${COVERAGE_METRICS.map((m) => `<th>${METRIC_LABELS[m]}</th>`).join('')}
    </tr></thead>
    <tbody>${treeRows}</tbody>
  </table>
</div>

<div class="section-title">未覆盖项</div>
${uncovered}

${gapList}

<div class="legend">
  <span><i class="dot-pass"></i>达标</span>
  <span><i class="dot-warn"></i>接近目标 (&lt;5%)</span>
  <span><i class="dot-fail"></i>未达标</span>
  <span><i class="dot-na"></i>N/A</span>
</div>

<div class="footer">由 SoC Verify 导出 · ${escapeHtml(formatDate(Date.now()))}</div>

<script>${TOGGLE_SCRIPT}</script>
</body>
</html>`;
}

export type JsonExportExtras = {
  gaps?: CoverageGap[];
  delta?: CoverageDelta[];
  targets?: Partial<Record<CoverageMetric, number>>;
};

/**
 * 生成完整 JSON 结构化导出。
 *
 * 包含：完整 Coverage Tree（root + 8 metric × Triplet）+ Target + Gap + Delta。
 * 使用 `JSON.stringify` 带 2 空格缩进，可直接写文件。
 */
export function generateJsonExport(
  data: CoverageData,
  extras?: JsonExportExtras,
): string {
  const effectiveTargets: Partial<Record<CoverageMetric, number>> = extras?.targets ?? {
    ...DEFAULT_COVERAGE_TARGETS,
    ...data.targets,
  };
  const gaps = extras?.gaps ?? detectGaps(data.root, effectiveTargets);

  const payload = {
    exportedAt: new Date().toISOString(),
    sessionId: data.sessionId,
    source: data.source,
    targets: effectiveTargets,
    sessionTargets: data.targets,
    root: data.root,
    uncovered: data.uncovered ?? null,
    metrics: data.metrics ?? null,
    gaps,
    delta: extras?.delta ?? [],
  };

  return JSON.stringify(payload, null, 2);
}

export type DeltaHtmlReportOptions = {
  title?: string;
};

/**
 * 生成两个 Session 之间的 Delta 对比 HTML 报告。
 *
 * 布局：头部 + Delta 对比表（8 metric + overall）+ Before/After 概览卡片。
 */
export function generateDeltaHtmlReport(
  before: CoverageData,
  after: CoverageData,
  delta: CoverageDelta[],
  opts?: DeltaHtmlReportOptions,
): string {
  const title = opts?.title ?? `覆盖率对比报告 · ${before.sessionId} → ${after.sessionId}`;
  const beforeSummary = summarizeCoverage(before.root);
  const afterSummary = summarizeCoverage(after.root);
  const beforeTargets: Partial<Record<CoverageMetric, number>> = {
    ...DEFAULT_COVERAGE_TARGETS,
    ...before.targets,
  };
  const afterTargets: Partial<Record<CoverageMetric, number>> = {
    ...DEFAULT_COVERAGE_TARGETS,
    ...after.targets,
  };

  // Delta 对比表
  const deltaRows = COVERAGE_METRICS.map((m) => {
    const d = delta.find((x) => x.metric === m);
    const beforeVal = d?.before ?? 0;
    const afterVal = d?.after ?? 0;
    const deltaVal = d?.delta ?? 0;
    const cls = deltaVal > 0 ? 'delta-up' : deltaVal < 0 ? 'delta-down' : 'delta-zero';
    const sign = deltaVal > 0 ? '+' : '';
    return `<tr>
      <td>${METRIC_LABELS[m]}</td>
      <td>${beforeVal.toFixed(1)}%</td>
      <td>${afterVal.toFixed(1)}%</td>
      <td class="${cls}">${sign}${deltaVal.toFixed(1)}</td>
    </tr>`;
  }).join('');
  // overall 行
  const overallDelta = afterSummary.overall - beforeSummary.overall;
  const overallCls = overallDelta > 0 ? 'delta-up' : overallDelta < 0 ? 'delta-down' : 'delta-zero';
  const overallSign = overallDelta > 0 ? '+' : '';
  const overallRow = `<tr>
    <td><strong>Overall</strong></td>
    <td><strong>${beforeSummary.overall.toFixed(1)}%</strong></td>
    <td><strong>${afterSummary.overall.toFixed(1)}%</strong></td>
    <td class="${overallCls}"><strong>${overallSign}${overallDelta.toFixed(1)}</strong></td>
  </tr>`;

  const beforeCards = renderOverviewCards(before.root, beforeTargets, beforeSummary);
  const afterCards = renderOverviewCards(after.root, afterTargets, afterSummary);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="header">
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">
    <span>Before: ${escapeHtml(before.sessionId)}</span>
    <span>After: ${escapeHtml(after.sessionId)}</span>
    <span>EDA Tool: ${escapeHtml(after.source.edaTool)}</span>
  </div>
</div>

<div class="section-title">逐 Metric 变化（delta = after − before）</div>
<div class="card" style="padding:0;overflow:hidden">
  <table class="delta-table">
    <thead><tr><th>Metric</th><th>Before</th><th>After</th><th>Delta</th></tr></thead>
    <tbody>${deltaRows}${overallRow}</tbody>
  </table>
</div>

<div class="section-title">Before 概览 · ${escapeHtml(before.sessionId)}</div>
<div class="card" style="padding:14px">${beforeCards}</div>

<div class="section-title">After 概览 · ${escapeHtml(after.sessionId)}</div>
<div class="card" style="padding:14px">${afterCards}</div>

<div class="legend">
  <span><i class="dot-pass"></i>达标</span>
  <span><i class="dot-warn"></i>接近目标 (&lt;5%)</span>
  <span><i class="dot-fail"></i>未达标</span>
  <span><i class="dot-na"></i>N/A</span>
</div>

<div class="footer">由 SoC Verify 导出 · ${escapeHtml(formatDate(Date.now()))}</div>
</body>
</html>`;
}

// ─── 范围选择逻辑（供 router / 测试复用） ─────────────────────────

export type ExportScope = 'current' | 'compare';

export type ExportFormat = 'html' | 'json';

/**
 * 校验导出参数的范围选择逻辑。
 * - scope='current'：sessionId 可缺省（router 层用最近 session）
 * - scope='compare'：sessionId 与 compareSessionId 均必填，且不能相同
 *
 * 返回归一化后的参数，或在非法时抛出 Error。
 */
export function resolveExportScope(input: {
  scope: ExportScope;
  sessionId?: string;
  compareSessionId?: string;
}): {
  scope: ExportScope;
  sessionId?: string;
  compareSessionId?: string;
} {
  if (input.scope === 'compare') {
    if (!input.sessionId || !input.compareSessionId) {
      throw new Error('scope=compare 时 sessionId 与 compareSessionId 均为必填');
    }
    if (input.sessionId === input.compareSessionId) {
      throw new Error('scope=compare 时 sessionId 与 compareSessionId 不能相同');
    }
    return {
      scope: 'compare',
      sessionId: input.sessionId,
      compareSessionId: input.compareSessionId,
    };
  }
  return {
    scope: 'current',
    sessionId: input.sessionId || undefined,
    compareSessionId: undefined,
  };
}

// ─── 对比 JSON 导出（包含两个 session） ──────────────────────────

/**
 * 生成对比范围的 JSON 导出，包含 before / after 两个 session 的完整数据 + delta。
 */
export function generateCompareJsonExport(
  before: CoverageData,
  after: CoverageData,
  delta: CoverageDelta[],
): string {
  const beforeTargets: Partial<Record<CoverageMetric, number>> = {
    ...DEFAULT_COVERAGE_TARGETS,
    ...before.targets,
  };
  const afterTargets: Partial<Record<CoverageMetric, number>> = {
    ...DEFAULT_COVERAGE_TARGETS,
    ...after.targets,
  };
  const payload = {
    exportedAt: new Date().toISOString(),
    scope: 'compare' as const,
    before: {
      sessionId: before.sessionId,
      source: before.source,
      targets: beforeTargets,
      root: before.root,
      uncovered: before.uncovered ?? null,
      gaps: detectGaps(before.root, beforeTargets),
    },
    after: {
      sessionId: after.sessionId,
      source: after.source,
      targets: afterTargets,
      root: after.root,
      uncovered: after.uncovered ?? null,
      gaps: detectGaps(after.root, afterTargets),
    },
    delta,
  };
  return JSON.stringify(payload, null, 2);
}
