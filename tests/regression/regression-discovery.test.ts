import { describe, it, expect } from 'vitest';
import {
  detectFileType,
  parseRegressionList,
  parseRegressionGroup,
  resolveGroupRefs,
  loadUsvpMap,
  discoverRegressions,
} from '../../src/main/regression/regression-discovery';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── File type detection ───────────────────────────────

describe('detectFileType', () => {
  it('detects list files by ON/OFF lines', () => {
    const content = `// header comment
ON,  ap_sys,  test_case,  rand,  10,  [RTL0.1, mini],  H,  default,  default,  default
OFF, ap_sys,  other_case, [1,2], 5,   [RTL0.5],         M,  default,  default,  default
`;
    expect(detectFileType(content)).toBe('list');
  });

  it('detects group files by path-like lines', () => {
    const content = `// ap_sys.grp
$PROJ_DIR/dv/ap_sys/regression/regr1.lst
$PROJ_DIR/dv/ap_sys/regression/regr2.lst
`;
    expect(detectFileType(content)).toBe('group');
  });

  it('detects unknown files', () => {
    expect(detectFileType('// just a comment\n')).toBe('unknown');
    expect(detectFileType('')).toBe('unknown');
    expect(detectFileType('# python comment\n')).toBe('unknown');
  });

  it('treats file with both ON/OFF and path lines as list', () => {
    const content = `ON, ap_sys, test, rand, 1, [tag], H, default, default, default, /some/path
$PROJ_DIR/dv/regr.lst
`;
    expect(detectFileType(content)).toBe('list');
  });

  it('handles ON/OFF case-insensitively', () => {
    expect(detectFileType('on, block, case, rand, 1, [tag], H, default, default, default\n')).toBe('list');
    expect(detectFileType('off, block, case, rand, 1, [tag], H, default, default, default\n')).toBe('list');
  });
});

// ── List parsing ──────────────────────────────────────

describe('parseRegressionList', () => {
  it('parses basic entries', () => {
    const content = `// regr.lst
// on/off, block, case, seed, iterative, tag, priority, config, CFG_DEF, env/base, plusargs
ON,  ap_sys,  apsys_bus_mini_test,  rand,  10,  [RTL0.1, mini, cq],  H,  default,  default,  default,  MYARG=[10:20]
OFF, ap_sys,  apsys_traffic_test,   [1,2,3], 10, [RTL0.1, mini, cq], H,  default,  default,  default,  MYARG=[1,2,3]
`;
    const result = parseRegressionList(content);
    expect(result.entries).toHaveLength(2);
    expect(result.onCount).toBe(1);
    expect(result.offCount).toBe(1);

    const entry0 = result.entries[0];
    expect(entry0.enabled).toBe(true);
    expect(entry0.block).toBe('ap_sys');
    expect(entry0.caseName).toBe('apsys_bus_mini_test');
    expect(entry0.seed).toBe('rand');
    expect(entry0.iterative).toBe('10');
    expect(entry0.tags).toEqual(['RTL0.1', 'mini', 'cq']);
    expect(entry0.priority).toBe('H');
    expect(entry0.config).toBe('default');
    expect(entry0.cfgDef).toBe('default');
    expect(entry0.envBase).toBe('default');
    expect(entry0.plusargs).toBe('MYARG=[10:20]');

    expect(result.entries[1].enabled).toBe(false);
    expect(result.entries[1].seed).toBe('[1,2,3]');
  });

  it('collects tag set across all entries', () => {
    const content = `ON, b, c1, rand, 1, [RTL0.1, mini], H, default, default, default
ON, b, c2, rand, 1, [RTL0.5, mini, cq], H, default, default, default
`;
    const result = parseRegressionList(content);
    expect(result.tagSet).toEqual(['RTL0.1', 'RTL0.5', 'cq', 'mini']);
  });

  it('handles entries with no tags', () => {
    const content = `ON, b, c1, rand, 1, , H, default, default, default
`;
    const result = parseRegressionList(content);
    expect(result.entries[0].tags).toEqual([]);
    expect(result.tagSet).toEqual([]);
  });

  it('handles seed range formats', () => {
    const content = `ON, b, c1, [1:100], 10, [tag], H, default, default, default
ON, b, c2, [1:100:2], 10, [tag], H, default, default, default
ON, b, c3, 12345, 10, [tag], H, default, default, default
`;
    const result = parseRegressionList(content);
    expect(result.entries[0].seed).toBe('[1:100]');
    expect(result.entries[1].seed).toBe('[1:100:2]');
    expect(result.entries[2].seed).toBe('12345');
  });

  it('handles complex plusargs with brackets containing commas', () => {
    const content = `ON, b, c1, rand, 5, [tag], H, default, default, default, (MYARG1=[1, 3, 5], MYARG2=[str1,str2,str3])
ON, b, c2, rand, 5, [tag], H, default, default, default, [scope, field]=[10:20:2]
`;
    const result = parseRegressionList(content);
    expect(result.entries[0].plusargs).toBe('(MYARG1=[1, 3, 5], MYARG2=[str1,str2,str3])');
    expect(result.entries[1].plusargs).toBe('[scope, field]=[10:20:2]');
  });

  it('handles iterative = all', () => {
    const content = `ON, b, c1, [1:100], all, [tag], H, default, default, default
`;
    const result = parseRegressionList(content);
    expect(result.entries[0].iterative).toBe('all');
  });

  it('handles empty priority', () => {
    const content = `ON, b, c1, rand, 1, [tag], , default, default, default
`;
    const result = parseRegressionList(content);
    expect(result.entries[0].priority).toBe('');
  });

  it('skips comment and blank lines', () => {
    const content = `// comment
# also comment

ON, b, c1, rand, 1, [tag], H, default, default, default
// another comment
ON, b, c2, rand, 1, [tag], H, default, default, default
`;
    const result = parseRegressionList(content);
    expect(result.entries).toHaveLength(2);
  });
});

// ── Group parsing ─────────────────────────────────────

describe('parseRegressionGroup', () => {
  it('parses file path references', () => {
    const content = `// ap_sys.grp
$PROJ_DIR/dv/ap_sys/regression/regr1.lst
$PROJ_DIR/dv/ap_sys/regression/regr2.lst
$PROJ_DIR/dv/ap_sys/regression/regr3.lst
`;
    const refs = parseRegressionGroup(content);
    expect(refs).toHaveLength(3);
    expect(refs[0]).toBe('$PROJ_DIR/dv/ap_sys/regression/regr1.lst');
  });

  it('skips comments and ON/OFF lines', () => {
    const content = `// comment
ON, b, c, rand, 1, [tag], H, default, default, default
$PROJ_DIR/dv/regr.lst
`;
    const refs = parseRegressionGroup(content);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toBe('$PROJ_DIR/dv/regr.lst');
  });
});

// ── Group resolution ──────────────────────────────────

describe('resolveGroupRefs', () => {
  it('resolves nested groups with cycle detection', async () => {
    // Create temp files
    const dir = mkdtempSync(join(tmpdir(), 'regr-test-'));
    try {
      const list1Path = join(dir, 'list1.lst');
      const list2Path = join(dir, 'list2.lst');
      const grp1Path = join(dir, 'grp1.grp');
      const grp2Path = join(dir, 'grp2.grp');

      writeFileSync(list1Path, 'ON, b, c1, rand, 1, [tag], H, default, default, default\n');
      writeFileSync(list2Path, 'ON, b, c2, rand, 1, [tag], H, default, default, default\n');

      // grp1 references list1 and grp2
      writeFileSync(grp1Path, `${list1Path}\n${grp2Path}\n`);
      // grp2 references list2 and grp1 (cycle!)
      writeFileSync(grp2Path, `${list2Path}\n${grp1Path}\n`);

      const reader = async (path: string) => {
        const { readFile } = await import('node:fs/promises');
        return readFile(path, 'utf-8');
      };

      const resolved = await resolveGroupRefs(grp1Path, reader);
      // Should resolve list1, grp2, list2 (grp1 is cycle, skipped)
      const paths = resolved.map((r) => r.path);
      expect(paths).toContain(list1Path);
      expect(paths).toContain(list2Path);
      // grp1 should not appear twice (cycle detected)
      const grp1Count = paths.filter((p) => p === grp1Path).length;
      expect(grp1Count).toBe(0); // grp1 is the starting point, already in visited
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('respects max depth', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'regr-depth-'));
    try {
      // Create 12 nested groups (exceeds MAX_GRP_DEPTH of 10)
      for (let i = 0; i < 12; i++) {
        const path = join(dir, `grp${i}.grp`);
        if (i < 11) {
          writeFileSync(path, `${join(dir, `grp${i + 1}.grp`)}\n`);
        } else {
          writeFileSync(path, `${join(dir, 'final.lst')}\n`);
          writeFileSync(join(dir, 'final.lst'), 'ON, b, c, rand, 1, [tag], H, default, default, default\n');
        }
      }

      const reader = async (path: string) => {
        const { readFile } = await import('node:fs/promises');
        return readFile(path, 'utf-8');
      };

      const resolved = await resolveGroupRefs(join(dir, 'grp0.grp'), reader);
      // Should not resolve all 12 levels — stops at depth 10
      // The resolved array should not contain the final.lst
      const hasFinal = resolved.some((r) => r.path.endsWith('final.lst'));
      expect(hasFinal).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ── usvp mapping ──────────────────────────────────────

describe('loadUsvpMap', () => {
  it('returns empty map when file does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'regr-usvp-'));
    try {
      const map = await loadUsvpMap(dir);
      expect(map).toEqual({});
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('loads mapping from .socverify/usvp-subsys-map.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'regr-usvp-'));
    try {
      mkdirSync(join(dir, '.socverify'), { recursive: true });
      writeFileSync(
        join(dir, '.socverify', 'usvp-subsys-map.json'),
        JSON.stringify({ apcpu: 'apcpu_sys', sp: 'aon_sys' }),
      );
      const map = await loadUsvpMap(dir);
      expect(map.apcpu).toBe('apcpu_sys');
      expect(map.sp).toBe('aon_sys');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ── discoverRegressions ───────────────────────────────

describe('discoverRegressions', () => {
  it('discovers lists from direct subsys regression dirs', async () => {
    const projEnv = mkdtempSync(join(tmpdir(), 'regr-discover-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'regr-proj-'));
    try {
      // Create $PROJ_ENV/ap_sys/regression/regr.lst
      mkdirSync(join(projEnv, 'ap_sys', 'regression'), { recursive: true });
      writeFileSync(
        join(projEnv, 'ap_sys', 'regression', 'regr.lst'),
        'ON, ap_sys, test_case, rand, 10, [RTL0.1, mini], H, default, default, default\n',
      );

      const result = await discoverRegressions(projectRoot, projEnv);
      expect(result).toHaveLength(1);
      expect(result[0].subsys).toBe('ap_sys');
      expect(result[0].items).toHaveLength(1);
      expect(result[0].items[0].type).toBe('list');
    } finally {
      rmSync(projEnv, { recursive: true });
      rmSync(projectRoot, { recursive: true });
    }
  });

  it('discovers lists from udtb/<subsys>/<block>/regression/', async () => {
    const projEnv = mkdtempSync(join(tmpdir(), 'regr-ip2soc-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'regr-proj-'));
    try {
      mkdirSync(join(projEnv, 'udtb', 'cp_sys', 'top', 'regression'), { recursive: true });
      writeFileSync(
        join(projEnv, 'udtb', 'cp_sys', 'top', 'regression', 'ip2soc.lst'),
        'ON, cp_sys, ip2soc_test, rand, 5, [tag], H, default, default, default\n',
      );

      const result = await discoverRegressions(projectRoot, projEnv);
      const cpSys = result.find((r) => r.subsys === 'cp_sys');
      expect(cpSys).toBeDefined();
      expect(cpSys!.items).toHaveLength(1);
      expect(cpSys!.items[0].type).toBe('list');
      expect((cpSys!.items[0] as { block: string }).block).toBe('top');
    } finally {
      rmSync(projEnv, { recursive: true });
      rmSync(projectRoot, { recursive: true });
    }
  });

  it('merges ip2soc lists into the same subsys as direct lists', async () => {
    const projEnv = mkdtempSync(join(tmpdir(), 'regr-merge-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'regr-proj-'));
    try {
      // Direct list
      mkdirSync(join(projEnv, 'ap_sys', 'regression'), { recursive: true });
      writeFileSync(
        join(projEnv, 'ap_sys', 'regression', 'direct.lst'),
        'ON, ap_sys, direct_test, rand, 10, [tag], H, default, default, default\n',
      );

      // ip2soc list
      mkdirSync(join(projEnv, 'udtb', 'ap_sys', 'sub', 'regression'), { recursive: true });
      writeFileSync(
        join(projEnv, 'udtb', 'ap_sys', 'sub', 'regression', 'ip2soc.lst'),
        'ON, ap_sys, ip2soc_test, rand, 5, [tag], H, default, default, default\n',
      );

      const result = await discoverRegressions(projectRoot, projEnv);
      const apSys = result.find((r) => r.subsys === 'ap_sys');
      expect(apSys).toBeDefined();
      expect(apSys!.items).toHaveLength(2);
    } finally {
      rmSync(projEnv, { recursive: true });
      rmSync(projectRoot, { recursive: true });
    }
  });

  it('deduplicates files that appear in both direct and ip2soc dirs', async () => {
    const projEnv = mkdtempSync(join(tmpdir(), 'regr-dedup-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'regr-proj-'));
    try {
      // Create the same file in both locations (simulated symlink/copy)
      mkdirSync(join(projEnv, 'ap_sys', 'regression'), { recursive: true });
      const directPath = join(projEnv, 'ap_sys', 'regression', 'shared.lst');
      writeFileSync(directPath, 'ON, ap_sys, test, rand, 1, [tag], H, default, default, default\n');

      // The dedup is by absolute path, so different paths won't be deduped.
      // This test confirms that the same file isn't added twice within one scan.
      const result = await discoverRegressions(projectRoot, projEnv);
      const apSys = result.find((r) => r.subsys === 'ap_sys');
      expect(apSys!.items).toHaveLength(1);
    } finally {
      rmSync(projEnv, { recursive: true });
      rmSync(projectRoot, { recursive: true });
    }
  });

  it('discovers usvp lists with short-name mapping', async () => {
    const projEnv = mkdtempSync(join(tmpdir(), 'regr-usvp-disc-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'regr-proj-'));
    try {
      // Create usvp-subsys-map.json
      mkdirSync(join(projectRoot, '.socverify'), { recursive: true });
      writeFileSync(
        join(projectRoot, '.socverify', 'usvp-subsys-map.json'),
        JSON.stringify({ apcpu: 'apcpu_sys' }),
      );

      // Create usvp regression list
      mkdirSync(join(projEnv, 'udtb', 'usvp', 'regression', 'apcpu'), { recursive: true });
      writeFileSync(
        join(projEnv, 'udtb', 'usvp', 'regression', 'apcpu', 'usvp_test.lst'),
        'ON, apcpu_sys, usvp_test, rand, 1, [tag], H, default, default, default\n',
      );

      const result = await discoverRegressions(projectRoot, projEnv);
      const apcpuSys = result.find((r) => r.subsys === 'apcpu_sys');
      expect(apcpuSys).toBeDefined();
      expect(apcpuSys!.items).toHaveLength(1);
    } finally {
      rmSync(projEnv, { recursive: true });
      rmSync(projectRoot, { recursive: true });
    }
  });

  it('uses short name as-is when no mapping exists', async () => {
    const projEnv = mkdtempSync(join(tmpdir(), 'regr-usvp-nomap-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'regr-proj-'));
    try {
      mkdirSync(join(projEnv, 'udtb', 'usvp', 'regression', 'unknown'), { recursive: true });
      writeFileSync(
        join(projEnv, 'udtb', 'usvp', 'regression', 'unknown', 'test.lst'),
        'ON, unknown, test, rand, 1, [tag], H, default, default, default\n',
      );

      const result = await discoverRegressions(projectRoot, projEnv);
      const unknownSubsys = result.find((r) => r.subsys === 'unknown');
      expect(unknownSubsys).toBeDefined();
    } finally {
      rmSync(projEnv, { recursive: true });
      rmSync(projectRoot, { recursive: true });
    }
  });

  it('discovers group files', async () => {
    const projEnv = mkdtempSync(join(tmpdir(), 'regr-group-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'regr-proj-'));
    try {
      mkdirSync(join(projEnv, 'ap_sys', 'regression'), { recursive: true });
      writeFileSync(
        join(projEnv, 'ap_sys', 'regression', 'group.grp'),
        '$PROJ_DIR/dv/ap_sys/regression/regr1.lst\n$PROJ_DIR/dv/ap_sys/regression/regr2.lst\n',
      );

      const result = await discoverRegressions(projectRoot, projEnv);
      const apSys = result.find((r) => r.subsys === 'ap_sys');
      expect(apSys).toBeDefined();
      expect(apSys!.items).toHaveLength(1);
      expect(apSys!.items[0].type).toBe('group');
    } finally {
      rmSync(projEnv, { recursive: true });
      rmSync(projectRoot, { recursive: true });
    }
  });

  it('does not treat udtb as a subsystem', async () => {
    const projEnv = mkdtempSync(join(tmpdir(), 'regr-noudtb-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'regr-proj-'));
    try {
      // Create udtb directory with subdirs but NO regression files at udtb top level
      mkdirSync(join(projEnv, 'udtb', 'ap_sys', 'block_a', 'regression'), { recursive: true });
      writeFileSync(
        join(projEnv, 'udtb', 'ap_sys', 'block_a', 'regression', 'ip.lst'),
        'ON, ap_sys, ip_test, rand, 1, [tag], H, default, default, default\n',
      );

      const result = await discoverRegressions(projectRoot, projEnv);
      // udtb must NOT appear as a subsystem
      expect(result.find((r) => r.subsys === 'udtb')).toBeUndefined();
      // ap_sys should appear (from ip2soc scan)
      const apSys = result.find((r) => r.subsys === 'ap_sys');
      expect(apSys).toBeDefined();
    } finally {
      rmSync(projEnv, { recursive: true });
      rmSync(projectRoot, { recursive: true });
    }
  });

  it('returns empty array when no regression dirs exist', async () => {
    const projEnv = mkdtempSync(join(tmpdir(), 'regr-empty-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'regr-proj-'));
    try {
      const result = await discoverRegressions(projectRoot, projEnv);
      expect(result).toEqual([]);
    } finally {
      rmSync(projEnv, { recursive: true });
      rmSync(projectRoot, { recursive: true });
    }
  });
});
