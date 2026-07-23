'use strict';

/*
 * Built-in Coverage Parser Plugin
 *
 * 解析 EDA 工具生成的文本报告（IMC / VCS urg / vcover），
 * 同时支持从 cov_merge 目录直接扫描覆盖率数据文件。
 *
 * 解析策略（按优先级）：
 *   1. 读取 reportDir/meta.json 获取 covMergeDir 和 edaTool
 *   2. 尝试读取并解析 reportDir 下的文本报告（summary.txt / detail.txt / metrics.txt）
 *   3. 如果文本报告为空或不存在，尝试直接从 covMergeDir 扫描覆盖率数据文件
 *   4. 如果都失败，返回一个包含基本结构的占位 CoverageData
 *
 * 支持的报告格式：
 *   - IMC summary report: 包含 "Coverage Summary" 和各 metric 百分比
 *   - VCS urg report: 包含 hierarchy 和 coverage 数据
 *   - vcover report: 包含 summary 和 detail 数据
 *   - JSON 覆盖率数据文件: 直接解析为 CoverageData
 */

const { readFileSync, readdirSync, existsSync, statSync } = require('node:fs');
const { join, basename, dirname } = require('node:path');

const MANIFEST = {
  id: 'builtin-coverage-parser',
  name: 'Built-in Coverage Parser',
  version: '1.0.0',
  kind: 'coverage-parser',
  description:
    '内置覆盖率解析插件：解析 IMC / VCS urg / vcover 文本报告，支持从 cov_merge 目录直接读取覆盖率数据。',
};

// ─── CoverageData 结构辅助 ────────────────────────────────────

const COVERAGE_METRICS = [
  'line', 'branch', 'toggle', 'condition',
  'fsm_state', 'fsm_transition', 'functional', 'assertion',
];

function naTriplet() {
  return { percentage: null, covered: null, total: null };
}

function emptyMetrics() {
  const m = {};
  for (const metric of COVERAGE_METRICS) {
    m[metric] = naTriplet();
  }
  return m;
}

function makeTriplet(covered, total) {
  if (total === 0 || (covered === null && total === null)) {
    return { percentage: 100, covered: covered || 0, total: total || 0 };
  }
  return {
    covered: covered,
    total: total,
    percentage: total > 0 ? (covered / total) * 100 : 0,
  };
}

function makeNode(name, path, depth, metrics, children) {
  return {
    name: name,
    path: path,
    depth: depth,
    metrics: metrics || emptyMetrics(),
    children: children || [],
  };
}

// ─── meta.json 读取 ──────────────────────────────────────────

function readMeta(reportDir) {
  const metaPath = join(reportDir, 'meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch {
    return null;
  }
}

// ─── 文本报告解析 ─────────────────────────────────────────────

/**
 * 从文本中提取覆盖率百分比。
 * 支持多种格式：
 *   "Lines:        95.3%"
 *   "line coverage: 95.3%"
 *   "Lines         95.30 %"
 */
function parsePercentage(text, metric) {
  if (!text) return null;
  var patterns = [
    new RegExp(metric + '\\s*(?:coverage)?\\s*[:\\s]+([\\d.]+)\\s*%', 'i'),
    new RegExp([metric] + '\\s+([\\d.]+)\\s*%', 'i'),
  ];
  for (var i = 0; i < patterns.length; i++) {
    var match = text.match(patterns[i]);
    if (match) {
      var val = parseFloat(match[1]);
      if (!isNaN(val)) return val;
    }
  }
  return null;
}

/**
 * 解析 IMC summary 报告。
 * IMC 报告通常包含类似以下格式的行：
 *   Coverage Summary:
 *   ------------------
 *   Line:       95.30%
 *   Branch:     87.20%
 *   ...
 */
function parseImcSummary(text) {
  if (!text) return null;
  var metrics = emptyMetrics();

  // IMC summary 格式: "Line: 95.30%" 或 "Lines: 95.30%"
  var lineMatch = parsePercentage(text, 'lines?') || parsePercentage(text, 'line');
  var branchMatch = parsePercentage(text, 'branch');
  var toggleMatch = parsePercentage(text, 'toggle');
  var condMatch = parsePercentage(text, 'condition') || parsePercentage(text, 'cond');
  var fsmStateMatch = parsePercentage(text, 'fsm\\s*state') || parsePercentage(text, 'fsm');
  var fsmTransMatch = parsePercentage(text, 'fsm\\s*trans');
  var funcMatch = parsePercentage(text, 'functional') || parsePercentage(text, 'function');
  var assertMatch = parsePercentage(text, 'assertion') || parsePercentage(text, 'assert');

  if (lineMatch !== null) metrics.line = { percentage: lineMatch, covered: null, total: null };
  if (branchMatch !== null) metrics.branch = { percentage: branchMatch, covered: null, total: null };
  if (toggleMatch !== null) metrics.toggle = { percentage: toggleMatch, covered: null, total: null };
  if (condMatch !== null) metrics.condition = { percentage: condMatch, covered: null, total: null };
  if (fsmStateMatch !== null) metrics.fsm_state = { percentage: fsmStateMatch, covered: null, total: null };
  if (fsmTransMatch !== null) metrics.fsm_transition = { percentage: fsmTransMatch, covered: null, total: null };
  if (funcMatch !== null) metrics.functional = { percentage: funcMatch, covered: null, total: null };
  if (assertMatch !== null) metrics.assertion = { percentage: assertMatch, covered: null, total: null };

  return metrics;
}

/**
 * 解析 IMC detail 报告中的模块层级信息。
 * 提取模块名和各 metric 覆盖率。
 */
function parseImcDetail(text) {
  if (!text) return [];
  var nodes = [];
  var lines = text.split('\n');
  var modulePattern = /^\s*(\S+)\s+/;
  var inModuleSection = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    // 检测模块段开始
    if (/module\s+hierarchy/i.test(line) || /instance\s+tree/i.test(line)) {
      inModuleSection = true;
      continue;
    }
    if (inModuleSection && /^\s*-/.test(line)) continue;
    if (inModuleSection && /^\s*$/.test(line)) {
      inModuleSection = false;
      continue;
    }

    if (inModuleSection) {
      var match = line.match(modulePattern);
      if (match && match[1] && !/^(line|branch|toggle|condition|fsm|functional|assert|coverage|summary|total)/i.test(match[1])) {
        var moduleName = match[1];
        var percentages = [];

        // 提取行中所有百分比
        var pctMatches = line.matchAll(/([\d.]+)%/g);
        var pctIdx = 0;
        var pctIter = pctMatches.next();
        while (!pctIter.done) {
          percentages.push(parseFloat(pctIter.value[1]));
          pctIter = pctMatches.next();
        }

        if (percentages.length > 0) {
          var metrics = emptyMetrics();
          var metricOrder = ['line', 'branch', 'toggle', 'condition', 'fsm_state', 'fsm_transition', 'functional', 'assertion'];
          for (var j = 0; j < percentages.length && j < metricOrder.length; j++) {
            metrics[metricOrder[j]] = { percentage: percentages[j], covered: null, total: null };
          }
          nodes.push({ name: moduleName, metrics: metrics });
        }
      }
    }
  }
  return nodes;
}

/**
 * 解析 VCS urg 报告。
 * urg 报告通常包含 hierarchy 和 coverage 数据。
 */
function parseUrgReport(text) {
  if (!text) return { summary: null, modules: [] };
  var metrics = emptyMetrics();
  var modules = [];
  var lines = text.split('\n');

  // 查找 summary 部分
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // urg summary 格式: "Line: 95.3%" 或 "toggle coverage: 87.2%"
    var linePct = parsePercentage(line, 'lines?') || parsePercentage(line, 'line');
    var branchPct = parsePercentage(line, 'branch');
    var togglePct = parsePercentage(line, 'toggle');
    var condPct = parsePercentage(line, 'condition') || parsePercentage(line, 'cond');

    if (linePct !== null) metrics.line = { percentage: linePct, covered: null, total: null };
    if (branchPct !== null) metrics.branch = { percentage: branchPct, covered: null, total: null };
    if (togglePct !== null) metrics.toggle = { percentage: togglePct, covered: null, total: null };
    if (condPct !== null) metrics.condition = { percentage: condPct, covered: null, total: null };
  }

  return { summary: metrics, modules: modules };
}

/**
 * 尝试从 JSON 文件解析 CoverageData。
 */
function tryParseJsonCoverage(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    var content = readFileSync(filePath, 'utf-8');
    var data = JSON.parse(content);
    // 检查是否有 root 字段（CoverageData 结构）
    if (data && data.root && data.root.name) {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 扫描 cov_merge 目录，寻找可解析的覆盖率数据文件。
 */
function scanCovMergeDir(covMergeDir) {
  if (!covMergeDir || !existsSync(covMergeDir)) return null;

  try {
    var entries = readdirSync(covMergeDir, { withFileTypes: true });

    // 1. 查找 JSON 格式的覆盖率数据文件
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (entry.isFile() && entry.name.endsWith('.json')) {
        var data = tryParseJsonCoverage(join(covMergeDir, entry.name));
        if (data) return data;
      }
    }

    // 2. 查找文本报告文件
    var textReports = [];
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j];
      if (e.isFile() && /\.(txt|report|rpt)$/i.test(e.name)) {
        try {
          var content = readFileSync(join(covMergeDir, e.name), 'utf-8');
          textReports.push(content);
        } catch {
          // skip
        }
      }
    }

    // 3. 递归扫描子目录（最多 2 层）
    for (var k = 0; k < entries.length; k++) {
      var sub = entries[k];
      if (sub.isDirectory()) {
        var subPath = join(covMergeDir, sub.name);
        try {
          var subEntries = readdirSync(subPath, { withFileTypes: true });
          for (var m = 0; m < subEntries.length; m++) {
            var se = subEntries[m];
            if (se.isFile() && se.name.endsWith('.json')) {
              var data2 = tryParseJsonCoverage(join(subPath, se.name));
              if (data2) return data2;
            }
            if (se.isFile() && /\.(txt|report|rpt)$/i.test(se.name)) {
              try {
                var content2 = readFileSync(join(subPath, se.name), 'utf-8');
                textReports.push(content2);
              } catch {
                // skip
              }
            }
          }
        } catch {
          // skip
        }
      }
    }

    // 4. 从文本报告中解析
    if (textReports.length > 0) {
      var combinedText = textReports.join('\n\n');
      var metrics = parseImcSummary(combinedText) || parseUrgReport(combinedText).summary;
      if (metrics) {
        var hasAny = false;
        for (var key in metrics) {
          if (metrics[key] && metrics[key].percentage !== null) {
            hasAny = true;
            break;
          }
        }
        if (hasAny) {
          var root = makeNode('top', 'top', 0, metrics, []);
          return {
            sessionId: '',
            source: { covMergeDir: covMergeDir, edaTool: 'unknown', reportGeneratedAt: 0 },
            root: root,
            targets: {},
          };
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ─── 主解析入口 ───────────────────────────────────────────────

async function parse(projectRoot, sessionId, reportDir) {
  // 1. 读取 meta.json（CoverageManager 在导入前写入）
  var meta = readMeta(reportDir);
  var covMergeDir = meta ? meta.covMergeDir : '';
  var edaTool = meta ? meta.edaTool : 'unknown';

  // 2. 尝试读取文本报告
  var summaryText = '';
  var detailText = '';
  var metricsText = '';

  var summaryPath = join(reportDir, 'summary.txt');
  var detailPath = join(reportDir, 'detail.txt');
  var metricsPath = join(reportDir, 'metrics.txt');

  if (existsSync(summaryPath)) {
    try { summaryText = readFileSync(summaryPath, 'utf-8'); } catch { /* skip */ }
  }
  if (existsSync(detailPath)) {
    try { detailText = readFileSync(detailPath, 'utf-8'); } catch { /* skip */ }
  }
  if (existsSync(metricsPath)) {
    try { metricsText = readFileSync(metricsPath, 'utf-8'); } catch { /* skip */ }
  }

  // 3. 解析文本报告
  var summaryMetrics = null;
  var moduleNodes = [];

  if (summaryText) {
    if (edaTool === 'imc') {
      summaryMetrics = parseImcSummary(summaryText);
    } else if (edaTool === 'vcs-urg') {
      var urgResult = parseUrgReport(summaryText);
      summaryMetrics = urgResult.summary;
    } else {
      // 尝试所有格式
      summaryMetrics = parseImcSummary(summaryText) || parseUrgReport(summaryText).summary;
    }
  }

  if (detailText) {
    moduleNodes = parseImcDetail(detailText);
  }

  // 4. 如果文本报告解析失败，尝试从 cov_merge 目录直接扫描
  if (!summaryMetrics && covMergeDir) {
    var covData = scanCovMergeDir(covMergeDir);
    if (covData) {
      // 如果找到完整的 CoverageData，直接使用
      covData.sessionId = sessionId;
      covData.source.edaTool = edaTool;
      covData.source.reportGeneratedAt = Date.now();
      return covData;
    }
  }

  // 5. 构建 CoverageData
  var rootMetrics = summaryMetrics || emptyMetrics();

  // 如果有模块节点，构建层级树
  var children = [];
  if (moduleNodes.length > 0) {
    for (var i = 0; i < moduleNodes.length; i++) {
      var node = moduleNodes[i];
      children.push(makeNode(node.name, 'top/' + node.name, 1, node.metrics, []));
    }
  }

  var root = makeNode('top', 'top', 0, rootMetrics, children);

  return {
    sessionId: sessionId,
    source: {
      covMergeDir: covMergeDir || '',
      edaTool: edaTool,
      reportGeneratedAt: Date.now(),
    },
    root: root,
    targets: {},
  };
}

module.exports = {
  manifest: MANIFEST,
  parse: parse,
};
