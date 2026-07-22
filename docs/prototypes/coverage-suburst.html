<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SoC Verify · 覆盖率旭日图原型</title>
<style>
  :root {
    --bg: oklch(0.14 0.006 250);
    --bg-surface: oklch(0.18 0.006 250);
    --bg-elevated: oklch(0.21 0.007 250);
    --fg: oklch(0.94 0.004 250);
    --fg-dim: oklch(0.62 0.008 250);
    --fg-faint: oklch(0.42 0.006 250);
    --border: oklch(0.25 0.007 250);
    --c-pass: oklch(0.62 0.14 145);
    --c-warn: oklch(0.70 0.13 85);
    --c-fail: oklch(0.58 0.15 25);
    --c-na: oklch(0.35 0.005 250);
    --c-accent: oklch(0.68 0.14 250);
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    --mono: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: var(--sans); padding: 24px; font-size: 13px;
  }
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
  .header h1 { font-size: 18px; font-weight: 700; }
  .header .badge { font-size: 10px; font-weight: 600; padding: 3px 10px; border-radius: 12px; background: var(--bg-elevated); color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.05em; }

  .toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .toolbar select { background: var(--bg-surface); border: 1px solid var(--border); color: var(--fg); font-size: 12px; padding: 5px 10px; border-radius: 6px; }
  .metric-tabs { display: flex; gap: 6px; }
  .metric-tab { font-size: 11px; padding: 4px 12px; border-radius: 6px; cursor: pointer; background: var(--bg-surface); border: 1px solid var(--border); color: var(--fg-dim); transition: all 0.15s; }
  .metric-tab.active { color: var(--c-accent); border-color: var(--c-accent); background: oklch(0.21 0.03 250); }

  .main-layout { display: grid; grid-template-columns: 1fr 320px; gap: 16px; }

  .sunburst-container {
    background: var(--bg-surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 24px; display: flex;
    flex-direction: column; align-items: center; justify-content: center;
    min-height: 480px; position: relative;
  }
  .sunburst-container svg { max-width: 100%; }
  .sunburst-center {
    position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%); text-align: center;
    pointer-events: none;
  }
  .sunburst-center .center-label { font-size: 10px; color: var(--fg-faint); text-transform: uppercase; letter-spacing: 0.05em; }
  .sunburst-center .center-value { font-family: var(--mono); font-size: 28px; font-weight: 700; margin-top: 4px; }
  .sunburst-center .center-module { font-size: 10px; color: var(--fg-dim); margin-top: 2px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; }

  /* Detail panel */
  .detail-panel {
    background: var(--bg-surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 14px;
  }
  .detail-panel .dp-header { display: flex; align-items: center; justify-content: space-between; }
  .detail-panel .dp-title { font-size: 13px; font-weight: 600; }
  .detail-panel .dp-path { font-size: 10px; color: var(--fg-faint); font-family: var(--mono); word-break: break-all; }
  .detail-panel .dp-metrics { display: flex; flex-direction: column; gap: 8px; }
  .dp-metric-row { display: flex; align-items: center; gap: 8px; }
  .dp-metric-row .dm-label { font-size: 11px; color: var(--fg-dim); min-width: 80px; }
  .dp-metric-row .dm-bar { flex: 1; height: 6px; border-radius: 3px; background: var(--bg-elevated); overflow: hidden; }
  .dp-metric-row .dm-bar-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
  .dp-metric-row .dm-value { font-family: var(--mono); font-size: 11px; font-weight: 600; min-width: 70px; text-align: right; }
  .dp-metric-row .dm-value .count { font-size: 9px; color: var(--fg-faint); }

  .dp-uncovered { margin-top: 8px; }
  .dp-uncovered-title { font-size: 10px; font-weight: 600; color: var(--fg-faint); text-transform: uppercase; margin-bottom: 6px; }
  .dp-uncovered-list { display: flex; flex-direction: column; gap: 3px; max-height: 180px; overflow-y: auto; }
  .dp-uncovered-item { font-family: var(--mono); font-size: 10px; color: var(--fg-dim); padding: 4px 6px; border-radius: 4px; background: var(--bg-elevated); }

  .legend { display: flex; gap: 16px; margin-top: 12px; font-size: 10px; color: var(--fg-dim); }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .legend-dot { width: 8px; height: 8px; border-radius: 50%; }
  .legend-dot.pass { background: var(--c-pass); }
  .legend-dot.warn { background: var(--c-warn); }
  .legend-dot.fail { background: var(--c-fail); }
  .legend-dot.na { background: var(--c-na); }

  .sunburst-arc { cursor: pointer; transition: opacity 0.15s; }
  .sunburst-arc:hover { opacity: 0.8; }
  .sunburst-arc.selected { stroke: var(--fg); stroke-width: 1.5; }
</style>
</head>
<body>

<div class="header">
  <h1>覆盖率分析 · 旭日图布局</h1>
  <span class="badge">方案 B</span>
</div>

<div class="toolbar">
  <select>
    <option>Session: 2024-01-15_merge_001</option>
    <option>Session: 2024-01-10_merge_002</option>
  </select>
  <div class="metric-tabs" id="metricTabs"></div>
</div>

<div class="main-layout">
  <div class="sunburst-container">
    <svg id="sunburst" width="440" height="440" viewBox="-220 -220 440 440"></svg>
    <div class="sunburst-center" id="sunburstCenter">
      <div class="center-label">Overall</div>
      <div class="center-value" id="centerValue">--</div>
      <div class="center-module" id="centerModule">tb_top</div>
    </div>
  </div>

  <div class="detail-panel" id="detailPanel">
    <div class="dp-header">
      <div>
        <div class="dp-title" id="dpTitle">tb_top</div>
        <div class="dp-path" id="dpPath">tb_top</div>
      </div>
    </div>
    <div class="dp-metrics" id="dpMetrics"></div>
    <div class="dp-uncovered" id="dpUncovered" style="display:none;">
      <div class="dp-uncovered-title">未覆盖项</div>
      <div class="dp-uncovered-list" id="dpUncoveredList"></div>
    </div>
  </div>
</div>

<div class="legend">
  <div class="legend-item"><span class="legend-dot pass"></span>达标</div>
  <div class="legend-item"><span class="legend-dot warn"></span>接近目标</div>
  <div class="legend-item"><span class="legend-dot fail"></span>未达标</div>
  <div class="legend-item"><span class="legend-dot na"></span>N/A</div>
</div>

<script>
const TARGETS = { line: 95, branch: 90, toggle: 85, condition: 85, fsm_state: 100, fsm_transition: 90, functional: 100, assertion: null };
const METRICS = ['line', 'branch', 'toggle', 'condition', 'fsm_state', 'fsm_transition', 'functional', 'assertion'];
const METRIC_LABELS = { line: 'Line', branch: 'Branch', toggle: 'Toggle', condition: 'Cond', fsm_state: 'FSM St', fsm_transition: 'FSM Tr', functional: 'Func', assertion: 'Assert' };

const tree = {
  name: 'tb_top', children: [
    { name: 'chip_top', children: [
      { name: 'dut', children: [
        { name: 'u_analog_bb_line_usb', m: { line: { p: 87.5, c: 13, t: 15 }, branch: { p: 80, c: 8, t: 10 }, toggle: { p: 75, c: 30, t: 40 }, condition: { p: 70, c: 7, t: 10 } } } },
        { name: 'u_analog_bb_line_pciepl', m: { line: { p: 87.5, c: 13, t: 15 }, branch: { p: 80, c: 8, t: 10 }, toggle: { p: 75, c: 30, t: 40 }, condition: { p: 70, c: 7, t: 10 } } } },
        { name: 'u_block_wrap_0', children: [
          { name: 'u_analog_mipi_mphy_2t2r', m: { line: { p: 58.42, c: 482, t: 825 }, branch: { p: 52.1, c: 350, t: 672 }, toggle: { p: 45.3, c: 1200, t: 2650 }, condition: { p: 48, c: 96, t: 200 }, fsm_state: { p: 66.7, c: 4, t: 6 }, fsm_transition: { p: 40, c: 6, t: 15 }, assertion: { p: 50, c: 3, t: 6 } } } },
          { name: 'u_g3_side_glue_wrap', m: { line: { p: 57.38, c: 1007, t: 1755 }, branch: { p: 50.2, c: 700, t: 1393 }, toggle: { p: 42.1, c: 2500, t: 5940 }, condition: { p: 45, c: 180, t: 400 } } } },
          { name: 'analog_mipi_mphy_2t2r_glue', m: { line: { p: 96.88, c: 225, t: 239 }, branch: { p: 92, c: 161, t: 175 }, toggle: { p: 88.5, c: 450, t: 508 }, condition: { p: 90, c: 45, t: 50 } } } },
          { name: 'analog_mipi_mphy_2t2r_0_collar', m: { line: { p: 84.23, c: 963, t: 1640 }, branch: { p: 78.5, c: 630, t: 802 }, toggle: { p: 72, c: 1800, t: 2500 }, condition: { p: 75, c: 150, t: 200 } } } },
          { name: 'u_anlg_phy_g3_rf', m: { line: { p: 79.97, c: 1540, t: 1974 }, branch: { p: 72.3, c: 1100, t: 1521 }, toggle: { p: 68.5, c: 3200, t: 4672 }, condition: { p: 70, c: 280, t: 400 }, fsm_state: { p: 80, c: 8, t: 10 }, fsm_transition: { p: 65, c: 13, t: 20 } } } },
          { name: 'u_reg_dec', m: { line: { p: 98.76, c: 159, t: 161 }, branch: { p: 96, c: 96, t: 100 }, toggle: { p: 92, c: 230, t: 250 }, condition: { p: 95, c: 38, t: 40 } } } },
          { name: 'u_analog_mipi_mphy_2t2r_glue_logic', m: { line: { p: 86.75, c: 720, t: 905 }, branch: { p: 80, c: 560, t: 700 }, toggle: { p: 78, c: 1400, t: 1795 }, condition: { p: 82, c: 164, t: 200 } } } },
          { name: 'u_cgm_mux2x_mphy_cb_cfgclk', m: { line: { p: 80, c: 4, t: 5 }, branch: { p: 75, c: 3, t: 4 }, toggle: { p: 70, c: 14, t: 20 } } } },
          { name: 'u_clk_gate_reg_read', m: { line: { p: 100, c: 4, t: 4 }, branch: { p: 100, c: 2, t: 2 }, toggle: { p: 100, c: 8, t: 8 } } } },
        ], m: { line: { p: 60.04, c: 323, t: 538 }, branch: { p: 52, c: 260, t: 500 }, toggle: { p: 48, c: 800, t: 1667 }, condition: { p: 50, c: 100, t: 200 }, fsm_state: { p: 66.7, c: 4, t: 6 }, fsm_transition: { p: 40, c: 6, t: 15 }, assertion: { p: 50, c: 3, t: 6 } } } },
      ], m: { line: { p: 93.07, c: 349, t: 375 }, branch: { p: 88, c: 440, t: 500 }, toggle: { p: 82, c: 1230, t: 1500 }, condition: { p: 85, c: 170, t: 200 }, fsm_state: { p: 80, c: 8, t: 10 }, fsm_transition: { p: 65, c: 13, t: 20 }, assertion: { p: 50, c: 3, t: 6 } } } },
    ], m: null },
  ], m: null
};

let currentMetric = 'line';
let selectedNode = null;

function classifyMetric(metric, val) {
  if (!val) return 'na';
  const target = TARGETS[metric];
  if (target === null) return val.p >= 90 ? 'pass' : val.p >= 80 ? 'warn' : 'fail';
  if (val.p >= target) return 'pass';
  if (val.p >= target - 5) return 'warn';
  return 'fail';
}

function getColor(cls) {
  return { pass: 'var(--c-pass)', warn: 'var(--c-warn)', fail: 'var(--c-fail)', na: 'var(--c-na)' }[cls];
}

function getColorOklch(cls) {
  return { pass: 'oklch(0.62 0.14 145)', warn: 'oklch(0.70 0.13 85)', fail: 'oklch(0.58 0.15 25)', na: 'oklch(0.35 0.005 250)' }[cls];
}

// Flatten tree into arcs for sunburst
function flattenTree(node, depth = 0, startAngle = 0, endAngle = 360, path = '') {
  const arcs = [];
  const myPath = path ? `${path}.${node.name}` : node.name;

  // This node's arc
  arcs.push({ node, depth, startAngle, endAngle, path: myPath });

  if (node.children && node.children.length > 0) {
    const childCount = node.children.length;
    const anglePerChild = (endAngle - startAngle) / childCount;
    for (let i = 0; i < childCount; i++) {
      const childStart = startAngle + i * anglePerChild;
      const childEnd = childStart + anglePerChild;
      arcs.push(...flattenTree(node.children[i], depth + 1, childStart, childEnd, myPath));
    }
  }
  return arcs;
}

function polarToCartesian(angle, radius) {
  const rad = (angle - 90) * Math.PI / 180;
  return { x: radius * Math.cos(rad), y: radius * Math.sin(rad) };
}

function arcPath(startAngle, endAngle, innerRadius, outerRadius) {
  const start = polarToCartesian(startAngle, outerRadius);
  const end = polarToCartesian(endAngle, outerRadius);
  const startInner = polarToCartesian(startAngle, innerRadius);
  const endInner = polarToCartesian(endAngle, innerRadius);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${end.x} ${end.y} L ${endInner.x} ${endInner.y} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${startInner.x} ${startInner.y} Z`;
}

function renderSunburst() {
  const svg = document.getElementById('sunburst');
  svg.innerHTML = '';
  const arcs = flattenTree(tree);
  const maxDepth = Math.max(...arcs.map(a => a.depth));
  const ringWidth = 60;
  const innerRadius = 40;

  for (const arc of arcs) {
    const innerR = innerRadius + arc.depth * ringWidth;
    const outerR = innerR + ringWidth - 4;
    const val = arc.node.m ? arc.node.m[currentMetric] : null;
    const cls = classifyMetric(currentMetric, val);
    const color = getColorOklch(cls);

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', arcPath(arc.startAngle, arc.endAngle, innerR, outerR));
    path.setAttribute('fill', color);
    path.setAttribute('opacity', val ? '0.85' : '0.3');
    path.setAttribute('class', 'sunburst-arc');
    path.setAttribute('data-name', arc.node.name);
    path.setAttribute('data-path', arc.path);
    path.addEventListener('click', () => selectNode(arc.node, arc.path));
    path.addEventListener('mouseenter', () => hoverNode(arc.node));
    svg.appendChild(path);

    // Label for larger arcs
    if (arc.endAngle - arc.startAngle > 15 && arc.depth > 0) {
      const midAngle = (arc.startAngle + arc.endAngle) / 2;
      const labelR = (innerR + outerR) / 2;
      const pos = polarToCartesian(midAngle, labelR);
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', pos.x);
      text.setAttribute('y', pos.y);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.setAttribute('fill', 'oklch(0.95 0 0)');
      text.setAttribute('font-size', '8');
      text.setAttribute('font-family', 'var(--mono)');
      text.setAttribute('pointer-events', 'none');
      text.textContent = arc.node.name.length > 12 ? arc.node.name.slice(0, 10) + '..' : arc.node.name;
      svg.appendChild(text);
    }
  }

  // Center text
  updateCenter(tree, 'tb_top');
}

function updateCenter(node, path) {
  const val = node.m ? node.m[currentMetric] : null;
  const centerVal = document.getElementById('centerValue');
  const centerMod = document.getElementById('centerModule');
  if (val) {
    centerVal.textContent = val.p.toFixed(1) + '%';
    centerVal.style.color = getColor(classifyMetric(currentMetric, val));
  } else {
    centerVal.textContent = 'n/a';
    centerVal.style.color = 'var(--c-na)';
  }
  document.getElementById('centerValue').previousElementSibling.textContent = METRIC_LABELS[currentMetric];
  centerMod.textContent = node.name;
}

function hoverNode(node) {
  updateCenter(node, node.name);
}

function selectNode(node, path) {
  selectedNode = node;
  document.querySelectorAll('.sunburst-arc').forEach(a => a.classList.remove('selected'));
  document.querySelector(`[data-path="${path}"]`)?.classList.add('selected');
  renderDetail(node, path);
}

function renderDetail(node, path) {
  document.getElementById('dpTitle').textContent = node.name;
  document.getElementById('dpPath').textContent = path;

  const metricsEl = document.getElementById('dpMetrics');
  metricsEl.innerHTML = '';
  for (const m of METRICS) {
    const val = node.m ? node.m[m] : null;
    const cls = classifyMetric(m, val);
    const color = getColor(cls);
    const pct = val ? val.p.toFixed(1) + '%' : 'n/a';
    const count = val ? `(${val.c}/${val.t})` : '';
    metricsEl.innerHTML += `
      <div class="dp-metric-row">
        <span class="dm-label">${METRIC_LABELS[m]}</span>
        <div class="dm-bar"><div class="dm-bar-fill" style="width:${val ? val.p : 0}%;background:${color}"></div></div>
        <span class="dm-value" style="color:${color}">${pct}<br><span class="count">${count}</span></span>
      </div>`;
  }

  // Uncovered items (mock)
  const uncovEl = document.getElementById('dpUncovered');
  const uncovList = document.getElementById('dpUncoveredList');
  if (node.m && node.m.line && node.m.line.p < 95) {
    uncovEl.style.display = 'block';
    uncovList.innerHTML = `
      <div class="dp-uncovered-item">${node.name}.sv:45 — 未覆盖的 if 分支</div>
      <div class="dp-uncovered-item">${node.name}.sv:128 — 未执行的 always 块</div>
      <div class="dp-uncovered-item">${node.name}.sv:203 — case 默认分支</div>`;
  } else {
    uncovEl.style.display = 'none';
  }
}

// Metric tabs
const tabsEl = document.getElementById('metricTabs');
for (const m of METRICS) {
  const tab = document.createElement('div');
  tab.className = 'metric-tab' + (m === currentMetric ? ' active' : '');
  tab.textContent = METRIC_LABELS[m];
  tab.addEventListener('click', () => {
    currentMetric = m;
    document.querySelectorAll('.metric-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    renderSunburst();
    if (selectedNode) renderDetail(selectedNode, selectedNode.name);
  });
  tabsEl.appendChild(tab);
}

renderSunburst();
renderDetail(tree, 'tb_top');
</script>

</body>
</html>
