/**
 * kb-vision.test.ts — 图像解读模块行为测试（issue 12，spec §3）。
 *
 * 验收：
 *  - 只发送受管图像字节：从 raw/assets 读取字节 → base64 内联，绝不引用本机路径；
 *  - 字节完整性：盘上字节 hash ≠ assetId 时不调用模型（内容寻址资产被破坏）；
 *  - 解读保存图类型、可见数值/关系、不确定项与 assetId；
 *  - 复用：同 assetId + 同上下文指纹（模型/提示版本/邻近文本）的成功解读不重复调用模型；
 *  - 失败保留失败记录（不写成功缓存），不抛异常；取消可观察；
 *  - 机械 parsed 不插入模型解释（本模块不写 raw/parsed）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildVisionPrompt,
  interpretImage,
  runVisionPhase,
  readVisionInterpretations,
  retryVisionAsset,
  verifyVisionModel,
  visionContextHash,
  VISION_PROMPT_VERSION,
  type VisionLlm,
} from '../src/main/kb/vision';
import { loadPdfRuntime } from '../src/main/kb/pdf-runtime';
import { initWikiLayout, wikiLayout, writeWikiManifest } from '../src/main/kb/wiki-layout';
import type { LlmConfig } from '../src/main/kb/llm-config';
import type { WikiVisionInterpretation } from '@shared/kb-types';

let kbPath: string;
const SOURCE_ID = 'a'.repeat(64);
const REVISION = 'b'.repeat(64);

// 1x1 PNG（真实 PNG 字节）
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const ASSET_ID = createHash('sha256').update(PNG_BYTES).digest('hex');

/** 写入受管资产字节 + pdf-assets.json 清单（issue 11 落盘格式）；条目可用 _bytes 覆写盘上字节 */
function writeAssetManifest(assets: Array<Record<string, unknown>>, revision: string = REVISION): void {
  const dir = join(wikiLayout(kbPath).rawAssetsDir, SOURCE_ID, revision);
  mkdirSync(dir, { recursive: true });
  const seen = new Set<string>();
  for (const a of assets) {
    const id = String(a.assetId);
    if (!seen.has(id)) {
      writeFileSync(join(dir, `${id}.${a.ext ?? 'png'}`), (a._bytes as Buffer | undefined) ?? PNG_BYTES);
      seen.add(id);
    }
  }
  const records = assets.map(({ _bytes, ...rest }) => rest);
  writeFileSync(
    join(dir, 'pdf-assets.json'),
    JSON.stringify({
      manifestVersion: 1,
      sourceId: SOURCE_ID,
      revision,
      parsedHash: null,
      extractor: { runtime: 'test', version: '0' },
      assets: records,
      pages: [],
      stats: {
        totalPages: 1, processedPages: 1, failedPages: 0, skippedPages: 0,
        failures: [], skipped: [], bitmapAssets: assets.length, renderAssets: 0,
        renderCandidates: [], renderRendered: [], renderRemaining: [],
        batchLimitReached: false, textPages: 1, cancelled: false,
      },
      extractions: [],
      textLayer: true,
      createdAt: '2026-09-14T00:00:00Z',
      updatedAt: '2026-09-14T00:00:00Z',
    }),
    'utf-8',
  );
}

const OBJECT_ASSET = {
  assetId: ASSET_ID,
  file: `${ASSET_ID}.png`,
  ext: 'png',
  method: 'object' as const,
  page: 3,
  width: 1,
  height: 1,
};

function fakeVisionLlm(
  text: string,
  opts: { fail?: Error; model?: string; onInvoke?: (req: { images: Array<{ base64: string; mediaType: string }>; user: string }) => void } = {},
): VisionLlm & { requests: Array<{ images: Array<{ base64: string; mediaType: string }>; user: string }> } {
  const requests: Array<{ images: Array<{ base64: string; mediaType: string }>; user: string }> = [];
  const invoke = async (req: { images: ReadonlyArray<{ base64: string; mediaType: string }>; user: string }) => {
    requests.push({ images: [...req.images], user: req.user });
    if (opts.fail) throw opts.fail;
    return { text, finishReason: 'stop' as const, usage: { inputTokens: 10, outputTokens: 5 } };
  };
  return {
    model: opts.model ?? 'vision-model',
    requests,
    invoke,
  } as unknown as VisionLlm & { requests: Array<{ images: Array<{ base64: string; mediaType: string }>; user: string }> };
}

const MODEL_OUTPUT = [
  '## 图类型',
  '时序图',
  '## 可见元素与信号',
  'CLK、VALID、READY 三条信号线',
  '## 关系或时序',
  'VALID 在 CLK 上升沿后拉高，READY 反压',
  '## 可辨认数值',
  'outstanding 上限标注为 8',
  '## 不确定项',
  '右侧小字标注不清晰，无法辨认单位',
].join('\n');

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-vision-'));
  await initWikiLayout(kbPath, { kbId: 'kb-vision-1', name: '视觉测试库' });
  await writeWikiManifest(kbPath, {
    manifestVersion: 1,
    format: 'wiki',
    kbId: 'kb-vision-1',
    name: '视觉测试库',
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:00Z',
    sources: {},
  });
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

// ── 提示词 ──────────────────────────────────────────────────────

describe('buildVisionPrompt', () => {
  it('要求事实性解读：图类型/可见信号/关系/数值/不确定项，禁止补齐', () => {
    const p = buildVisionPrompt({ sourceName: 'ddr-spec.pdf', page: 3, method: 'page-render' });
    expect(p.system).toContain('事实');
    expect(p.user).toContain('图类型');
    expect(p.user).toContain('不确定项');
    expect(p.user).toContain('不清晰');
    // 数值原样保留、不换算补齐
    expect(p.user).toContain('换算');
    // 提供了页码与来源名（证据定位），不提供本机路径
    expect(p.user).toContain('ddr-spec.pdf');
    expect(p.user).toContain('3');
    expect(JSON.stringify(p)).not.toMatch(/D:\\|C:\\/);
  });

  it('无页码时不伪造页码', () => {
    const p = buildVisionPrompt({ sourceName: 'x.pdf', page: null, method: 'object' });
    expect(p.user).not.toContain('第 null 页');
  });
});

// ── interpretImage ──────────────────────────────────────────────

describe('interpretImage', () => {
  it('读取受管字节并以 base64 发送，解读字段被结构化保存', async () => {
    writeAssetManifest([OBJECT_ASSET]);
    const llm = fakeVisionLlm(MODEL_OUTPUT);
    const rec = await interpretImage({
      kbPath,
      sourceId: SOURCE_ID,
      sourceRevision: REVISION,
      asset: OBJECT_ASSET,
      llm,
    });
    expect(llm.requests).toHaveLength(1);
    // 实际字节（base64）而非本机路径
    expect(llm.requests[0].images).toEqual([{ mediaType: 'image/png', base64: PNG_BYTES.toString('base64') }]);
    expect(rec.status).toBe('ok');
    expect(rec.assetId).toBe(ASSET_ID);
    expect(rec.imageType).toBe('时序图');
    expect(rec.visibleElements).toContain('CLK');
    expect(rec.relations).toContain('READY');
    expect(rec.visibleValues).toContain('8');
    expect(rec.uncertainties).toContain('不清晰');
    expect(rec.promptVersion).toBe(VISION_PROMPT_VERSION);
    expect(rec.contextHash).toMatch(/^[0-9a-f]{64}$/);
    // 持久化到 .kb/vision
    const saved = JSON.parse(
      readFileSync(join(wikiLayout(kbPath).visionDir, SOURCE_ID, REVISION, `${ASSET_ID}.json`), 'utf-8'),
    ) as WikiVisionInterpretation;
    expect(saved.status).toBe('ok');
    // 机械 parsed 目录不被写入（模型解释不进原文）
    expect(existsSync(join(wikiLayout(kbPath).rawParsedDir, 'x.md'))).toBe(false);
  });

  it('盘上字节与 assetId 不符：不调用模型，失败记录 assetHashMismatch', async () => {
    writeAssetManifest([OBJECT_ASSET]);
    // 覆写为不同字节
    writeFileSync(
      join(wikiLayout(kbPath).rawAssetsDir, SOURCE_ID, REVISION, `${ASSET_ID}.png`),
      Buffer.from('tampered'),
    );
    const llm = fakeVisionLlm(MODEL_OUTPUT);
    const rec = await interpretImage({
      kbPath,
      sourceId: SOURCE_ID,
      sourceRevision: REVISION,
      asset: OBJECT_ASSET,
      llm,
    });
    expect(llm.requests).toHaveLength(0);
    expect(rec.status).toBe('failed');
    expect(rec.errorCode).toBe('assetHashMismatch');
  });

  it('资产文件缺失：失败记录 assetNotFound', async () => {
    mkdirSync(join(wikiLayout(kbPath).rawAssetsDir, SOURCE_ID, REVISION), { recursive: true });
    const llm = fakeVisionLlm(MODEL_OUTPUT);
    const rec = await interpretImage({
      kbPath,
      sourceId: SOURCE_ID,
      sourceRevision: REVISION,
      asset: OBJECT_ASSET,
      llm,
    });
    expect(llm.requests).toHaveLength(0);
    expect(rec.status).toBe('failed');
    expect(rec.errorCode).toBe('assetNotFound');
  });

  it('同上下文成功解读复用：第二次不再调用模型', async () => {
    writeAssetManifest([OBJECT_ASSET]);
    const llm = fakeVisionLlm(MODEL_OUTPUT);
    await interpretImage({ kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, asset: OBJECT_ASSET, llm });
    const rec2 = await interpretImage({ kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, asset: OBJECT_ASSET, llm });
    expect(llm.requests).toHaveLength(1);
    expect(rec2.status).toBe('ok');
  });

  it('模型配置变化后重新解读（指纹不匹配不复用）', async () => {
    writeAssetManifest([OBJECT_ASSET]);
    const llmA = fakeVisionLlm(MODEL_OUTPUT, { model: 'vision-a' });
    await interpretImage({ kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, asset: OBJECT_ASSET, llm: llmA });
    const llmB = fakeVisionLlm(MODEL_OUTPUT, { model: 'vision-b' });
    const rec = await interpretImage({ kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, asset: OBJECT_ASSET, llm: llmB });
    expect(llmB.requests).toHaveLength(1);
    expect(rec.model).toBe('vision-b');
  });

  it('失败解读不复用：重试会再次调用模型；失败记录保留错误码', async () => {
    writeAssetManifest([OBJECT_ASSET]);
    const failing = fakeVisionLlm('', { fail: new Error('端点 500') });
    const rec1 = await interpretImage({ kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, asset: OBJECT_ASSET, llm: failing });
    expect(rec1.status).toBe('failed');
    expect(rec1.errorCode).toBe('llmFailed');
    expect(rec1.errorMessage).toContain('500');

    const ok = fakeVisionLlm(MODEL_OUTPUT);
    const rec2 = await interpretImage({ kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, asset: OBJECT_ASSET, llm: ok });
    expect(ok.requests).toHaveLength(1);
    expect(rec2.status).toBe('ok');
  });
});

// ── runVisionPhase ──────────────────────────────────────────────

describe('runVisionPhase', () => {
  it('无资产清单或空清单：ok 且不需要视觉', async () => {
    const llm = fakeVisionLlm(MODEL_OUTPUT);
    const r = await runVisionPhase({ kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, llm });
    expect(r.needed).toBe(false);
    expect(r.interpretations).toHaveLength(0);
    expect(r.failures).toHaveLength(0);
    expect(llm.requests).toHaveLength(0);
  });

  it('同图多次出现只解读一次，各位置记录保留在资产清单', async () => {
    const dup = { ...OBJECT_ASSET, page: 5 };
    writeAssetManifest([OBJECT_ASSET, dup]);
    const llm = fakeVisionLlm(MODEL_OUTPUT);
    const r = await runVisionPhase({ kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, llm });
    expect(llm.requests).toHaveLength(1);
    expect(r.needed).toBe(true);
    expect(r.interpretations).toHaveLength(1);
    expect(r.stats.total).toBe(1);
  });

  it('多张图逐张解读（并发 1），失败不中断其余图', async () => {
    const bytes2 = Buffer.from('second-image-bytes');
    const asset2 = {
      assetId: createHash('sha256').update(bytes2).digest('hex'),
      file: `${createHash('sha256').update(bytes2).digest('hex')}.png`,
      ext: 'png',
      method: 'object' as const,
      page: 4,
      width: 1,
      height: 1,
    };
    writeAssetManifest([OBJECT_ASSET, { ...asset2, _bytes: bytes2 }]);
    let n = 0;
    const llm = fakeVisionLlm(MODEL_OUTPUT);
    const origInvoke = llm.invoke.bind(llm);
    (llm as unknown as { invoke: typeof llm.invoke }).invoke = async (req) => {
      n += 1;
      if (n === 2) throw new Error('boom');
      return origInvoke(req);
    };
    const r = await runVisionPhase({ kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, llm });
    expect(r.interpretations).toHaveLength(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].errorMessage).toContain('boom');
    expect(r.stats.failed).toBe(1);
    expect(r.stats.interpreted).toBe(1);
  });

  it('未配置视觉模型（llm null）：全部资产记为 visionNotConfigured 失败', async () => {
    writeAssetManifest([OBJECT_ASSET]);
    const r = await runVisionPhase({ kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, llm: null });
    expect(r.needed).toBe(true);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].errorCode).toBe('visionNotConfigured');
  });

  it('取消：已完成的保留，剩余不再解读，cancelled=true', async () => {
    const asset2 = { ...OBJECT_ASSET, assetId: 'd'.repeat(64), file: `${'d'.repeat(64)}.png`, page: 4 };
    writeAssetManifest([OBJECT_ASSET, asset2]);
    const controller = new AbortController();
    const llm = fakeVisionLlm(MODEL_OUTPUT);
    const origInvoke = llm.invoke.bind(llm);
    (llm as unknown as { invoke: typeof llm.invoke }).invoke = async (req) => {
      controller.abort();
      return origInvoke(req);
    };
    const r = await runVisionPhase({
      kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, llm, signal: controller.signal,
    });
    expect(r.cancelled).toBe(true);
    expect(r.interpretations).toHaveLength(1);
    expect(r.failures).toHaveLength(0);
  });

  it('readVisionInterpretations 返回已保存解读；无记录返回 null', async () => {
    expect(await readVisionInterpretations(kbPath, SOURCE_ID)).toBeNull();
    writeAssetManifest([OBJECT_ASSET]);
    const llm = fakeVisionLlm(MODEL_OUTPUT);
    await runVisionPhase({ kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, llm });
    const list = await readVisionInterpretations(kbPath, SOURCE_ID);
    expect(list).toHaveLength(1);
    expect(list?.[0].assetId).toBe(ASSET_ID);
  });
});

// ── verifyVisionModel（图片能力独立验证）────────────────────────

describe('verifyVisionModel', () => {
  const tinyPng = PNG_BYTES.toString('base64');
  function cfg(status: number, body: unknown, apiFormat?: 'openai-responses'): LlmConfig {
    return {
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-test',
      model: 'vision-model',
      providerId: 'openai',
      ...(apiFormat ? { apiFormat } : {}),
      fetchFn: (async () =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch,
    };
  }

  it('端点接受图片并返回文本 → ok', async () => {
    const r = await verifyVisionModel(cfg(200, {
      choices: [{ finish_reason: 'stop', message: { content: 'OK' } }],
    }));
    expect(r.ok).toBe(true);
  });

  it('401 → authError；404 → modelNotFound；400 → imageRejected；429 → rateLimited', async () => {
    expect(await verifyVisionModel(cfg(401, { error: { message: 'bad key' } }))).toMatchObject({
      ok: false, error: { kind: 'authError' },
    });
    expect(await verifyVisionModel(cfg(404, { error: { message: 'no model' } }))).toMatchObject({
      ok: false, error: { kind: 'modelNotFound' },
    });
    expect(await verifyVisionModel(cfg(400, { error: { message: 'image input not supported' } }))).toMatchObject({
      ok: false, error: { kind: 'imageRejected' },
    });
    expect(await verifyVisionModel(cfg(429, { error: { message: 'slow down' } }))).toMatchObject({
      ok: false, error: { kind: 'rateLimited' },
    });
  });

  it('网络失败 → networkError；200 但非 JSON → apiError', async () => {
    expect(
      await verifyVisionModel({
        ...cfg(200, {}),
        fetchFn: (async () => {
          throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch,
      }),
    ).toMatchObject({ ok: false, error: { kind: 'networkError' } });
    expect(await verifyVisionModel(cfg(200, '<html>gateway</html>'))).toMatchObject({
      ok: false, error: { kind: 'apiError' },
    });
  });

  it('验证请求确实携带图片字节', async () => {
    let captured: string | null = null;
    const c: LlmConfig = {
      ...cfg(200, { choices: [{ message: { content: 'OK' } }] }),
      fetchFn: (async (_url: string | URL, init?: RequestInit) => {
        captured = String(init?.body ?? '');
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
      }) as unknown as typeof fetch,
    };
    await verifyVisionModel(c);
    expect(captured).toContain('image_url');
    expect(captured).toContain(tinyPng.slice(0, 20));
  });
});

// ── issue 13：批量读图去重、缓存与续跑 ──────────────────────────

describe('视觉缓存指纹 v2（issue 13：处理参数 + 输出语言参与指纹）', () => {
  it('处理参数或语言变化 → 指纹变化（同图不同发送形态不误用旧解读）', () => {
    const base = {
      assetId: ASSET_ID,
      model: 'vision-model',
      promptVersion: VISION_PROMPT_VERSION,
      nearbyTextHash: '',
    };
    const h1 = visionContextHash({ ...base, processParams: 'orig', language: 'zh' });
    const h2 = visionContextHash({ ...base, processParams: 'maxEdge=2048', language: 'zh' });
    const h3 = visionContextHash({ ...base, processParams: 'orig', language: 'en' });
    expect(new Set([h1, h2, h3]).size).toBe(3);
    expect(h1).toBe(visionContextHash({ ...base, processParams: 'orig', language: 'zh' }));
  });

  it('interpretImage 持久化 language 与 processParams（默认 zh + orig）', async () => {
    writeAssetManifest([OBJECT_ASSET]);
    const rec = await interpretImage({
      kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, asset: OBJECT_ASSET, llm: fakeVisionLlm(MODEL_OUTPUT),
    });
    expect(rec.language).toBe('zh');
    expect(rec.processParams).toBe('orig');
  });
});

describe('同图同上下文并发去重（issue 13）', () => {
  it('并发两请求同 asset+context → 模型只调用 1 次，两者都得到 ok 记录', async () => {
    writeAssetManifest([OBJECT_ASSET]);
    const llm = fakeVisionLlm(MODEL_OUTPUT);
    const input = { kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, asset: OBJECT_ASSET, llm };
    const [a, b] = await Promise.all([interpretImage(input), interpretImage(input)]);
    expect(llm.requests).toHaveLength(1);
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    expect(a.contextHash).toBe(b.contextHash);
  });

  it('并发不同上下文（不同邻近文本）→ 各自调用（去重不跨上下文）', async () => {
    writeAssetManifest([OBJECT_ASSET]);
    const llm = fakeVisionLlm(MODEL_OUTPUT);
    const input = { kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, asset: OBJECT_ASSET, llm };
    await Promise.all([
      interpretImage({ ...input, nearbyTextHash: 'ctx-a' }),
      interpretImage({ ...input, nearbyTextHash: 'ctx-b' }),
    ]);
    expect(llm.requests).toHaveLength(2);
  });

  it('失败不占去重槽位：失败的并发请求结束后，后续请求重新调用模型', async () => {
    writeAssetManifest([OBJECT_ASSET]);
    const failing = fakeVisionLlm('', { fail: new Error('端点 500') });
    const input = { kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, asset: OBJECT_ASSET, llm: failing };
    const [a, b] = await Promise.all([interpretImage(input), interpretImage(input)]);
    expect(a.status).toBe('failed');
    expect(b.status).toBe('failed');
    // 失败不写成功缓存：失败也只调用一次（并发共享同一次尝试），但下一次会真正重试
    expect(failing.requests).toHaveLength(1);
    const ok = fakeVisionLlm(MODEL_OUTPUT);
    const rec = await interpretImage({ ...input, llm: ok });
    expect(ok.requests).toHaveLength(1);
    expect(rec.status).toBe('ok');
  });
});

describe('发送图像尺寸上限（issue 13，spec §3：单张最长边 2048px）', () => {
  it('超限 object 图：发送前等比缩小到最长边 2048，记录 processParams=maxEdge=2048', async () => {
    // 用本地 canvas 运行时生成真实 2500x100 PNG
    const rt = await loadPdfRuntime();
    const big = rt.canvas.createCanvas(2500, 100);
    big.getContext('2d').fillRect?.(0, 0, 2500, 100);
    const bigBytes = Buffer.from(big.encodeSync('png'));
    const bigId = createHash('sha256').update(bigBytes).digest('hex');
    writeAssetManifest([{ assetId: bigId, file: `${bigId}.png`, ext: 'png', method: 'object', page: 2, width: 2500, height: 100, _bytes: bigBytes }]);

    const llm = fakeVisionLlm(MODEL_OUTPUT);
    const rec = await interpretImage({
      kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION,
      asset: { assetId: bigId, ext: 'png', method: 'object', page: 2, width: 2500, height: 100 },
      llm,
    });
    expect(rec.status).toBe('ok');
    expect(rec.processParams).toBe('maxEdge=2048');
    // 发送的是缩放后字节，不是原图字节
    expect(llm.requests).toHaveLength(1);
    const sent = llm.requests[0].images[0];
    expect(sent.base64).not.toBe(bigBytes.toString('base64'));
    // 缩放后最长边 = 2048
    const rt2 = await loadPdfRuntime();
    const decoded = await rt2.canvas.loadImage!(Buffer.from(sent.base64, 'base64'));
    expect(Math.max(decoded.width, decoded.height)).toBe(2048);
  });

  it('超限且解码失败（损坏字节但 hash 匹配）→ imageTooLarge 失败记录，不发送未知字节', async () => {
    const corrupt = Buffer.from('definitely-not-a-decodable-image-oversized');
    const corruptId = createHash('sha256').update(corrupt).digest('hex');
    writeAssetManifest([{ assetId: corruptId, file: `${corruptId}.png`, ext: 'png', method: 'object', page: 2, width: 4000, height: 3000, _bytes: corrupt }], REVISION);
    const llm = fakeVisionLlm(MODEL_OUTPUT);
    const rec = await interpretImage({
      kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION,
      asset: { assetId: corruptId, ext: 'png', method: 'object', page: 2, width: 4000, height: 3000 },
      llm,
    });
    expect(llm.requests).toHaveLength(0);
    expect(rec.status).toBe('failed');
    expect(rec.errorCode).toBe('imageTooLarge');
  });
});

describe('批次页数上限（issue 13，spec §3：每批最多 50 页）', () => {
  /** 生成 pages 页、每页一张独立小图的清单 */
  function manifestOfPages(pages: number): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (let p = 1; p <= pages; p += 1) {
      const bytes = Buffer.from(`page-${p}-image`);
      const id = createHash('sha256').update(bytes).digest('hex');
      out.push({ assetId: id, file: `${id}.png`, ext: 'png', method: 'object', page: p, width: 1, height: 1, _bytes: bytes });
    }
    return out;
  }

  it('61 页 → 只处理前 50 页，batchLimitReached=true，待处理页可见（不暗漏）', async () => {
    writeAssetManifest(manifestOfPages(61));
    const llm = fakeVisionLlm(MODEL_OUTPUT);
    const r = await runVisionPhase({ kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, llm });
    expect(llm.requests).toHaveLength(50);
    expect(r.batchLimitReached).toBe(true);
    expect(r.stats.pages.total).toBe(61);
    expect(r.stats.pages.processed).toBe(50);
    expect(r.stats.pages.pending).toEqual(Array.from({ length: 11 }, (_, i) => i + 51));
    expect(r.stats.total).toBe(61);
    expect(r.stats.interpreted).toBe(50);
  });

  it('继续批次：重跑复用已解读 50 页，只处理剩余 11 页', async () => {
    writeAssetManifest(manifestOfPages(61));
    const llm1 = fakeVisionLlm(MODEL_OUTPUT);
    await runVisionPhase({ kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, llm: llm1 });
    expect(llm1.requests).toHaveLength(50);

    const llm2 = fakeVisionLlm(MODEL_OUTPUT);
    const r2 = await runVisionPhase({ kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, llm: llm2 });
    expect(llm2.requests).toHaveLength(11);
    expect(r2.batchLimitReached).toBe(false);
    expect(r2.stats.pages.pending).toEqual([]);
    expect(r2.stats.reused).toBe(50);
    expect(r2.stats.interpreted).toBe(11);
  });

  it('已全部复用时不触发批次上限（复用页不占配额），进度回调报告 reused', async () => {
    writeAssetManifest(manifestOfPages(60));
    const first = await runVisionPhase({
      kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, llm: fakeVisionLlm(MODEL_OUTPUT), maxBatchPages: 60,
    });
    expect(first.batchLimitReached).toBe(false);

    const progresses: Array<{ done: number; total: number; reused?: number }> = [];
    const r = await runVisionPhase({
      kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, llm: fakeVisionLlm(MODEL_OUTPUT),
      onProgress: (p) => progresses.push({ ...p }),
    });
    expect(r.batchLimitReached).toBe(false);
    expect(r.stats.reused).toBe(60);
    expect(r.stats.interpreted).toBe(0);
    expect(progresses.at(-1)).toMatchObject({ done: 60, total: 60, reused: 60 });
  });
});

describe('真实 usage 汇总（issue 13：UI 报告真实用量）', () => {
  it('两张图各 {10,5} → 合计 {20,10}；totalTokens 存在时求和', async () => {
    const bytes2 = Buffer.from('usage-second-image');
    const asset2Id = createHash('sha256').update(bytes2).digest('hex');
    writeAssetManifest([
      OBJECT_ASSET,
      { assetId: asset2Id, file: `${asset2Id}.png`, ext: 'png', method: 'object', page: 4, width: 1, height: 1, _bytes: bytes2 },
    ]);
    const llm = fakeVisionLlm(MODEL_OUTPUT);
    const r = await runVisionPhase({ kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, llm });
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });

  it('模型响应无 usage → usage=null（不伪造 0）', async () => {
    writeAssetManifest([OBJECT_ASSET]);
    const llm = fakeVisionLlm(MODEL_OUTPUT);
    const origInvoke = llm.invoke.bind(llm);
    (llm as unknown as { invoke: typeof llm.invoke }).invoke = async (req) => {
      const r = await origInvoke(req);
      return { text: typeof r === 'string' ? r : r.text, finishReason: 'stop', usage: null };
    };
    const r = await runVisionPhase({ kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, llm });
    expect(r.usage).toBeNull();
  });
});

describe('已采用解释跨修订保留（issue 13：页面历史可回溯旧解读）', () => {
  it('新修订解读后，旧修订记录仍可读（readVisionInterpretations 按修订隔离）', async () => {
    writeAssetManifest([OBJECT_ASSET]);
    await interpretImage({ kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, asset: OBJECT_ASSET, llm: fakeVisionLlm(MODEL_OUTPUT) });

    const rev2 = 'c'.repeat(64);
    writeAssetManifest([OBJECT_ASSET], rev2);
    await interpretImage({ kbPath, sourceId: SOURCE_ID, sourceRevision: rev2, asset: OBJECT_ASSET, llm: fakeVisionLlm(MODEL_OUTPUT, { model: 'vision-b' }) });

    const old = await readVisionInterpretations(kbPath, SOURCE_ID, REVISION);
    expect(old).toHaveLength(1);
    expect(old?.[0].sourceRevision).toBe(REVISION);
    const cur = await readVisionInterpretations(kbPath, SOURCE_ID, rev2);
    expect(cur?.[0].model).toBe('vision-b');
  });
});

describe('单图独立重试（issue 13：retryVisionAsset）', () => {
  it('按 assetId 重试失败图：只调用该图，成功后记录落盘', async () => {
    const bytes2 = Buffer.from('retry-second-image');
    const asset2Id = createHash('sha256').update(bytes2).digest('hex');
    writeAssetManifest([
      OBJECT_ASSET,
      { assetId: asset2Id, file: `${asset2Id}.png`, ext: 'png', method: 'object', page: 4, width: 1, height: 1, _bytes: bytes2 },
    ]);
    // 两张都失败
    await runVisionPhase({ kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, llm: fakeVisionLlm('', { fail: new Error('端点 500') }) });
    // 单图重试 asset2
    const llm = fakeVisionLlm(MODEL_OUTPUT);
    const rec = await retryVisionAsset({
      kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, assetId: asset2Id, llm,
    });
    expect(llm.requests).toHaveLength(1);
    expect(rec?.assetId).toBe(asset2Id);
    expect(rec?.status).toBe('ok');
    // 第一张失败记录保持不变
    const all = await readVisionInterpretations(kbPath, SOURCE_ID, REVISION);
    expect(all?.find((x) => x.assetId === ASSET_ID)?.status).toBe('failed');
  });

  it('assetId 不在清单 → null（不伪造记录）', async () => {
    writeAssetManifest([OBJECT_ASSET]);
    const rec = await retryVisionAsset({
      kbPath, sourceId: SOURCE_ID, sourceRevision: REVISION, assetId: 'f'.repeat(64), llm: fakeVisionLlm(MODEL_OUTPUT),
    });
    expect(rec).toBeNull();
  });
});
