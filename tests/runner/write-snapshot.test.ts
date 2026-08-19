import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachWriteSnapshot,
  attachWriteSnapshotToStartEvent,
  captureWriteSnapshot,
} from '../../runner/write-snapshot';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runner write snapshots', () => {
  it('marks a missing write target on the tool-start event', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'soc-verify-write-snapshot-'));
    tempDirs.push(cwd);
    const event = {
      type: 'tool_execution_start',
      toolCallId: 'write-new-file',
      toolName: 'write',
      args: { path: 'generated.md', content: 'generated' },
    };

    expect(attachWriteSnapshotToStartEvent(event, cwd)).toEqual({
      ...event,
      fileExistedBefore: false,
    });
  });

  it('captures existing content and preserves result details', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'soc-verify-write-snapshot-'));
    tempDirs.push(cwd);
    await writeFile(join(cwd, 'README.md'), 'before\n', 'utf8');

    const snapshot = captureWriteSnapshot({ path: 'README.md' }, cwd);

    expect(snapshot).toEqual({ fileExistedBefore: true, beforeContent: 'before\n' });
    expect(attachWriteSnapshot({ details: { resolvedPath: 'README.md' } }, snapshot)).toEqual({
      details: {
        resolvedPath: 'README.md',
        fileExistedBefore: true,
        beforeContent: 'before\n',
      },
    });
  });
});
