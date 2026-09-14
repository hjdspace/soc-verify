/**
 * issue 30 — 打包 GUI 门禁：驱动**实际安装包**（dist/win-unpacked/SoC Verify.exe）。
 *
 * 与 issue 26 的图冒烟（dev Electron + 独立 harness 页）不同，本文件启动的
 * 是打包产物自身的可执行文件与 app.asar，通过 Chromium DevTools Protocol
 * 驱动真实产品 UI：
 *
 *  1. 磁盘预置（userData/projects.json + state_<id>.json + kb-registry.json
 *     + <projectRoot>/.socverify/kb-mounts.json），让应用启动即「已打开项目
 *     + 已挂载固定规模库 + 停留在知识库视图」；
 *  2. `--remote-debugging-port` 连 CDP，点击进入「知识页 → 知识图谱」，
 *     读取产品自报的 `kb-graph-diagnostics`（首帧 xxxms）；
 *  3. rAF 间隙探针记录布局期间主线程卡顿（窗口响应）；
 *  4. 全量记录页面资源请求，断言无 http(s)（无 CDN）且无模型请求
 *     （重启待审阅不重耗模型的打包侧证据）；
 *  5. `--disable-3d-apis` 复述无 WebGL 降级（邻接列表 + 不可用 WebGL 文案）；
 *  6. 同一 userData 二次启动 = 重启重开（A22「可启动与重开」）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── 打包产物定位 ────────────────────────────────────────────────

export type PackagedApp = {
  exePath: string;
  resourcesDir: string;
  asarPath: string;
  exeBytes: number;
  exeMtimeIso: string;
};

/** 定位打包产物；找不到时抛出自描述错误（不静默跳过） */
export function resolvePackagedApp(repoRoot: string): PackagedApp {
  const exePath = join(repoRoot, 'dist', 'win-unpacked', 'SoC Verify.exe');
  const resourcesDir = join(repoRoot, 'dist', 'win-unpacked', 'resources');
  const asarPath = join(resourcesDir, 'app.asar');
  if (!existsSync(exePath)) {
    throw new Error(
      `未找到打包产物 ${exePath}。请先运行 npm run package:win（issue 30 门禁只验收实际安装包，不验收 dev 产物）。`,
    );
  }
  if (!existsSync(asarPath)) {
    throw new Error(`打包产物缺 app.asar：${asarPath}`);
  }
  const st = statSync(exePath);
  return { exePath, resourcesDir, asarPath, exeBytes: st.size, exeMtimeIso: st.mtime.toISOString() };
}

// ── 磁盘预置（让应用启动即处于目标状态）─────────────────────────

export type SeededAppState = {
  userDataDir: string;
  projectRoot: string;
  projectId: string;
  kbId: string;
};

export type SeedOptions = {
  userDataDir: string;
  projectRoot: string;
  kbPath: string;
  kbId: string;
  kbName: string;
  /** 提供则原样写入 kb-settings.json（保留真实 LLM 配置，让「重启不重耗模型」断言有意义） */
  kbSettingsJson?: string | null;
};

/**
 * 预置启动状态：
 *  - `<userData>/socverify-data/projects.json`（唯一项目，lastOpenedAt 最大）
 *  - `<userData>/socverify-data/state_<projectId>.json`（uiLayout.activeView = 'kb'）
 *  - `<userData>/socverify-data/kb-registry.json`（登记 fixture 库，format=wiki）
 *  - `<projectRoot>/.socverify/kb-mounts.json`（挂载该库）
 *  - `<userData>/socverify-data/kb-settings.json`（可选）
 */
export function seedAppState(options: SeedOptions): SeededAppState {
  const { userDataDir, projectRoot, kbPath, kbId, kbName } = options;
  const dataDir = join(userDataDir, 'socverify-data');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(projectRoot, '.socverify'), { recursive: true });

  const projectId = 'proj-package-gate-30';
  const now = Date.now();

  writeFileSync(
    join(dataDir, 'projects.json'),
    JSON.stringify(
      [{ id: projectId, name: 'package-gate', rootPath: projectRoot, createdAt: now, lastOpenedAt: now }],
      null,
      2,
    ),
    'utf-8',
  );

  writeFileSync(
    join(dataDir, `state_${projectId}.json`),
    JSON.stringify(
      {
        projectId,
        uiLayout: {
          rightPanelCollapsed: true,
          activeView: 'kb',
          aiPanelMode: 'drawer',
          filePanelMode: 'drawer',
        },
      },
      null,
      2,
    ),
    'utf-8',
  );

  writeFileSync(
    join(dataDir, 'kb-registry.json'),
    JSON.stringify([{ id: kbId, name: kbName, path: kbPath, registeredAt: now, format: 'wiki' }], null, 2),
    'utf-8',
  );

  writeFileSync(
    join(projectRoot, '.socverify', 'kb-mounts.json'),
    JSON.stringify([{ kbId, mountedAt: now }], null, 2),
    'utf-8',
  );

  if (typeof options.kbSettingsJson === 'string') {
    writeFileSync(join(dataDir, 'kb-settings.json'), options.kbSettingsJson, 'utf-8');
  }

  return { userDataDir, projectRoot, projectId, kbId };
}

/** 读取真实 kb-settings.json（存在才注入；不包含密钥，密钥在 credentials.json） */
export function readRealKbSettings(): string | null {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  const path = join(appData, 'soc-verify', 'socverify-data', 'kb-settings.json');
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

// ── CDP 客户端（Node 22+ 全局 WebSocket，无新增依赖）────────────

type CdpHandler = (params: Record<string, unknown>) => void;

class CdpConnection {
  private seq = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly handlers = new Map<string, Set<CdpHandler>>();
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as
        | { id: number; result?: unknown; error?: { message: string } }
        | { method: string; params: Record<string, unknown> };
      if ('id' in msg && typeof msg.id === 'number') {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`CDP ${msg.error.message}`));
        else entry.resolve(msg.result ?? {});
        return;
      }
      if ('method' in msg) {
        for (const handler of this.handlers.get(msg.method) ?? []) handler(msg.params);
      }
    });
  }

  static async connect(wsUrl: string): Promise<CdpConnection> {
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`WebSocket 连接失败: ${wsUrl}`)), { once: true });
    });
    return new CdpConnection(socket);
  }

  on(method: string, handler: CdpHandler): void {
    const set = this.handlers.get(method) ?? new Set<CdpHandler>();
    set.add(handler);
    this.handlers.set(method, set);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.seq++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject: reject as (e: Error) => void,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 调用超时: ${method}`));
        }
      }, 30_000);
    });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // ignore
    }
  }
}

type PageTarget = { id: string; type: string; url: string; webSocketDebuggerUrl?: string };

async function listPageTargets(port: number): Promise<PageTarget[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) return [];
  const targets = (await res.json()) as PageTarget[];
  return targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 页面求值辅助 ────────────────────────────────────────────────

function pageEvalSource(expression: string): string {
  return `(() => {
    try {
      const value = (${expression});
      return JSON.stringify(value === undefined ? null : value);
    } catch (error) {
      return JSON.stringify({ __error: String(error && error.stack ? error.stack : error) });
    }
  })()`;
}

export type PageSession = {
  evaluate: <T>(expression: string) => Promise<T>;
  consoleErrors: string[];
  remoteRequests: Array<{ url: string }>;
  close: () => void;
};

/** 连接主窗口页面：启用 Runtime/Page/Network/Log，收集错误与外联请求。
 * 连接后先验证 CDP 命令往返 + 页面就绪，失败自动重连（应用启动期
 * 可能出现导航重建 context，首个连接偶发无响应）。 */
async function attachToMainPage(port: number, timeoutMs = 90_000): Promise<PageSession> {
  const startedAt = Date.now();
  let lastError = '无页面 target';
  while (Date.now() - startedAt < timeoutMs) {
    let targets: PageTarget[] = [];
    try {
      targets = await listPageTargets(port);
    } catch {
      targets = [];
    }
    const page = targets.find((t) => t.url.startsWith('file://')) ?? targets[0];
    if (page?.webSocketDebuggerUrl) {
      try {
        return await connectAndVerify(page.webSocketDebuggerUrl);
      } catch (error) {
        lastError = String(error);
      }
    } else {
      lastError = targets.length === 0 ? '无页面 target' : '页面缺少 webSocketDebuggerUrl';
    }
    await sleep(500);
  }
  throw new Error(`等待页面 target 超时（${lastError}）`);
}

async function connectAndVerify(wsUrl: string): Promise<PageSession> {
  const conn = await CdpConnection.connect(wsUrl);
  const consoleErrors: string[] = [];
  const remoteRequests: Array<{ url: string }> = [];

  conn.on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error') {
      const text = (params.args as Array<{ value?: unknown }> | undefined)
        ?.map((a) => String(a.value ?? ''))
        .join(' ');
      consoleErrors.push(text?.slice(0, 500) ?? '(console.error)');
    }
  });
  conn.on('Runtime.exceptionThrown', (params) => {
    const detail = params.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined;
    consoleErrors.push((detail?.exception?.description ?? detail?.text ?? 'exception').slice(0, 500));
  });
  conn.on('Log.entryAdded', (params) => {
    const entry = params.entry as { level?: string; text?: string } | undefined;
    if (entry?.level === 'error') consoleErrors.push((entry.text ?? 'log.error').slice(0, 500));
  });
  conn.on('Network.requestWillBeSent', (params) => {
    const url = String((params.request as { url?: string } | undefined)?.url ?? '');
    if (/^https?:/i.test(url) && !url.startsWith('http://127.0.0.1')) remoteRequests.push({ url });
  });

  const evaluateRaw = async <T,>(expression: string): Promise<T> => {
    const result = await conn.send<{ result: { value: string } }>('Runtime.evaluate', {
      expression: pageEvalSource(expression),
      returnByValue: true,
      awaitPromise: true,
    });
    const parsed = JSON.parse(result.result.value) as T | { __error: string };
    if (parsed && typeof parsed === 'object' && '__error' in parsed) {
      throw new Error(`页面求值失败: ${(parsed as { __error: string }).__error}`);
    }
    return parsed as T;
  };

  // 事件域必须在验证前启用，否则收集不到错误与外联请求
  await conn.send('Runtime.enable');
  await conn.send('Page.enable');
  await conn.send('Network.enable');
  await conn.send('Log.enable');

  // 连接验证：命令必须能往返，且页面 document 已就绪
  const verifyStarted = Date.now();
  for (;;) {
    try {
      const ready = await evaluateRaw<string>(`document.readyState`);
      if (ready === 'complete') break;
    } catch (error) {
      conn.close();
      throw new Error(`CDP 连接验证失败: ${String(error)}`);
    }
    if (Date.now() - verifyStarted > 20_000) {
      conn.close();
      throw new Error('CDP 连接验证失败: document.readyState 迟终未 complete');
    }
    await sleep(200);
  }

  return {
    evaluate: evaluateRaw,
    consoleErrors,
    remoteRequests,
    close: () => conn.close(),
  };
}

// ── 场景执行 ────────────────────────────────────────────────────

export type GraphScenarioOptions = {
  app: PackagedApp;
  userDataDir: string;
  /** 额外命令行开关（如 --disable-3d-apis） */
  extraArgs?: string[];
  /** 无 WebGL 场景：只断言降级列表，不要求首帧 */
  expectDegraded?: boolean;
  /** 已知 LLM provider 主机名（用于「无模型请求」断言） */
  modelHosts?: string[];
};

export type GraphScenarioResult = {
  ok: boolean;
  failures: string[];
  checks: Array<{ name: string; ok: boolean; detail?: unknown }>;
  firstFrameMs: number | null;
  canvasCount: number;
  adjacencyDegraded: boolean;
  webglNotice: string | null;
  graphCoverageText: string | null;
  diagnosticsText: string | null;
  /** 图视图加载期间 rAF 最大间隙（窗口响应，ms） */
  maxRafGapMs: number | null;
  /** 1000 页图挂载后渲染进程 JS heap（字节） */
  heapUsedBytes: number | null;
  requests: { total: number; remote: Array<{ url: string }>; model: string[] };
  consoleErrors: string[];
  timings: { appReadyMs: number | null; graphLoadMs: number | null };
};

/** 安装 rAF 间隙探针（在点击图 tab 之前） */
const RAF_PROBE = `
  (() => {
    if (window.__pkgGateRaf) return true;
    const probe = { maxGap: 0, ticks: 0, last: performance.now(), running: true };
    window.__pkgGateRaf = probe;
    const loop = () => {
      if (!probe.running) return;
      const now = performance.now();
      const gap = now - probe.last;
      if (gap > probe.maxGap) probe.maxGap = gap;
      probe.last = now;
      probe.ticks += 1;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return true;
  })()
`;

function clickByTestId(testId: string): string {
  return `(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
    if (!el) return false;
    el.click();
    return true;
  })()`;
}

function clickButtonByText(text: string): string {
  return `(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const target = buttons.find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)});
    if (!target) return false;
    target.click();
    return true;
  })()`;
}

async function waitFor(
  evaluate: (expression: string) => Promise<unknown>,
  expression: string,
  label: string,
  timeoutMs = 45_000,
) {
  const startedAt = Date.now();
  let last: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    last = await evaluate(expression);
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`等待超时（${label}）: ${expression} → ${JSON.stringify(last)?.slice(0, 200)}`);
}

export async function runGraphScenario(options: GraphScenarioOptions): Promise<GraphScenarioResult> {
  const port = 22000 + Math.floor(Math.random() * 20000);
  const failures: string[] = [];
  const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
  const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, detail });

  const child = launchApp(options.app.exePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${options.userDataDir}`,
    ...(options.extraArgs ?? []),
  ]);

  const result: GraphScenarioResult = {
    ok: false,
    failures,
    checks,
    firstFrameMs: null,
    canvasCount: 0,
    adjacencyDegraded: false,
    webglNotice: null,
    graphCoverageText: null,
    diagnosticsText: null,
    maxRafGapMs: null,
    heapUsedBytes: null,
    requests: { total: 0, remote: [], model: [] },
    consoleErrors: [],
    timings: { appReadyMs: null, graphLoadMs: null },
  };

  let session: PageSession | null = null;
  try {
    const t0 = Date.now();
    session = await attachToMainPage(port);
    result.timings.appReadyMs = Date.now() - t0;
    const { evaluate, consoleErrors, remoteRequests, close } = session;
    result.consoleErrors = consoleErrors;

    // 1) 应用壳就绪（预置状态让 activeView=kb，这里只验证壳已渲染）
    await waitFor(
      evaluate,
      `!!document.querySelector('[data-testid=nav-active-indicator]') || !!document.querySelector('[aria-label=视图导航]')`,
      '应用壳就绪',
    );
    // 预置了 uiLayout.activeView='kb'；若未生效则点击导航兜底
    const kbActive = await evaluate<boolean>(`document.querySelector('[data-testid=kb-wiki-graph-tab]') !== null
      || Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').includes('知识页'))`);
    if (!kbActive) {
      await evaluate<boolean>(clickButtonByText('知识库'));
      await sleep(400);
    }

    // 2) 进入知识页 tab（挂载库为 wiki 格式时才出现）
    await waitFor(evaluate, `Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === '知识页')`, '知识页 tab 出现');
    await evaluate<boolean>(clickButtonByText('知识页'));
    await sleep(300);

    // 3) 图视图 tab + rAF 探针
    await evaluate<boolean>(RAF_PROBE);
    const hasGraphTab = await evaluate<boolean>(clickByTestId('kb-wiki-graph-tab'));
    check('图视图 tab 可点击', hasGraphTab === true, hasGraphTab);
    const graphLoadStart = Date.now();

    if (options.expectDegraded) {
      // 无 WebGL：应出现邻接列表与降级提示，且无画布
      await waitFor(evaluate, `!!document.querySelector('[data-testid=kb-graph-adjacency]')`, '邻接列表降级出现', 60_000);
      const canvases = await evaluate<number>(`document.querySelectorAll('[data-testid=kb-graph-canvas] canvas').length`);
      result.canvasCount = canvases;
      result.adjacencyDegraded = true;
      result.webglNotice = await evaluate<string | null>(
        `document.querySelector('[data-testid=kb-graph-webgl-notice]')?.textContent ?? null`,
      );
      check('无 WebGL 时给出邻接列表', true);
      check('降级路径不渲染画布', canvases === 0, canvases);
      check('降级原因可观察（不可用 WebGL）', (result.webglNotice ?? '').includes('不可用 WebGL'), result.webglNotice);
    } else {
      // 4) 首帧：产品自报 diagnostics（必须等到出现「首帧 NNNms」——
      //    挂载早期诊断栏只有 WebGL(webgl2) 等前缀，还没有首帧数值）
      const diagnostics = await waitFor(
        evaluate,
        `(document.querySelector('[data-testid=kb-graph-diagnostics]')?.textContent ?? '').match(/首帧\\s*\\d+(?:\\.\\d+)?\\s*ms/) ? document.querySelector('[data-testid=kb-graph-diagnostics]').textContent : false`,
        '图视图首帧数值就绪',
        120_000,
      ) as string;
      result.diagnosticsText = diagnostics;
      const match = diagnostics.match(/首帧\s*(\d+(?:\.\d+)?)\s*ms/);
      if (match) {
        result.firstFrameMs = Number(match[1]);
      } else {
        failures.push(`诊断文本未包含首帧数值: ${diagnostics.slice(0, 200)}`);
      }
      result.timings.graphLoadMs = Date.now() - graphLoadStart;
      result.graphCoverageText = await evaluate<string | null>(
        `document.querySelector('[data-testid=kb-graph-coverage]')?.textContent ?? null`,
      );
      result.canvasCount = await evaluate<number>(
        `document.querySelectorAll('[data-testid=kb-graph-canvas] canvas').length`,
      );
      check('首帧已由产品自报', result.firstFrameMs !== null, result.firstFrameMs);
      check('画布已渲染（sigma canvas 存在）', result.canvasCount >= 1, result.canvasCount);
      check('1000 页图按预算裁剪展开', (result.graphCoverageText ?? '').length > 0, result.graphCoverageText);

      // 5) 窗口响应：rAF 最大间隙
      await sleep(500); // 布局动画结束后读数
      const probe = await evaluate<{ maxGap: number; ticks: number }>(
        `(() => { const p = window.__pkgGateRaf; if (p) p.running = false; return p ?? { maxGap: -1, ticks: 0 }; })()`,
      );
      result.maxRafGapMs = probe.maxGap;
      check('布局期间主线程探针有采样', probe.ticks > 10, probe);
      check('布局期间 rAF 最大间隙 ≤ 2000ms（窗口保持可响应）', probe.maxGap >= 0 && probe.maxGap <= 2000, probe);
    }

    // 6) 内存（渲染进程 JS heap）
    const metrics = await evaluate<Record<string, number>>(`
      (async () => {
        const m = performance.memory;
        return { jsHeapUsed: m ? m.usedJSHeapSize : -1, jsHeapTotal: m ? m.totalJSHeapSize : -1 };
      })()
    `);
    result.heapUsedBytes = metrics.jsHeapUsed >= 0 ? metrics.jsHeapUsed : null;

    // 7) 无 CDN / 无模型请求
    result.requests = {
      total: remoteRequests.length,
      remote: remoteRequests,
      model: remoteRequests
        .map((r) => r.url)
        .filter((url) => (options.modelHosts ?? []).some((host) => url.includes(host))),
    };
    check('无 http(s) 外联请求（无 CDN）', result.requests.remote.length === 0, result.requests.remote.slice(0, 5));
    check('无模型请求（重启待审阅不重耗模型）', result.requests.model.length === 0, result.requests.model);

    result.ok = checks.every((c) => c.ok) && failures.length === 0;
    close();
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  await killTree(child);
  result.ok = result.checks.every((c) => c.ok) && result.failures.length === 0;
  return result;
}

// ── 进程控制 ────────────────────────────────────────────────────

function launchApp(exePath: string, args: string[]): ChildProcess {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 必须以 GUI 模式启动
  const child = spawn(
    exePath,
    // --no-sandbox：冒烟/门禁环境下 GPU/沙箱初始化可能不可用（与 issue 26 smoke 一致）
    ['--no-sandbox', ...args],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stderr?.on('data', (c) => {
    const text = String(c);
    if (/DevTools listening|error|fail/i.test(text)) launchDiagnostics.push(text.slice(0, 400));
  });
  child.on('error', () => undefined);
  return child;
}

/** 最近一次启动的诊断输出（stderr 中与调试端口/错误相关的行） */
export const launchDiagnostics: string[] = [];

export async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
    });
  } else {
    child.kill('SIGKILL');
  }
  await sleep(600);
}
