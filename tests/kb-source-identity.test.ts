/**
 * kb source identity 行为测试（issue 02 — 导入来源身份规则）。
 *
 * spec §1 身份规则：
 *  - sourcePath 是相对 raw/sources/ 的规范路径，持久化使用 `/`；
 *    拒绝绝对路径与穿越。
 *  - sourceId 由规范化的完整相对路径计算 SHA256（包括目录与扩展名）；
 *    a/report.pdf、b/report.pdf、a/report.docx 是三个来源。
 *  - Windows 大小写等价、Unicode NFC 归一后检测碰撞，保留显示拼写。
 *  - parsed 输出为 <sourcePath>.md（保留源扩展名，如 notes.md.md）。
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  normalizeSourcePath,
  sourceIdFor,
  sourceCollisionKey,
  isTextImportExtension,
} from '../src/main/kb/source-identity';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf-8').digest('hex');

describe('normalizeSourcePath', () => {
  it('接受普通相对路径并统一为 / 分隔', () => {
    const r = normalizeSourcePath('manuals\\AXI\\spec.pdf');
    expect(r).toEqual({ ok: true, normalized: 'manuals/AXI/spec.pdf' });
  });

  it('NFC 归一化显示拼写（组合变音符号 → 预组合）', () => {
    const composed = 'café.pdf'; // U+00E9
    const decomposed = 'cafe\u0301.pdf'; // e + U+0301
    const a = normalizeSourcePath(composed);
    const b = normalizeSourcePath(decomposed);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.normalized).toBe(b.normalized);
      expect(a.normalized === 'café.pdf' || a.normalized === decomposed.normalize('NFC')).toBe(true);
    }
  });

  it('拒绝绝对路径、穿越、盘符、UNC、ADS、保留名', () => {
    for (const bad of [
      '/etc/passwd.pdf',
      'C:\\tmp\\x.pdf',
      'C:tmp/x.pdf',
      '\\\\server\\share\\x.pdf',
      '../x.pdf',
      'a/../b.pdf',
      'a//b.pdf',
      'a/./b.pdf',
      'x:stream.pdf',
      'con.pdf',
      'a/b.pdf.',
      'a/b.pdf ',
      'a/b\tpdf',
    ]) {
      const r = normalizeSourcePath(bad);
      expect(r.ok, `应拒绝: ${bad}`).toBe(false);
    }
  });

  it('拒绝空路径与非字符串', () => {
    expect(normalizeSourcePath('').ok).toBe(false);
    expect(normalizeSourcePath('   ').ok).toBe(false);
    expect(normalizeSourcePath(undefined as unknown as string).ok).toBe(false);
  });
});

describe('sourceIdFor — 完整相对路径含目录与扩展名参与身份', () => {
  it('同名不同目录是不同来源', () => {
    expect(sourceIdFor('a/report.pdf')).not.toBe(sourceIdFor('b/report.pdf'));
  });

  it('同路径不同扩展名是不同来源', () => {
    expect(sourceIdFor('a/report.pdf')).not.toBe(sourceIdFor('a/report.docx'));
  });

  it('sourceId = NFC 规范化路径的 SHA256', () => {
    expect(sourceIdFor('manuals/spec.pdf')).toBe(sha256('manuals/spec.pdf'));
  });

  it('NFC 等价拼写得到同一 sourceId', () => {
    expect(sourceIdFor('café.pdf')).toBe(sourceIdFor('cafe\u0301.pdf'));
  });

  it('大小写敏感：Spec.pdf 与 spec.pdf 身份不同（碰撞由 collision key 检测）', () => {
    expect(sourceIdFor('Spec.pdf')).not.toBe(sourceIdFor('spec.pdf'));
  });
});

describe('sourceCollisionKey — Windows 大小写等价碰撞检测', () => {
  it('大小写不同的路径碰撞键相同', () => {
    expect(sourceCollisionKey('Manuals/Spec.PDF')).toBe(sourceCollisionKey('manuals/spec.pdf'));
  });

  it('NFC 等价拼写碰撞键相同', () => {
    expect(sourceCollisionKey('café.pdf')).toBe(sourceCollisionKey('cafe\u0301.pdf'));
  });

  it('不同路径碰撞键不同', () => {
    expect(sourceCollisionKey('a/x.pdf')).not.toBe(sourceCollisionKey('b/x.pdf'));
  });
});

describe('isTextImportExtension — 直接 Markdown/text 导入判定', () => {
  it('md/markdown/txt 直接文本导入', () => {
    expect(isTextImportExtension('.md')).toBe(true);
    expect(isTextImportExtension('.markdown')).toBe(true);
    expect(isTextImportExtension('.txt')).toBe(true);
    expect(isTextImportExtension('.MD')).toBe(true);
  });

  it('引擎格式不走文本直通', () => {
    expect(isTextImportExtension('.pdf')).toBe(false);
    expect(isTextImportExtension('.docx')).toBe(false);
    expect(isTextImportExtension('.html')).toBe(false);
  });
});
