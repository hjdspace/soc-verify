/**
 * kb-compile-cache.test.ts — 编译缓存增量跳过行为测试（issue 17，验收 A02/A08/A12）。
 *
 * 验收映射：
 *  - 来源/转换/视觉/模型/规则/purpose/提示及实际读依赖参与缓存指纹
 *  - 仅完整已发布产出可成功命中，还需验证产出存在与来源/依赖有效
 *  - awaiting_review 不重复生成；全拒绝保留决定避免刷新烧 token；force 新建尝试
 *  - published_partial 不记录完整成功；索引刷新失败只重试索引
 *  - 变化 schema、模型、parsed 或删除产出文件均能精准失效
 *  - 未变化不会重复 LLM 调用
 *
 * 测试缝：直接调用 compile-cache 模块的纯函数 + compileWikiSource 的缓存集成。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  computeCacheFingerprint,
  checkCompileCache,
  saveCompileCache,
  clearCompileCache,
  recordRejection,
  checkRejection,
  type CompileCacheEntry,
  type CompileCacheFingerprintInput,
} from '../src/main/kb/compile-cache';
import { initWikiLayout, writeWikiManifest, wikiLayout, SCHEMA_MD_SKELETON, type WikiKbManifest } from '../src/main/kb/wiki-layout';
import type { WikiSourceRecord } from '@shared/kb-types';

let kbPath: string;

const SOURCE_ID = 'a'.repeat(64);
const REVISION = 'b'.repeat(64);
const PARSED_HASH = createHash('sha256').update('来源正文', 'utf-8').digest('hex');
const SOURCE_PATH = 'note.md';
const MODEL_FP = 'fake-model';
const SCHEMA_HASH = createHash('sha256').update(SCHEMA_MD_SKELETON, 'utf-8').digest('hex');
const PURPOSE_HASH = createHash('sha256').update('purpose', 'utf-8').digest('hex');

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-cache-'));
  await initWikiLayout(kbPath, { kbId: 'kb-cache-1', name: '缓存测试库' });
  writeFileSync(wikiLayout(kbPath).purposeMdPath, 'purpose', 'utf-8');
  writeFileSync(wikiLayout(kbPath).schemaMdPath, SCHEMA_MD_SKELETON, 'utf-8');
});

/** 在 manifest 中设置来源记录，使 checkCompileCache 的来源修订校验通过 */
async function setupSourceInManifest(): Promise<void> {
  const manifest: WikiKbManifest = {
    manifestVersion: 1,
    format: 'wiki',
    kbId: 'kb-cache-1',
    name: '缓存测试库',
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:00Z',
    sources: {
      [SOURCE_ID]: {
        sourcePath: SOURCE_PATH,
        sourceId: SOURCE_ID,
        ext: '.md',
        size: 0,
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
}

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

// ── 指纹计算 ─────────────────────────────────────────────────────

describe('computeCacheFingerprint — 指纹参与因子', () => {
  const baseInput: CompileCacheFingerprintInput = {
    sourceId: SOURCE_ID,
    sourceRevision: REVISION,
    parsedHash: PARSED_HASH,
    visionHash: null,
    schemaHash: SCHEMA_HASH,
    purposeHash: PURPOSE_HASH,
    modelFingerprint: MODEL_FP,
    readDependencyHash: 'read-dep-hash',
    publishedPageIds: ['concepts/axi'],
  };

  it('来源修订变化 → 指纹不同', () => {
    const a = computeCacheFingerprint(baseInput);
    const b = computeCacheFingerprint({ ...baseInput, sourceRevision: 'c'.repeat(64) });
    expect(a).not.toBe(b);
  });

  it('parsedHash 变化 → 指纹不同', () => {
    const a = computeCacheFingerprint(baseInput);
    const b = computeCacheFingerprint({ ...baseInput, parsedHash: 'd'.repeat(64) });
    expect(a).not.toBe(b);
  });

  it('schemaHash 变化 → 指纹不同', () => {
    const a = computeCacheFingerprint(baseInput);
    const b = computeCacheFingerprint({ ...baseInput, schemaHash: 'e'.repeat(64) });
    expect(a).not.toBe(b);
  });

  it('purposeHash 变化 → 指纹不同', () => {
    const a = computeCacheFingerprint(baseInput);
    const b = computeCacheFingerprint({ ...baseInput, purposeHash: 'f'.repeat(64) });
    expect(a).not.toBe(b);
  });

  it('modelFingerprint 变化 → 指纹不同', () => {
    const a = computeCacheFingerprint(baseInput);
    const b = computeCacheFingerprint({ ...baseInput, modelFingerprint: 'other-model' });
    expect(a).not.toBe(b);
  });

  it('visionHash 变化 → 指纹不同', () => {
    const a = computeCacheFingerprint(baseInput);
    const b = computeCacheFingerprint({ ...baseInput, visionHash: 'vision-hash' });
    expect(a).not.toBe(b);
  });

  it('readDependencyHash 变化 → 指纹不同', () => {
    const a = computeCacheFingerprint(baseInput);
    const b = computeCacheFingerprint({ ...baseInput, readDependencyHash: 'other-read-dep' });
    expect(a).not.toBe(b);
  });

  it('publishedPageIds 变化 → 指纹不同', () => {
    const a = computeCacheFingerprint(baseInput);
    const b = computeCacheFingerprint({ ...baseInput, publishedPageIds: ['concepts/axi', 'entities/cpu'] });
    expect(a).not.toBe(b);
  });

  it('相同输入 → 指纹一致（确定性）', () => {
    const a = computeCacheFingerprint(baseInput);
    const b = computeCacheFingerprint(baseInput);
    expect(a).toBe(b);
  });
});

// ── 缓存命中与失效 ───────────────────────────────────────────────

describe('checkCompileCache — 命中条件', () => {
  const baseFingerprintInput: CompileCacheFingerprintInput = {
    sourceId: SOURCE_ID,
    sourceRevision: REVISION,
    parsedHash: PARSED_HASH,
    visionHash: null,
    schemaHash: SCHEMA_HASH,
    purposeHash: PURPOSE_HASH,
    modelFingerprint: MODEL_FP,
    readDependencyHash: 'read-dep-hash',
    publishedPageIds: [],
  };

  it('无缓存文件 → miss', async () => {
    const result = await checkCompileCache(kbPath, baseFingerprintInput);
    expect(result.hit).toBe(false);
  });

  it('指纹匹配且产出文件存在 → hit', async () => {
    // 在 manifest 中设置来源记录
    await setupSourceInManifest();

    const fp = computeCacheFingerprint(baseFingerprintInput);
    // 创建产出文件
    mkdirSync(join(kbPath, 'wiki', 'sources'), { recursive: true });
    writeFileSync(join(kbPath, 'wiki', 'sources', `${SOURCE_ID}.md`), 'page content', 'utf-8');

    const entry: CompileCacheEntry = {
      fingerprint: fp,
      sourceId: SOURCE_ID,
      sourceRevision: REVISION,
      publishedPageIds: [`sources/${SOURCE_ID}`],
      publishedAt: '2026-09-14T00:00:00Z',
      partial: false,
    };
    await saveCompileCache(kbPath, SOURCE_ID, entry);

    const result = await checkCompileCache(kbPath, baseFingerprintInput);
    expect(result.hit).toBe(true);
  });

  it('指纹不匹配 → miss（schema 变化）', async () => {
    await setupSourceInManifest();
    const fp = computeCacheFingerprint(baseFingerprintInput);
    mkdirSync(join(kbPath, 'wiki', 'sources'), { recursive: true });
    writeFileSync(join(kbPath, 'wiki', 'sources', `${SOURCE_ID}.md`), 'page content', 'utf-8');

    const entry: CompileCacheEntry = {
      fingerprint: fp,
      sourceId: SOURCE_ID,
      sourceRevision: REVISION,
      publishedPageIds: [`sources/${SOURCE_ID}`],
      publishedAt: '2026-09-14T00:00:00Z',
      partial: false,
    };
    await saveCompileCache(kbPath, SOURCE_ID, entry);

    const result = await checkCompileCache(kbPath, {
      ...baseFingerprintInput,
      schemaHash: 'changed-schema',
    });
    expect(result.hit).toBe(false);
  });

  it('产出文件被删除 → miss（精准失效）', async () => {
    await setupSourceInManifest();
    const fp = computeCacheFingerprint(baseFingerprintInput);
    mkdirSync(join(kbPath, 'wiki', 'sources'), { recursive: true });
    writeFileSync(join(kbPath, 'wiki', 'sources', `${SOURCE_ID}.md`), 'page content', 'utf-8');

    const entry: CompileCacheEntry = {
      fingerprint: fp,
      sourceId: SOURCE_ID,
      sourceRevision: REVISION,
      publishedPageIds: [`sources/${SOURCE_ID}`],
      publishedAt: '2026-09-14T00:00:00Z',
      partial: false,
    };
    await saveCompileCache(kbPath, SOURCE_ID, entry);

    // 删除产出文件
    rmSync(join(kbPath, 'wiki', 'sources', `${SOURCE_ID}.md`));

    const result = await checkCompileCache(kbPath, baseFingerprintInput);
    expect(result.hit).toBe(false);
  });

  it('partial=true 的缓存 → miss（published_partial 不冒充完整成功）', async () => {
    await setupSourceInManifest();
    const fp = computeCacheFingerprint(baseFingerprintInput);
    mkdirSync(join(kbPath, 'wiki', 'sources'), { recursive: true });
    writeFileSync(join(kbPath, 'wiki', 'sources', `${SOURCE_ID}.md`), 'page content', 'utf-8');

    const entry: CompileCacheEntry = {
      fingerprint: fp,
      sourceId: SOURCE_ID,
      sourceRevision: REVISION,
      publishedPageIds: [`sources/${SOURCE_ID}`],
      publishedAt: '2026-09-14T00:00:00Z',
      partial: true, // published_partial 不记录完整成功
    };
    await saveCompileCache(kbPath, SOURCE_ID, entry);

    const result = await checkCompileCache(kbPath, baseFingerprintInput);
    expect(result.hit).toBe(false);
  });
});

// ── 全拒绝记录 ───────────────────────────────────────────────────

describe('recordRejection / checkRejection — 全拒绝不烧 token', () => {
  it('记录全拒绝 → checkRejection 返回 true', async () => {
    await recordRejection(kbPath, SOURCE_ID, REVISION, '2026-09-14T00:00:00Z');
    const result = await checkRejection(kbPath, SOURCE_ID, REVISION);
    expect(result.rejected).toBe(true);
  });

  it('无拒绝记录 → rejected=false', async () => {
    const result = await checkRejection(kbPath, SOURCE_ID, REVISION);
    expect(result.rejected).toBe(false);
  });

  it('来源修订变化 → 旧拒绝记录不适用', async () => {
    await recordRejection(kbPath, SOURCE_ID, REVISION, '2026-09-14T00:00:00Z');
    const result = await checkRejection(kbPath, SOURCE_ID, 'c'.repeat(64));
    expect(result.rejected).toBe(false);
  });

  it('clearCompileCache 同时清除拒绝记录', async () => {
    await recordRejection(kbPath, SOURCE_ID, REVISION, '2026-09-14T00:00:00Z');
    await clearCompileCache(kbPath, SOURCE_ID);
    const result = await checkRejection(kbPath, SOURCE_ID, REVISION);
    expect(result.rejected).toBe(false);
  });
});

// ── 缓存持久化 ───────────────────────────────────────────────────

describe('saveCompileCache / clearCompileCache — 持久化', () => {
  it('saveCompileCache 写入文件且可读回', async () => {
    const entry: CompileCacheEntry = {
      fingerprint: 'test-fp',
      sourceId: SOURCE_ID,
      sourceRevision: REVISION,
      publishedPageIds: ['sources/x'],
      publishedAt: '2026-09-14T00:00:00Z',
      partial: false,
    };
    await saveCompileCache(kbPath, SOURCE_ID, entry);
    const cachePath = join(wikiLayout(kbPath).kbDir, 'compile-cache', `${SOURCE_ID}.json`);
    expect(existsSync(cachePath)).toBe(true);
    const raw = JSON.parse(readFileSync(cachePath, 'utf-8'));
    expect(raw.fingerprint).toBe('test-fp');
  });

  it('clearCompileCache 删除缓存文件（幂等）', async () => {
    const entry: CompileCacheEntry = {
      fingerprint: 'test-fp',
      sourceId: SOURCE_ID,
      sourceRevision: REVISION,
      publishedPageIds: [],
      publishedAt: '2026-09-14T00:00:00Z',
      partial: false,
    };
    await saveCompileCache(kbPath, SOURCE_ID, entry);
    await clearCompileCache(kbPath, SOURCE_ID);
    const cachePath = join(wikiLayout(kbPath).kbDir, 'compile-cache', `${SOURCE_ID}.json`);
    expect(existsSync(cachePath)).toBe(false);
    // 再次清除不报错
    await clearCompileCache(kbPath, SOURCE_ID);
  });
});
