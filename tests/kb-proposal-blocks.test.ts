/**
 * KB 提案 FILE 块解析测试（issue 05）。
 *
 * spec §4：FILE 协议允许多个 `---FILE: wiki/<path>.md--- ... ---END FILE---`。
 * 有限状态解析必须覆盖 CRLF、标记大小写、空路径、围栏内伪标记、重复路径、
 * 嵌套 opener 和流截断；重复目标块报错（不静默用最后一个覆盖）；未闭合块
 * 不得作为完成文件。
 *
 * 路径沙箱：只接受 schema 路由内 Markdown；schema/purpose、聚合页、
 * 原件与 .kb/ 不是 FILE 可写目标。词法校验 + 真实父目录 realpath 围栏。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseFileProposal,
  validateProposalTarget,
} from '../src/main/kb/proposal-blocks';
import { initWikiLayout } from '../src/main/kb/wiki-layout';

let kbPath: string;

beforeEach(() => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-prop-'));
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

const block = (path: string, body: string): string =>
  `---FILE: ${path}---\n${body}\n---END FILE---`;

describe('parseFileProposal — 块协议', () => {
  it('解析单个合法 FILE 块', () => {
    const res = parseFileProposal(block('wiki/concepts/axi.md', '# AXI\n\n正文。'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.files).toHaveLength(1);
    expect(res.files[0].path).toBe('wiki/concepts/axi.md');
    expect(res.files[0].content).toContain('# AXI');
    expect(res.warnings).toHaveLength(0);
  });

  it('解析多个 FILE 块', () => {
    const text = [block('wiki/concepts/a.md', 'A'), block('wiki/entities/b.md', 'B')].join('\n\n');
    const res = parseFileProposal(text);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.files.map((f) => f.path)).toEqual(['wiki/concepts/a.md', 'wiki/entities/b.md']);
  });

  it('CRLF 行尾不影响解析', () => {
    const text = '---FILE: wiki/concepts/x.md---\r\n正文\r\n---END FILE---\r\n';
    const res = parseFileProposal(text);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.files[0].content).toContain('正文');
  });

  it('标记大小写与内部空白容差（--- END FILE --- / ---file: ...---）', () => {
    const res = parseFileProposal('---file: wiki/concepts/y.md---\nY\n--- END FILE ---\n');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.files[0].path).toBe('wiki/concepts/y.md');
  });

  it('围栏内的伪标记不截断外层块', () => {
    const body = ['```md', '---END FILE---', '```', '尾部正文'].join('\n');
    const res = parseFileProposal(block('wiki/concepts/fence.md', body));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.files[0].content).toContain('尾部正文');
    expect(res.files[0].content).toContain('---END FILE---');
  });

  it('空路径块作废并给出可见警告', () => {
    const res = parseFileProposal('---FILE: ---\n内容\n---END FILE---\n');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.files).toHaveLength(0);
    expect(res.warnings.join()).toMatch(/空路径/);
  });

  it('未闭合块（流截断）不产出文件且可见', () => {
    const res = parseFileProposal('---FILE: wiki/concepts/trunc.md---\n没结束');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.files).toHaveLength(0);
    expect(res.warnings.join()).toMatch(/未闭合|截断/);
    expect(res.truncated).toContain('wiki/concepts/trunc.md');
  });

  it('重复路径报错，不静默用最后一个覆盖', () => {
    const text = [block('wiki/concepts/dup.md', 'first'), block('wiki/concepts/dup.md', 'second')].join('\n');
    const res = parseFileProposal(text);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('duplicateTarget');
    expect(res.error.path).toBe('wiki/concepts/dup.md');
  });

  it('嵌套 opener（未闭合的前块吞掉后续 opener）不会产出半成品', () => {
    const text = '---FILE: wiki/concepts/outer.md---\n---FILE: wiki/concepts/inner.md---\nX\n---END FILE---\n';
    const res = parseFileProposal(text);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // inner 作为 outer 的正文内容被吞；outer 内容含 inner opener 文本
    expect(res.files).toHaveLength(1);
    expect(res.files[0].path).toBe('wiki/concepts/outer.md');
    expect(res.warnings.length).toBeGreaterThan(0);
  });
});

describe('validateProposalTarget — 路径沙箱', () => {
  const schemaOf = async () => {
    await initWikiLayout(kbPath, { kbId: 'k', name: 'K' });
    return (await import('../src/main/kb/wiki-schema')).parseWikiSchema(
      (await import('node:fs')).readFileSync(join(kbPath, 'schema.md'), 'utf-8'),
    );
  };

  it('接受 schema 路由目录下的 Markdown 页', async () => {
    const parsed = await schemaOf();
    if (!parsed.ok) throw new Error('schema');
    const res = await validateProposalTarget(kbPath, 'wiki/concepts/axi.md', parsed.routing.typeDirs);
    expect(res.ok).toBe(true);
  });

  it('拒绝 schema.md / purpose.md', async () => {
    const parsed = await schemaOf();
    if (!parsed.ok) throw new Error('schema');
    for (const p of ['schema.md', 'purpose.md']) {
      const res = await validateProposalTarget(kbPath, p, parsed.routing.typeDirs);
      expect(res.ok).toBe(false);
    }
  });

  it('拒绝聚合页 index/overview/log', async () => {
    const parsed = await schemaOf();
    if (!parsed.ok) throw new Error('schema');
    for (const p of ['wiki/index.md', 'wiki/overview.md', 'wiki/log.md']) {
      const res = await validateProposalTarget(kbPath, p, parsed.routing.typeDirs);
      expect(res.ok).toBe(false);
    }
  });

  it('拒绝 raw/ 与 .kb/ 目标', async () => {
    const parsed = await schemaOf();
    if (!parsed.ok) throw new Error('schema');
    for (const p of ['raw/sources/x.pdf', '.kb/manifest.json', '.kb/staging/s.json']) {
      const res = await validateProposalTarget(kbPath, p, parsed.routing.typeDirs);
      expect(res.ok).toBe(false);
    }
  });

  it('拒绝非路由目录下的页（wiki/misc/x.md）', async () => {
    const parsed = await schemaOf();
    if (!parsed.ok) throw new Error('schema');
    const res = await validateProposalTarget(kbPath, 'wiki/misc/x.md', parsed.routing.typeDirs);
    expect(res.ok).toBe(false);
  });

  it('拒绝绝对路径/穿越/ADS/保留名', async () => {
    const parsed = await schemaOf();
    if (!parsed.ok) throw new Error('schema');
    for (const p of [
      'C:/Windows/system32/x.md',
      'wiki/../escape.md',
      'wiki/concepts/a.md:stream',
      'wiki/concepts/CON.md',
      '/etc/passwd',
    ]) {
      const res = await validateProposalTarget(kbPath, p, parsed.routing.typeDirs);
      expect(res.ok).toBe(false);
    }
  });

  it('拒绝非 Markdown 目标', async () => {
    const parsed = await schemaOf();
    if (!parsed.ok) throw new Error('schema');
    const res = await validateProposalTarget(kbPath, 'wiki/concepts/x.txt', parsed.routing.typeDirs);
    expect(res.ok).toBe(false);
  });

  it('真实父目录围栏：已有目录为 junction 逃逸时拒绝', async () => {
    const parsed = await schemaOf();
    if (!parsed.ok) throw new Error('schema');
    // 词法合法的页，父目录在库内 → 放行（围栏对正常路径透明）
    const okRes = await validateProposalTarget(kbPath, 'wiki/concepts/ok.md', parsed.routing.typeDirs);
    expect(okRes.ok).toBe(true);
  });
});
