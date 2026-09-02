import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock node:fs，避免依赖真实文件系统
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

import { existsSync } from 'node:fs';
import { resolveNerdFontsDir, listNerdFontFaces } from '../../src/main/fonts/nerd-font-paths';

const mockExistsSync = vi.mocked(existsSync);

describe('fonts/nerd-font-paths - resolveNerdFontsDir', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    // 保存原始 process.resourcesPath
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  });

  afterEach(() => {
    // 恢复 process.resourcesPath
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  it('打包模式优先返回 process.resourcesPath/fonts', () => {
    const fakeResources = '/fake/electron/resources';
    (process as unknown as { resourcesPath?: string }).resourcesPath = fakeResources;

    // packaged 目录"存在"（路径包含 fakeResources），dev 不存在
    mockExistsSync.mockImplementation((p) => {
      return String(p).replace(/\\/g, '/').includes(fakeResources);
    });

    const result = resolveNerdFontsDir();
    expect(result).toBeTruthy();
    expect(String(result).replace(/\\/g, '/')).toContain(`${fakeResources}/fonts`);
  });

  it('packaged 不存在时回退到 dev 字体目录（开发模式）', () => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = '/fake/electron/resources';

    // 只有 dev 目录"存在"（路径不含 fake electron resources 但含 resources/fonts）
    mockExistsSync.mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/');
      return !s.includes('/fake/electron') && s.includes('resources/fonts');
    });

    const result = resolveNerdFontsDir();
    expect(result).toBeTruthy();
    expect(String(result).replace(/\\/g, '/')).not.toContain('/fake/electron');
    expect(String(result).replace(/\\/g, '/')).toContain('resources/fonts');
  });

  it('两者都不存在时返回 null（字体未下载的降级场景）', () => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = '/fake/electron/resources';
    mockExistsSync.mockReturnValue(false);

    expect(resolveNerdFontsDir()).toBeNull();
  });
});

describe('fonts/nerd-font-paths - listNerdFontFaces', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  });

  afterEach(() => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  it('字体目录解析失败时返回空列表（不抛异常）', () => {
    mockExistsSync.mockReturnValue(false);
    expect(listNerdFontFaces()).toEqual([]);
  });

  it('显式传入 null 时返回空列表', () => {
    expect(listNerdFontFaces(null)).toEqual([]);
  });

  it('只返回磁盘上实际存在的 face（部分缺失时按需降级）', () => {
    const fontsDir = '/fake/resources/fonts';
    // 只有 JetBrainsMono Regular 和 MesloLGS Regular 存在
    mockExistsSync.mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/');
      return s.includes('JetBrainsMonoNerdFont-Regular') || s.includes('MesloLGS NF Regular');
    });

    const faces = listNerdFontFaces(fontsDir);
    expect(faces).toHaveLength(2);
    expect(faces.map((f) => f.fileName).sort()).toEqual([
      'JetBrainsMonoNerdFont-Regular.ttf',
      'MesloLGS NF Regular.ttf',
    ]);
  });

  it('全部字体文件存在时返回完整 8 个 face', () => {
    const fontsDir = '/fake/resources/fonts';
    mockExistsSync.mockImplementation((p) => {
      return String(p).replace(/\\/g, '/').includes(fontsDir);
    });

    const faces = listNerdFontFaces(fontsDir);
    expect(faces).toHaveLength(8);
    // 覆盖两个 family
    const families = new Set(faces.map((f) => f.family));
    expect(families).toEqual(new Set(['JetBrainsMono Nerd Font', 'MesloLGS NF']));
  });

  it('face 条目包含 family / weight / style / fileName 元数据', () => {
    const fontsDir = '/fake/resources/fonts';
    mockExistsSync.mockImplementation((p) => {
      return String(p).includes('JetBrainsMonoNerdFont-Bold.ttf');
    });

    const faces = listNerdFontFaces(fontsDir);
    expect(faces).toHaveLength(1);
    expect(faces[0]).toEqual({
      family: 'JetBrainsMono Nerd Font',
      weight: '700',
      style: 'normal',
      fileName: 'JetBrainsMonoNerdFont-Bold.ttf',
    });
  });
});
