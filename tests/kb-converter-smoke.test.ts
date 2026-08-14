/**
 * Knowledge Base Converter 冒烟测试。
 *
 * 使用真实的 @firecrawl/anydoc NAPI 模块验证 ABI 可用性。
 * 不 mock，anydoc 纯本地毫秒级，安全运行。
 */

import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { convertDocument, type ConvertResult } from '../src/main/kb/converter';

describe('convertDocument — 冒烟测试（真实 anydoc NAPI）', () => {
  it('真实转换一个 CSV 文档（无图片）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-smoke-'));
    const csvPath = join(dir, 'sources', 'sample.csv');
    await mkdir(join(dir, 'sources'), { recursive: true });
    await writeFile(csvPath, 'name,value,unit\nalpha,100,mV\nbeta,200,mV\n');

    try {
      const result = await convertDocument(csvPath, dir);
      expect(result.ok).toBe(true);
      const ok = result as Extract<ConvertResult, { ok: true }>;
      expect(ok.markdownPath).toBe(join(dir, 'sample.md'));
      const md = await readFile(ok.markdownPath, 'utf-8');
      expect(md).toContain('alpha');
      expect(md).toContain('100');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
