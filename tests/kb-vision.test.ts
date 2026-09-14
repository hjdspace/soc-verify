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
  verifyVisionModel,
  VISION_PROMPT_VERSION,
  type VisionLlm,
} from '../src/main/kb/vision';
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
function writeAssetManifest(assets: Array<Record<string, unknown>>): void {
  const dir = join(wikiLayout(kbPath).rawAssetsDir, SOURCE_ID, REVISION);
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
      revision: REVISION,
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
