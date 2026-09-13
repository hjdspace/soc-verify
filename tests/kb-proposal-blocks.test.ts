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
  filterTruncatedFileRepairOutput,
  serializeProposalFiles,
  checkTargetRoute,
  normalizeProposalPath,
} from '../src/main/kb/proposal-blocks';
import { initWikiLayout } from '../src/main/kb/wiki-layout';
import { DEFAULT_TYPE_DIRS } from '../src/main/kb/wiki-schema';

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

// ── issue 09：任意 token 分片与敌意流 ─────────────────────────

/** 把文本按固定大小切片（模拟 token 分片到达） */
function sliceInto(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

/** 确定性伪随机分片（避免 flaky） */
function sliceRandom(text: string, seed: number): string[] {
  const chunks: string[] = [];
  let s = seed >>> 0;
  let i = 0;
  while (i < text.length) {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    const size = 1 + (s % 7);
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  return chunks;
}

/** 敌意流：CRLF + 标记大小写 + 围栏伪标记 + 空路径 + 嵌套 opener + 大小写重复路径 + 截断 */
const HOSTILE_STREAM = [
  '---FILE: wiki/concepts/axi.md---',
  '```md',
  '---END FILE---',                                          // 围栏内伪标记：不截断外层块
  '```',
  '--- end file ---',                                        // 大小写变体 closer
  '',
  '---FILE: wiki/concepts/outer.md---',
  '---FILE: wiki/concepts/inner.md---',                    // 未闭合块内的嵌套 opener（作为正文）
  'X',
  '---END FILE---',
  '',
  '---file: wiki/entities/dup.md---',
  'first',
  '---END FILE---',
  '',
  '---FILE: Wiki/Entities/DUP.md---',                        // 大小写 + 分隔符等价的重复目标
  'second',
  '---END FILE---',
  '',
  '---FILE: ---',
  '空路径',
  '---END FILE---',
  '',
  '---FILE: wiki/concepts/trunc.md---',
  '没结束的内容',                                            // 流截断（无 closer）
].join('\r\n');

describe('parseFileProposal — 任意 token 分片与敌意流（issue 09）', () => {
  it('任意分片边界下解析结果一致（1..17 字节 + 确定性随机分片）', () => {
    const expected = parseFileProposal(HOSTILE_STREAM);
    for (let size = 1; size <= 17; size += 1) {
      const rejoined = sliceInto(HOSTILE_STREAM, size).join('');
      expect(parseFileProposal(rejoined)).toEqual(expected);
    }
    for (const seed of [1, 7, 42, 1337]) {
      const rejoined = sliceRandom(HOSTILE_STREAM, seed).join('');
      expect(parseFileProposal(rejoined)).toEqual(expected);
    }
  });

  it('敌意流：大小写等价的重复路径立即报错，不用最后一个静默覆盖', () => {
    const res = parseFileProposal(HOSTILE_STREAM);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('duplicateTarget');
    expect(res.error.path).toBe('Wiki/Entities/DUP.md');
  });

  it('去掉重复路径后：伪标记/大小写 closer/嵌套 opener 不产出半成品，截断块可见', () => {
    const text = [
      '---FILE: wiki/concepts/axi.md---',
      '```md',
      '---END FILE---',
      '```',
      '--- end file ---',
      '',
      '---FILE: wiki/concepts/outer.md---',
      '---FILE: wiki/concepts/inner.md---',
      'X',
      '---END FILE---',
      '',
      '---FILE: ---',
      '空路径',
      '---END FILE---',
      '',
      '---FILE: wiki/concepts/trunc.md---',
      '没结束的内容',
    ].join('\r\n');
    const res = parseFileProposal(text);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.files.map((f) => f.path)).toEqual(['wiki/concepts/axi.md', 'wiki/concepts/outer.md']);
    // 围栏内伪标记是正文；大小写 closer 被正确消费（用于闭合块）
    expect(res.files[0]!.content).toContain('---END FILE---');
    expect(res.files[0]!.content).not.toContain('--- end file ---');
    // 嵌套 opener 只产出外块（inner 文本被吞进 outer 正文）
    expect(res.files[1]!.content).toContain('inner.md');
    expect(res.truncated).toEqual(['wiki/concepts/trunc.md']);
    expect(res.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('normalizeProposalPath：反斜杠/大小写/前缀点归一（Windows 不敏感）', () => {
    expect(normalizeProposalPath(' Wiki\\Concepts\\AXI.md ')).toBe('wiki/concepts/axi.md');
    expect(normalizeProposalPath('./wiki/index.md')).toBe('wiki/index.md');
  });

  it('serializeProposalFiles 往返：规范化 CRLF 并可再次解析', () => {
    const text = serializeProposalFiles([
      { path: 'wiki/concepts/a.md', content: '# A\r\n正文\r\n' },
      { path: 'wiki/entities/b.md', content: '# B' },
    ]);
    expect(text).toContain('---FILE: wiki/concepts/a.md---');
    expect(text).not.toContain('\r');
    const res = parseFileProposal(text);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.files.map((f) => f.path)).toEqual(['wiki/concepts/a.md', 'wiki/entities/b.md']);
    expect(res.files[0]!.content).toContain('正文');
  });

  it('checkTargetRoute：只放行 schema 路由内 Markdown，拒绝聚合页/受管子树', () => {
    const dirs = DEFAULT_TYPE_DIRS;
    expect(checkTargetRoute('wiki/concepts/axi.md', dirs).ok).toBe(true);
    expect(checkTargetRoute('wiki/sources/x.md', dirs).ok).toBe(true);
    expect(checkTargetRoute('wiki/index.md', dirs).ok).toBe(false);
    expect(checkTargetRoute('wiki/misc/x.md', dirs).ok).toBe(false);
    expect(checkTargetRoute('wiki/concepts/x.txt', dirs).ok).toBe(false);
    expect(checkTargetRoute('raw/sources/x.md', dirs).ok).toBe(false);
    expect(checkTargetRoute('.kb/staging/x.md', dirs).ok).toBe(false);
    expect(checkTargetRoute('../escape.md', dirs).ok).toBe(false);
  });
});

// ── issue 09：有界修复输出过滤 ────────────────────────────────

describe('filterTruncatedFileRepairOutput — 只接受既定目标', () => {
  const allowed = ['wiki/sources/abc.md', 'wiki/concepts/trunc.md'];

  it('保留既定目标块，丢弃未请求路径（可见警告）', () => {
    const text = [
      block('wiki/concepts/other.md', '不该出现的页'),
      block('wiki/sources/abc.md', '摘要正文'),
      block('wiki/concepts/trunc.md', '补齐的正文'),
    ].join('\n');
    const res = filterTruncatedFileRepairOutput(text, allowed);
    expect(res.files.map((f) => f.path)).toEqual(['wiki/sources/abc.md', 'wiki/concepts/trunc.md']);
    expect(res.dropped).toEqual(['wiki/concepts/other.md']);
    expect(res.duplicates).toEqual([]);
    expect(res.warnings.join('\n')).toContain('未请求');
  });

  it('修复输出内重复的既定目标 → 整批拒绝（不用最后一个静默覆盖）', () => {
    const text = [
      block('wiki/sources/abc.md', '摘要第一份'),
      block('wiki/sources/abc.md', '摘要第二份'),
      block('wiki/concepts/trunc.md', '补齐的正文'),
    ].join('\n');
    const res = filterTruncatedFileRepairOutput(text, allowed);
    expect(res.files).toEqual([]);
    expect(res.duplicates).toEqual(['wiki/sources/abc.md']);
    expect(res.warnings.join()).toMatch(/解析失败|重复/);
  });

  it('修复未闭合（仍截断）→ files 空且 truncated 报告既定目标', () => {
    const text = `---FILE: wiki/concepts/trunc.md---\n又没结束`;
    const res = filterTruncatedFileRepairOutput(text, allowed);
    expect(res.files).toEqual([]);
    expect(res.truncated).toEqual(['wiki/concepts/trunc.md']);
  });

  it('大小写/分隔符归一后仍匹配既定目标（Windows 不敏感）', () => {
    const res = filterTruncatedFileRepairOutput(
      block('Wiki\\Sources\\ABC.md', '正文'),
      allowed,
    );
    expect(res.files).toHaveLength(1);
    expect(res.dropped).toEqual([]);
  });
});
