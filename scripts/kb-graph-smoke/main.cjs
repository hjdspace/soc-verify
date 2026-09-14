/**
 * 图视图冒烟：在真实 Electron 运行时里驱动真实 KbWikiGraph（issue 26 / spec §11）。
 *
 * 用法（由 scripts/kb-graph-smoke.mjs 编排，不单独手跑）：
 *   electron scripts/kb-graph-smoke/main.cjs --scenario=webgl \
 *     --harness=<构建产物目录> --out=<报告 json 路径>
 *
 * 场景：
 *   webgl     —— WebGL 可用：画布渲染 + worker 布局 + 真实鼠标命中/拖拽 + 卸载释放
 *   no-webgl  —— WebGL 被禁用：邻接列表降级 + 不创建 worker/上下文
 *   large     —— 1000 页 / 10000 边：首个可交互画面耗时 + 预算裁剪与展开
 *
 * 断言全部在这里，harness 侧只提供控制面；同时拦截网络请求证明无 CDN。
 */

const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const scenario = argValue('scenario', 'webgl');
const harnessDir = argValue('harness', path.join(__dirname, '..', '..', 'dist', 'kb-graph-smoke'));
const outFile = argValue('out', '');
const repositoryRoot = path.resolve(__dirname, '..', '..');

const report = {
  scenario,
  ok: false,
  // 运行时自描述：证据要能独立说明「在哪个 Electron/Chromium 上跑出来的」
  runtime: {
    electron: process.versions.electron ?? null,
    chrome: process.versions.chrome ?? null,
    node: process.versions.node ?? null,
  },
  checks: [],
  metrics: {},
  diagnostics: { console: [], requests: [], failures: [] },
};

function check(name, ok, detail) {
  report.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  return Boolean(ok);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 单实例与 GPU/沙箱开关（冒烟专用）──────────────────────────
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let win = null;

async function evaluate(expression) {
  const payload = await win.webContents.executeJavaScript(
    `(() => {
      try {
        const value = (${expression});
        return JSON.stringify(value === undefined ? null : value);
      } catch (error) {
        return JSON.stringify({ __error: String(error) });
      }
    })()`,
    true,
  );
  const parsed = JSON.parse(payload);
  if (parsed && typeof parsed === 'object' && '__error' in parsed) {
    throw new Error(`页面求值失败：${parsed.__error}`);
  }
  return parsed;
}

async function waitFor(expression, label, timeoutMs = 20000) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < timeoutMs) {
    last = await evaluate(expression);
    if (last) return last;
    await sleep(50);
  }
  throw new Error(`等待超时（${label}）：${expression}`);
}

async function canvasBounds() {
  return evaluate(`(() => {
    const host = document.querySelector('[data-testid=kb-graph-canvas]');
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`);
}

function send(type, x, y) {
  win.webContents.sendInputEvent({
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: 'left',
    clickCount: 1,
  });
}

async function clickAt(x, y) {
  send('mouseMove', x, y);
  await sleep(20);
  send('mouseDown', x, y);
  await sleep(30);
  send('mouseUp', x, y);
  await sleep(120);
}

/**
 * 真实鼠标命中：先用「选择 → 聚焦」把目标节点移到视口中心并清空选中，
 * 再用真实输入事件点击中心（含小范围栅格重试），证明点选走的是 sigma 命中测试。
 */
async function hitTestSelect(pageId, bounds) {
  await evaluate(`window.__kbGraphSmoke.select(${JSON.stringify(pageId)})`);
  await sleep(600); // 等待相机动画（300ms）结束
  await evaluate(`window.__kbGraphSmoke.select(null)`);
  await sleep(80);

  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const offsets = [
    [0, 0],
    [0, -6], [0, 6], [-6, 0], [6, 0],
    [0, -14], [0, 14], [-14, 0], [14, 0],
    [0, -24], [0, 24], [-24, 0], [24, 0],
  ];
  for (const [dx, dy] of offsets) {
    await clickAt(centerX + dx, centerY + dy);
    const selected = await evaluate(`window.__kbGraphSmoke.state().selectedPageId`);
    if (selected !== null) {
      if (selected !== pageId) {
        report.diagnostics.failures.push(`命中节点为 ${selected}（期望 ${pageId}）`);
      }
      return { hit: true, dx, dy, selected, expected: selected === pageId };
    }
  }
  return { hit: false };
}

// ── 场景实现 ────────────────────────────────────────────────

async function assertCspMatchesApplication() {
  const appHtml = fs.readFileSync(path.join(repositoryRoot, 'src', 'renderer', 'index.html'), 'utf8');
  const extract = (html) => {
    const match = html.match(/http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/);
    return match ? match[1].replace(/\s+/g, ' ').trim() : null;
  };
  const appCsp = extract(appHtml);
  const harnessCsp = await evaluate(
    `document.querySelector('meta[http-equiv="Content-Security-Policy"]').getAttribute('content').replace(/\\s+/g, ' ').trim()`,
  );
  check('harness 使用与产品一致的 CSP', appCsp !== null && appCsp === harnessCsp, { appCsp, harnessCsp });
}

async function assertNoRemoteRequests() {
  const remote = report.diagnostics.requests.filter((url) => /^https?:/i.test(url));
  check('无任何 http(s) 远程请求（无 CDN）', remote.length === 0, remote.length === 0 ? undefined : remote);
  const cspViolations = report.diagnostics.console.filter((line) => /Content Security Policy|Refused to/i.test(line));
  check('无 CSP 拦截日志', cspViolations.length === 0, cspViolations.length === 0 ? undefined : cspViolations);
}

async function scenarioWebgl() {
  await evaluate(`window.__kbGraphSmoke.mount('small')`);
  const fixture = await evaluate(`window.__kbGraphSmoke.fixtureInfo()`);

  const firstFrameMs = await waitFor(
    `window.__kbGraphSmoke.state().firstFrameMs`,
    '首个可交互画面（small）',
  );
  report.metrics.firstFrameMs = firstFrameMs;
  report.metrics.fixture = fixture;
  check('首个可交互画面已记录（非组件挂载）', typeof firstFrameMs === 'number' && firstFrameMs >= 0, firstFrameMs);
  check('首个可交互画面 ≤ 3000ms', firstFrameMs <= 3000, firstFrameMs);

  const canvases = await evaluate(`document.querySelectorAll('[data-testid=kb-graph-canvas] canvas').length`);
  report.metrics.canvasCount = canvases;
  check('画布已渲染（sigma canvas 存在）', canvases >= 1, canvases);

  const glInfo = await evaluate(`(() => {
    const canvas = document.querySelector('[data-testid=kb-graph-canvas] canvas');
    const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      version: gl.getParameter(gl.VERSION),
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
    };
  })()`);
  report.metrics.webgl = glInfo;
  check('画布拿到 WebGL 上下文', glInfo !== null, glInfo);

  const layoutChannel = await waitFor(
    `window.__kbGraphSmoke.state().layoutChannel`,
    'worker 布局结果',
  );
  report.metrics.layoutChannel = layoutChannel;
  check('布局在 worker 中完成', layoutChannel === 'worker', layoutChannel);

  const workerStats = await evaluate(`window.__kbGraphStats.workers`);
  report.metrics.workers = workerStats;
  check('创建了布局 worker', workerStats.created >= 1, workerStats.created);
  check('worker 投递了布局请求', workerStats.postMessages >= 1, workerStats.postMessages);
  const remoteWorker = workerStats.urls.filter((url) => !url.startsWith('file:'));
  check('worker 脚本为本地资源（file://）', remoteWorker.length === 0, workerStats.urls);

  // ── 真实鼠标命中（画布点选）─────────────────────────────────
  const bounds = await canvasBounds();
  check('画布容器有可用尺寸', Boolean(bounds) && bounds.width > 100 && bounds.height > 100, bounds);
  const hit = await hitTestSelect(fixture.hubPageId, bounds);
  report.metrics.hitTest = hit;
  check('画布上真实点选命中节点', hit.hit, hit);
  check('点中的是期望的枢纽节点', hit.expected === true, hit);

  const detailTitle = await evaluate(`(() => {
    const el = document.querySelector('[data-testid=kb-graph-detail-title]');
    return el ? el.textContent : null;
  })()`);
  check('点选后详情面板显示节点', detailTitle !== null, detailTitle);

  const bridgeHint = await evaluate(`(() => {
    const el = document.querySelector('[data-testid=kb-graph-detail-bridge-hint]');
    return el ? el.textContent : null;
  })()`);
  check('桥接线索以启发式文案呈现', typeof bridgeHint === 'string' && bridgeHint.includes('启发式建议'), bridgeHint);

  // ── 真实鼠标拖拽 ───────────────────────────────────────────
  await sleep(500); // 等相机动画结束，避免拖拽中途画面还在移
  const beforeDrag = await evaluate(`window.__kbGraphSmoke.state().manualLayoutCount`);
  check('点选不会被记成手动调整布局', beforeDrag === 0, beforeDrag);
  const dragX = bounds.x + bounds.width / 2 + (hit.dx ?? 0);
  const dragY = bounds.y + bounds.height / 2 + (hit.dy ?? 0);
  send('mouseMove', dragX, dragY);
  await sleep(30);
  send('mouseDown', dragX, dragY);
  await sleep(40);
  send('mouseMove', dragX + 70, dragY + 45);
  await sleep(40);
  send('mouseMove', dragX + 110, dragY + 70);
  await sleep(40);
  send('mouseUp', dragX + 110, dragY + 70);
  await sleep(200);
  const afterDrag = await evaluate(`window.__kbGraphSmoke.state().manualLayoutCount`);
  report.metrics.drag = { beforeDrag, afterDrag };
  check('拖动节点被面板观测到', afterDrag > beforeDrag, report.metrics.drag);

  const resetVisible = await evaluate(`!!document.querySelector('[data-testid=kb-graph-reset-layout]')`);
  if (resetVisible) {
    await evaluate(`document.querySelector('[data-testid=kb-graph-reset-layout]').click()`);
    await sleep(150);
  }
  const afterReset = await evaluate(`window.__kbGraphSmoke.state().manualLayoutCount`);
  check('可回到自动布局', resetVisible ? afterReset === 0 : true, { resetVisible, afterReset });

  // ── 类型过滤（真实点击）────────────────────────────────────
  await evaluate(`document.querySelector('[data-testid=kb-graph-type-source]').click()`);
  await sleep(150);
  const coverageAfterFilter = await evaluate(`document.querySelector('[data-testid=kb-graph-coverage]').textContent`);
  report.metrics.coverageAfterFilter = coverageAfterFilter;
  check('类型过滤生效', coverageAfterFilter.includes('共 1 页'), coverageAfterFilter);
  await evaluate(`document.querySelector('[data-testid=kb-graph-type-source]').click()`);
  await sleep(150);

  // ── 社区着色（真实点击）────────────────────────────────────
  await evaluate(`document.querySelector('[data-testid=kb-graph-color-community]').click()`);
  await sleep(150);
  const colorMode = await evaluate(`window.__kbGraphSmoke.state().colorMode`);
  check('社区着色模式可切换', colorMode === 'community', colorMode);

  // ── 卸载释放 ───────────────────────────────────────────────
  await evaluate(`window.__kbGraphSmoke.unmount()`);
  await sleep(400);
  const afterUnmount = {
    canvases: await evaluate(`document.querySelectorAll('[data-testid=kb-graph-canvas] canvas').length`),
    workers: await evaluate(`window.__kbGraphStats.workers`),
    lostContexts: await evaluate(`window.__kbGraphLostContexts()`),
    contexts: await evaluate(`window.__kbGraphStats.contexts.created`),
  };
  report.metrics.afterUnmount = afterUnmount;
  check('卸载后画布被移除', afterUnmount.canvases === 0, afterUnmount.canvases);
  check('卸载后 worker 被终止', afterUnmount.workers.terminated >= afterUnmount.workers.created, afterUnmount.workers);
  check('卸载后 WebGL 上下文被释放', afterUnmount.lostContexts >= 1, {
    lost: afterUnmount.lostContexts,
    created: afterUnmount.contexts,
  });

  await assertCspMatchesApplication();
  await assertNoRemoteRequests();
}

async function scenarioNoWebgl() {
  await evaluate(`window.__kbGraphSmoke.mount('small')`);
  await waitFor(`window.__kbGraphSmoke.state().nodeCount > 0`, '快照加载');
  await sleep(400);

  const adjacency = await evaluate(`!!document.querySelector('[data-testid=kb-graph-adjacency]')`);
  check('WebGL 不可用时给出邻接列表', adjacency === true, adjacency);

  const notice = await evaluate(`(() => {
    const el = document.querySelector('[data-testid=kb-graph-webgl-notice]');
    return el ? el.textContent : null;
  })()`);
  check('错误原因可观察', typeof notice === 'string' && notice.includes('不可用 WebGL'), notice);

  const workers = await evaluate(`window.__kbGraphStats.workers`);
  check('降级路径不创建 worker', workers.created === 0, workers.created);
  const contexts = await evaluate(`window.__kbGraphStats.contexts.created`);
  check('降级路径不创建 WebGL 上下文', contexts === 0, contexts);
  const canvases = await evaluate(`document.querySelectorAll('[data-testid=kb-graph-canvas] canvas').length`);
  check('降级路径不渲染画布', canvases === 0, canvases);

  // 邻接列表里真实点击节点 → 详情 → 打开知识页
  const rowClicked = await evaluate(`(() => {
    const row = document.querySelector('[data-testid="kb-graph-adjacency-row-concepts/hub"]');
    if (!row) return false;
    const button = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === '时钟复位枢纽');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  check('邻接列表可选中节点', rowClicked === true);
  await sleep(150);
  const selected = await evaluate(`window.__kbGraphSmoke.state().selectedPageId`);
  check('选中状态进入 store', selected === 'concepts/hub', selected);

  await evaluate(`document.querySelector('[data-testid=kb-graph-detail-open-page]').click()`);
  await sleep(150);
  const opened = await evaluate(`window.__kbGraphSmoke.openedPages()`);
  check('节点跳转回调收到 pageId', opened.includes('concepts/hub'), opened);

  await assertCspMatchesApplication();
  await assertNoRemoteRequests();
}

async function scenarioLarge() {
  await evaluate(`window.__kbGraphSmoke.mount('large')`);
  const fixture = await evaluate(`window.__kbGraphSmoke.fixtureInfo()`);
  report.metrics.fixture = fixture;
  check('大规模 fixture 为 1000 页 / 10000 边', fixture.nodeCount === 1000 && fixture.edgeCount >= 9000, fixture);

  const firstFrameMs = await waitFor(
    `window.__kbGraphSmoke.state().firstFrameMs`,
    '首个可交互画面（1000 页）',
  );
  report.metrics.firstFrameMs = firstFrameMs;
  check('首个可交互画面 ≤ 3000ms', firstFrameMs <= 3000, firstFrameMs);

  const coverageBefore = await evaluate(`document.querySelector('[data-testid=kb-graph-coverage]').textContent`);
  report.metrics.coverageBefore = coverageBefore;
  check('大图先按预算裁剪', coverageBefore.includes('其余 600 页待展开'), coverageBefore);

  const layoutChannel = await waitFor(`window.__kbGraphSmoke.state().layoutChannel`, 'worker 布局结果', 30000);
  report.metrics.layoutChannel = layoutChannel;
  check('大图布局在 worker 中完成', layoutChannel === 'worker', layoutChannel);

  // 按需展开：每次点击按 GRAPH_EXPAND_STEP 增长，直到全量可见
  let expandClicks = 0;
  for (let i = 0; i < 5; i++) {
    const hasExpand = await evaluate(`!!document.querySelector('[data-testid=kb-graph-expand]')`);
    if (!hasExpand) break;
    await evaluate(`document.querySelector('[data-testid=kb-graph-expand]').click()`);
    expandClicks += 1;
    await sleep(300);
  }
  report.metrics.expandClicks = expandClicks;
  const coverageAfter = await evaluate(`document.querySelector('[data-testid=kb-graph-coverage]').textContent`);
  report.metrics.coverageAfter = coverageAfter;
  check('按需展开后全量可见', coverageAfter.includes('共 1000 页'), { coverageAfter, expandClicks });

  const workers = await evaluate(`window.__kbGraphStats.workers`);
  report.metrics.workers = { created: workers.created, postMessages: workers.postMessages };
  check('大图同样走 worker 布局', workers.created >= 1 && workers.postMessages >= 1, report.metrics.workers);

  await evaluate(`window.__kbGraphSmoke.unmount()`);
  await sleep(300);
  const afterUnmount = await evaluate(`window.__kbGraphStats.workers`);
  check('大图卸载后 worker 被终止', afterUnmount.terminated >= afterUnmount.created, afterUnmount);

  await assertCspMatchesApplication();
  await assertNoRemoteRequests();
}

const SCENARIOS = {
  webgl: scenarioWebgl,
  'no-webgl': scenarioNoWebgl,
  large: scenarioLarge,
};

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    report.diagnostics.requests.push(details.url);
    callback({});
  });

  win = new BrowserWindow({
    show: true,
    x: -20000,
    y: -20000,
    width: 1280,
    height: 860,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.webContents.on('console-message', (event, level, message) => {
    if (typeof message === 'string') {
      report.diagnostics.console.push(`${level}: ${message}`);
      return;
    }
    const detail = event && typeof event === 'object'
      ? `${event.level ?? ''}: ${event.message ?? ''}`
      : String(event);
    report.diagnostics.console.push(detail);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    report.diagnostics.failures.push(`did-fail-load ${code} ${description} ${url}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    report.diagnostics.failures.push(`render-process-gone ${JSON.stringify(details)}`);
  });

  try {
    await win.loadFile(path.join(harnessDir, 'index.html'));
    await waitFor(`!!window.__kbGraphSmoke`, 'harness 控制面就绪');
    const run = SCENARIOS[scenario];
    if (!run) throw new Error(`未知场景：${scenario}`);
    await run();
    report.ok = report.checks.every((item) => item.ok) && report.diagnostics.failures.length === 0;
  } catch (error) {
    report.diagnostics.failures.push(`异常：${error && error.stack ? error.stack : String(error)}`);
    report.ok = false;
  }

  const output = JSON.stringify(report, null, 2);
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, output, 'utf8');
  }
  process.stdout.write(`\nSMOKE_RESULT=${output}\n`);
  app.exit(report.ok ? 0 : 1);
});
