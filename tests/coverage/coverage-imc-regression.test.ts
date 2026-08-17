import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoverageData } from '../../src/shared/types';
import { DEFAULT_EDA_COMMANDS } from '../../src/shared/types';
import { parseCoverageInWorker } from '../../src/main/coverage/coverage-worker';

type CoverageParserModule = {
  parse: (projectRoot: string, sessionId: string, reportDir: string, options?: { summaryOnly?: boolean }) => Promise<CoverageData>;
};

const require = createRequire(import.meta.url);
const parser = require(resolve('plugins/builtin-coverage-parser/index.js')) as CoverageParserModule;
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'soc-verify-coverage-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Cadence IMC coverage regressions', () => {
  it('runs the coverage parser in a worker without a syntax error', async () => {
    const projectRoot = await makeTempDir();
    const reportDir = join(projectRoot, 'reports');
    const pluginPath = join(projectRoot, 'parser.cjs');
    await mkdir(reportDir);
    await writeFile(
      pluginPath,
      `module.exports = { parse() { return {
        sessionId: 'source',
        source: { covMergeDir: '', edaTool: 'imc', reportGeneratedAt: 0 },
        root: { name: 'top', path: 'top', depth: 0, metrics: {}, children: [] },
        targets: {}
      }; } };`,
      'utf-8',
    );

    const result = await parseCoverageInWorker(pluginPath, projectRoot, reportDir, {
      sessionId: 'merge_test',
      covMergeDir: join(projectRoot, 'cov_merge'),
      edaTool: 'imc',
    });

    expect(result.data.sessionId).toBe('merge_test');
  });

  it('parses an IMC hierarchy summary when metrics.txt is absent', async () => {
    const projectRoot = await makeTempDir();
    const reportDir = join(projectRoot, 'reports');
    await mkdir(reportDir);
    await writeFile(
      join(reportDir, 'meta.json'),
      JSON.stringify({ covMergeDir: join(projectRoot, 'cov_merge'), edaTool: 'imc' }),
      'utf-8',
    );
    await writeFile(
      join(reportDir, 'summary.txt'),
      [
        'name                  Overall Average  Overall Covered  Code Average  Code Covered       Fsm Average  Fsm Covered  Functional Average  Functional Covered',
        '-----------------------------------------------------------------------------------------------------------------------------------------------------------',
        'tb_top                n/a              n/a              n/a           n/a                n/a          n/a          n/a                 n/a',
        '|--chip_top           n/a              n/a              n/a           n/a                n/a          n/a          n/a                 n/a',
        '|  |--dut             94.13%           94.13% (353/375) 94.13%        94.13% (353/375)   n/a          n/a          n/a                 n/a',
        '|  |  |--u_block      60.78%           60.78% (327/538) 60.78%       60.78% (327/538)   n/a          n/a          n/a                 n/a',
      ].join('\n'),
      'utf-8',
    );

    const result = await parser.parse(projectRoot, 'merge_test', reportDir);
    const dut = result.root.children[0]?.children[0];

    expect(result.root.name).toBe('tb_top');
    expect(dut?.name).toBe('dut');
    expect(dut?.metrics.line).toEqual({ percentage: 94.13, covered: 353, total: 375 });
    expect(dut?.children[0]?.metrics.line.percentage).toBe(60.78);
  });

  it('uses IMC report options accepted by the 24.09 command syntax', () => {
    expect(DEFAULT_EDA_COMMANDS.imc.metricsCommand).toContain('report -metrics overall');
    expect(DEFAULT_EDA_COMMANDS.imc.binsCommand).toContain('report -detail -metrics functional');
    expect(DEFAULT_EDA_COMMANDS.imc.binsCommand).not.toContain('report -bins');
  });

  it('keeps the main event loop responsive while parsing', async () => {
    const projectRoot = await makeTempDir();
    const reportDir = join(projectRoot, 'reports');
    const pluginPath = join(projectRoot, 'slow-parser.cjs');
    await mkdir(reportDir);
    await writeFile(
      pluginPath,
      `module.exports = { parse() {
        const end = Date.now() + 250;
        while (Date.now() < end) {}
        return {
          sessionId: 'source',
          source: { covMergeDir: '', edaTool: 'imc', reportGeneratedAt: 0 },
          root: { name: 'top', path: 'top', depth: 0, metrics: {}, children: [] },
          targets: {}
        };
      } };`,
      'utf-8',
    );

    const events: string[] = [];
    const parsePromise = parseCoverageInWorker(pluginPath, projectRoot, reportDir, {
      sessionId: 'merge_test',
      covMergeDir: join(projectRoot, 'cov_merge'),
      edaTool: 'imc',
    }).then(() => events.push('parse'));
    setTimeout(() => events.push('timer'), 20);

    await parsePromise;

    expect(events).toEqual(['timer', 'parse']);
  });

  // ─── 分层解析（summaryOnly）测试 ────────────────────────────────

  it('passes summaryOnly option through to the plugin in worker', async () => {
    const projectRoot = await makeTempDir();
    const reportDir = join(projectRoot, 'reports');
    const pluginPath = join(projectRoot, 'parser.cjs');
    await mkdir(reportDir);
    await writeFile(
      pluginPath,
      `module.exports = {
        parse(projectRoot, sessionId, reportDir, options) {
          return {
            sessionId: 'source',
            source: { covMergeDir: '', edaTool: 'imc', reportGeneratedAt: 0 },
            root: { name: 'top', path: 'top', depth: 0, metrics: {}, children: [] },
            targets: {},
            summaryOnly: !!(options && options.summaryOnly),
          };
        }
      };`,
      'utf-8',
    );

    const result = await parseCoverageInWorker(pluginPath, projectRoot, reportDir, {
      sessionId: 'merge_summary',
      covMergeDir: join(projectRoot, 'cov_merge'),
      edaTool: 'imc',
      summaryOnly: true,
    });

    expect(result.data.sessionId).toBe('merge_summary');
    expect((result.data as Record<string, unknown>).summaryOnly).toBe(true);
  });

  it('parses only summary when summaryOnly option is true', async () => {
    const projectRoot = await makeTempDir();
    const reportDir = join(projectRoot, 'reports');
    await mkdir(reportDir);
    await writeFile(
      join(reportDir, 'meta.json'),
      JSON.stringify({ covMergeDir: join(projectRoot, 'cov_merge'), edaTool: 'imc' }),
      'utf-8',
    );
    await writeFile(
      join(reportDir, 'summary.txt'),
      [
        'name                  Overall Average  Overall Covered  Code Average  Code Covered       Fsm Average  Fsm Covered  Functional Average  Functional Covered',
        '-----------------------------------------------------------------------------------------------------------------------------------------------------------',
        'tb_top                n/a              n/a              n/a           n/a                n/a          n/a          n/a                 n/a',
        '|--chip_top           n/a              n/a              n/a           n/a                n/a          n/a          n/a                 n/a',
        '|  |--dut             94.13%           94.13% (353/375) 94.13%        94.13% (353/375)   n/a          n/a          n/a                 n/a',
      ].join('\n'),
      'utf-8',
    );
    // detail.txt exists but should NOT be read in summaryOnly mode
    await writeFile(
      join(reportDir, 'detail.txt'),
      'Instance                    Line%     Branch%\n' +
      'tb_top                      95.30     87.20\n' +
      '  dut                       95.00     87.00\n',
      'utf-8',
    );
    // bins.txt exists but should NOT be read in summaryOnly mode
    await writeFile(
      join(reportDir, 'bins.txt'),
      'Covergroup: my_cg\n  Bin: auto_bin[0]    [0/1]    UNCOVERED\n',
      'utf-8',
    );

    const result = await parser.parse(projectRoot, 'merge_test', reportDir, { summaryOnly: true });

    // summaryOnly flag should be set
    expect(result.summaryOnly).toBe(true);
    // summary hierarchy tree should be parsed
    expect(result.root.name).toBe('tb_top');
    const dut = result.root.children[0]?.children[0];
    expect(dut?.name).toBe('dut');
    expect(dut?.metrics.line.percentage).toBe(94.13);
    // uncovered should NOT be populated (bins.txt was not read)
    expect(result.uncovered).toBeUndefined();
  });

  it('parses all reports when summaryOnly option is false or absent', async () => {
    const projectRoot = await makeTempDir();
    const reportDir = join(projectRoot, 'reports');
    await mkdir(reportDir);
    await writeFile(
      join(reportDir, 'meta.json'),
      JSON.stringify({ covMergeDir: join(projectRoot, 'cov_merge'), edaTool: 'imc' }),
      'utf-8',
    );
    await writeFile(
      join(reportDir, 'summary.txt'),
      [
        'name                  Overall Average  Overall Covered  Code Average  Code Covered',
        '----------------------------------------------------------------------------',
        'tb_top                n/a              n/a              n/a           n/a',
        '|--dut                94.13%           94.13% (353/375) 94.13%        94.13% (353/375)',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(reportDir, 'bins.txt'),
      'Covergroup: my_cg\n  Bin: auto_bin[0]    [0/1]    UNCOVERED\n',
      'utf-8',
    );

    // Full parse (no summaryOnly option)
    const result = await parser.parse(projectRoot, 'merge_test', reportDir);

    // summaryOnly should be false
    expect(result.summaryOnly).toBe(false);
    // bins should be parsed (uncovered populated)
    expect(result.uncovered).toBeDefined();
    expect(result.uncovered?.functional).toBeDefined();
    expect(result.uncovered?.functional?.length).toBe(1);
  });
});
