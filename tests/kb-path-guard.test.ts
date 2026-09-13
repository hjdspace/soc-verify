/**
 * KB Path Guard 测试。
 *
 * 词法校验（validateManagedRelPath）不触碰磁盘，用拒绝表 + 接受表直接断言；
 * 真实路径围栏（ensureRealPathWithinRoot）用真实临时目录注入
 * junction/symlink（Windows 用 junction，免管理员权限）验证逃逸防护。
 *
 * 覆盖场景：
 *  - 词法拒绝：空路径、绝对/盘符/UNC/ADS、穿越、空段、尾点尾空格、
 *    Windows 保留名（含带扩展名形式）、NUL/控制字符
 *  - 词法接受：常规相对路径、反斜杠归一、Unicode 与中间空格、
 *    非保留名不受误伤（constant/com0/auxiliary）
 *  - 围栏接受：根自身、根内已存在路径
 *  - 围栏拒绝：junction/symlink 指向库外（目录与经由链接的文件）、路径不存在
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';

import {
  validateManagedRelPath,
  ensureRealPathWithinRoot,
} from '../src/main/kb/path-guard';

// ── 词法校验 ──────────────────────────────────────────────────────

describe('validateManagedRelPath 拒绝表', () => {
  const rejected: Array<[string, string]> = [
    ['', '为空'],
    ['/abs/path.md', '相对路径'],
    ['C:\\abs\\path.md', '相对路径'],
    ['C:foo.md', '相对路径'],
    ['\\\\server\\share\\doc.md', '相对路径'],
    ['page.md:stream', '相对路径'],
    ['a/b:ads', '相对路径'],
    ['a/../b.md', '穿越'],
    ['..', '穿越'],
    ['.', '穿越'],
    ['a//b.md', '空段'],
    ['a/b.md/', '空段'],
    ['a/b.md.', '以点或空格结尾'],
    ['a/b.md ', '以点或空格结尾'],
    ['a/con.md', '保留名'],
    ['a/CON', '保留名'],
    ['a/com1.txt', '保留名'],
    ['a/lpt9.tar.gz', '保留名'],
    ['a/PrN.md', '保留名'],
    ['a\u0000b', '控制字符'],
    ['a\nb', '控制字符'],
  ];

  it.each(rejected)('拒绝 %j（原因含「%s」）', (input, reasonPart) => {
    const result = validateManagedRelPath(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reasonPart);
  });
});

describe('validateManagedRelPath 接受表', () => {
  it('接受常规相对路径并统一为正斜杠', () => {
    expect(validateManagedRelPath('wiki/concepts/axi.md')).toEqual({
      ok: true,
      normalized: 'wiki/concepts/axi.md',
    });
    expect(validateManagedRelPath('raw\\sources\\a\\spec.pdf')).toEqual({
      ok: true,
      normalized: 'raw/sources/a/spec.pdf',
    });
  });

  it('接受 Unicode 与段中间空格', () => {
    expect(validateManagedRelPath('协议 手册/DDR5 说明.md')).toEqual({
      ok: true,
      normalized: '协议 手册/DDR5 说明.md',
    });
  });

  it('非保留名不受保留名规则误伤', () => {
    // COM0/LPT0 与前缀扩展词不在清单内（COM0/LPT0 为 spike 待验证项）
    expect(validateManagedRelPath('constant.md').ok).toBe(true);
    expect(validateManagedRelPath('com0/note.md').ok).toBe(true);
    expect(validateManagedRelPath('auxiliary/x.md').ok).toBe(true);
  });
});

// ── 真实路径围栏 ──────────────────────────────────────────────────

describe('ensureRealPathWithinRoot', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-path-guard-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('根自身与根内已存在路径通过', async () => {
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'a.md'), 'x');

    await expect(ensureRealPathWithinRoot(root, root)).resolves.toEqual({ ok: true });
    await expect(ensureRealPathWithinRoot(root, join(root, 'docs'))).resolves.toEqual({ ok: true });
    await expect(ensureRealPathWithinRoot(root, join(root, 'docs', 'a.md'))).resolves.toEqual({ ok: true });
  });

  it('junction/symlink 指向库外 → 拒绝（目录本身）', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kb-pg-outside-'));
    try {
      const outsideReal = await realpath(outside);
      await symlink(outsideReal, join(root, 'link'), 'junction');

      const result = await ensureRealPathWithinRoot(root, join(root, 'link'));
      expect(result.ok).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('经由库外链接的文件 → 拒绝（防 junction 逃逸写穿透）', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kb-pg-outside-'));
    try {
      const outsideReal = await realpath(outside);
      await symlink(outsideReal, join(root, 'link'), 'junction');
      await writeFile(join(outside, 'x.md'), 'x');

      const result = await ensureRealPathWithinRoot(root, join(root, 'link', 'x.md'));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('逃逸');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('路径不存在 → 拒绝并说明 realpath 失败', async () => {
    const result = await ensureRealPathWithinRoot(root, join(root, 'no-such', 'file.md'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('realpath 解析失败');
  });
});
