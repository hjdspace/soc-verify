import { describe, it, expect } from 'vitest';
import { buildNerdFontFaceCss, type NerdFontFaceDescriptor } from '../../src/renderer/src/styles/nerd-font-css';

const makeFace = (overrides: Partial<NerdFontFaceDescriptor> = {}): NerdFontFaceDescriptor => ({
  family: 'JetBrainsMono Nerd Font',
  weight: '400',
  style: 'normal',
  url: 'local-resource://app/D%3A%2Fproj%2Fresources%2Ffonts%2FJetBrainsMonoNerdFont-Regular.ttf',
  ...overrides,
});

describe('styles/nerd-font-css - buildNerdFontFaceCss', () => {
  it('为单个 face 生成完整的 @font-face 规则', () => {
    const css = buildNerdFontFaceCss([makeFace()]);
    expect(css).toContain("@font-face {");
    expect(css).toContain("font-family: 'JetBrainsMono Nerd Font';");
    expect(css).toContain('font-style: normal;');
    expect(css).toContain('font-weight: 400;');
    expect(css).toContain('font-display: swap;');
    expect(css).toContain("src: url('local-resource://app/D%3A%2Fproj%2Fresources%2Ffonts%2FJetBrainsMonoNerdFont-Regular.ttf') format('truetype');");
  });

  it('为多个 face 生成多条规则', () => {
    const css = buildNerdFontFaceCss([
      makeFace(),
      makeFace({ family: 'MesloLGS NF', weight: '700', style: 'italic', url: 'local-resource://app/fonts/Meslo.ttf' }),
    ]);
    expect(css.match(/@font-face \{/g)).toHaveLength(2);
    expect(css).toContain("font-family: 'MesloLGS NF';");
    expect(css).toContain('font-weight: 700;');
    expect(css).toContain('font-style: italic;');
  });

  it('空列表返回空字符串（降级场景不注入任何规则）', () => {
    expect(buildNerdFontFaceCss([])).toBe('');
  });

  it('按扩展名推断 format：woff2 / woff / otf / ttf', () => {
    const css = buildNerdFontFaceCss([
      makeFace({ url: 'local-resource://app/F.woff2' }),
      makeFace({ url: 'local-resource://app/F.woff' }),
      makeFace({ url: 'local-resource://app/F.otf' }),
      makeFace({ url: 'local-resource://app/F.ttf' }),
    ]);
    expect(css).toContain("format('woff2')");
    expect(css).toContain("format('woff')");
    expect(css).toContain("format('opentype')");
    expect(css).toContain("format('truetype')");
  });

  it('未知扩展名回退为 truetype', () => {
    const css = buildNerdFontFaceCss([makeFace({ url: 'local-resource://app/F.unknown' })]);
    expect(css).toContain("format('truetype')");
  });
});
