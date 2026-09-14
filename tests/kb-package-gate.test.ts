/**
 * issue 30 — 验收安装包完整旅程与固定规模性能（总门禁）。
 *
 * 阶段顺序（README 执行总则：验证/前置整理 → 实现 → 行为验证）：
 *  1. 固定规模 fixture：1000 页 / 10000 边 / 约 50MB parsed（参数进报告）
 *  2. 缓存热关键词检索 p95（生产 searchWiki，门禁 ≤1000ms）
 *  3. 打包运行时探针：打包 exe + ELECTRON_RUN_AS_NODE（LanceDB/PDF/转换/布局/无 CDN）
 *  4. 打包 GUI（CDP）：图视图首帧 / 窗口响应 / 无模型请求 / 重启重开
 *  5. 打包 GUI：无 WebGL 降级（--disable-3d-apis）
 *  6. 真实模型旅程：图文 PDF → 编译（含视觉）→ 审阅 → 发布 → 查询 → 保存问答
 *     （含真实取消与重启恢复零模型调用；模型延迟单独计）
 *  7. 汇总报告 → .scratch/llm-wiki/spikes/30-package/{report.json,report.md}
 *
 * 运行：npm run gate:kb-package（推荐）或
 *      node node_modules/vitest/vitest.mjs run tests/kb-package-gate.test.ts --pool=vmThreads
 *
 * 前置：dist/win-unpacked 必须由 `npm run package:win` 按 HEAD 产出
 * （门禁只验收实际安装包；缺失时阶段 3–5 明确失败并定位，不静默跳过）。
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { writePackageKb, PACKAGE_KB_ID, PACKAGE_KB_NAME, probeQueryCoverage, PACKAGE_QUERIES } from './package/kb-package-fixture';
import { measureKeywordLatency, formatBytes } from './package/kb-package-perf';
import { searchWiki } from '../src/main/kb/wiki-search';
import { resolvePackagedApp, seedAppState, readRealKbSettings, runGraphScenario, type GraphScenarioResult, type PackagedApp } from './package/kb-package-gui';
import { runRealModelJourney, resolveRealCredentials, buildJourneyDocx } from './package/kb-journey-real-model';
import { mixedPdfFixture, vectorOnlyPdfFixture } from './fixtures/pdf-fixture';
import {
  buildReport,
  writeReport,
  collectEnvironment,
  GATE_THRESHOLDS,
  type PackageGateReport,
  type EnvironmentInfo,
} from './package/kb-package-report';

vi.setConfig({ testTimeout: 900_000 });

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportDir = process.env.KB_PACKAGE_REPORT_DIR
  ?? join(repoRoot, '.scratch', 'llm-wiki', 'spikes', '30-package');
const issuesDir = join(repoRoot, '.scratch', 'llm-wiki', 'issues');
const workDir = join(reportDir, 'work');

// ── 跨阶段共享状态（最终写入报告）───────────────────────────────

type SharedState = {
  environment: EnvironmentInfo | null;
  packagedApp: PackagedApp | null;
  packageVersion: string | null;
  fixture: PackageGateReport['fixture'];
  keywordLatency: PackageGateReport['measurements']['keywordLatency'];
  cancelLatency: PackageGateReport['measurements']['cancelLatency'];
  packagedRuntime: Record<string, unknown> | null;
  gui: GraphScenarioResult[];
  journey: PackageGateReport['measurements']['journey'];
  findings: PackageGateReport['findings'];
};

const state: SharedState = {
  environment: null,
  packagedApp: null,
  packageVersion: null,
  fixture: null,
  keywordLatency: null,
  cancelLatency: null,
  packagedRuntime: null,
  gui: [],
  journey: null,
  findings: [],
};

const kbPath = join(workDir, 'kb-package-30');
const projectRoot = join(workDir, 'project');
const userDataDir = join(workDir, 'userData');

function finding(severity: 'blocker' | 'high' | 'info', id: string, message: string, ticket: string): void {
  if (!state.findings.some((f) => f.id === id)) state.findings.push({ severity, id, message, ticket });
}

/** 已知 LLM provider 主机（从真实凭证推导；用于「无模型请求」断言） */
function modelHosts(): string[] {
  const appData = process.env.APPDATA;
  if (!appData) return [];
  try {
    const credentials = JSON.parse(
      readFileSync(join(appData, 'soc-verify', 'socverify-data', 'credentials.json'), 'utf-8'),
    ) as Array<{ baseUrl?: string }>;
    return credentials
      .map((c) => {
        try {
          return new URL(c.baseUrl ?? '').hostname;
        } catch {
          return '';
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ── 阶段 1：固定规模 fixture ────────────────────────────────────

describe('issue 30 门禁 — 阶段 1：固定规模 fixture', () => {
  it('生成 1000 页 / 10000 边 / 约 50MB parsed，参数原样记录，查询集全覆盖', async () => {
    mkdirSync(workDir, { recursive: true });
    const fixture = await writePackageKb(kbPath);
    state.fixture = {
      params: fixture.params,
      pageCount: fixture.pageCount,
      edgeCount: fixture.edgeCount,
      sourceCount: fixture.sourceCount,
      parsedBytes: fixture.parsedBytes,
      sourceBytes: fixture.sourceBytes,
      wikiBytes: fixture.wikiBytes,
      generateMs: fixture.generateMs,
    };

    expect(fixture.pageCount).toBe(1000);
    expect(fixture.edgeCount).toBeGreaterThanOrEqual(10000);
    expect(fixture.parsedBytes).toBeGreaterThanOrEqual(45 * 1024 * 1024);
    expect(fixture.parsedBytes).toBeLessThanOrEqual(55 * 1024 * 1024);
    console.log(
      `[kb-package-gate] fixture: ${fixture.pageCount} 页 / ${fixture.edgeCount} 边 / parsed ${formatBytes(fixture.parsedBytes)} / 生成 ${fixture.generateMs}ms`,
    );

    const probes = await probeQueryCoverage(kbPath);
    const zero = probes.filter((p) => p.hits === 0);
    expect(zero, `零命中查询（测不了真实检索路径）: ${zero.map((p) => p.query).join('、')}`).toEqual([]);
  });
});

// ── 阶段 2：关键词 p95 ──────────────────────────────────────────

describe('issue 30 门禁 — 阶段 2：缓存热关键词检索 p95', () => {
  it('生产 searchWiki（keyword 模式）p95 ≤ 1000ms，查询全部有命中', async () => {
    expect(state.fixture).not.toBeNull();
    const result = await measureKeywordLatency(PACKAGE_QUERIES, async (query, topK) => {
      const r = await searchWiki(kbPath, { query, topK });
      if (!r.ok) throw new Error(`searchWiki 失败: ${r.error.message}`);
      return { hits: r.result.hits.length };
    });
    state.keywordLatency = {
      stats: result.stats,
      byKind: result.byKind,
      warmupPasses: result.warmupPasses,
      measuredPasses: result.measuredPasses,
      passMs: result.passMs,
      memoryPeak: result.memoryPeak,
      allQueriesHit: result.allQueriesHit,
      zeroHitQueries: result.zeroHitQueries,
      note:
        '生产路径 searchWiki（keyword 模式 = 产品当前实际路径，见 issue 29 接线结论）；'
        + '缓存热 = fixture 预热一轮后逐轮计时（应用层无检索缓存，每次重读页面与 parsed 全文，'
        + '测得的是真实产品路径热稳态）；模型延迟不参与本测量。',
    };

    console.log(
      `[kb-package-gate] keyword p50=${result.stats.p50Ms}ms p95=${result.stats.p95Ms}ms max=${result.stats.maxMs}ms `
        + `rssPeak=${formatBytes(result.memoryPeak.rssPeakBytes)}`,
    );
    expect(result.allQueriesHit).toBe(true);
    expect(result.stats.p95Ms).toBeLessThanOrEqual(GATE_THRESHOLDS.keywordP95Ms);
  });
});

// ── 阶段 3：打包运行时探针 ──────────────────────────────────────

describe('issue 30 门禁 — 阶段 3：打包运行时（实际安装包二进制）', () => {
  it('LanceDB/PDF 运行时/本地转换/图布局在打包运行时内可启动与重开，零外联', async () => {
    state.environment = await collectEnvironment();
    const app = resolvePackagedApp(repoRoot);
    state.packagedApp = app;

    // PDF fixtures（打包运行时 pdfjs 渲染用）+ DOCX（打包内本地转换用）
    const pdfPath = join(workDir, 'mixed.pdf');
    const pdfVectorPath = join(workDir, 'vector.pdf');
    writeFileSync(pdfPath, mixedPdfFixture());
    writeFileSync(pdfVectorPath, vectorOnlyPdfFixture(3));
    const docxPath = join(workDir, 'journey.docx');
    writeFileSync(docxPath, await buildJourneyDocx());

    const outPath = join(reportDir, 'packaged-runtime.json');
    const runtimeScript = join(repoRoot, 'scripts', 'kb-package-gate', 'runtime.cjs');
    const env: Record<string, string | undefined> = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.NODE_OPTIONS;

    const exitCode = await new Promise<number>((resolveExit) => {
      const child = spawn(app.exePath, [
        runtimeScript,
        `--resources=${app.resourcesDir}`,
        `--work=${join(workDir, 'runtime')}`,
        `--pdf=${pdfPath}`,
        `--pdf-vector=${pdfVectorPath}`,
        `--docx=${docxPath}`,
        `--out=${outPath}`,
      ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c) => (out += c.toString()));
      child.stderr.on('data', (c) => (out += c.toString()));
      child.on('close', (code) => {
        if (code !== 0) console.log(`[kb-package-gate] runtime 输出尾部: ${out.slice(-1500)}`);
        resolveExit(code ?? 1);
      });
    });
    expect(exitCode, '打包运行时探针以非 0 退出').toBe(0);

    expect(existsSync(outPath), '打包运行时报告未产出').toBe(true);
    const report = JSON.parse(readFileSync(outPath, 'utf-8')) as Record<string, unknown> & {
      packageVersion?: string;
      ok: boolean;
      failures: string[];
    };
    state.packagedRuntime = report;
    state.packageVersion = report.packageVersion ?? null;
    console.log(`[kb-package-gate] packaged runtime ok=${report.ok} failures=${JSON.stringify(report.failures)}`);

    // 打包运行时失败 → 定位责任票（有界：只分类，不现场修包）
    const blob = JSON.stringify(report);
    if (/lancedb|apache-arrow/i.test(blob)) {
      finding(
        'blocker',
        'packaged-lancedb-unloadable',
        '打包产物内 @lancedb/lancedb 无法加载：依赖链中的 apache-arrow 未进入安装包'
          + '（require 从 asar/node_modules/@lancedb/lancedb 解析失败）。开发环境正常、打包后向量索引不可用，'
          + '属打包依赖收集问题；spike 21 只验证了开发进程与 Electron 运行时，打包进程复述在本票首次执行并失败。',
        '21',
      );
    }
    if (!report.ok && /pdfjs|pdf\.mjs|@napi-rs/i.test(blob)) {
      finding('high', 'packaged-pdf-runtime', `打包内 PDF 本地运行时检查失败: ${JSON.stringify(report.failures).slice(0, 300)}`, '11');
    }
    if (!report.ok && !/DOCX → Markdown 成功/.test(blob)) {
      finding('high', 'packaged-conversion', `打包内本地转换检查未通过: ${JSON.stringify(report.failures).slice(0, 300)}`, '2');
    }
    expect(report.ok, `打包运行时探针失败: ${report.failures.join('；')}`).toBe(true);
    expect(exitCode, '打包运行时探针以非 0 退出').toBe(0);
  });
});

// ── 阶段 4/5：打包 GUI（CDP 驱动真实产品 UI）────────────────────

describe('issue 30 门禁 — 阶段 4：打包 GUI 图视图（首帧/响应/无 CDN/重启）', () => {
  it('预置项目+挂载库后启动实际安装包，图视图首帧 ≤ 3000ms，零外联', async () => {
    const app = resolvePackagedApp(repoRoot);
    seedAppState({
      userDataDir,
      projectRoot,
      kbPath,
      kbId: PACKAGE_KB_ID,
      kbName: PACKAGE_KB_NAME,
      kbSettingsJson: readRealKbSettings(),
    });

    // 首次启动：图首帧 + 窗口响应 + 无模型请求
    const first = await runGraphScenario({ app, userDataDir, modelHosts: modelHosts() });
    state.gui.push(first);
    console.log(
      `[kb-package-gate] GUI#1 ok=${first.ok} firstFrame=${first.firstFrameMs}ms rafGap=${first.maxRafGapMs}ms `
        + `remote=${first.requests.remote.length} model=${first.requests.model.length}`,
    );
    for (const f of first.failures) console.log(`[kb-package-gate] GUI#1 失败: ${String(f).slice(0, 300)}`);

    // 重启（同一 userData = 二次启动）：可启动与重开
    const second = await runGraphScenario({ app, userDataDir, modelHosts: modelHosts() });
    second.checks = second.checks.map((c) => (c.name.startsWith('图') ? { ...c, name: `重启后 ${c.name}` } : c));
    state.gui.push(second);
    console.log(`[kb-package-gate] GUI#2(重启) ok=${second.ok} firstFrame=${second.firstFrameMs}ms`);

    expect(first.ok, `首次 GUI 场景失败: ${first.failures.join('；')}`).toBe(true);
    expect(second.ok, `重启 GUI 场景失败: ${second.failures.join('；')}`).toBe(true);
    expect(first.firstFrameMs).not.toBeNull();
    expect(first.firstFrameMs!).toBeLessThanOrEqual(GATE_THRESHOLDS.graphFirstFrameMs);
  });
});

describe('issue 30 门禁 — 阶段 5：打包 GUI 无 WebGL 降级', () => {
  it('--disable-3d-apis 下出现邻接列表与「不可用 WebGL」提示，且不渲染画布', async () => {
    const app = resolvePackagedApp(repoRoot);
    const degraded = await runGraphScenario({
      app,
      userDataDir,
      modelHosts: modelHosts(),
      expectDegraded: true,
      extraArgs: ['--disable-3d-apis', '--disable-gpu', '--disable-software-rasterizer'],
    });
    state.gui.push(degraded);
    console.log(`[kb-package-gate] GUI#3(无WebGL) ok=${degraded.ok} adjacency=${degraded.adjacencyDegraded} canvas=${degraded.canvasCount}`);
    for (const f of degraded.failures) console.log(`[kb-package-gate] GUI#3 失败: ${String(f).slice(0, 300)}`);
    expect(degraded.ok, `无 WebGL 场景失败: ${degraded.failures.join('；')}`).toBe(true);
  });
});

// ── 阶段 6：真实模型旅程 ────────────────────────────────────────

describe('issue 30 门禁 — 阶段 6：真实模型图文旅程', () => {
  it('小型图文 DOCX → 编译（含视觉）→ 审阅 → 发布 → 查询 → 保存问答（模型延迟单独计）', async () => {
    const credentials = resolveRealCredentials();
    if (!credentials) {
      finding(
        'blocker',
        'real-model-credentials-unavailable',
        '本机未找到可用的模型凭证（credentials.json / kb-settings.json），真实模型旅程未执行；'
          + '该验收条目未满足，不以假流代替真实模型验证。',
        '30',
      );
      console.log('[kb-package-gate] 跳过真实模型旅程（无凭证）——已记录 blocker');
      return;
    }

    const runJourney = (compile: typeof credentials.compile) =>
      runRealModelJourney({
        kbPath: join(workDir, `journey-kb-${compile.model.replace(/[^\w-]/g, '_')}`),
        kbId: 'kb-journey-30',
        kbName: 'issue30 旅程库',
        docxBytes: journeyDocx,
        credentials: { ...credentials, compile },
        query: 'AXI outstanding limit 8',
        taskTimeoutMs: 600_000,
      });

    const journeyDocx = await buildJourneyDocx();
    let result = await runJourney(credentials.compile);
    console.log(
      `[kb-package-gate] journey(${credentials.compile.model}) ok=${result.ok} `
        + `steps=${result.steps.map((s) => `${s.ok ? '✅' : '❌'}${s.name}`).join(' → ')}`,
    );

    // 有界换模型重试：主配置模型协议失败时，用已配置的备选模型再走一次
    if (!result.ok && credentials.alternates.length > 0) {
      const protocolFailure = result.steps.some(
        (s) => !s.ok && (s.detail ?? '').includes('frontmatter'),
      );
      if (protocolFailure) {
        const alt = credentials.alternates[0]!;
        finding(
          'high',
          'real-model-compile-protocol-rejected',
          `真实模型 ${credentials.describe.compile.providerId}/${credentials.describe.compile.model} 的编译输出未通过提案协议校验`
            + `（frontmatter 围栏缺失，任务以 llmFailed 终止；模型输出头部见 report.json modelCalls.textHead）。`
            + `协议解析的有界重试未覆盖该失败形态。`,
          '9',
        );
        console.log(`[kb-package-gate] 主模型协议失败，用备选模型重试一次: ${alt.providerId}/${alt.model}`);
        const retry = await runJourney(alt);
        console.log(
          `[kb-package-gate] journey(${alt.model}) ok=${retry.ok} `
            + `steps=${retry.steps.map((s) => `${s.ok ? '✅' : '❌'}${s.name}`).join(' → ')}`,
        );
        if (retry.ok) {
          result = retry;
        } else {
          result.modelCalls.push(...retry.modelCalls);
          result.failures.push(`备选模型 ${alt.model} 旅程也未走通: ${retry.failures.join('；')}`);
          result.ok = false;
        }
      }
    }

    state.journey = { ...result, modelCallsSummary: result.modelCalls };

    console.log(
      `[kb-package-gate] modelCalls(${result.modelCalls.length}): `
        + result.modelCalls.map((c) => `${c.role}/${c.model}=${c.ms}ms`).join(', '),
    );
    if (result.cancelProbe) {
      console.log(`[kb-package-gate] 真实取消: ack=${result.cancelProbe.cancelAckMs}ms 重启后模型调用=${result.cancelProbe.modelCallsAfterAttach}`);
      state.cancelLatency = {
        source: '真实模型编译进行中 queue.pause()（同时验证重启恢复零模型调用）',
        cancelAckMs: result.cancelProbe.cancelAckMs,
        lateResultRejected: result.cancelProbe.taskBackToQueued,
        note: '真实模型延迟单独计（modelCalls 逐条记录），取消确认延迟只含本地协调开销。',
      };
    }

    expect(result.ok, `真实模型旅程失败: ${result.failures.join('；')}`).toBe(true);
  });
});

// ── 阶段 7：汇总报告 ────────────────────────────────────────────

describe('issue 30 门禁 — 阶段 7：汇总报告与证据核对', () => {
  it('A01–A22 证据入口齐全，报告落盘', async () => {
    if (!state.environment) state.environment = await collectEnvironment();

    // 取消响应（本地受控测量，由 kb-package-cancel.test.ts 产出）
    const cancelFile = join(reportDir, 'cancel-measurement.json');
    if (existsSync(cancelFile)) {
      try {
        state.cancelLatency = JSON.parse(readFileSync(cancelFile, 'utf-8')) as PackageGateReport['measurements']['cancelLatency'];
      } catch {
        // 忽略：报告里如实显示为未测量
      }
    }

    if (!state.packagedApp) {
      finding('blocker', 'packaged-app-missing', '未找到 dist/win-unpacked 打包产物，打包门禁（A22/验收条目 6）未执行。请先 npm run package:win。', '30');
    }

    const report = buildReport({
      environment: state.environment,
      packagedApp: state.packagedApp,
      packageVersion: state.packageVersion,
      fixture: state.fixture,
      measurements: {
        keywordLatency: state.keywordLatency,
        cancelLatency: state.cancelLatency,
        packagedRuntime: state.packagedRuntime,
        gui: state.gui.length > 0 ? state.gui : null,
        journey: state.journey,
      },
      findings: state.findings,
      commands: [
        'npm run package:win            # 按 HEAD 产出实际安装包（dist/win-unpacked）',
        'npm run gate:kb-package        # 本门禁：fixture → p95 → 打包运行时 → 打包 GUI → 真实模型旅程 → 报告',
        'npm run bench:kb-quality       # issue 29 检索质量门禁（复用，不重复实现）',
        'npm run smoke:kb-graph         # issue 26 图视图冒烟（复用）',
      ],
      issuesDir,
      repoRoot,
    });

    const { jsonPath, mdPath } = writeReport(reportDir, report);
    console.log(`[kb-package-gate] 报告：${jsonPath}`);
    console.log(`[kb-package-gate] 报告：${mdPath}`);
    for (const f of report.findings) {
      console.log(`[kb-package-gate] finding [${f.severity}] ${f.id} → issue ${f.ticket}`);
    }
    for (const g of report.gates) {
      console.log(`[kb-package-gate] gate ${g.met ? 'PASS' : 'MISS'} ${g.name}: ${g.actual}（${g.threshold}）`);
    }

    expect(report.acceptanceMatrix.every((row) => !row.evidenceMissing), 'A01–A22 证据入口存在缺失').toBe(true);
    expect(
      report.ticketHandovers.every((t) => t.hasHandover),
      `实施票交接记录缺失: ${report.ticketHandovers.filter((t) => !t.hasHandover).map((t) => t.ticket).join('、')}`,
    ).toBe(true);
  });
});

export { state, kbPath, workDir, reportDir };
