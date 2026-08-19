import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('cross-platform pointer feedback', () => {
  it('keeps hover variants available when Chromium reports no hover device', async () => {
    const css = await readFile(resolve(process.cwd(), 'src/renderer/src/styles/globals.css'), 'utf8');

    expect(css).toContain('@custom-variant hover (&:hover);');
    expect(css).toContain('button:not(:disabled):active');
    expect(css).toContain('transform: translateY(1px);');
  });
});
