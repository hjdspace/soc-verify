import { describe, expect, it } from 'vitest';
import { buildUntrackedFileDiff, parseUnifiedDiff } from '../../src/main/scm/scm-diff';

const SAMPLE_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1234567..89abcde 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@',
  ' line1',
  '-old line2',
  '+new line2',
  '+added line2b',
  ' line3',
  '+line4 new',
  '@@ -10,3 +11,4 @@ context',
  ' line10',
  '-removed',
  ' line11',
  '\\ No newline at end of file',
  '+tail',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('parses hunks with context/add/del lines and line numbers', () => {
    const diff = parseUnifiedDiff(SAMPLE_DIFF, { path: 'src/a.ts', staged: false });

    expect(diff.path).toBe('src/a.ts');
    expect(diff.staged).toBe(false);
    expect(diff.isNewFile).toBe(false);
    expect(diff.isDeleted).toBe(false);
    expect(diff.isBinary).toBe(false);
    expect(diff.hunks).toHaveLength(2);

    const hunk1 = diff.hunks[0];
    expect(hunk1.header).toBe('@@ -1,4 +1,5 @@');
    expect(hunk1.lines).toEqual([
      { type: 'ctx', content: 'line1', oldLine: 1, newLine: 1 },
      { type: 'del', content: 'old line2', oldLine: 2 },
      { type: 'add', content: 'new line2', newLine: 2 },
      { type: 'add', content: 'added line2b', newLine: 3 },
      { type: 'ctx', content: 'line3', oldLine: 3, newLine: 4 },
      { type: 'add', content: 'line4 new', newLine: 5 },
    ]);

    const hunk2 = diff.hunks[1];
    expect(hunk2.header).toBe('@@ -10,3 +11,4 @@ context');
    expect(hunk2.lines).toEqual([
      { type: 'ctx', content: 'line10', oldLine: 10, newLine: 11 },
      { type: 'del', content: 'removed', oldLine: 11 },
      { type: 'ctx', content: 'line11', oldLine: 12, newLine: 12 },
      { type: 'add', content: 'tail', newLine: 13 },
    ]);

    expect(diff.totalAdd).toBe(4);
    expect(diff.totalDel).toBe(2);
  });

  it('marks a new file when the old side is /dev/null', () => {
    const diff = parseUnifiedDiff(
      [
        'diff --git a/new.ts b/new.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1,2 @@',
        '+first',
        '+second',
      ].join('\n'),
      { path: 'new.ts', staged: true },
    );

    expect(diff.isNewFile).toBe(true);
    expect(diff.isDeleted).toBe(false);
    expect(diff.hunks[0].lines).toEqual([
      { type: 'add', content: 'first', newLine: 1 },
      { type: 'add', content: 'second', newLine: 2 },
    ]);
    expect(diff.totalAdd).toBe(2);
    expect(diff.totalDel).toBe(0);
  });

  it('marks a deleted file when the new side is /dev/null', () => {
    const diff = parseUnifiedDiff(
      [
        'diff --git a/gone.ts b/gone.ts',
        'deleted file mode 100644',
        '--- a/gone.ts',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-bye',
        '-world',
      ].join('\n'),
      { path: 'gone.ts', staged: false },
    );

    expect(diff.isDeleted).toBe(true);
    expect(diff.isNewFile).toBe(false);
    expect(diff.totalDel).toBe(2);
  });

  it('detects binary files and produces no hunks', () => {
    const diff = parseUnifiedDiff(
      [
        'diff --git a/img.png b/img.png',
        'index 1234567..89abcde 100644',
        'Binary files a/img.png and b/img.png differ',
      ].join('\n'),
      { path: 'img.png', staged: false },
    );

    expect(diff.isBinary).toBe(true);
    expect(diff.hunks).toEqual([]);
  });

  it('returns an empty diff for empty input (no changes)', () => {
    const diff = parseUnifiedDiff('', { path: 'clean.ts', staged: false });
    expect(diff.hunks).toEqual([]);
    expect(diff.totalAdd).toBe(0);
    expect(diff.totalDel).toBe(0);
  });

  it('ignores content after a second file diff header', () => {
    const diff = parseUnifiedDiff(
      [
        'diff --git a/one.ts b/one.ts',
        '--- a/one.ts',
        '+++ b/one.ts',
        '@@ -1,1 +1,1 @@',
        '-a',
        '+b',
        'diff --git a/two.ts b/two.ts',
        '--- a/two.ts',
        '+++ b/two.ts',
        '@@ -1,1 +1,1 @@',
        '-c',
        '+d',
      ].join('\n'),
      { path: 'one.ts', staged: false },
    );

    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0].lines).toEqual([
      { type: 'del', content: 'a', oldLine: 1 },
      { type: 'add', content: 'b', newLine: 1 },
    ]);
    expect(diff.totalAdd).toBe(1);
    expect(diff.totalDel).toBe(1);
  });
});

describe('buildUntrackedFileDiff', () => {
  it('marks every line as an addition with sequential new line numbers', () => {
    const diff = buildUntrackedFileDiff('fresh.ts', 'alpha\nbeta\n');

    expect(diff).toMatchObject({
      path: 'fresh.ts',
      staged: false,
      isNewFile: true,
      isDeleted: false,
      isBinary: false,
      totalAdd: 2,
      totalDel: 0,
    });
    expect(diff.hunks[0].lines).toEqual([
      { type: 'add', content: 'alpha', newLine: 1 },
      { type: 'add', content: 'beta', newLine: 2 },
    ]);
  });

  it('normalizes CRLF line endings', () => {
    const diff = buildUntrackedFileDiff('win.ts', 'a\r\nb\r\n');
    expect(diff.hunks[0].lines.map((l) => l.content)).toEqual(['a', 'b']);
  });

  it('produces an empty diff for empty content', () => {
    const diff = buildUntrackedFileDiff('empty.ts', '');
    expect(diff.hunks).toEqual([]);
    expect(diff.totalAdd).toBe(0);
  });
});
