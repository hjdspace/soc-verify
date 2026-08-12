import { describe, it, expect } from 'vitest';
import { buildRegrCommand } from '../../src/main/regression/regression-runner';

// ── Command building ──────────────────────────────────

describe('buildRegrCommand', () => {
  it('builds basic command with just -regr', () => {
    const cmd = buildRegrCommand('/path/to/regr.lst', {});
    expect(cmd).toBe('runsim -regr /path/to/regr.lst');
  });

  it('adds -tag option', () => {
    const cmd = buildRegrCommand('/path/to/regr.lst', { tags: ['RTL0.1', 'mini'] });
    expect(cmd).toBe('runsim -regr /path/to/regr.lst -tag RTL0.1,mini');
  });

  it('adds -nt (non-tag) option', () => {
    const cmd = buildRegrCommand('/path/to/regr.lst', { nonTags: ['RTL0.5'] });
    expect(cmd).toBe('runsim -regr /path/to/regr.lst -nt RTL0.5');
  });

  it('adds -fm (fail mode) flag', () => {
    const cmd = buildRegrCommand('/path/to/regr.lst', { failMode: true });
    expect(cmd).toBe('runsim -regr /path/to/regr.lst -fm');
  });

  it('adds -cov flag', () => {
    const cmd = buildRegrCommand('/path/to/regr.lst', { coverage: true });
    expect(cmd).toBe('runsim -regr /path/to/regr.lst -cov');
  });

  it('adds -regr_work option', () => {
    const cmd = buildRegrCommand('/path/to/regr.lst', { regrWork: '/work/dir' });
    expect(cmd).toBe('runsim -regr /path/to/regr.lst -regr_work /work/dir');
  });

  it('adds -merge only when coverage is also enabled', () => {
    const cmdWithCov = buildRegrCommand('/path/to/regr.lst', { coverage: true, merge: true });
    expect(cmdWithCov).toBe('runsim -regr /path/to/regr.lst -cov -merge');

    // Without coverage, -merge is silently dropped
    const cmdWithoutCov = buildRegrCommand('/path/to/regr.lst', { merge: true });
    expect(cmdWithoutCov).toBe('runsim -regr /path/to/regr.lst');
  });

  it('combines all options', () => {
    const cmd = buildRegrCommand('/path/to/regr.grp', {
      tags: ['RTL0.1'],
      nonTags: ['RTL0.5'],
      failMode: true,
      coverage: true,
      regrWork: '/work/regression',
      merge: true,
    });
    expect(cmd).toBe(
      'runsim -regr /path/to/regr.grp -tag RTL0.1 -nt RTL0.5 -fm -cov -regr_work /work/regression -merge',
    );
  });

  it('handles empty arrays for tags and nonTags', () => {
    const cmd = buildRegrCommand('/path/to/regr.lst', { tags: [], nonTags: [] });
    expect(cmd).toBe('runsim -regr /path/to/regr.lst');
  });

  it('handles undefined options', () => {
    const cmd = buildRegrCommand('/path/to/regr.lst', {
      tags: undefined,
      nonTags: undefined,
      failMode: undefined,
      coverage: undefined,
      regrWork: undefined,
      merge: undefined,
    });
    expect(cmd).toBe('runsim -regr /path/to/regr.lst');
  });

  it('handles file paths with spaces', () => {
    const cmd = buildRegrCommand('/path/to/my regression list.lst', {});
    expect(cmd).toBe('runsim -regr /path/to/my regression list.lst');
  });
});
