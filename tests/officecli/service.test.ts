import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const { execOfficeCliMock } = vi.hoisted(() => ({
  execOfficeCliMock: vi.fn(),
}));

vi.mock('../../src/main/officecli/executor', () => ({
  execOfficeCli: execOfficeCliMock,
  killProcessTree: vi.fn(),
  OfficeCliNotAvailableError: class OfficeCliNotAvailableError extends Error {},
}));

import { viewHtml } from '../../src/main/officecli/service';

describe('officecli service', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.clearAllMocks();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('passes an HTML output file path when an output directory is provided', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'soc-verify-officecli-'));
    execOfficeCliMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', duration: 1 });

    const htmlPath = await viewHtml('D:\\docs\\report.docx', tempDir);

    const expectedPath = join(tempDir, 'report.html');
    expect(htmlPath).toBe(expectedPath);
    expect(execOfficeCliMock).toHaveBeenCalledWith(expect.objectContaining({
      args: ['view', 'D:\\docs\\report.docx', 'html', '-o', expectedPath],
    }));
  });
});
