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

  // ─── metrics.txt 快速导入层（SoC 代码覆盖率重构） ────────────────

  /** 用户提供的真实 metrics.txt 数据（imc report -metrics overall 产物） */
  const REAL_METRICS_TXT = [
    'name                           Overall Average       Overall Covered',
    'tb_top                         n/a                   n/a',
    '|--chip_top                    n/a                   n/a',
    '|  |--dut                      94.13%                94.13% (353/375)',
    '|     |--u_analog_bb_line_usb  87.50%                86.67% (13/15)',
    '|     |--u_analog_bb_line_pciepll 87.50%            86.67% (13/15)',
    '|     |--u_block_wrap_0        90.71%                90.71% (488/538)',
    '|     |   |--u_analog_mipi_mphy_2t2r 71.03%         71.03% (586/825)',
    '|     |   |--u_g3_side_glue_wrap 70.37%             70.37% (1235/1755)',
    '|     |       |--analog_mipi_mphy_2t2r_glue 100.00% 100.00% (239/239)',
    '|     |       |--analog_mipi_mphy_2t2r_0_collar 90.36% 71.46% (1172/1640)',
    '|     |       |--analog_mipi_phy_g3_rf 83.53%       82.07% (1620/1974)',
    '|     |           |--u_reg_dec 98.76%               98.76% (159/161)',
    '|     |--u_analog_mipi_mphy_2t2r_glue_logic 92.90%  89.50% (810/905)',
    '|     |--u_cgm_mux2_mphy_cb_cfgclk 100.00%          100.00% (5/5)',
    '|     |--u_clk_gate_reg_read    100.00%              100.00% (4/4)',
    '|     |--u_cgm_mux2_mphy_symbolclk_for_aux 100.00%  100.00% (5/5)',
    '|     |--u_cgm_divn_mphy_symbolclk_div4 53.85%      53.85% (7/13)',
    '|     |--u_cgm_mux6_mphy_linkclk_for_aux 100.00%    100.00% (11/11)',
    '|     |--u_cgm_divn_mphy_linkclk_div4 53.85%        53.85% (7/13)',
    '|     |--u_rst_dvfs_top_n       100.00%              100.00% (5/5)',
    '|     |--u_apb2rmmi_0           94.03%              85.59% (95/111)',
    '|     |   |--U_SYNC_UPDT        50.00%              50.00% (2/4)',
    '|     |   |--U_SYNC_INLN        100.00%             100.00% (4/4)',
    '|     |   |--U_SYNC_START       100.00%             100.00% (4/4)',
    '|     |--u_apb2rmmi_1           95.69%              90.99% (101/111)',
    '|     |   |--U_SYNC_UPDT        75.00%              75.00% (3/4)',
    '|     |   |--U_SYNC_INLN        100.00%             100.00% (4/4)',
    '|     |   |--U_SYNC_START       100.00%             100.00% (4/4)',
    '|     |--u_apb2rmmi_2           91.25%              76.58% (85/111)',
    '|     |   |--U_SYNC_UPDT        50.00%              50.00% (2/4)',
    '|     |   |--U_SYNC_INLN        100.00%             100.00% (4/4)',
    '|     |   |--U_SYNC_START       100.00%             100.00% (4/4)',
  ].join('\n');

  /** 从树中按 path 定位节点（root path 以 top/ 开头，由 buildHierarchyTree 生成） */
  function findNode(root: CoverageData['root'], name: string): CoverageData['root'] | null {
    if (root.name === name) return root;
    for (const child of root.children) {
      const found = findNode(child, name);
      if (found) return found;
    }
    return null;
  }

  it('parses real metrics.txt: hierarchy tree + Overall Covered code coverage', async () => {
    const projectRoot = await makeTempDir();
    const reportDir = join(projectRoot, 'reports');
    await mkdir(reportDir);
    await writeFile(
      join(reportDir, 'meta.json'),
      JSON.stringify({ covMergeDir: join(projectRoot, 'cov_merge'), edaTool: 'imc' }),
      'utf-8',
    );
    await writeFile(join(reportDir, 'metrics.txt'), REAL_METRICS_TXT, 'utf-8');

    const result = await parser.parse(projectRoot, 'merge_test', reportDir, { summaryOnly: true });

    // 层级树根：tb_top → chip_top → dut
    expect(result.root.name).toBe('tb_top');
    const chipTop = result.root.children[0];
    expect(chipTop?.name).toBe('chip_top');
    const dut = chipTop?.children[0];
    expect(dut?.name).toBe('dut');

    // dut 代码覆盖率：Overall Covered 94.13% (353/375)（非 Overall Average）
    expect(dut?.metrics.line).toEqual({ percentage: 94.13, covered: 353, total: 375 });

    // 深层节点：u_reg_dec（depth 6 链，前缀长度栈推导，深度无上限）
    const regDec = findNode(result.root, 'u_reg_dec');
    expect(regDec).not.toBeNull();
    expect(regDec?.depth).toBe(6);
    expect(regDec?.path).toBe('tb_top.chip_top.dut.u_block_wrap_0.u_g3_side_glue_wrap.analog_mipi_phy_g3_rf.u_reg_dec');
    expect(regDec?.metrics.line).toEqual({ percentage: 98.76, covered: 159, total: 161 });

    // Average ≠ Covered 的节点：取 Covered（u_apb2rmmi_0：Average 94.03 / Covered 85.59）
    const apb0 = findNode(result.root, 'u_apb2rmmi_0');
    expect(apb0?.metrics.line).toEqual({ percentage: 85.59, covered: 95, total: 111 });

    // 兄弟分支回退：u_analog_mipi_mphy_2t2r_glue_logic 回到 dut 下（与 u_block_wrap_0 同级）
    expect(apb0?.path).toBe('tb_top.chip_top.dut.u_apb2rmmi_0');
    const glueLogic = findNode(result.root, 'u_analog_mipi_mphy_2t2r_glue_logic');
    expect(glueLogic?.depth).toBe(3);
    expect(glueLogic?.metrics.line).toEqual({ percentage: 89.5, covered: 810, total: 905 });

    // N/A 行（tb_top/chip_top）：全 N/A triplet
    expect(result.root.metrics.line).toEqual({ percentage: null, covered: null, total: null });

    // 其他 metric 不参与（detail.txt 未解析）
    expect(dut?.metrics.branch.percentage).toBeNull();
    expect(dut?.metrics.functional.percentage).toBeNull();
  });

  it('parses metrics.txt deeper than 6 levels (no depth cap, dot-separated path)', async () => {
    const projectRoot = await makeTempDir();
    const reportDir = join(projectRoot, 'reports');
    await mkdir(reportDir);
    await writeFile(
      join(reportDir, 'meta.json'),
      JSON.stringify({ covMergeDir: join(projectRoot, 'cov_merge'), edaTool: 'imc' }),
      'utf-8',
    );
    // 9 层真实 IMC 格式（前缀竖线+空格逐层延伸）
    await writeFile(
      join(reportDir, 'metrics.txt'),
      [
        'name                           Overall Average       Overall Covered',
        'l0                             90.00%                90.00% (90/100)',
        '|--l1                          90.00%                90.00% (90/100)',
        '|  |--l2                       90.00%                90.00% (90/100)',
        '|  |  |--l3                    90.00%                90.00% (90/100)',
        '|  |  |  |--l4                 90.00%                90.00% (90/100)',
        '|  |  |  |  |--l5              90.00%                90.00% (90/100)',
        '|  |  |  |  |  |--l6           90.00%                90.00% (90/100)',
        '|  |  |  |  |  |  |--l7        90.00%                90.00% (90/100)',
        '|  |  |  |  |  |  |  |--l8     90.00%                90.00% (90/100)',
      ].join('\n'),
      'utf-8',
    );

    const result = await parser.parse(projectRoot, 'merge_test', reportDir, { summaryOnly: true });

    // 根：l0，path 无 top 前缀，直接以模块名为第一级
    expect(result.root.name).toBe('l0');
    expect(result.root.path).toBe('l0');
    // 逐层下钻到 depth 8，path 点号拼接
    let node = result.root;
    for (let depth = 1; depth <= 8; depth++) {
      node = node.children[0];
      expect(node?.name).toBe(`l${depth}`);
      expect(node?.depth).toBe(depth);
      expect(node?.path).toBe(Array.from({ length: depth + 1 }, (_, i) => `l${i}`).join('.'));
    }
  });

  it('falls back to summary.txt hierarchy when metrics.txt is absent', async () => {
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
        '|--dut                94.13%           94.13% (353/375) 94.13%        94.13% (353/375)   n/a          n/a          n/a                 n/a',
      ].join('\n'),
      'utf-8',
    );

    const result = await parser.parse(projectRoot, 'merge_test', reportDir);
    const dut = result.root.children[0];
    expect(dut?.name).toBe('dut');
    expect(dut?.metrics.line).toEqual({ percentage: 94.13, covered: 353, total: 375 });
  });

  it('imc default commands: summary disabled, metrics is the quick-import command', () => {
    expect(DEFAULT_EDA_COMMANDS.imc.summaryCommand).toBeUndefined();
    expect(DEFAULT_EDA_COMMANDS.imc.metricsCommand).toContain('-execcmd "report -metrics overall');
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
