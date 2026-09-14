/**
 * issue 30 — 真实模型旅程：小型图文来源 → 编译（含视觉）→ 审阅 → 发布 →
 * 查询 → 主动保存问答（验收条目「实际配置模型完成小型图文来源…旅程」）。
 *
 * 全部走生产边界：importWikiSources（真实 anydoc 本地转换 + 提图）→
 * WikiIngestQueueManager（真实 callLlm 编译 + 真实视觉解读）→
 * recordDecision → publishChangeSet → searchWiki → saveQueryMessages。
 *
 * 模型延迟**单独计**（spec §Testing Decisions「真实模型延迟单独计」）：
 * 每次调用的耗时与 usage 逐条记录在 modelCalls，不混入本地性能数字。
 *
 * 凭证读取与本应用一致的字段（kb-settings.json 的 llm/vision 角色 +
 * credentials.json），不在报告或日志中输出任何密钥。
 *
 * 「重启待审阅不重耗模型」在同一旅程中实测：
 *  enqueue → 等任务进入 running（模型调用进行中）→ pause()（真实取消，
 *  同时测量取消响应）→ 确认无页面写入 → 重新 attach（= 重启恢复）→
 *  断言恢复过程零模型调用、任务保持 queued 等待人工继续。
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { createCanvas } from '@napi-rs/canvas';
import type { OpenAiApiFormat } from '@shared/types';
import { WikiIngestQueueManager } from '../../src/main/kb/ingest-queue';
import { importWikiSources, convertWikiSource } from '../../src/main/kb/source-import';
import { initWikiLayout, wikiLayout, SCHEMA_MD_SKELETON } from '../../src/main/kb/wiki-layout';
import { listChangeSets, readChangeSet, recordDecision } from '../../src/main/kb/staging';
import { publishChangeSet } from '../../src/main/kb/publish';
import { searchWiki } from '../../src/main/kb/wiki-search';
import { saveQueryMessages } from '../../src/main/kb/save-query';
import { callLlm } from '../../src/main/kb/llm-call';
import type { LlmConfig } from '../../src/main/kb/llm-config';
import type { LlmUsage } from '../../src/main/kb/llm-call';
import type { CompileLlm } from '../../src/main/kb/compile';
import type { VisionLlm } from '../../src/main/kb/vision';
import { pdfAssetDir } from '../../src/main/kb/pdf-asset-store';
import type { WikiSourceRecord, WikiSourceRef } from '@shared/kb-types';
import { wikiRealHunkIds } from '@shared/wiki-hunks';

// ── 凭证解析（与应用相同字段；不落日志）─────────────────────────

export type RealCredentials = {
  compile: LlmConfig;
  vision: LlmConfig | null;
  /** 其他已配置模型（协议失败时做一次有界换模型重试用；最多 2 个） */
  alternates: LlmConfig[];
  /** 供报告记录的角色配置（不含密钥） */
  describe: { compile: { providerId: string; model: string }; vision: { providerId: string; model: string } | null };
};

type CredentialFileEntry = {
  providerId: string;
  label?: string;
  apiKey: string;
  baseUrl?: string;
  api?: string;
  models?: Array<{ id: string; name?: string; input?: string[] }>;
};

/** 从真实配置解析编译与视觉模型；不可用时返回 null（如实记录阻塞） */
export function resolveRealCredentials(): RealCredentials | null {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  const dataDir = join(appData, 'soc-verify', 'socverify-data');
  let credentials: CredentialFileEntry[] = [];
  let settings: { llm?: { providerId?: string; model?: string }; vision?: { providerId?: string; model?: string } } = {};
  try {
    credentials = JSON.parse(readFileSync(join(dataDir, 'credentials.json'), 'utf-8')) as CredentialFileEntry[];
  } catch {
    return null;
  }
  try {
    settings = JSON.parse(readFileSync(join(dataDir, 'kb-settings.json'), 'utf-8'));
  } catch {
    // 无设置 → 用第一个凭证
  }

  const toConfig = (entry: CredentialFileEntry, modelId: string): LlmConfig => ({
    baseUrl: entry.baseUrl ?? '',
    apiKey: entry.apiKey,
    model: modelId,
    providerId: entry.providerId,
    apiFormat: (entry.api === 'openai-responses' ? 'openai-responses' : 'openai-completions') as OpenAiApiFormat,
  });

  // 编译模型：KB 设置 llm 角色（providerId + model），缺省第一个凭证第一个模型
  const llmRole = settings.llm;
  const compileEntry = llmRole?.providerId
    ? credentials.find((c) => c.providerId === llmRole.providerId) ?? credentials[0]
    : credentials[0];
  if (!compileEntry?.baseUrl || !compileEntry?.apiKey) return null;
  const compileModel = llmRole?.model ?? compileEntry.models?.[0]?.id;
  if (!compileModel) return null;

  // 视觉模型：KB 设置 vision 角色；否则选第一个声明 image 输入的模型
  let vision: LlmConfig | null = null;
  const visionRole = settings.vision;
  const visionEntry = visionRole?.providerId ? credentials.find((c) => c.providerId === visionRole.providerId) : undefined;
  const visionModel = visionRole?.model
    ?? visionEntry?.models?.find((m) => (m.input ?? []).includes('image'))?.id
    ?? credentials.flatMap((c) => c.models ?? []).find((m) => (m.input ?? []).includes('image'))?.id;
  const visionProvider = visionEntry ?? credentials.find((c) => (c.models ?? []).some((m) => (m.input ?? []).includes('image')));
  if (visionProvider?.baseUrl && visionProvider.apiKey && visionModel) {
    vision = toConfig(visionProvider, visionModel);
  }

  // 备选模型：优先「不同 provider」的模型（同 provider 免费档位易 429），
  // 有界：最多 2 个，仅协议失败时换一次
  const alternates: LlmConfig[] = [];
  const otherProviderFirst = [...credentials.filter((c) => c.providerId !== compileEntry.providerId), ...credentials.filter((c) => c.providerId === compileEntry.providerId && c !== compileEntry)];
  for (const entry of otherProviderFirst) {
    if (!entry.baseUrl || !entry.apiKey) continue;
    for (const model of entry.models ?? []) {
      alternates.push(toConfig(entry, model.id));
      if (alternates.length >= 2) break;
    }
    if (alternates.length >= 2) break;
  }

  return {
    compile: toConfig(compileEntry, compileModel),
    vision,
    alternates,
    describe: {
      compile: { providerId: compileEntry.providerId, model: compileModel },
      vision: vision ? { providerId: visionProvider!.providerId, model: visionModel! } : null,
    },
  };
}

// ── 真实模型适配器（生产 callLlm 包装，逐调用记录延迟）──────────

export type ModelCallRecord = {
  role: 'compile' | 'vision';
  model: string;
  ms: number;
  usage: LlmUsage | null;
  finishReason: string | null;
  /** 输出前 400 字符（协议失败时的诊断证据；不写密钥） */
  textHead?: string;
};

function realCompileLlm(config: LlmConfig, log: ModelCallRecord[]): CompileLlm {
  return {
    model: config.model,
    invoke: async (req) => {
      const t0 = Date.now();
      const result = await callLlm(config, {
        system: req.system,
        user: req.user,
        maxTokens: req.maxTokens,
        timeoutMs: 300_000,
      });
      log.push({
        role: 'compile',
        model: config.model,
        ms: Date.now() - t0,
        usage: result.usage,
        finishReason: result.finishReason,
        textHead: result.text.slice(0, 400),
      });
      return result;
    },
  };
}

function realVisionLlm(config: LlmConfig, log: ModelCallRecord[]): VisionLlm {
  return {
    model: config.model,
    invoke: async (req) => {
      const t0 = Date.now();
      const result = await callLlm(config, {
        system: req.system,
        user: req.user,
        images: [...req.images],
        maxTokens: req.maxTokens,
        signal: req.signal,
        timeoutMs: 300_000,
      });
      log.push({
        role: 'vision',
        model: config.model,
        ms: Date.now() - t0,
        usage: result.usage,
        finishReason: result.finishReason,
        textHead: result.text.slice(0, 400),
      });
      return result;
    },
  };
}

// ── 图文来源 fixture（DOCX：真实文字层 + 嵌入位图）──────────────

/**
 * 生成小型图文 DOCX：
 *  - 文字层：SoC 约束文字（anydoc 可本地转换，实测可提取）；
 *  - 嵌入位图：@napi-rs/canvas 绘制的时序示意（触发视觉解读链路）。
 *
 * 之所以不用 tests/fixtures/pdf-fixture 的 PDF：anydoc 对该 PDF 判定
 * ImageBased（无可提取文字层，需 OCR），转换会拒绝（实测见 30 票首轮门禁）；
 * DOCX 是「文字 + 图片」能被本地引擎完整转换的最小来源。
 */
export async function buildJourneyDocx(): Promise<Buffer> {
  // 位图：400×160，时钟波形 + 两个方框 + 标注文字（视觉模型可解读的内容）
  const canvas = createCanvas(400, 160);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 400, 160);
  ctx.strokeStyle = '#cc0000';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(20, 80);
  for (let i = 0; i < 5; i++) {
    ctx.lineTo(20 + i * 60 + 30, 80);
    ctx.lineTo(20 + i * 60 + 30, 30);
    ctx.lineTo(20 + (i + 1) * 60, 30);
    ctx.lineTo(20 + (i + 1) * 60, 80);
  }
  ctx.stroke();
  ctx.strokeStyle = '#0033cc';
  ctx.lineWidth = 2;
  ctx.strokeRect(30, 110, 70, 30);
  ctx.strokeRect(280, 110, 70, 30);
  ctx.fillStyle = '#111111';
  ctx.font = '16px sans-serif';
  ctx.fillText('CLK 100MHz', 250, 20);
  ctx.fillText('EN', 45, 130);
  ctx.fillText('RDY', 295, 130);

  const png = canvas.toBuffer('image/png');

  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Default Extension="png" ContentType="image/png"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>',
  );
  zip.folder('word')!.file(
    '_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>'
      + '</Relationships>',
  );
  const paragraphs = [
    'AXI outstanding limit 8 per ID since revision R3.',
    'AWLEN[7:0] supports INCR bursts of 1 to 256 beats; bursts must not cross 4KB.',
    'Figure 1: clock-enable handshake timing sketch. T_SETUP is 2 cycles and T_HOLD is 1 cycle on the diagram.',
    'DDRC accepts at most 8-beat bursts (DDRC_MAX_BURST = 8).',
  ]
    .map(
      (text) =>
        '<w:p><w:r><w:t xml:space="preserve">'
        + text
        + '</w:t></w:r></w:p>'
        + '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
        + '<wp:extent cx="3048000" cy="1219200"/><wp:docPr id="1" name="Picture 1"/>'
        + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        + '<pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>'
        + '<pic:blipFill><a:blip r:embed="rId10"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3048000" cy="1219200"/></a:xfrm>'
        + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
        + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>',
    )
    .join('');
  zip.folder('word')!.file(
    'document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<w:body>' + paragraphs + '</w:body></w:document>',
  );
  zip.folder('word')!.folder('media')!.file('image1.png', png);
  return await zip.generateAsync({ type: 'nodebuffer' });
}

// ── 旅程实现 ────────────────────────────────────────────────────

export type JourneyStep = { name: string; ok: boolean; detail?: string; ms?: number };

export type RealModelJourneyResult = {
  ok: boolean;
  failures: string[];
  steps: JourneyStep[];
  modelCalls: ModelCallRecord[];
  credentials: RealCredentials['describe'] | null;
  changeSetId: string | null;
  publishedPageIds: string[];
  query: { text: string; hits: number; firstHitTitle: string | null } | null;
  savedQuery: { changeSetId: string; deduplicated: boolean } | null;
  /** 真实取消（模型调用进行中）与重启恢复证据 */
  cancelProbe: { cancelAckMs: number; taskBackToQueued: boolean; modelCallsAfterAttach: number } | null;
};

export type JourneyOptions = {
  kbPath: string;
  kbId: string;
  kbName: string;
  /** 图文 DOCX 字节（buildJourneyDocx 产物；真实 anydoc 转换 + 提图） */
  docxBytes: Buffer;
  credentials: RealCredentials | null;
  /** 查询文本（从 DOCX 文字层选一个词） */
  query: string;
  /** 单步等待上限 */
  taskTimeoutMs?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runRealModelJourney(options: JourneyOptions): Promise<RealModelJourneyResult> {
  const { kbPath, kbId, kbName, docxBytes, credentials } = options;
  const steps: JourneyStep[] = [];
  const failures: string[] = [];
  const modelCalls: ModelCallRecord[] = [];
  const step = (name: string, ok: boolean, detail?: string, ms?: number) => {
    steps.push({ name, ok, ...(detail ? { detail } : {}), ...(ms !== undefined ? { ms } : {}) });
    if (!ok) failures.push(`${name}: ${detail ?? '失败'}`);
    return ok;
  };

  const result: RealModelJourneyResult = {
    ok: false,
    failures,
    steps,
    modelCalls,
    credentials: credentials?.describe ?? null,
    changeSetId: null,
    publishedPageIds: [],
    query: null,
    savedQuery: null,
    cancelProbe: null,
  };

  if (!credentials) {
    failures.push('未找到可用模型凭证（credentials.json / kb-settings.json），旅程无法执行');
    return result;
  }

  const taskTimeoutMs = options.taskTimeoutMs ?? 480_000;

  // ── 1. 初始化库 ──
  await initWikiLayout(kbPath, { kbId, name: kbName });
  writeSchemaAndPurpose(kbPath);

  // ── 2. 导入图文 DOCX（真实 anydoc 本地转换 + 提图）──
  const incoming = join(kbPath, '..', 'journey-incoming');
  mkdirSync(incoming, { recursive: true });
  const docxAbs = join(incoming, 'spec-mixed.docx');
  writeFileSync(docxAbs, docxBytes);
  const tImport = Date.now();
  const imported = await importWikiSources(kbPath, [{ absolutePath: docxAbs }]);
  const rec0 = imported[0];
  if (!rec0?.ok) {
    step('导入图文 DOCX', false, rec0?.ok === false ? rec0.error.message : 'no result');
    return result;
  }
  const rec: WikiSourceRecord = rec0.source;
  if (rec.parsedRevision !== rec.currentRevision) {
    const conv = await convertWikiSource(kbPath, rec.sourceId, {});
    if (!conv.ok) {
      step('转换图文 DOCX（本地 anydoc）', false, conv.error.message);
      return result;
    }
  }
  const assetDir = journeyAssetDir(kbPath, rec.sourceId, rec.currentRevision);
  const assetFiles = existsSync(assetDir) ? readdirSync(assetDir) : [];
  step(
    '导入并转换图文 DOCX（本地 anydoc，提取位图资产）',
    rec.assetCount > 0 && assetFiles.length > 0,
    `assets=${rec.assetCount ?? 0} assetFiles=${assetFiles.length}`,
    Date.now() - tImport,
  );

  // ── 3. 真实编译（取消探针 + 完成两条路径）──
  const queue = new WikiIngestQueueManager({
    notify: () => undefined,
    compileLlmFactory: async () => realCompileLlm(credentials.compile, modelCalls),
    visionLlmFactory: credentials.vision ? async () => realVisionLlm(credentials.vision!, modelCalls) : async () => null,
  });
  const attach = await queue.attach(kbPath, kbId);
  if (!attach.ok) {
    step('队列 attach', false, attach.reason);
    return result;
  }

  const callsBefore = modelCalls.length;
  const task = await queue.enqueueCompile(kbId, rec.sourceId);

  // 等任务进入执行中（第一次模型调用已发出）
  const RUNNING_PHASES = new Set(['converting', 'vision', 'analyzing', 'generating', 'validating', 'committing']);
  const runningAt = Date.now();
  let sawRunning = false;
  while (Date.now() - runningAt < 120_000) {
    const snap = queue.snapshot(kbId);
    const t = snap?.tasks.find((x) => x.taskId === task.taskId);
    if (t) {
      sawRunning = RUNNING_PHASES.has(t.phase);
      if (sawRunning || ['done', 'failed', 'blocked', 'cancelled'].includes(t.phase)) break;
    }
    await sleep(50);
  }

  // 真实取消：模型调用进行中 pause（取消响应实测，模型延迟不掺入本地数字）
  if (sawRunning) {
    const t0 = Date.now();
    await queue.pause(kbId);
    const cancelAckMs = Date.now() - t0;
    await sleep(300);
    const snap = queue.snapshot(kbId);
    const t = snap?.tasks.find((x) => x.taskId === task.taskId);
    const backToQueued = t?.phase === 'queued';
    // 取消后迟到的模型结果不得写入 wiki/
    const wikiMdCount = countWikiPages(kbPath);
    result.cancelProbe = { cancelAckMs, taskBackToQueued: backToQueued, modelCallsAfterAttach: -1 };
    modelCalls.length = callsBefore; // 取消后的迟到调用不计入旅程统计
    step(
      '真实取消（模型调用进行中）：pause 确认 + 任务回 queued + 无页面写入',
      backToQueued && wikiMdCount === 0,
      `cancelAckMs=${cancelAckMs} phase=${t?.phase} wikiPages=${wikiMdCount}`,
      cancelAckMs,
    );

    // 重启恢复：detach + 重新 attach = 重启；恢复过程必须零模型调用
    await queue.detach(kbId);
    const callsAtAttach = modelCalls.length;
    const mgr2 = new WikiIngestQueueManager({
      notify: () => undefined,
      compileLlmFactory: async () => realCompileLlm(credentials.compile, modelCalls),
      visionLlmFactory: credentials.vision ? async () => realVisionLlm(credentials.vision!, modelCalls) : async () => null,
    });
    const attach2 = await mgr2.attach(kbPath, kbId);
    await sleep(2000); // 给潜在的「自动续跑」留观察窗
    const snap2 = mgr2.snapshot(kbId);
    const t2 = snap2?.tasks.find((x) => x.taskId === task.taskId);
    const consumed = modelCalls.length - callsAtAttach;
    result.cancelProbe = {
      cancelAckMs,
      taskBackToQueued: backToQueued,
      modelCallsAfterAttach: consumed,
    };
    step(
      '重启恢复：重新 attach 后零模型调用（待排队任务等待人工继续）',
      attach2.ok && t2?.phase === 'queued' && consumed === 0,
      `phase=${t2?.phase} consumed=${consumed}`,
    );

    await mgr2.resume(kbId);
    // ── 4. 等编译完成（真实模型）──
    const done = await waitForTask(mgr2, kbId, task.taskId, taskTimeoutMs);
    const lastTask = done.task;
    step(
      '真实模型编译完成（分析 → FILE 提案，含视觉解读）',
      lastTask?.phase === 'done',
      lastTask && lastTask.phase !== 'done' ? `phase=${lastTask.phase} lastError=${JSON.stringify(lastTask.lastError)}` : `modelCalls=${modelCalls.length}`,
    );
    if (lastTask?.phase !== 'done') return result;
    await mgr2.detach(kbId);
  } else {
    // 未观察到 running（可能瞬时完成）——直接等结束
    const done = await waitForTask(queue, kbId, task.taskId, taskTimeoutMs);
    step('真实模型编译完成', done.task?.phase === 'done', `phase=${done.task?.phase}`);
    if (done.task?.phase !== 'done') return result;
    await queue.detach(kbId);
  }

  // ── 5. 审阅：全部接受 ──
  const listed = await listChangeSets(kbPath, kbId);
  if (!listed.ok) {
    step('编译提案进入审阅（staging）', false, 'listChangeSets failed');
    return result;
  }
  if (listed.value.length === 0) {
    step('编译提案进入审阅（staging）', false, 'changeSets=0');
    return result;
  }
  step('编译提案进入审阅（staging）', true, `changeSets=${listed.value.length}`);
  const changeSetId = listed.value[0]!.changeSetId;
  result.changeSetId = changeSetId;
  const cs = await readChangeSet(kbPath, changeSetId);
  if (!cs.ok) {
    step('读取变更集', false, 'readChangeSet failed');
    return result;
  }
  for (const page of cs.value.pages) {
    const dec = await recordDecision(kbPath, {
      changeSetId,
      pageRelPath: page.relPath,
      hunkIds: wikiRealHunkIds(page),
      decision: 'accepted',
    });
    if (!dec.ok) {
      step(`接受页面 ${page.relPath}`, false, dec.ok === false ? dec.error.message : undefined);
      return result;
    }
  }
  step('人工审阅：全部接受', true, `pages=${cs.value.pages.length}`);

  // ── 6. 发布 ──
  const published = await publishChangeSet(kbPath, { kbId, changeSetId });
  if (!step('发布变更集', published.ok, published.ok ? undefined : JSON.stringify(published))) {
    return result;
  }
  result.publishedPageIds = cs.value.pages.map((p) => p.relPath.replace(/^wiki\//, '').replace(/\.md$/, ''));

  // ── 7. 查询（本地关键词检索，模型不参与）──
  const search = await searchWiki(kbPath, { query: options.query, topK: 10 });
  if (search.ok) {
    result.query = {
      text: options.query,
      hits: search.result.hits.length,
      firstHitTitle: search.result.hits[0]?.title ?? null,
    };
    step('发布后关键词查询命中', search.result.hits.length > 0, `hits=${search.result.hits.length}`);
  } else {
    step('发布后关键词查询命中', false, search.error.message);
  }

  // ── 8. 主动保存问答（无证据判断 + 真实引用混选）──
  const sourceRef: WikiSourceRef = {
    sourceId: rec.sourceId,
    sourceRevision: rec.currentRevision,
    parsedHash: rec.parsedHash!,
  };
  const saved = await saveQueryMessages(kbPath, {
    kbId,
    messages: [
      { id: 'm1', role: 'user', content: options.query },
      {
        id: 'm2',
        role: 'assistant',
        content: `根据 [[sources/${rec.sourceId}|来源手册]]：这是基于已发布知识页与来源全文的回答摘要（旅程自动生成）。`,
      },
    ],
    title: '旅程问答：图文来源要点',
    summary: 'issue 30 真实模型旅程保存的问答页。',
    sourceRefs: [sourceRef],
  });
  if (saved.ok) {
    result.savedQuery = { changeSetId: saved.changeSet.changeSetId, deduplicated: saved.deduplicated ?? false };
    const cs2 = await readChangeSet(kbPath, saved.changeSet.changeSetId);
    let accepted = cs2.ok;
    if (cs2.ok) {
      for (const page of cs2.value.pages) {
        const dec = await recordDecision(kbPath, {
          changeSetId: saved.changeSet.changeSetId,
          pageRelPath: page.relPath,
          hunkIds: wikiRealHunkIds(page),
          decision: 'accepted',
        });
        if (!dec.ok) accepted = false;
      }
    }
    const pub2 = accepted ? await publishChangeSet(kbPath, { kbId, changeSetId: saved.changeSet.changeSetId }) : { ok: false as const };
    step('主动保存问答 → 审阅 → 发布为 query 页', pub2.ok, pub2.ok ? undefined : '审阅或发布失败');
  } else {
    step('主动保存问答', false, saved.ok === false ? saved.error.message : undefined);
  }

  result.ok = steps.every((s) => s.ok);
  return result;
}

async function waitForTask(
  mgr: WikiIngestQueueManager,
  kbId: string,
  taskId: string,
  timeoutMs: number,
): Promise<{ task: { phase: string; lastError: unknown } | null }> {
  const startedAt = Date.now();
  for (;;) {
    const snap = mgr.snapshot(kbId);
    const t = snap?.tasks.find((x) => x.taskId === taskId);
    if (t && ['done', 'failed', 'blocked', 'cancelled'].includes(t.phase)) return { task: t };
    if (Date.now() - startedAt > timeoutMs) return { task: t ?? null };
    await sleep(500);
  }
}

function writeSchemaAndPurpose(kbPath: string): void {
  writeFileSync(wikiLayout(kbPath).schemaMdPath, SCHEMA_MD_SKELETON, 'utf-8');
  writeFileSync(join(kbPath, 'purpose.md'), '沉淀 SoC 验证协议知识（issue 30 旅程）。', 'utf-8');
}

function countWikiPages(kbPath: string): number {
  const wikiDir = wikiLayout(kbPath).wikiDir;
  if (!existsSync(wikiDir)) return 0;
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.toLowerCase().endsWith('.md')) total += 1;
    }
  };
  walk(wikiDir);
  return total;
}

/** 资产目录（视觉解读核对用） */
export function journeyAssetDir(kbPath: string, sourceId: string, revision: string): string {
  return pdfAssetDir(wikiLayout(kbPath), sourceId, revision);
}
