/**
 * kb-compile-vision.test.ts — 编译视觉门禁行为测试（issue 12，spec §3）。
 *
 * 验收：
 *  - 来源含位图资产且未配置视觉模型 → visionNotConfigured 阻止完整编译
 *    （不暗退回纯文字；提示可改配置或显式选择仅文字继续）；
 *  - 视觉解读失败 → visionFailed 阻止编译；已成功解读保留在 .kb/vision
 *    （重试只重做失败项）；compile LLM 不被调用（不基于缺失证据生成）；
 *  - 用户明确选择仅按文字继续（textOnly）→ 编译继续成功，changeSet.partial=true
 *    且 visionGaps 列出未解读资产（审阅可见「部分产出」，不冒充完整编译）；
 *  - 解读成功 → 附录（明确标注「模型图像解读」+ assetId）进入编译输入；
 *    机械 parsed 全文不变（模型解释不进原文）；
 *  - 无资产来源不受门禁影响。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { compileWikiSource, type CompileLlm, type LlmCallResultLike } from '../src/main/kb/compile';
import { interpretImage, type VisionLlm } from '../src/main/kb/vision';
import { initWikiLayout, writeWikiManifest, wikiLayout, SCHEMA_MD_SKELETON, type WikiKbManifest } from '../src/main/kb/wiki-layout';
import type { WikiSourceRecord } from '@shared/kb-types';

let kbPath: string;

const SOURCE_ID = 'a'.repeat(64);
const REVISION = 'b'.repeat(64);
const PARSED_CONTENT = '来源正文：AXI 协议详解。\n信号表略。';
const PARSED_HASH = createHash('sha256').update(PARSED_CONTENT, 'utf-8').digest('hex');
const SRC_REF = { sourceId: SOURCE_ID, sourceRevision: REVISION, parsedHash: PARSED_HASH };

const SOURCE_PATH = 'note.md';

// 1x1 PNG（真实 PNG 字节）
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const ASSET_ID = createHash('sha256').update(PNG_BYTES).digest('hex');

const MODEL_OUTPUT = [
  '## 图类型',
  '时序图',
  '## 可见元素与信号',
  'CLK、VALID、READY',
  '## 关系或时序',
  'VALID 在 CLK 后拉高',
  '## 可辨认数值',
  'outstanding 上限 8',
  '## 不确定项',
  '右侧小字不清晰',
].join('\n');

/** 写入受管资产字节 + pdf-assets.json 清单（issue 11 落盘格式；_bytes 覆写默认字节） */
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
      parsedHash: PARSED_HASH,
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

/** fake compile LLM：按脚本依序返回，记录调用请求 */
function fakeLlm(responses: LlmCallResultLike[]): CompileLlm & { requests: Array<{ system: string; user: string }> } {
  const requests: Array<{ system: string; user: string }> = [];
  let i = 0;
  return {
    model: 'fake-model',
    requests,
    invoke: async (req: { system: string; user: string }) => {
      requests.push({ system: req.system, user: req.user });
      const r = responses[i++];
      if (!r) throw new Error('fake LLM 脚本耗尽');
      if (typeof r === 'string') return { text: r, finishReason: 'stop', usage: null };
      return r;
    },
  } as unknown as CompileLlm & { requests: Array<{ system: string; user: string }> };
}

/** fake vision LLM：记录请求，可注入失败 */
function fakeVisionLlm(
  text: string,
  opts: { fail?: Error } = {},
): VisionLlm & { calls: number } {
  const state = { calls: 0 };
  return {
    model: 'vision-model',
    get calls() {
      return state.calls;
    },
    invoke: async () => {
      state.calls += 1;
      if (opts.fail) throw opts.fail;
      return { text, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
    },
  } as unknown as VisionLlm & { calls: number };
}

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-compile-vision-'));
  await initWikiLayout(kbPath, { kbId: 'kb-compile-1', name: '编译测试库' });
  writeFileSync(join(wikiLayout(kbPath).rawParsedDir, `${SOURCE_PATH}.md`), PARSED_CONTENT, 'utf-8');
  const manifest: WikiKbManifest = {
    manifestVersion: 1,
    format: 'wiki',
    kbId: 'kb-compile-1',
    name: '编译测试库',
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:00Z',
    sources: {
      [SOURCE_ID]: {
        sourcePath: SOURCE_PATH,
        sourceId: SOURCE_ID,
        ext: '.md',
        size: PARSED_CONTENT.length,
        currentRevision: REVISION,
        parsedRevision: REVISION,
        parsedHash: PARSED_HASH,
        engine: 'text',
        engineFingerprint: 'text',
        status: 'ready',
        assetCount: 0,
        importedAt: '2026-09-14T00:00:00Z',
        updatedAt: '2026-09-14T00:00:00Z',
      } satisfies WikiSourceRecord,
    },
  };
  await writeWikiManifest(kbPath, manifest);
  writeFileSync(wikiLayout(kbPath).purposeMdPath, '记录验证知识与踩坑。', 'utf-8');
  writeFileSync(wikiLayout(kbPath).schemaMdPath, SCHEMA_MD_SKELETON, 'utf-8');
  writeFileSync(join(kbPath, 'wiki', 'index.md'), '# 知识库索引\n\n## 概念\n\n### AXI\n- **路径**: `concepts/axi.md`\n', 'utf-8');
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

// ── 提案文本工具 ────────────────────────────────────────────────

function pageFrontmatter(type: string, title: string): string {
  return [
    '---',
    `type: ${type}`,
    `title: "${title}"`,
    'summary: 摘要。',
    'keywords: [AXI]',
    'tags: []',
    'sources:',
    `  - sourceId: "${SRC_REF.sourceId}"`,
    `    sourceRevision: "${SRC_REF.sourceRevision}"`,
    `    parsedHash: "${SRC_REF.parsedHash}"`,
    'created: "2026-09-14T00:00:00Z"',
    'updated: "2026-09-14T00:00:00Z"',
    '---',
  ].join('\n');
}

const fileBlock = (p: string, body: string): string => `---FILE: ${p}---\n${body}\n---END FILE---`;

function standardScript(): LlmCallResultLike[] {
  const summaryPage = `${pageFrontmatter('source', 'AXI 来源')}\n\n# AXI 来源\n\n概述。`;
  const conceptPage = `${pageFrontmatter('concept', 'AXI')}\n\n# AXI\n\n握手协议。`;
  return [
    { text: '## 关键实体\n- AXI', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } },
    {
      text: [fileBlock(`wiki/sources/${SOURCE_ID}.md`, summaryPage), '', fileBlock('wiki/concepts/axi.md', conceptPage)].join('\n'),
      finishReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 40 },
    },
  ];
}

const compile = (deps: {
  llm: CompileLlm | null;
  visionLlm?: VisionLlm | null;
  textOnly?: boolean;
  signal?: AbortSignal;
}) =>
  compileWikiSource(
    kbPath,
    { kbId: 'kb-compile-1', taskId: 'task-cv1', sourceId: SOURCE_ID },
    { ...deps },
  );

// ── 门禁：未配置 / 失败阻止完整编译 ─────────────────────────────

describe('compileWikiSource — 视觉门禁', () => {
  it('有位图资产且未配置 vision → visionNotConfigured 阻止编译，compile LLM 不被调用', async () => {
    writeAssetManifest([OBJECT_ASSET]);
    const llm = fakeLlm(standardScript());
    const res = await compile({ llm, visionLlm: null });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('visionNotConfigured');
    expect(res.message).toContain('视觉模型');
    expect(res.message).toContain('仅按文字');
    // 不基于缺失证据生成
    expect(llm.requests).toHaveLength(0);
    expect(readdirSync(wikiLayout(kbPath).stagingDir)).toHaveLength(0);
  });

  it('视觉解读失败 → visionFailed 阻止编译；已成功解读保留，compile LLM 不被调用', async () => {
    const bytes2 = Buffer.from('second-image-bytes');
    const asset2Id = createHash('sha256').update(bytes2).digest('hex');
    writeAssetManifest([
      OBJECT_ASSET,
      { assetId: asset2Id, file: `${asset2Id}.png`, ext: 'png', method: 'object', page: 4, width: 1, height: 1 },
    ]);
    // 第二张失败：覆写字节使 hash 失配（assetHashMismatch）
    writeFileSync(join(wikiLayout(kbPath).rawAssetsDir, SOURCE_ID, REVISION, `${asset2Id}.png`), Buffer.from('tampered'));
    const llm = fakeLlm(standardScript());
    const res = await compile({ llm, visionLlm: fakeVisionLlm(MODEL_OUTPUT) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('visionFailed');
    expect(res.message).toContain('解读失败');
    expect(llm.requests).toHaveLength(0);
    // 已成功解读保留（重试只重做失败项）
    const visionDir = join(wikiLayout(kbPath).visionDir, SOURCE_ID, REVISION);
    expect(existsSync(join(visionDir, `${ASSET_ID}.json`))).toBe(true);
    expect(readdirSync(wikiLayout(kbPath).stagingDir)).toHaveLength(0);
  });

  it('无资产来源不受门禁影响（不要求配置 vision）', async () => {
    const llm = fakeLlm(standardScript());
    const res = await compile({ llm, visionLlm: null });
    expect(res.ok).toBe(true);
    expect(llm.requests).toHaveLength(2);
  });
});

// ── 解读成功：附录进入编译输入 ─────────────────────────────────

describe('compileWikiSource — 视觉附录', () => {
  it('解读成功 → 附录进入分析提示词（模型图像解读 + assetId），编译成功不标 partial', async () => {
    writeAssetManifest([OBJECT_ASSET]);
    const vision = fakeVisionLlm(MODEL_OUTPUT);
    const llm = fakeLlm(standardScript());
    const res = await compile({ llm, visionLlm: vision });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(vision.invoke).toBeDefined();
    // 附录明确标注模型生成与非原文，携带 assetId 与解读内容
    expect(llm.requests[0]!.user).toContain('模型图像解读');
    expect(llm.requests[0]!.user).toContain(ASSET_ID.slice(0, 8));
    expect(llm.requests[0]!.user).toContain('时序图');
    expect(llm.requests[0]!.user).toContain('不清晰');
    // 不冒充完整编译：partial 不标、visionGaps 为空
    expect(res.changeSet.partial).toBeFalsy();
    expect(res.changeSet.visionGaps ?? []).toHaveLength(0);
    // 机械 parsed 全文不变（模型解释不进原文）
    expect(readFileSync(join(wikiLayout(kbPath).rawParsedDir, `${SOURCE_PATH}.md`), 'utf-8')).toBe(PARSED_CONTENT);
  });
});

// ── 仅按文字继续：partial + 视觉缺口 ───────────────────────────

describe('compileWikiSource — 仅按文字继续（textOnly）', () => {
  it('textOnly=true → 跳过视觉调用，编译成功且 partial=true、visionGaps 列出未解读资产', async () => {
    writeAssetManifest([OBJECT_ASSET]);
    const vision = fakeVisionLlm(MODEL_OUTPUT);
    const llm = fakeLlm(standardScript());
    const res = await compile({ llm, visionLlm: vision, textOnly: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 明确跳过：不调用视觉模型
    expect((vision as unknown as { calls: number }).calls).toBe(0);
    expect(res.changeSet.partial).toBe(true);
    expect(res.changeSet.visionGaps).toHaveLength(1);
    expect(res.changeSet.visionGaps![0]).toMatchObject({ assetId: ASSET_ID, page: 3 });
    // 提案可见「部分产出」提示
    expect(res.changeSet.warnings.join('\n')).toContain('部分产出');
  });

  it('textOnly=true + 既有成功解读 → gaps 只列缺失资产，附录复用既有解读', async () => {
    const bytes2 = Buffer.from('second-image-bytes');
    const asset2Id = createHash('sha256').update(bytes2).digest('hex');
    const asset2 = { assetId: asset2Id, file: `${asset2Id}.png`, ext: 'png', method: 'object' as const, page: 4, width: 1, height: 1 };
    // 预置 asset1 的既有成功解读
    writeAssetManifest([OBJECT_ASSET, asset2]);
    await interpretImage({
      kbPath,
      sourceId: SOURCE_ID,
      sourceRevision: REVISION,
      asset: OBJECT_ASSET,
      llm: fakeVisionLlm(MODEL_OUTPUT),
    });
    const llm = fakeLlm(standardScript());
    const res = await compile({ llm, visionLlm: null, textOnly: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changeSet.partial).toBe(true);
    expect(res.changeSet.visionGaps).toHaveLength(1);
    expect(res.changeSet.visionGaps![0].assetId).toBe(asset2Id);
    // 既有解读作为附录进入编译输入（复用已完成产物）
    expect(llm.requests[0]!.user).toContain('模型图像解读');
    expect(llm.requests[0]!.user).toContain(ASSET_ID.slice(0, 8));
  });
});

// ── 批次页数上限与真实 usage（issue 13）────────────────────────

describe('compileWikiSource — 批次上限与真实 usage（issue 13）', () => {
  /** 生成 pages 页、每页一张独立小图的清单 */
  function manifestOfPages(pages: number): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (let p = 1; p <= pages; p += 1) {
      const bytes = Buffer.from(`compile-page-${p}-image`);
      const id = createHash('sha256').update(bytes).digest('hex');
      out.push({ assetId: id, file: `${id}.png`, ext: 'png', method: 'object', page: p, width: 1, height: 1, _bytes: bytes });
    }
    return out;
  }

  it('解读达到单批页上限 → visionBatchLimit 阻止编译（不暗漏页），提示继续批次或缩小范围', async () => {
    writeAssetManifest(manifestOfPages(61));
    const llm = fakeLlm(standardScript());
    const res = await compile({ llm, visionLlm: fakeVisionLlm(MODEL_OUTPUT) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('visionBatchLimit');
    // 可操作信息：待处理页可见，给出继续批次/缩小范围两条路
    expect(res.message).toContain('待处理');
    expect(res.message).toContain('11');
    expect(res.message).toContain('继续');
    expect(res.message).toContain('缩小范围');
    // 不基于不完整证据生成
    expect(llm.requests).toHaveLength(0);
    expect(readdirSync(wikiLayout(kbPath).stagingDir)).toHaveLength(0);
  });

  it('解读成功的真实 usage 汇入编译诊断（UI 报告真实用量，不伪造）', async () => {
    writeAssetManifest([OBJECT_ASSET]);
    const llm = fakeLlm(standardScript());
    const res = await compile({ llm, visionLlm: fakeVisionLlm(MODEL_OUTPUT) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // fakeVisionLlm 每次调用 usage {inputTokens:10, outputTokens:5}
    expect(res.usage).toContainEqual({ inputTokens: 10, outputTokens: 5 });
  });
});
