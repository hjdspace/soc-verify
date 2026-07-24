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
 *   3. 如果文本报告为空或不存在，尝试直接从 cov_merge 目录扫描覆盖率数据文件
 *   4. 如果都失败，返回一个包含基本结构的占位 CoverageData
 *
 * 支持的报告格式：
 *   - IMC summary report: 表格格式，含 Metric / Covered/Total / Coverage%
 *   - IMC detail report: 层级缩进格式，含 Instance / 各 metric 百分比
 *   - VCS urg report: 包含 hierarchy 和 coverage 数据
 *   - vcover report: 包含 summary 和 detail 数据
 *   - JSON 覆盖率数据文件: 直接解析为 CoverageData
 *
 * Debug 日志：解析过程会写入 reportDir/parser-debug.log，记录每一步的解析结果。
 */

const { readFileSync, readdirSync, existsSync, statSync, writeFileSync, appendFileSync } = require('node:fs');
const { join, basename, dirname } = require('node:path');

const MANIFEST = {
  id: 'builtin-coverage-parser',
  name: 'Built-in Coverage Parser',
  version: '1.1.0',
  kind: 'coverage-parser',
  description:
    '内置覆盖率解析插件：解析 IMC / VCS urg / vcover 文本报告，支持从 cov_merge 目录直接读取覆盖率数据。',
};

// ─── CoverageData 结构辅助 ────────────────────────────────────

const COVERAGE_METRICS = [
  'line', 'branch', 'toggle', 'condition',
  'fsm_state', 'fsm_transition', 'functional', 'assertion',
];

// IMC 报告中 metric 名称到内部 metric key 的映射
const METRIC_NAME_MAP = {
  'line': 'line', 'lines': 'line',
  'branch': 'branch', 'branches': 'branch',
  'toggle': 'toggle', 'toggles': 'toggle',
  'condition': 'condition', 'conditions': 'condition', 'cond': 'condition',
  'fsm state': 'fsm_state', 'fsm states': 'fsm_state', 'fsm-state': 'fsm_state', 'fsm': 'fsm_state',
  'fsm transition': 'fsm_transition', 'fsm transitions': 'fsm_transition', 'fsm-trans': 'fsm_transition',
  'functional': 'functional', 'function': 'functional', 'covergroup': 'functional',
  'assertion': 'assertion', 'assert': 'assertion', 'asserts': 'assertion',
  'statement': 'line', 'statements': 'line', // IMC 有时用 statement 代替 line
};

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

// ─── Debug 日志 ──────────────────────────────────────────────

function createDebugLogger(reportDir) {
  var logPath = join(reportDir, 'parser-debug.log');
  try {
    writeFileSync(logPath, `=== Coverage Parser Debug Log ===\nTimestamp: ${new Date().toISOString()}\n\n`, 'utf-8');
  } catch {
    // 如果写不了日志文件，不阻塞解析
  }
  return function log(msg) {
    try {
      appendFileSync(logPath, msg + '\n', 'utf-8');
    } catch {
      // ignore
    }
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
 * 从一行文本中提取 covered/total 计数对。
 * 支持格式: "9530/10000", "9530 / 10000"
 */
function parseCoveredTotal(text) {
  if (!text) return null;
  var match = text.match(/(\d+)\s*\/\s*(\d+)/);
  if (match) {
    return { covered: parseInt(match[1], 10), total: parseInt(match[2], 10) };
  }
  return null;
}

/**
 * 从一行文本中提取百分比。
 * 支持格式: "95.30%", "95.30 %", "95.30"
 */
function parsePercent(text) {
  if (!text) return null;
  var match = text.match(/([\d.]+)\s*%/);
  if (match) {
    var val = parseFloat(match[1]);
    if (!isNaN(val)) return val;
  }
  // 没有百分号的纯数字（在表格列中）
  match = text.match(/^\s*([\d.]+)\s*$/);
  if (match) {
    var val2 = parseFloat(match[1]);
    if (!isNaN(val2) && val2 >= 0 && val2 <= 100) return val2;
  }
  return null;
}

/**
 * 将 metric 名称（可能含空格/大小写变体）映射到内部 metric key。
 */
function normalizeMetricName(name) {
  if (!name) return null;
  var lower = name.toLowerCase().trim();
  // 直接匹配
  if (METRIC_NAME_MAP[lower]) return METRIC_NAME_MAP[lower];
  // 模糊匹配：去掉空格后再查
  var noSpace = lower.replace(/\s+/g, ' ');
  if (METRIC_NAME_MAP[noSpace]) return METRIC_NAME_MAP[noSpace];
  var compact = lower.replace(/\s+/g, '');
  if (METRIC_NAME_MAP[compact]) return METRIC_NAME_MAP[compact];
  // 尝试前缀匹配
  for (var key in METRIC_NAME_MAP) {
    if (lower.startsWith(key) || key.startsWith(lower)) {
      return METRIC_NAME_MAP[key];
    }
  }
  return null;
}

/**
 * 解析 IMC summary 报告。
 *
 * 支持多种真实 IMC 报告格式：
 *
 * 格式 1（带分隔符的表格）:
 *   Metric         | Covered/Total | Coverage
 *   Line           | 9530/10000    | 95.30 %
 *
 * 格式 2（对齐列，无分隔符）:
 *   Lines                      9530/10000      95.30%
 *   Branches                   872/1000        87.20%
 *
 * 格式 3（简单键值对）:
 *   Line:       95.30%
 *   Branch:     87.20%
 *
 * 格式 4（带括号）:
 *   Line:     95.30%  (9530/10000)
 */
function parseImcSummary(text, log) {
  if (!text) return null;
  var metrics = emptyMetrics();
  var foundAny = false;

  var lines = text.split('\n');

  log('[parseImcSummary] Starting, total lines: ' + lines.length);
  log('[parseImcSummary] First 5 lines:');
  for (var i = 0; i < Math.min(5, lines.length); i++) {
    log('  ' + i + ': ' + JSON.stringify(lines[i]));
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();
    if (!trimmed) continue;
    // 跳过分隔线
    if (/^[-=+_#|~]+$/.test(trimmed)) continue;
    // 跳过纯标题行
    if (/^(coverage\s*summary|summary\s+of\s+coverage|coverage\s+report)$/i.test(trimmed)) continue;

    // 尝试解析该行中的 metric
    var metricKey = tryParseMetricFromLine(line, log);
    if (metricKey && metricKey.key) {
      metrics[metricKey.key] = metricKey.triplet;
      foundAny = true;
      log('[parseImcSummary] Parsed metric: ' + metricKey.key +
        ' = ' + JSON.stringify(metricKey.triplet) + ' from line: ' + JSON.stringify(trimmed));
    }
  }

  if (!foundAny) {
    log('[parseImcSummary] WARNING: No metrics found in summary report!');
  } else {
    log('[parseImcSummary] Found metrics: ' + Object.keys(metrics).filter(function(k) { return metrics[k].percentage !== null; }).join(', '));
  }

  return foundAny ? metrics : null;
}

/**
 * 从一行文本中尝试提取 metric 名称和覆盖率值。
 * 返回 { key: metricKey, triplet: {percentage, covered, total} } 或 null。
 */
function tryParseMetricFromLine(line, log) {
  // 策略1: "Metric: 95.30% (9530/10000)" 格式
  var match1 = line.match(/^\s*(.+?)\s*[:=]\s*([\d.]+)\s*%\s*(?:\(?(\d+)\s*\/\s*(\d+)\)?)?/i);
  if (match1) {
    var key1 = normalizeMetricName(match1[1]);
    if (key1) {
      var pct1 = parseFloat(match1[2]);
      var ct1 = (match1[3] && match1[4]) ? { covered: parseInt(match1[3], 10), total: parseInt(match1[4], 10) } : null;
      return {
        key: key1,
        triplet: {
          percentage: pct1,
          covered: ct1 ? ct1.covered : null,
          total: ct1 ? ct1.total : null,
        },
      };
    }
  }

  // 策略2: 表格行 "Metric | covered/total | percentage%"
  // 用 | 或多个空格分割列
  var parts = line.split(/\s*\|\s*|\s{2,}/);
  if (parts.length >= 2) {
    var metricPart = parts[0].trim();
    var key2 = normalizeMetricName(metricPart);
    if (key2) {
      // 在剩余部分中找百分比和 covered/total
      var pct2 = null;
      var ct2 = null;
      for (var j = 1; j < parts.length; j++) {
        if (pct2 === null) {
          pct2 = parsePercent(parts[j]);
        }
        if (ct2 === null) {
          ct2 = parseCoveredTotal(parts[j]);
        }
      }
      if (pct2 !== null || ct2 !== null) {
        // 如果有 covered/total 但没有百分比，计算百分比
        if (pct2 === null && ct2) {
          pct2 = ct2.total > 0 ? (ct2.covered / ct2.total) * 100 : 0;
        }
        return {
          key: key2,
          triplet: {
            percentage: pct2,
            covered: ct2 ? ct2.covered : null,
            total: ct2 ? ct2.total : null,
          },
        };
      }
    }
  }

  // 策略3: 单个数字行 "Lines    95.30%"
  // 匹配 metric名称 后跟百分比
  var match3 = line.match(/^\s*(\w[\w\s]*?)\s+([\d.]+)\s*%/i);
  if (match3) {
    var key3 = normalizeMetricName(match3[1]);
    if (key3) {
      var pct3 = parseFloat(match3[2]);
      return {
        key: key3,
        triplet: { percentage: pct3, covered: null, total: null },
      };
    }
  }

  // 策略4: "covered/total percentage%" 格式（无明确 metric 名）
  // 例如 "9530/10000   95.30%"
  // 这种情况靠上下文判断，暂不处理

  return null;
}

/**
 * 解析 IMC detail 报告中的模块层级信息。
 *
 * 真实 IMC detail 报告格式：
 *   Instance                    Line%     Branch%    Toggle%    Cond%
 *   tb_top                      95.30     87.20      78.50      80.00
 *     chip_top                  95.50     87.50      78.80      80.20
 *       dut                     95.00     87.00      78.00      79.80
 *
 * 层级通过行首缩进（空格数）表示。
 *
 * 返回 { nodes: [...], tree: rootNode } 结构。
 */
function parseImcDetail(text, log) {
  if (!text) return { nodes: [], tree: null };
  var lines = text.split('\n');
  var nodes = [];
  var tree = null;

  log('[parseImcDetail] Starting, total lines: ' + lines.length);
  log('[parseImcDetail] First 10 lines:');
  for (var i = 0; i < Math.min(10, lines.length); i++) {
    log('  ' + i + ': ' + JSON.stringify(lines[i]));
  }

  // 找到数据表的列头行
  var headerLineIdx = -1;
  var columnMetrics = []; // 列索引到 metric key 的映射

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var lower = line.toLowerCase();

    // 检测列头行：包含多个 metric 名称
    if (/instance|hierarchy|module/i.test(line) && /line|branch|toggle|cond|fsm|assert|function/i.test(line)) {
      headerLineIdx = i;
      // 解析列头：找出每列对应的 metric
      var colPositions = [];
      // 用正则找出所有 metric 关键词及其位置
      var metricPatterns = [
        { re: /line/gi, key: 'line' },
        { re: /branch/gi, key: 'branch' },
        { re: /toggle/gi, key: 'toggle' },
        { re: /cond(?:ition)?/gi, key: 'condition' },
        { re: /fsm\s*state/gi, key: 'fsm_state' },
        { re: /fsm\s*trans/gi, key: 'fsm_transition' },
        { re: /functional|function|covergroup/gi, key: 'functional' },
        { re: /assert(?:ion)?/gi, key: 'assertion' },
      ];

      for (var p = 0; p < metricPatterns.length; p++) {
        var re = new RegExp(metricPatterns[p].re);
        var m = re.exec(line);
        while (m) {
          colPositions.push({ start: m.index, key: metricPatterns[p].key });
          // 避免死循环
          if (!metricPatterns[p].re.global) break;
          m = re.exec(line);
        }
      }

      // 按位置排序
      colPositions.sort(function(a, b) { return a.start - b.start; });

      // 去重（同一个 metric 可能匹配多次）
      var seen = {};
      columnMetrics = [];
      for (var c = 0; c < colPositions.length; c++) {
        if (!seen[colPositions[c].key]) {
          seen[colPositions[c].key] = true;
          columnMetrics.push(colPositions[c]);
        }
      }

      log('[parseImcDetail] Found header at line ' + i + ': ' + JSON.stringify(line));
      log('[parseImcDetail] Column metrics: ' + columnMetrics.map(function(c) { return c.key + '@' + c.start; }).join(', '));
      break;
    }
  }

  // 如果没找到列头，尝试自动检测数据行
  if (headerLineIdx === -1) {
    log('[parseImcDetail] No header line found, trying auto-detect data lines...');
    // 自动检测：行首有缩进 + 实例名 + 数字
    columnMetrics = [
      { start: 0, key: 'line' },
      { start: 0, key: 'branch' },
      { start: 0, key: 'toggle' },
      { start: 0, key: 'condition' },
    ];
  }

  // 如果没有列头信息，用默认顺序
  if (columnMetrics.length === 0) {
    log('[parseImcDetail] No column metrics detected, using default order');
    columnMetrics = [
      { start: 0, key: 'line' },
      { start: 0, key: 'branch' },
      { start: 0, key: 'toggle' },
      { start: 0, key: 'condition' },
      { start: 0, key: 'fsm_state' },
      { start: 0, key: 'fsm_transition' },
      { start: 0, key: 'functional' },
      { start: 0, key: 'assertion' },
    ];
  }

  // 解析数据行
  var startIdx = headerLineIdx >= 0 ? headerLineIdx + 1 : 0;
  var instanceNodes = [];

  for (var i = startIdx; i < lines.length; i++) {
    var line = lines[i];
    if (!line.trim()) continue;
    // 跳过分隔线
    if (/^[-=+_#|~\s]+$/.test(line)) continue;
    // 跳过总结行
    if (/^(total|summary|overall)/i.test(line.trim())) continue;

    // 计算缩进级别（行首空格数）
    var indentMatch = line.match(/^(\s*)/);
    var indent = indentMatch ? indentMatch[1].length : 0;
    var depth = Math.floor(indent / 2); // 每级 2 个空格

    // 提取实例名（第一个非空格的单词，可能包含 . 或 _ ）
    var trimmed = line.trim();
    var nameMatch = trimmed.match(/^(\S+)/);
    if (!nameMatch) continue;
    var instanceName = nameMatch[1];

    // 跳过非实例行（如列名残留）
    if (/^(line|branch|toggle|condition|fsm|functional|assert|coverage|metric|instance|hierarchy|module)/i.test(instanceName)
        && !/[._]/.test(instanceName) && indent === 0 && headerLineIdx === -1) {
      // 可能是另一个表头，跳过
      continue;
    }

    // 提取行中的所有数字（百分比或计数）
    var numbers = [];
    var numRe = /([\d.]+)/g;
    var numMatch;
    while ((numMatch = numRe.exec(trimmed)) !== null) {
      var num = parseFloat(numMatch[1]);
      if (!isNaN(num)) numbers.push(num);
    }

    // 第一个数字可能是实例名的一部分（如果实例名以数字开头）
    // 但通常实例名不包含纯数字，所以跳过第一个匹配如果它紧跟在实例名后面

    // 去掉实例名部分，提取数字
    var afterName = trimmed.substring(instanceName.length);
    var pctNumbers = [];
    var pctRe = /([\d.]+)\s*%?/g;
    var pctMatch;
    while ((pctMatch = pctRe.exec(afterName)) !== null) {
      var val = parseFloat(pctMatch[1]);
      if (!isNaN(val)) pctNumbers.push(val);
    }

    // 如果没有百分比符号，数字可能是 0-100 范围的百分比
    // 过滤掉明显不是百分比的数字（如行号等）
    var metrics = emptyMetrics();

    if (pctNumbers.length > 0) {
      // 按列头顺序映射
      for (var j = 0; j < pctNumbers.length && j < columnMetrics.length; j++) {
        var key = columnMetrics[j].key;
        var pct = pctNumbers[j];
        // 百分比应该在 0-100 范围
        if (pct >= 0 && pct <= 100) {
          metrics[key] = { percentage: pct, covered: null, total: null };
        }
      }
    }

    // 构建节点
    var hasAnyMetric = false;
    for (var k in metrics) {
      if (metrics[k].percentage !== null) {
        hasAnyMetric = true;
        break;
      }
    }

    var node = {
      name: instanceName,
      indent: indent,
      depth: depth,
      metrics: metrics,
      children: [],
    };

    instanceNodes.push(node);

    if (hasAnyMetric) {
      log('[parseImcDetail] Instance: ' + instanceName + ' (indent=' + indent + ', depth=' + depth +
        ') metrics: ' + JSON.stringify(metrics));
    }
  }

  // 构建层级树
  tree = buildHierarchyTree(instanceNodes, log);

  log('[parseImcDetail] Parsed ' + instanceNodes.length + ' instance nodes');
  log('[parseImcDetail] Tree root: ' + (tree ? tree.name : 'null') +
    ', children: ' + (tree ? tree.children.length : 0));

  return { nodes: instanceNodes, tree: tree };
}

/**
 * 将扁平的实例节点列表（带缩进信息）构建为层级树。
 * 使用栈算法：根据缩进级别确定父子关系。
 */
function buildHierarchyTree(nodes, log) {
  if (!nodes || nodes.length === 0) return null;

  var root = null;
  var stack = []; // { node, depth }

  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var coverageNode = makeNode(
      node.name,
      '',  // path 后面构建
      node.depth,
      node.metrics,
      [],
    );

    // 弹出栈中深度 >= 当前节点深度的节点
    while (stack.length > 0 && stack[stack.length - 1].depth >= node.depth) {
      stack.pop();
    }

    if (stack.length === 0) {
      // 顶层节点
      if (root === null) {
        root = coverageNode;
        coverageNode.path = 'top/' + node.name;
        coverageNode.depth = 0;
      } else {
        // 如果已经有 root，将此节点作为 root 的兄弟（或子节点）
        // 实际上 IMC 报告通常只有一个顶层实例（如 tb_top）
        root.children.push(coverageNode);
        coverageNode.path = root.path + '/' + node.name;
        coverageNode.depth = root.depth + 1;
      }
    } else {
      // 作为栈顶节点的子节点
      var parent = stack[stack.length - 1].node;
      parent.children.push(coverageNode);
      coverageNode.path = parent.path + '/' + node.name;
      coverageNode.depth = parent.depth + 1;
    }

    stack.push({ node: coverageNode, depth: coverageNode.depth });
  }

  // 如果只有一个顶层节点，将其作为 root
  // 如果有多个顶层节点，创建一个虚拟 root
  if (root && root.children.length > 0 && stack.length === 0) {
    // root 已设置
  }

  return root;
}

/**
 * 解析 VCS urg 报告。
 * urg 报告通常包含 hierarchy 和 coverage 数据。
 */
function parseUrgReport(text, log) {
  if (!text) return { summary: null, modules: [] };
  var metrics = emptyMetrics();
  var modules = [];
  var lines = text.split('\n');

  if (log) log('[parseUrgReport] Starting, lines: ' + lines.length);

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var result = tryParseMetricFromLine(line, log);
    if (result && result.key) {
      metrics[result.key] = result.triplet;
    }
  }

  var hasAny = false;
  for (var k in metrics) {
    if (metrics[k].percentage !== null) {
      hasAny = true;
      break;
    }
  }

  if (log) log('[parseUrgReport] Found metrics: ' + (hasAny ? 'yes' : 'no'));

  return { summary: hasAny ? metrics : null, modules: modules };
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
function scanCovMergeDir(covMergeDir, log) {
  if (!covMergeDir || !existsSync(covMergeDir)) {
    if (log) log('[scanCovMergeDir] covMergeDir does not exist: ' + covMergeDir);
    return null;
  }

  if (log) log('[scanCovMergeDir] Scanning: ' + covMergeDir);

  try {
    var entries = readdirSync(covMergeDir, { withFileTypes: true });
    if (log) log('[scanCovMergeDir] Found ' + entries.length + ' entries: ' + entries.map(function(e) { return e.name + (e.isDirectory() ? '/' : ''); }).join(', '));

    // 1. 查找 JSON 格式的覆盖率数据文件
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (entry.isFile() && entry.name.endsWith('.json')) {
        var data = tryParseJsonCoverage(join(covMergeDir, entry.name));
        if (data) {
          if (log) log('[scanCovMergeDir] Found JSON coverage data: ' + entry.name);
          return data;
        }
      }
    }

    // 2. 查找文本报告文件
    var textReports = [];
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j];
      if (e.isFile() && /\.(txt|report|rpt)$/i.test(e.name)) {
        try {
          var content = readFileSync(join(covMergeDir, e.name), 'utf-8');
          textReports.push({ name: e.name, content: content });
          if (log) log('[scanCovMergeDir] Found text report: ' + e.name + ' (' + content.length + ' chars)');
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
              if (data2) {
                if (log) log('[scanCovMergeDir] Found JSON coverage data in subdir: ' + sub.name + '/' + se.name);
                return data2;
              }
            }
            if (se.isFile() && /\.(txt|report|rpt)$/i.test(se.name)) {
              try {
                var content2 = readFileSync(join(subPath, se.name), 'utf-8');
                textReports.push({ name: sub.name + '/' + se.name, content: content2 });
                if (log) log('[scanCovMergeDir] Found text report in subdir: ' + sub.name + '/' + se.name);
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
      if (log) log('[scanCovMergeDir] Trying to parse ' + textReports.length + ' text reports');

      // 尝试用第一个文本报告作为 summary
      var combinedText = textReports.map(function(r) { return r.content; }).join('\n\n');
      var metrics = parseImcSummary(combinedText, log);
      if (!metrics) {
        var urgResult = parseUrgReport(combinedText, log);
        metrics = urgResult.summary;
      }

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

    // 5. 检查是否有 .covdb 文件（IMC 二进制数据库）
    var hasCovdb = entries.some(function(e) { return e.isFile() && /\.covdb$/i.test(e.name); });
    var hasCovdbDir = entries.some(function(e) { return e.isDirectory() && /covdb/i.test(e.name); });
    if (hasCovdb || hasCovdbDir) {
      if (log) log('[scanCovMergeDir] Found IMC coverage database (.covdb) but cannot parse binary format directly. EDA command (imc) is required to generate text reports.');
    }

    if (log) log('[scanCovMergeDir] No parseable coverage data found');
    return null;
  } catch (err) {
    if (log) log('[scanCovMergeDir] Error: ' + (err && err.message ? err.message : String(err)));
    return null;
  }
}

// ─── 主解析入口 ───────────────────────────────────────────────

async function parse(projectRoot, sessionId, reportDir) {
  var log = createDebugLogger(reportDir);

  log('=== Parse Start ===');
  log('projectRoot: ' + projectRoot);
  log('sessionId: ' + sessionId);
  log('reportDir: ' + reportDir);

  // 1. 读取 meta.json（CoverageManager 在导入前写入）
  var meta = readMeta(reportDir);
  var covMergeDir = meta ? meta.covMergeDir : '';
  var edaTool = meta ? meta.edaTool : 'unknown';

  log('meta.json: ' + JSON.stringify(meta));
  log('covMergeDir: ' + covMergeDir);
  log('edaTool: ' + edaTool);

  // 2. 尝试读取文本报告
  var summaryText = '';
  var detailText = '';
  var metricsText = '';

  var summaryPath = join(reportDir, 'summary.txt');
  var detailPath = join(reportDir, 'detail.txt');
  var metricsPath = join(reportDir, 'metrics.txt');

  if (existsSync(summaryPath)) {
    try {
      summaryText = readFileSync(summaryPath, 'utf-8');
      log('summary.txt: found, ' + summaryText.length + ' chars');
      log('summary.txt first 500 chars:\n' + summaryText.substring(0, 500));
    } catch (e) {
      log('summary.txt: read error: ' + (e && e.message ? e.message : String(e)));
    }
  } else {
    log('summary.txt: NOT FOUND at ' + summaryPath);
  }

  if (existsSync(detailPath)) {
    try {
      detailText = readFileSync(detailPath, 'utf-8');
      log('detail.txt: found, ' + detailText.length + ' chars');
      log('detail.txt first 500 chars:\n' + detailText.substring(0, 500));
    } catch (e) {
      log('detail.txt: read error: ' + (e && e.message ? e.message : String(e)));
    }
  } else {
    log('detail.txt: NOT FOUND at ' + detailPath);
  }

  if (existsSync(metricsPath)) {
    try {
      metricsText = readFileSync(metricsPath, 'utf-8');
      log('metrics.txt: found, ' + metricsText.length + ' chars');
    } catch (e) {
      log('metrics.txt: read error: ' + (e && e.message ? e.message : String(e)));
    }
  } else {
    log('metrics.txt: NOT FOUND at ' + metricsPath);
  }

  // 3. 解析文本报告
  var summaryMetrics = null;
  var detailResult = { nodes: [], tree: null };

  if (summaryText) {
    if (edaTool === 'imc') {
      log('[parse] Using IMC summary parser');
      summaryMetrics = parseImcSummary(summaryText, log);
    } else if (edaTool === 'vcs-urg') {
      log('[parse] Using VCS urg summary parser');
      var urgResult = parseUrgReport(summaryText, log);
      summaryMetrics = urgResult.summary;
    } else {
      log('[parse] Unknown EDA tool, trying all parsers');
      summaryMetrics = parseImcSummary(summaryText, log);
      if (!summaryMetrics) {
        var urgResult2 = parseUrgReport(summaryText, log);
        summaryMetrics = urgResult2.summary;
      }
    }
  } else {
    log('[parse] No summary text to parse');
  }

  if (detailText) {
    log('[parse] Parsing detail report...');
    detailResult = parseImcDetail(detailText, log);
  } else {
    log('[parse] No detail text to parse');
  }

  // 4. 如果文本报告解析失败，尝试从 cov_merge 目录直接扫描
  if (!summaryMetrics && covMergeDir) {
    log('[parse] Summary parsing failed, trying direct scan of cov_merge dir...');
    var covData = scanCovMergeDir(covMergeDir, log);
    if (covData) {
      log('[parse] Direct scan succeeded, using scanned data');
      covData.sessionId = sessionId;
      covData.source.edaTool = edaTool;
      covData.source.reportGeneratedAt = Date.now();
      log('=== Parse End (direct scan) ===');
      return covData;
    } else {
      log('[parse] Direct scan also failed — returning empty data');
    }
  }

  // 5. 构建 CoverageData
  var rootMetrics = summaryMetrics || emptyMetrics();

  // 如果有 detail 解析出的树，使用它
  var root;
  if (detailResult.tree) {
    // 用 summary 的总体指标作为 root 的 metrics
    root = detailResult.tree;
    root.metrics = rootMetrics;
    log('[parse] Using detail tree as root, root.name=' + root.name + ', children=' + root.children.length);
  } else {
    // 如果有扁平模块节点，构建层级树
    var children = [];
    if (detailResult.nodes && detailResult.nodes.length > 0) {
      for (var i = 0; i < detailResult.nodes.length; i++) {
        var node = detailResult.nodes[i];
        children.push(makeNode(node.name, 'top/' + node.name, 1, node.metrics, []));
      }
      log('[parse] Using flat nodes as children, count=' + children.length);
    } else {
      log('[parse] No module nodes, returning root only with summary metrics');
    }

    root = makeNode('top', 'top', 0, rootMetrics, children);
  }

  log('=== Parse End ===');
  log('Root: ' + root.name + ', children: ' + root.children.length);
  var metricSummary = {};
  for (var mk in rootMetrics) {
    metricSummary[mk] = rootMetrics[mk].percentage;
  }
  log('Root metrics: ' + JSON.stringify(metricSummary));

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
