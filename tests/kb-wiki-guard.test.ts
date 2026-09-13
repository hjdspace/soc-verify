/**
 * KB wiki 只读守卫测试（issue 04）。
 *
 * spec §2：知识库预览与通用文件编辑器识别受管 Wiki 页面并只读；
 * 应用受控写入入口不得绕过 KB 发布服务。受管范围 = <kb>/wiki/** 全部
 * 文件 + schema.md / purpose.md（后者须经规则编辑器的校验入口修改）。
 */

import { describe, it, expect } from 'vitest';
import { isManagedWikiPath } from '../src/shared/kb-wiki-guard';

const KB = 'D:\\kb\\my-wiki';

describe('isManagedWikiPath', () => {
  it('wiki/ 目录下全部只读（含子目录）', () => {
    expect(isManagedWikiPath(KB, 'D:\\kb\\my-wiki\\wiki\\concepts\\axi.md')).toBe(true);
    expect(isManagedWikiPath(KB, 'D:\\kb\\my-wiki\\wiki\\index.md')).toBe(true);
    expect(isManagedWikiPath(KB, 'D:/kb/my-wiki/wiki/concepts/axi.md')).toBe(true); // 正斜杠等价
  });

  it('schema.md / purpose.md 只读（须经规则编辑器）', () => {
    expect(isManagedWikiPath(KB, 'D:\\kb\\my-wiki\\schema.md')).toBe(true);
    expect(isManagedWikiPath(KB, 'D:\\kb\\my-wiki\\purpose.md')).toBe(true);
  });

  it('raw/ 与 .kb/ 不在此守卫范围（由各自受控入口治理）', () => {
    expect(isManagedWikiPath(KB, 'D:\\kb\\my-wiki\\raw\\sources\\a.pdf')).toBe(false);
    expect(isManagedWikiPath(KB, 'D:\\kb\\my-wiki\\.kb\\manifest.json')).toBe(false);
  });

  it('库外路径不受限', () => {
    expect(isManagedWikiPath(KB, 'D:\\proj\\src\\main.rs')).toBe(false);
    expect(isManagedWikiPath(KB, 'D:\\kb\\my-wiki-other\\wiki\\x.md')).toBe(false); // 前缀陷阱
  });

  it('wikiish 前缀目录不算受管（精确段匹配）', () => {
    expect(isManagedWikiPath(KB, 'D:\\kb\\my-wiki\\wiki-something\\x.md')).toBe(false);
  });

  it('Windows 大小写不敏感', () => {
    expect(isManagedWikiPath(KB, 'D:\\KB\\MY-WIKI\\WIKI\\x.md')).toBe(true);
  });

  it('kbPath 缺失时恒为 false', () => {
    expect(isManagedWikiPath(undefined, 'D:\\kb\\my-wiki\\wiki\\x.md')).toBe(false);
    expect(isManagedWikiPath('', 'D:\\kb\\my-wiki\\wiki\\x.md')).toBe(false);
  });
});
