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
 * 分层解析模式（options.summaryOnly）：
 *   - summaryOnly=true：只解析 summary.txt，快速返回层级树 + 覆盖率摘要
 *   - summaryOnly=false（默认）：解析全部报告（summary + detail + metrics + grade + bins + csv）
 *   分层解析避免大数据量时一次性解析所有报告导致 GUI 卡顿
 *
 * 支持的报告格式：
 *   - IMC summary report: 表格格式，含 Metric / Covered/Total / Coverage%
 *   - IMC detail report: 层级缩进格式，含 Instance / 各 metric 百分比
 *   - VCS urg -format text 报告目录（ADR 0024 解析优先级）：
 *     ① session.xml（`-xml_verbose -show summary` 类型化 XML，确定性）优先；
 *     ② 降级 → dashboard.txt（顶层摘要）+ hierarchy.txt（层级树）；
 *     ③ 两者都缺失 → 报错。
 *     此外 line.dat/branch.dat/cond.dat/tgl.dat/fsm.dat/assert.dat
 *     （file/line 级未覆盖项，供 AI 覆盖收敛消费）在 ①② 两路径均解析。
 *   - vcover report: 包含 summary 和 detail 数据
 *   - JSON 覆盖率数据文件: 直接解析为 CoverageData
 *
 * Debug 日志：解析过程会写入 reportDir/parser-debug.log，记录每一步的解析结果。
 */

const { readFileSync, readdirSync, existsSync, writeFileSync, appendFileSync, statSync } = require('node:fs');
const { join } = require('node:path');

const MANIFEST = {
  apiVersion: '1.0',
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
  'toggle': 'toggle', 'toggles': 'toggle', 'tgl': 'toggle',
  'condition': 'condition', 'conditions': 'condition', 'cond': 'condition',
  'fsm state': 'fsm_state', 'fsm states': 'fsm_state', 'fsm-state': 'fsm_state', 'fsm': 'fsm_state',
  'fsm transition': 'fsm_transition', 'fsm transitions': 'fsm_transition', 'fsm-trans': 'fsm_transition',
  'functional': 'functional', 'function': 'functional', 'covergroup': 'functional',
  'assertion': 'assertion', 'assert': 'assertion', 'asserts': 'assertion',
  'statement': 'line', 'statements': 'line', // IMC 有时用 statement 代替 line
};

// ─── VCS urg -format text 报告解析（ADR 0021）────────────────

/**
 * urg text 报告目录中的文件名 → 平台 metric key。
 * urg -format text 生成一组 ASCII 产物：dashboard.txt、hierarchy.txt、
 * 以及逐 metric 的 .dat 文件（每行一个覆盖点，未覆盖项带 file:line）。
 */
var URG_METRIC_DAT = {
  'line.dat': 'line',
  'branch.dat': 'branch',
  'cond.dat': 'condition',
  'tgl.dat': 'toggle',
  'fsm.dat': 'fsm_state',
  'assert.dat': 'assertion',
};

/** UncoveredItem 中 description 汇总时的最大条数（防超大 prompt） */
var URG_UNCOVERED_PER_METRIC_CAP = 200;

// ─── 最小 XML 解析器（ADR 0024：session.xml 优先解析）──────────
//
// 插件运行时被 coverage worker 加载，打包后 plugins 目录无法解析
// node_modules，因此手写最小 XML 解析器（无外部依赖）：
//   - 支持元素嵌套、属性（双引号/单引号）、自闭合标签
//   - 支持文本/属性实体转义：&amp; &lt; &gt; &quot; &apos; 及数字实体 &#65; &#x42;
//   - 跳过 XML 声明、注释、处理指令、DOCTYPE
//   - CDATA 段按原文跳过（内容不作为标记解析、不做实体解码）
//   - 结构性错误（标签未闭合、闭合标签不匹配、属性缺引号等）抛 Error

var XML_ENTITY_MAP = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** 解码 XML 实体（命名 + 十进制/十六进制数字实体）；未知实体保留原样 */
function decodeXmlEntities(input) {
  if (!input || input.indexOf('&') < 0) return input;
  return input.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (all, name) {
    if (name.charAt(0) === '#') {
      var code = (name.charAt(1) === 'x' || name.charAt(1) === 'X')
        ? parseInt(name.substring(2), 16)
        : parseInt(name.substring(1), 10);
      if (isNaN(code) || code < 0 || code > 0x10ffff) return all; // 非法字符引用保留原样
      try {
        return String.fromCodePoint(code);
      } catch (_e) {
        return all;
      }
    }
    if (Object.prototype.hasOwnProperty.call(XML_ENTITY_MAP, name)) return XML_ENTITY_MAP[name];
    return all; // 未知命名实体保留原样（宽松，不阻断解析）
  });
}

/**
 * 解析 XML 文档，返回根元素节点 { name, attrs, text, children }。
 * 仅覆盖 session.xml 所需的 XML 子集；结构错误抛 Error（fail-closed）。
 */
function parseXmlDocument(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('XML 解析错误：输入为空');
  }
  var pos = 0;
  var len = text.length;

  function err(msg) {
    return new Error('XML 解析错误（offset ' + pos + '）：' + msg);
  }

  function startsWith(s) {
    return len - pos >= s.length && text.substr(pos, s.length) === s;
  }

  function skipWhitespace() {
    while (pos < len) {
      var c = text.charCodeAt(pos);
      if (c === 32 || c === 9 || c === 10 || c === 13) pos++;
      else break;
    }
  }

  function isNameStartChar(ch) {
    return /[A-Za-z_:]/.test(ch);
  }

  function isNameChar(ch) {
    return /[A-Za-z0-9_.:-]/.test(ch);
  }

  function readName() {
    if (pos >= len || !isNameStartChar(text[pos])) throw err('期望元素/属性名');
    var start = pos;
    while (pos < len && isNameChar(text[pos])) pos++;
    return text.substring(start, pos);
  }

  /** 跳过注释 / 处理指令（含 XML 声明）/ <! 声明，返回是否跳过了内容 */
  function skipMisc() {
    if (startsWith('<!--')) {
      var end = text.indexOf('-->', pos + 4);
      if (end < 0) throw err('注释未闭合');
      pos = end + 3;
      return true;
    }
    if (startsWith('<?')) {
      var end2 = text.indexOf('?>', pos + 2);
      if (end2 < 0) throw err('处理指令/XML 声明未闭合');
      pos = end2 + 2;
      return true;
    }
    if (startsWith('<!')) {
      // DOCTYPE 等 <!...> 声明：跳到 '>'（不支持内部子集，session.xml 不使用）
      var end3 = text.indexOf('>', pos + 2);
      if (end3 < 0) throw err('<! 声明未闭合');
      pos = end3 + 1;
      return true;
    }
    return false;
  }

  /** 解析一个元素（进入时 pos 指向 '<'），返回节点 */
  function parseElement() {
    pos++; // 消费 '<'
    var name = readName();
    var attrs = {};
    var selfClosed = false;

    // 属性表
    for (;;) {
      skipWhitespace();
      if (pos >= len) throw err('元素 <' + name + '> 意外结束');
      var ch = text[pos];
      if (ch === '>') { pos++; break; }
      if (ch === '/') {
        if (pos + 1 >= len || text[pos + 1] !== '>') throw err('自闭合标签格式错误');
        pos += 2;
        selfClosed = true;
        break;
      }
      var attrName = readName();
      skipWhitespace();
      if (text[pos] !== '=') throw err('属性 ' + attrName + ' 缺少取值（XML 不支持无值属性）');
      pos++;
      skipWhitespace();
      var quote = text[pos];
      if (quote !== '"' && quote !== "'") throw err('属性 ' + attrName + ' 取值未加引号');
      pos++;
      var endQ = text.indexOf(quote, pos);
      if (endQ < 0) throw err('属性 ' + attrName + ' 取值未闭合');
      var rawValue = text.substring(pos, endQ);
      pos = endQ + 1;
      if (Object.prototype.hasOwnProperty.call(attrs, attrName)) {
        throw err('属性 ' + attrName + ' 重复');
      }
      attrs[attrName] = decodeXmlEntities(rawValue);
    }

    var node = { name: name, attrs: attrs, text: '', children: [] };
    if (selfClosed) return node;

    // 元素内容：文本 / CDATA / 注释 / 子元素，直至 </name>
    for (;;) {
      if (pos >= len) throw err('元素 <' + name + '> 未闭合');
      if (startsWith('</')) {
        pos += 2;
        var closeName = readName();
        skipWhitespace();
        if (text[pos] !== '>') throw err('闭合标签 </' + closeName + '> 格式错误');
        pos++;
        if (closeName !== name) {
          throw err('闭合标签不匹配：期望 </' + name + '>，实际 </' + closeName + '>');
        }
        return node;
      }
      if (startsWith('<![CDATA[')) {
        // CDATA 段按原文跳过（内容不作为标记解析、不做实体解码）；
        // 注意必须在 <! 通配分支之前检查（CDATA 也以 <! 开头）
        var endC = text.indexOf(']]>', pos + 9);
        if (endC < 0) throw err('CDATA 段未闭合');
        node.text += text.substring(pos + 9, endC);
        pos = endC + 3;
        continue;
      }
      if (startsWith('<!--') || startsWith('<?') || startsWith('<!')) {
        skipMisc();
        continue;
      }
      if (text[pos] === '<') {
        node.children.push(parseElement());
        continue;
      }
      // 普通文本：累积到下一个 '<'（实体不含 '<'，不会跨块拆分）
      var nextLt = text.indexOf('<', pos);
      if (nextLt < 0) nextLt = len;
      node.text += decodeXmlEntities(text.substring(pos, nextLt));
      pos = nextLt;
    }
  }

  // 根元素之前：只允许空白与声明/注释/DOCTYPE
  for (;;) {
    skipWhitespace();
    if (pos >= len) throw err('未找到根元素');
    if (skipMisc()) continue;
    if (text[pos] === '<') break;
    throw err('根元素之前存在非法文本');
  }
  var root = parseElement();

  // 根元素之后：只允许空白与注释/处理指令
  for (;;) {
    skipWhitespace();
    if (pos >= len) break;
    if (skipMisc()) continue;
    throw err('根元素之后存在非法内容');
  }
  return root;
}

// ─── urg session.xml 解析（ADR 0024 优先路径）──────────────────

/**
 * session.xml 中 coverage 元素 type 属性值 → 平台 metric key。
 * urg 的 code coverage 只有单一 "fsm" type（state 与 transition 合并统计），
 * 沿用 URG_METRIC_DAT 中 'fsm.dat' → 'fsm_state' 的既有语义：整体映射到
 * fsm_state，fsm_transition 在 XML 路径下不单独产出（text 路径同样不区分）。
 */
var URG_XML_TYPE_MAP = {
  'line': 'line', 'statement': 'line',
  'branch': 'branch',
  'condition': 'condition', 'cond': 'condition', 'expression': 'condition',
  'toggle': 'toggle', 'tgl': 'toggle',
  'fsm': 'fsm_state', 'fsm state': 'fsm_state',
  'assertion': 'assertion', 'assert': 'assertion',
  'functional': 'functional', 'covergroup': 'functional', 'cover': 'functional',
};

/** 解析 session.xml 数值属性：缺失/明确不适用（n/a、-、空）→ null；非数字 → 抛错 */
function parseUrgXmlNumber(raw, what) {
  if (raw === undefined || raw === null) return null;
  var t = String(raw).trim();
  if (t === '' || t === '-' || t === 'n/a' || t.toLowerCase() === 'na' || t.toLowerCase() === 'none') {
    return null;
  }
  if (!/^-?\d+(\.\d+)?$/.test(t)) {
    throw new Error('session.xml 解析错误：' + what + ' 属性值不是数字：' + raw);
  }
  return parseFloat(t);
}

/**
 * 从 coverage 元素构造 triplet。
 *
 * URG SCORE 语义（ADR 0024，fail-closed）：
 *   - covered > total、负值 sentinel（如 -1）、score > 100 → 解析错误，不静默错算
 *   - 不适用（属性缺失或 n/a）→ { percentage: null, covered: null, total: null }
 *   - score 缺失但有 covered/total 时按 covered/total 计算（与 _makeTriplet 语义一致）
 */
function urgXmlTriplet(el, context) {
  var score = parseUrgXmlNumber(el.attrs.score, context + ' score');
  var covered = parseUrgXmlNumber(el.attrs.covered, context + ' covered');
  var total = parseUrgXmlNumber(el.attrs.total, context + ' total');

  if (score !== null && score < 0) {
    throw new Error('session.xml 解析错误：' + context + ' score 为负值 sentinel（' + score + '），数据无效（fail-closed）');
  }
  if (covered !== null && covered < 0) {
    throw new Error('session.xml 解析错误：' + context + ' covered 为负值 sentinel（' + covered + '），数据无效（fail-closed）');
  }
  if (total !== null && total < 0) {
    throw new Error('session.xml 解析错误：' + context + ' total 为负值 sentinel（' + total + '），数据无效（fail-closed）');
  }
  if (score !== null && score > 100) {
    throw new Error('session.xml 解析错误：' + context + ' score 超过 100（' + score + '），数据无效（fail-closed）');
  }
  if (covered !== null && total !== null && covered > total) {
    throw new Error('session.xml 解析错误：' + context + ' covered(' + covered + ') > total(' + total + ')，违背 SCORE 语义（fail-closed）');
  }

  if (score === null && covered === null && total === null) {
    return naTriplet(); // 不适用 → 三者均 null
  }
  if (score === null) {
    // score 缺失但有计数：按计数计算（total=0 时视为 100%，与 _makeTriplet 一致）
    score = total > 0 ? (covered / total) * 100 : 100;
  }
  return { percentage: score, covered: covered, total: total };
}

/** 深度优先查找第一个名为 scope 的元素（urg session.xml 的层级根） */
function findFirstScopeElement(node) {
  if (node.name === 'scope') return node;
  for (var i = 0; i < node.children.length; i++) {
    var found = findFirstScopeElement(node.children[i]);
    if (found) return found;
  }
  return null;
}

/**
 * scope 元素 → CoverageNode（递归）。
 *
 * URG SCORE 语义：父 scope 的 metric 分数已包含 subtree，此处直接取 XML 中的
 * 分数，禁止对 descendants 做任何累加/重算；多 metric 聚合的 coverage_pct 应为
 * 所选 metric 百分比的算术平均——平台数据模型按 metric 独立建模 triplet，
 * 解析器不产出聚合 covered/total 计数（聚合由消费方按算术平均语义计算）。
 */
function urgXmlScopeToNode(el, parentPath, depth, log) {
  var name = el.attrs.name;
  if (!name || !name.trim()) {
    throw new Error('session.xml 解析错误：scope 元素缺少 name 属性（depth=' + depth + '）');
  }
  name = name.trim();
  var path = parentPath ? parentPath + '/' + name : 'top/' + name;
  var metrics = emptyMetrics();
  var children = [];

  for (var i = 0; i < el.children.length; i++) {
    var child = el.children[i];
    if (child.name === 'scope') {
      children.push(urgXmlScopeToNode(child, path, depth + 1, log));
      continue;
    }
    if (child.name === 'coverage' || child.name === 'metric') {
      var rawType = (child.attrs.type || '').toLowerCase().trim();
      var metricKey = URG_XML_TYPE_MAP[rawType];
      if (!metricKey) {
        log('[parseUrgSessionXml] 忽略未知 metric type: ' + rawType + ' (scope ' + path + ')');
        continue;
      }
      if (metrics[metricKey].percentage !== null || metrics[metricKey].covered !== null) {
        // 同一 scope 内重复 type：保留后者并记录日志（urg 正常不产出，防御式）
        log('[parseUrgSessionXml] scope ' + path + ' 中 metric type ' + rawType + ' 重复，取后者');
      }
      metrics[metricKey] = urgXmlTriplet(child, path + ' ' + rawType);
    }
    // 其他子元素（report 包装层、label 等）忽略
  }

  return makeNode(name, path, depth, metrics, children);
}

/**
 * 解析 urg session.xml（`urg -xml_verbose -show summary` 产物，ADR 0024）。
 * 返回 { tree, summary }：tree 为层级 CoverageNode 树，summary 为根 scope metrics。
 * XML 结构错误或违背 SCORE 语义的数据直接抛 Error（fail-closed，不降级）。
 */
function parseUrgSessionXml(text, log) {
  if (typeof log !== 'function') log = function () {}; // log 可选（独立调用/单测场景）
  var root = parseXmlDocument(text);
  var scopeEl = findFirstScopeElement(root);
  if (!scopeEl) {
    throw new Error('session.xml 解析错误：未找到 scope 元素（非 urg -xml_verbose 产物？）');
  }
  var tree = urgXmlScopeToNode(scopeEl, '', 0, log);
  log('[parseUrgSessionXml] root=' + tree.name + ', direct children=' + tree.children.length);
  return { tree: tree, summary: tree.metrics };
}

/**
 * 解析 dashboard.txt：顶层 8 metric 摘要。
 *
 * dashboard.txt 中的典型表格行（列名可能随版本变化，采用防御式解析）：
 *   Line Coverage:            95.30%  (9530/10000)
 *   Branch Coverage:          87.20%
 *   Toggle Coverage:          ...
 * 也兼容 "Line  95.30%" 等无 Coverage 后缀写法。
 */
function parseUrgDashboard(text, log) {
  if (!text) return null;
  var metrics = emptyMetrics();
  var foundAny = false;
  var lines = text.split('\n');

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    // 只匹配 metric 名 + 百分比（可带 covered/total 括号）的行
    var m = line.match(/(line|branch|toggle|tgl|cond(?:ition)?|fsm|assert(?:ion)?|functional|covergroup)[^:%\d]*:?[ \t]+([\d.]+)\s*%\s*(?:\(\s*(\d+)\s*\/\s*(\d+)\s*\))?/i);
    if (!m) continue;
    var key = normalizeMetricName(m[1]);
    if (!key) continue;
    var pct = parseFloat(m[2]);
    if (isNaN(pct)) continue;
    metrics[key] = {
      percentage: pct,
      covered: m[3] ? parseInt(m[3], 10) : null,
      total: m[4] ? parseInt(m[4], 10) : null,
    };
    foundAny = true;
    if (log) log('[parseUrgDashboard] ' + key + ' = ' + pct + '% from: ' + JSON.stringify(line.trim()));
  }

  if (log) log('[parseUrgDashboard] foundAny=' + foundAny);
  return foundAny ? metrics : null;
}

/**
 * 从一行文本中提取层级路径与一组百分比（0-100 纯数字或 xx.xx%）。
 * 返回 { name, depth, values: number[] } 或 null。
 * depth 由前导 "|--"/"| "/缩进推断。
 */
function parseUrgHierarchyLine(line) {
  if (!line) return null;
  // 去掉行尾注释与表头残留
  var trimmed = line.replace(/\s*#.*$/, '');
  if (!trimmed.trim()) return null;
  if (/^[-=+_|~\s]+$/.test(trimmed)) return null; // 分隔线

  // 计算层级："|--" 与 "| " 每个竖线一级
  var depth = 0;
  var m;
  var prefixRe = /^(?:\|\s*)+/;
  if ((m = prefixRe.exec(trimmed))) {
    depth = (m[0].match(/\|/g) || []).length;
  }
  var body = trimmed.substring(m ? m[0].length : 0).replace(/^-+\s*/, '');
  body = body.trim();
  if (!body) return null;

  // 名称 = 首个空白前的 token
  var nameMatch = body.match(/^(\S+)/);
  if (!nameMatch) return null;
  var name = nameMatch[1];
  // 跳过表头/合计行
  if (/^(name|module|instance|hierarchy|total|summary|overall)$/i.test(name)) return null;

  // 提取名称后的所有数字（百分比或计数）
  var afterName = body.substring(name.length);
  var values = [];
  var numRe = /(-?[\d.]+)/g;
  var nm;
  while ((nm = numRe.exec(afterName)) !== null) {
    var v = parseFloat(nm[1]);
    if (!isNaN(v)) values.push(v);
  }
  if (values.length === 0) return null;
  return { name: name, depth: depth, values: values };
}

/**
 * 解析 hierarchy.txt：层级模块树。
 *
 * 每行一个实例（"| "前缀表层级），后面跟一列列百分比。列顺序无法预知
 * （取决于 urg 版本与启用的 metric），采用启发式：
 *   1. 从表头行解析列名 → 列名→metric 映射
 *   2. 无表头时按常见顺序（line/toggle/branch/cond/fsm/functional/assert）映射
 *   3. 数值 >100 视为计数而非百分比，跳过
 * 返回 { tree, headerMetrics } 或 null。
 */
function parseUrgHierarchy(text, log) {
  if (!text) return null;
  var lines = text.split('\n');
  // 找表头行：包含 name/module/instance 且含多个 metric 关键词
  var headerMetrics = null;
  for (var i = 0; i < lines.length; i++) {
    var lower = lines[i].toLowerCase();
    if ((/name|module|instance|hier/i.test(lines[i])) &&
        (/line|branch|tgl|toggle|cond|fsm|assert|func|cov/i.test(lower))) {
      // 收集表头中的 metric 列（按出现顺序）
      var cols = [];
      var colRe = /(line|branch|tgl|toggle|cond(?:ion)?|fsm|assert(?:ion)?|functional|covergroup|cov|group)/gi;
      var cm;
      while ((cm = colRe.exec(lines[i])) !== null) {
        var key = normalizeMetricName(cm[1]);
        if (key) cols.push(key);
      }
      // 去重（同 metric 多列时保序去重）
      var seen = {};
      var uniq = [];
      for (var c = 0; c < cols.length; c++) {
        if (!seen[cols[c]]) { seen[cols[c]] = true; uniq.push(cols[c]); }
      }
      if (uniq.length > 0) {
        headerMetrics = uniq;
        log('[parseUrgHierarchy] header at line ' + i + ': metrics=' + uniq.join(','));
      }
      break;
    }
  }
  if (!headerMetrics) {
    // 无表头 → 常见顺序
    headerMetrics = ['line', 'toggle', 'branch', 'condition', 'fsm_state', 'functional', 'assertion'];
    log('[parseUrgHierarchy] no header found, using default metric order');
  }

  var nodes = [];
  for (var j = 0; j < lines.length; j++) {
    var parsed = parseUrgHierarchyLine(lines[j]);
    if (!parsed) continue;
    var metrics = emptyMetrics();
    var vi = 0;
    for (var k = 0; k < parsed.values.length && vi < headerMetrics.length; k++) {
      var v2 = parsed.values[k];
      // 跳过明显不是百分比的计数（>100 或负数）
      if (v2 < 0 || v2 > 100) continue;
      metrics[headerMetrics[vi]] = { percentage: v2, covered: null, total: null };
      vi++;
    }
    nodes.push({ name: parsed.name, depth: parsed.depth, metrics: metrics, children: [] });
  }

  if (nodes.length === 0) {
    if (log) log('[parseUrgHierarchy] no nodes parsed');
    return null;
  }
  var tree = buildHierarchyTree(nodes, log);
  if (!tree) return null;
  if (log) log('[parseUrgHierarchy] parsed ' + nodes.length + ' nodes');
  return { tree: tree, headerMetrics: headerMetrics };
}

/** 从 .dat 行中提取 file:line 证据。返回 { file, line } 或 null。 */
function parseUrgFileLine(text) {
  if (!text) return null;
  // 常见形态："...file.v:123..."（行号紧跟冒号）
  var m = text.match(/(\S+\.[va]h?)\s*[:\s]\s*(\d+)/i);
  if (m) return { file: m[1], line: parseInt(m[2], 10) };
  // "line 123 in file.v"
  m = text.match(/line\s+(\d+)\s+in\s+(\S+)/i);
  if (m) return { file: m[2], line: parseInt(m[1], 10) };
  return null;
}

/**
 * 解析 urg 目录下逐 metric 的 .dat 文件 → 未覆盖项（file/line 级）。
 * session.xml 优先路径与 text 降级路径共用（ADR 0024：summary 与 detail 数据互不影响）。
 * includeDat=false（summaryOnly 快速导入）时跳过。
 */
function parseUrgDatFiles(reportDir, log, includeDat) {
  var uncovered = {};
  if (includeDat === false) {
    log('[parseUrgDatFiles] summaryOnly mode — skipping .dat uncovered parsing');
    return null;
  }
  for (var datName in URG_METRIC_DAT) {
    var metricKey = URG_METRIC_DAT[datName];
    var datPath = join(reportDir, datName);
    if (!existsSync(datPath)) continue;
    try {
      var lines = readFileSync(datPath, 'utf-8').split('\n');
      var items = [];
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (!l.trim()) continue;
        // 未覆盖行通常含 "uncovered"/"never"/"0/" 标记或按格式全部为未覆盖清单；
        // 防御式：有 UNCOVERED/NOT COVERED 标记优先，否则只要能提取 file:line 就收
        var lower = l.toLowerCase();
        var flagged = lower.indexOf('uncovered') >= 0 || lower.indexOf('not covered') >= 0 ||
                      lower.indexOf('never') >= 0;
        var fl = parseUrgFileLine(l);
        if (!fl) continue;
        if (!flagged && lower.indexOf('covered') >= 0) continue; // 明确标为已覆盖则跳过
        items.push({
          module: '',
          file: fl.file,
          line: fl.line,
          description: l.trim().substring(0, 200),
        });
        if (items.length >= URG_UNCOVERED_PER_METRIC_CAP) break;
      }
      if (items.length > 0) {
        uncovered[metricKey] = items;
        log('[parseUrgDatFiles] ' + datName + ' → ' + items.length + ' uncovered items (' + metricKey + ')');
      }
    } catch (err) {
      log('[parseUrgDatFiles] ' + datName + ' read error: ' + String(err));
    }
  }
  var hasAny = false;
  for (var mk in uncovered) { if (uncovered[mk] && uncovered[mk].length > 0) { hasAny = true; break; } }
  return hasAny ? uncovered : null;
}

/**
 * 解析 urg text 报告目录（降级路径，启发式，ADR 0024）：
 *   1. dashboard.txt → 顶层 metric 摘要
 *   2. hierarchy.txt → 层级模块树
 *   3. *.dat → file/line 级未覆盖项（每 metric 一组 UncoveredItem）
 * dashboard/hierarchy 缺失时逐项降级，不整体失败。
 * includeDat=false（summaryOnly 快速导入）时跳过 .dat 解析。
 */
function parseUrgReportDir(reportDir, log, includeDat) {
  var result = { summary: null, tree: null, uncovered: null, filesSeen: [] };
  if (!existsSync(reportDir)) {
    log('[parseUrgReportDir] reportDir not found: ' + reportDir);
    return result;
  }

  var entries;
  try {
    entries = readdirSync(reportDir);
  } catch (err) {
    log('[parseUrgReportDir] readdir failed: ' + (err && err.message ? err.message : String(err)));
    return result;
  }
  result.filesSeen = entries.slice();
  log('[parseUrgReportDir] entries: ' + entries.join(', '));

  // 1. dashboard.txt（若不存在，尝试目录内任意 dashboard*.txt）
  var dashboardFile = entries.find(function (f) { return /^dashboard.*\.txt$/i.test(f); });
  if (dashboardFile) {
    try {
      result.summary = parseUrgDashboard(readFileSync(join(reportDir, dashboardFile), 'utf-8'), log);
    } catch (err) {
      log('[parseUrgReportDir] dashboard read error: ' + String(err));
    }
  } else {
    log('[parseUrgReportDir] no dashboard*.txt found');
  }

  // 2. hierarchy.txt
  var hierFile = entries.find(function (f) { return /^hierarchy.*\.txt$/i.test(f); });
  if (hierFile) {
    try {
      var parsed = parseUrgHierarchy(readFileSync(join(reportDir, hierFile), 'utf-8'), log);
      if (parsed) result.tree = parsed.tree;
    } catch (err) {
      log('[parseUrgReportDir] hierarchy read error: ' + String(err));
    }
  } else {
    log('[parseUrgReportDir] no hierarchy*.txt found');
  }

  // 3. *.dat → 未覆盖项
  result.uncovered = parseUrgDatFiles(reportDir, log, includeDat);

  return result;
}

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

function _makeTriplet(covered, total) {
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

  for (i = 0; i < lines.length; i++) {
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
 * 解析 IMC 24.09 的层级 summary 表格。
 *
 * 该格式把覆盖率放在每个层级实例的一行，而不是按 metric 一行：
 *   name  Overall Average  Overall Covered  Code Average  Code Covered ...
 *   |--dut 94.13% 94.13% (353/375) ...
 * Code/Fsm 是 IMC 的聚合列，映射到平台最接近的 line/fsm_state 指标，
 * 同时保留 covered/total，供覆盖率树和中间页面渲染。
 */
function parseImcHierarchySummary(text, log) {
  if (!text) return null;
  var lines = text.split('\n');
  var headerIndex = -1;
  var header;
  for (var i = 0; i < lines.length; i++) {
    if (/^\s*name\s+/i.test(lines[i]) && /overall\s+average/i.test(lines[i]) &&
        /code\s+covered/i.test(lines[i])) {
      headerIndex = i;
      header = lines[i];
      break;
    }
  }
  if (headerIndex < 0 || !header) return null;

  function triplet(averageText, coveredText) {
    var counts = parseCoveredTotal(coveredText);
    var percentage = parsePercent(coveredText);
    if (percentage === null) percentage = parsePercent(averageText);
    if (percentage === null && !counts) return naTriplet();
    return {
      percentage: percentage,
      covered: counts ? counts.covered : null,
      total: counts ? counts.total : null,
    };
  }

  var nodes = [];
  for (i = headerIndex + 1; i < lines.length; i++) {
    var line = lines[i];
    if (!line.trim() || /^\s*[-=+_#|~]+\s*$/.test(line)) continue;
    var valuePattern = /n\/a|[\d.]+%\s*(?:\(\s*\d+\s*\/\s*\d+\s*\))?/gi;
    var valueMatch = valuePattern.exec(line);
    if (!valueMatch) continue;
    var rawName = line.substring(0, valueMatch.index).trim();
    if (!rawName || /^name$/i.test(rawName)) continue;

    var values = [valueMatch[0]];
    while ((valueMatch = valuePattern.exec(line)) !== null) values.push(valueMatch[0]);
    if (values.length < 8) continue;

    var prefix = rawName.match(/^(?:[|+`]\s*(?:--)?\s*)+/);
    var depth = prefix ? (prefix[0].match(/[|+`]/g) || []).length : 0;
    var name = (prefix ? rawName.substring(prefix[0].length) : rawName).trim();
    if (!name) continue;

    var metrics = emptyMetrics();
    metrics.line = triplet(values[2], values[3]);
    metrics.fsm_state = triplet(values[4], values[5]);
    metrics.functional = triplet(values[6], values[7]);
    nodes.push({ name: name, depth: depth, metrics: metrics, children: [] });
  }

  if (nodes.length === 0) return null;
  var tree = buildHierarchyTree(nodes, log);
  if (!tree) return null;
  log('[parseImcHierarchySummary] Parsed ' + nodes.length + ' hierarchy nodes');
  return { tree: tree, metrics: nodes[0].metrics };
}

/**
 * 从一行文本中尝试提取 metric 名称和覆盖率值。
 * 返回 { key: metricKey, triplet: {percentage, covered, total} } 或 null。
 */
function tryParseMetricFromLine(line, _log) {
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
  var tree = null;

  log('[parseImcDetail] Starting, total lines: ' + lines.length);
  log('[parseImcDetail] First 10 lines:');
  for (var i = 0; i < Math.min(10, lines.length); i++) {
    log('  ' + i + ': ' + JSON.stringify(lines[i]));
  }

  // 找到数据表的列头行
  var headerLineIdx = -1;
  var columnMetrics = []; // 列索引到 metric key 的映射

  for (i = 0; i < lines.length; i++) {
    var line = lines[i];

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

  for (i = startIdx; i < lines.length; i++) {
    line = lines[i];
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
function buildHierarchyTree(nodes, _log) {
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

    // 5. 检查是否有二进制覆盖率数据库文件（IMC / VCS）
    var hasCovdb = entries.some(function(e) { return e.isFile() && /\.covdb$/i.test(e.name); });
    var hasCovdbDir = entries.some(function(e) { return e.isDirectory() && /covdb/i.test(e.name); });
    if (hasCovdb || hasCovdbDir) {
      if (log) log('[scanCovMergeDir] Found IMC coverage database (.covdb) but cannot parse binary format directly. EDA command (imc) is required to generate text reports.');
    }

    // Cadence IMC .ucd (Unified Coverage Database) / .ucm (merged coverage) 文件
    var hasUcd = entries.some(function(e) { return e.isFile() && /\.(ucd|ucm)$/i.test(e.name); });
    if (hasUcd) {
      if (log) log('[scanCovMergeDir] Found Cadence IMC binary coverage files (.ucd/.ucm). These require the imc EDA tool to generate text reports. Check that imc is in PATH and EDA command templates are configured.');
    }

    // VCS .vdb 目录
    var hasVdb = entries.some(function(e) { return e.isDirectory() && /\.vdb$/i.test(e.name); });
    if (hasVdb) {
      if (log) log('[scanCovMergeDir] Found VCS coverage database directory (.vdb). EDA command (urg) is required to generate text reports.');
    }

    if (log) log('[scanCovMergeDir] No parseable coverage data found');
    return null;
  } catch (err) {
    if (log) log('[scanCovMergeDir] Error: ' + (err && err.message ? err.message : String(err)));
    return null;
  }
}

// ─── 测试用例贡献度报告解析 ──────────────────────────────────

/**
 * 解析测试用例贡献度报告。
 *
 * 支持两种格式：
 * 1. VCS urg -grade testfile 输出（gradedtests.txt）:
 *    Test file: testname1
 *    Score: 95.50
 *    Rank: 1
 *
 * 2. Cadence IMC report -grading 输出（grade.txt）:
 *    Name             Line%   Branch%   Toggle%   ...
 *    testname1        95.5    87.2      76.0      ...
 */
function parseGradeReport(text, log) {
  if (!text || !text.trim()) return null;
  var contributions = [];

  // 尝试 urg 格式（Test file: + Score: + Rank:）
  var urgPattern = /Test\s*file\s*:\s*(\S+)/gi;
  var urgMatches = [];
  var match;
  while ((match = urgPattern.exec(text)) !== null) {
    urgMatches.push(match[1]);
  }

  if (urgMatches.length > 0) {
    // urg -grade testfile 格式
    var scorePattern = /Score\s*:\s*([0-9.]+)/gi;
    var rankPattern = /Rank\s*:\s*(\d+)/gi;
    var scores = [];
    var ranks = [];
    while ((match = scorePattern.exec(text)) !== null) scores.push(parseFloat(match[1]));
    while ((match = rankPattern.exec(text)) !== null) ranks.push(parseInt(match[1], 10));

    for (var i = 0; i < urgMatches.length; i++) {
      contributions.push({
        testName: urgMatches[i],
        score: i < scores.length ? scores[i] : undefined,
        rank: i < ranks.length ? ranks[i] : undefined,
      });
    }
    if (log) log('[parseGradeReport] urg format: ' + contributions.length + ' tests');
    return contributions;
  }

  // 尝试 IMC report -grading 格式（表格）
  // 找到表头行（包含 % 或 test/name 等关键词）
  var lines = text.split('\n');
  var headerIdx = -1;
  var metricColumns = []; // {colIdx, metric}

  for (var li = 0; li < lines.length; li++) {
    var lower = lines[li].toLowerCase();
    if (lower.indexOf('test') >= 0 && lower.indexOf('%') >= 0 ||
        (lower.indexOf('name') >= 0 && lower.indexOf('line') >= 0)) {
      headerIdx = li;
      var parts = lines[li].split(/\s+/);
      for (var pi = 0; pi < parts.length; pi++) {
        var pLower = parts[pi].toLowerCase().replace('%', '');
        if (METRIC_NAME_MAP[pLower]) {
          metricColumns.push({ colIdx: pi, metric: METRIC_NAME_MAP[pLower] });
        }
      }
      break;
    }
  }

  if (headerIdx >= 0) {
    // 解析数据行
    for (var di = headerIdx + 1; di < lines.length; di++) {
      var cols = lines[di].trim().split(/\s+/);
      if (cols.length < 2) continue;
      // 第一列是测试名，后续列是百分比
      var testName = cols[0];
      if (!testName || /^[-=]+$/.test(testName)) continue;

      var coverage = {};
      for (var mc = 0; mc < metricColumns.length; mc++) {
        var val = parseFloat(cols[metricColumns[mc].colIdx]);
        if (!isNaN(val)) {
          coverage[metricColumns[mc].metric] = val;
        }
      }

      contributions.push({
        testName: testName,
        coverage: Object.keys(coverage).length > 0 ? coverage : undefined,
      });
    }
    if (log) log('[parseGradeReport] IMC format: ' + contributions.length + ' tests');
    return contributions;
  }

  if (log) log('[parseGradeReport] Unknown format, no contributions parsed');
  return null;
}

// ─── Covergroup Bin 级报告解析 ─────────────────────────────────

/**
 * 解析 IMC report -detail -metrics functional 输出，提取未覆盖的 bin 列表。
 *
 * 输出格式示例：
 *   Covergroup: my_cg
 *     Bin: auto_bin[0]    [0/1]    UNCOVERED
 *     Bin: auto_bin[1]    [1/1]    COVERED
 *
 * 返回 UncoveredItem[] 列表（仅 UNCOVERED 的 bin）。
 */
function parseBinsReport(text, log) {
  if (!text || !text.trim()) return null;
  var uncovered = [];
  var currentCg = '';

  var lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // 匹配 Covergroup 行
    var cgMatch = line.match(/^(?:Covergroup|CG)\s*:\s*(.+)/i);
    if (cgMatch) {
      currentCg = cgMatch[1].trim();
      continue;
    }

    // 匹配 Bin 行
    var binMatch = line.match(/Bin\s*:\s*(\S+)\s*\[(\d+)\/(\d+)\]\s*(\w+)/i);
    if (binMatch) {
      var covered = parseInt(binMatch[2], 10);
      var total = parseInt(binMatch[3], 10);
      var status = binMatch[4].toUpperCase();

      if (status === 'UNCOVERED' || (covered === 0 && total > 0)) {
        uncovered.push({
          module: currentCg || 'unknown',
          signal: binMatch[1],
          description: 'Bin ' + binMatch[1] + ' in ' + (currentCg || 'unknown') + ' is uncovered [' + covered + '/' + total + ']',
        });
      }
      continue;
    }

    // 也匹配更简单的格式：仅列出未覆盖项
    // 例如：  my_cg.auto_bin[0]    UNCOVERED
    var simpleMatch = line.match(/^(\S+)\s+(UNCOVERED|NOT\s+COVERED|0\s*\/\s*\d+)/i);
    if (simpleMatch) {
      var fullName = simpleMatch[1];
      var dotIdx = fullName.lastIndexOf('.');
      var cgName = dotIdx > 0 ? fullName.substring(0, dotIdx) : '';
      var binName = dotIdx > 0 ? fullName.substring(dotIdx + 1) : fullName;
      uncovered.push({
        module: cgName || 'unknown',
        signal: binName,
        description: 'Bin ' + binName + ' is uncovered',
      });
    }
  }

  if (log) log('[parseBinsReport] Parsed ' + uncovered.length + ' uncovered bins');
  return uncovered.length > 0 ? uncovered : null;
}

// ─── CSV 数据读取 ─────────────────────────────────────────────

/**
 * 读取 CSV 目录下所有 .csv 文件并合并为单个字符串。
 *
 * urg -format csv 会在指定目录下生成多个 CSV 文件（如 hierarchy.csv, covergroup.csv 等），
 * 我们将它们拼接成一个带文件名分隔的字符串，方便 AI 直接消费。
 */
function readCsvData(csvDir, log) {
  if (!csvDir || !existsSync(csvDir)) {
    if (log) log('[readCsvData] CSV directory not found: ' + csvDir);
    return null;
  }

  try {
    var files = readdirSync(csvDir).filter(function(f) { return f.endsWith('.csv'); });
    if (files.length === 0) {
      if (log) log('[readCsvData] No CSV files found in ' + csvDir);
      return null;
    }

    var parts = [];
    for (var i = 0; i < files.length; i++) {
      var content = readFileSync(join(csvDir, files[i]), 'utf-8');
      parts.push('=== ' + files[i] + ' ===');
      parts.push(content.trim());
      parts.push('');
    }

    var result = parts.join('\n');
    if (log) log('[readCsvData] Read ' + files.length + ' CSV files, total ' + result.length + ' chars');
    return result;
  } catch (err) {
    if (log) log('[readCsvData] Error: ' + (err && err.message ? err.message : String(err)));
    return null;
  }
}

// ─── 主解析入口 ───────────────────────────────────────────────

async function parse(projectRoot, sessionId, reportDir, options) {
  // 分层解析：options.summaryOnly=true 时只解析 summary.txt，跳过 detail/grade/bins/csv
  var summaryOnly = !!(options && options.summaryOnly);
  var log = createDebugLogger(reportDir);

  log('=== Parse Start (summaryOnly=' + summaryOnly + ') ===');
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

  // 辅助函数：安全读取文本文件，跳过目录（IMC report_metrics 会生成目录而非文件）
  function safeReadTextFile(filePath, log, label) {
    if (!existsSync(filePath)) {
      log(label + ': NOT FOUND at ' + filePath);
      return '';
    }
    try {
      var stats = statSync(filePath);
      if (stats.isDirectory()) {
        log(label + ': is a DIRECTORY (not a file) at ' + filePath + ' — skipping');
        return '';
      }
      var content = readFileSync(filePath, 'utf-8');
      log(label + ': found, ' + content.length + ' chars');
      return content;
    } catch (e) {
      log(label + ': read error: ' + (e && e.message ? e.message : String(e)));
      return '';
    }
  }

  // 2. 尝试读取文本报告
  var summaryText = '';
  var detailText = '';

  var summaryPath = join(reportDir, 'summary.txt');
  var detailPath = join(reportDir, 'detail.txt');
  var metricsPath = join(reportDir, 'metrics.txt');

  // 使用 safeReadTextFile 安全读取，处理 IMC 可能生成目录而非文件的情况
  summaryText = safeReadTextFile(summaryPath, log, 'summary.txt');
  if (summaryText) {
    log('summary.txt first 500 chars:\n' + summaryText.substring(0, 500));
  }

  // 分层解析：summaryOnly 模式跳过 detail/metrics/grade/bins/csv
  if (!summaryOnly) {
    detailText = safeReadTextFile(detailPath, log, 'detail.txt');
    if (detailText) {
      log('detail.txt first 500 chars:\n' + detailText.substring(0, 500));
    }

    // metrics.txt 读取（仅用于 debug 日志，IMC report_metrics 可能生成目录）
    safeReadTextFile(metricsPath, log, 'metrics.txt');
  } else {
    log('[parse] summaryOnly mode — skipping detail/metrics/grade/bins/csv');
  }

  // 3. 解析文本报告
  var summaryMetrics = null;
  var summaryHierarchy = null;
  var detailResult = { nodes: [], tree: null };
  // urg text 报告目录解析结果（vcs-urg 路径，ADR 0021）
  var urgDirResult = null;

  if (edaTool === 'vcs-urg') {
    // 解析优先级（ADR 0024）：
    //   ① session.xml 存在 → XML 解析（确定性；解析失败直接抛错，不降级）
    //   ② 降级 → dashboard.txt + hierarchy.txt（启发式 text 路径，向后兼容）
    //   ③ 两者都缺失 → 报错（fail-closed）
    log('[parse] Using VCS urg report-directory parser (session.xml first)');
    var sessionXmlText = safeReadTextFile(join(reportDir, 'session.xml'), log, 'session.xml');
    if (sessionXmlText) {
      // ① XML 优先路径：summary + 层级树来自 session.xml；.dat 未覆盖项仍从目录解析
      var urgXml = parseUrgSessionXml(sessionXmlText, log);
      summaryMetrics = urgXml.summary;
      summaryHierarchy = { tree: urgXml.tree };
      urgDirResult = {
        summary: urgXml.summary,
        tree: urgXml.tree,
        uncovered: parseUrgDatFiles(reportDir, log, !summaryOnly),
        filesSeen: ['session.xml'],
      };
    } else {
      // ② text 降级路径：dashboard.txt / hierarchy.txt / *.dat
      urgDirResult = parseUrgReportDir(reportDir, log, !summaryOnly);
      summaryMetrics = urgDirResult.summary;
      summaryHierarchy = urgDirResult.tree ? { tree: urgDirResult.tree } : null;
      // 兼容：若目录内没有 dashboard/hierarchy（如旧版模板写了 summary.txt），
      // 退回旧行为解析 summary.txt
      if (!summaryMetrics && summaryText) {
        var urgLegacy = parseUrgReport(summaryText, log);
        summaryMetrics = urgLegacy.summary;
      }
      // ③ session.xml 与 text 报告全部缺失 → 报错（fail-closed，不让空数据流入闭环）
      if (!summaryMetrics && !summaryHierarchy) {
        throw new Error(
          'urg 报告目录解析失败：缺少 session.xml，且未找到可解析的 dashboard.txt/hierarchy.txt 文本报告（reportDir=' + reportDir + '）',
        );
      }
    }
  } else if (summaryText) {
    if (edaTool === 'imc') {
      log('[parse] Using IMC summary parser');
      summaryHierarchy = parseImcHierarchySummary(summaryText, log);
      summaryMetrics = summaryHierarchy ? summaryHierarchy.metrics : parseImcSummary(summaryText, log);
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

  // 3b. 读取并解析新增报告（grade / bins / csv）
  // 分层解析：summaryOnly 模式跳过这些报告
  var testContributions = null;
  var uncoveredBins = null;
  var csvData = null;

  if (!summaryOnly) {
    // grade 报告（urg 默认命令输出到 {reportDir}/grade/ 子目录，其次查根目录与 gradedtests.txt）
    var gradeCandidates = [
      join(reportDir, 'grade', 'grade.txt'),
      join(reportDir, 'grade', 'gradedtests.txt'),
      join(reportDir, 'grade.txt'),
      join(reportDir, 'gradedtests.txt'),
    ];
    var gradeText = '';
    for (var gi = 0; gi < gradeCandidates.length && !gradeText; gi++) {
      gradeText = safeReadTextFile(gradeCandidates[gi], log, 'grade:' + gradeCandidates[gi]);
    }
    if (gradeText) {
      testContributions = parseGradeReport(gradeText, log);
    }

    // bins 报告
    var binsPath = join(reportDir, 'bins.txt');
    var binsText = safeReadTextFile(binsPath, log, 'bins.txt');
    if (binsText) {
      uncoveredBins = parseBinsReport(binsText, log);
    }

    // CSV 数据
    var csvDir = join(reportDir, 'csv');
    csvData = readCsvData(csvDir, log);
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
  } else if (summaryHierarchy && summaryHierarchy.tree) {
    root = summaryHierarchy.tree;
    root.metrics = rootMetrics;
    log('[parse] Using summary hierarchy as root, root.name=' + root.name + ', children=' + root.children.length);
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

  // 6. 构建 uncovered 项（优先 urg .dat 文件级未覆盖，其次 bins 报告）
  var uncovered = undefined;
  if (urgDirResult && urgDirResult.uncovered) {
    uncovered = urgDirResult.uncovered;
    var urgCount = 0;
    for (var uk in uncovered) {
      if (uncovered[uk]) urgCount += uncovered[uk].length;
    }
    log('[parse] Added ' + urgCount + ' uncovered items from urg .dat files');
  } else if (uncoveredBins && uncoveredBins.length > 0) {
    uncovered = { functional: uncoveredBins };
    log('[parse] Added ' + uncoveredBins.length + ' uncovered bins from bins report');
  }

  return {
    sessionId: sessionId,
    source: {
      covMergeDir: covMergeDir || '',
      edaTool: edaTool,
      reportGeneratedAt: Date.now(),
    },
    root: root,
    targets: {},
    uncovered: uncovered,
    testContributions: testContributions || undefined,
    csvData: csvData || undefined,
    // 标记本次解析的模式：true=仅解析了summary，detail/grade/bins/csv未解析
    summaryOnly: summaryOnly,
  };
}

module.exports = {
  manifest: MANIFEST,
  parse: parse,
  // 导出内部函数供按需调用
  parseImcHierarchySummary: parseImcHierarchySummary,
  parseImcSummary: parseImcSummary,
  parseImcDetail: parseImcDetail,
  parseGradeReport: parseGradeReport,
  parseBinsReport: parseBinsReport,
  readCsvData: readCsvData,
  parseUrgDashboard: parseUrgDashboard,
  parseUrgHierarchy: parseUrgHierarchy,
  parseUrgHierarchyLine: parseUrgHierarchyLine,
  parseUrgFileLine: parseUrgFileLine,
  parseUrgReportDir: parseUrgReportDir,
  parseXmlDocument: parseXmlDocument,
  parseUrgSessionXml: parseUrgSessionXml,
};
