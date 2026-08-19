import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyRejections, getFileDiff } from '../../src/main/diff/diff-engine';
import type { DiffToolCall } from '../../src/shared/types';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function editedFile(): Promise<{ filePath: string; toolCall: DiffToolCall }> {
  const dir = await mkdtemp(join(tmpdir(), 'soc-verify-diff-'));
  tempDirs.push(dir);
  const filePath = join(dir, 'core.sv');
  await writeFile(filePath, 'module core;\n  assign ready = valid;\nendmodule\n', 'utf8');
  return {
    filePath,
    toolCall: {
      id: 'edit-1',
      toolName: 'edit',
      filePath,
      timestamp: 1,
      sessionId: 'session-1',
      oldText: "  assign ready = 1'b0;",
      newText: '  assign ready = valid;',
      isNewFile: false,
    },
  };
}

describe('Diff Review engine', () => {
  it('shows the before and after lines for an omp edit', async () => {
    const { filePath, toolCall } = await editedFile();

    const diff = await getFileDiff(filePath, [toolCall]);

    expect(diff.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'del', content: "  assign ready = 1'b0;" }),
      expect.objectContaining({ type: 'add', content: '  assign ready = valid;' }),
    ]));
    expect(diff.hunks).toHaveLength(1);
  });

  it('restores the before text when the user rejects an omp edit', async () => {
    const { filePath, toolCall } = await editedFile();

    const result = await applyRejections(filePath, [{
      hunkId: 1,
      toolCallId: toolCall.id,
      toolName: toolCall.toolName,
      oldText: toolCall.oldText,
      newText: toolCall.newText,
      deleteFile: false,
    }]);

    expect(result.ok).toBe(true);
    await expect(readFile(filePath, 'utf8')).resolves.toContain("assign ready = 1'b0;");
  });

  it('builds reviewable hunks when the file uses CRLF and omp diff text uses LF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'soc-verify-diff-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'README.md');
    await writeFile(filePath, 'title changed\r\nbody\r\n', 'utf8');

    const diff = await getFileDiff(filePath, [{
      id: 'edit-crlf',
      toolName: 'edit',
      filePath,
      timestamp: 1,
      oldText: 'title original\nbody',
      newText: 'title changed\nbody',
      isNewFile: false,
    }]);

    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0].overwritten).toBe(false);
  });

  it('rejects only the selected hunk from a multi-hunk tool call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'soc-verify-diff-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'README.md');
    await writeFile(filePath, 'first after\nmiddle\nlast after\n', 'utf8');

    const result = await applyRejections(filePath, [{
      hunkId: 1,
      toolCallId: 'edit-many',
      toolName: 'edit',
      oldText: 'first before\nmiddle\nlast before',
      newText: 'first after\nmiddle\nlast after',
      startLine: 1,
      oldLines: ['first before'],
      newLines: ['first after'],
      deleteFile: false,
    }]);

    expect(result.ok).toBe(true);
    await expect(readFile(filePath, 'utf8')).resolves.toBe(
      'first before\nmiddle\nlast after\n',
    );
  });

  it('does not apply the same pure-deletion rejection twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'soc-verify-diff-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'README.md');
    await writeFile(filePath, 'body\n', 'utf8');
    const rejection = {
      hunkId: 1,
      toolCallId: 'edit-heading',
      toolName: 'edit',
      oldText: '# SoC Verify\n\nbody',
      newText: 'body',
      startLine: 1,
      oldLines: ['# SoC Verify', ''],
      newLines: [],
      beforeLine: null,
      afterLine: 'body',
      deleteFile: false,
    };

    const first = await applyRejections(filePath, [rejection]);
    const contentAfterFirst = await readFile(filePath, 'utf8');
    const second = await applyRejections(filePath, [rejection]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    await expect(readFile(filePath, 'utf8')).resolves.toBe(contentAfterFirst);
    expect(contentAfterFirst).toBe('# SoC Verify\n\nbody\n');
  });
});
