import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const parser = require(resolve('plugins/builtin-coverage-parser/index.js')) as {
  parseDetailReport: (
    detailPath: string,
  ) => {
    instances: Array<{
      instance: string;
      type: string;
      file: string;
      blocks: { covered: number; total: number; percentage: number | null };
      branches: { covered: number; total: number; percentage: number | null };
      statements: { covered: number; total: number; percentage: number | null };
    }>;
    instanceCount: number;
    parseMs: number;
  };
};

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'soc-verify-detail-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * 用户提供的真实 detail.txt 样例（imc report -detail -all -out）。
 * 两个 instance：analog_bb_line_usb（单空格尾）与 analog_bb_line_pciepll（双空格尾），
 * 覆盖行尾空白差异。块明细行（Count/Block 列）不应影响 instance 级统计提取。
 */
const REAL_DETAIL_TXT = [
  '',
  '',
  'Covered+Uncovered+Excluded+UNR Block Detail Report, Instance Based',
  '================================================================================',
  'Instance name: tb_top.chip_top.dut.u_analog_bb_line_usb',
  'Type name: analog_bb_line_usb',
  'File name: /tech_phys/chips/KunlunN02/D_die/analog/v0p9/analog_bb_line_usb_20260618-14:42/verilog/analog_bb_line_usb.v',
  'Include Files:',
  '    /pub/tech_phys/chips/KunlunN02/D_die/analog/v0p9/analog_bb_line_usb_20260618-14:42/verilog/analog_bb_line_usb_powerpin_sim.v',
  'Number of covered blocks: 3 of 3',
  'Number of uncovered blocks: 0 of 3',
  'Number of excluded blocks: 0',
  'Number of unreachable blocks: 0',
  'Number of covered branches: 2 of 2',
  'Number of uncovered branches: 0 of 2',
  'Number of excluded branches: 0',
  'Number of unreachable branches: 0',
  'Number of covered statements: 2 of 2',
  'Number of uncovered statements: 0 of 2',
  'Number of excluded statements: 0',
  'Number of unreachable statements: 0',
  '',
  'Count   Block #Stmt Line Kind                  Origin Source Code',
  '--------------------------------------------------------------------------------',
  '1       1     0     24 ternary 1 true *        24     assign CLK_OUT_TO_USB = cell_on ? CLK_IN : 1\'b0 ;',
  '1       2     0     24 ternary 1 false *       24     assign CLK_OUT_TO_USB = cell_on ? CLK_IN : 1\'b0 ;',
  '1       3     2     1 (analog_bb_line_usb_powerpin_sim.v) code block       1 (analog_bb_line_usb_powerpin_sim.v) initial begin',
  '(*) indicates a branch',
  '',
  'Instance name: tb_top.chip_top.dut.u_analog_bb_line_pciepll  ',
  'Type name: analog_bb_line_pciepll  ',
  'File name: /tech_phys/chips/KunlunN02/D_die/analog/v0p9/analog_bb_line_pciepll_20260618-14:42/verilog/analog_bb_line_pciepll.v  ',
  'Include Files:  ',
  '    /pub/tech_phys/chips/KunlunN02/D_die/analog/v0p9/analog_bb_line_pciepll_20260618-14:42/verilog/analog_bb_line_pciepll_powerpin_sim.v  ',
  'Number of covered blocks: 3 of 3  ',
  'Number of uncovered blocks: 0 of 3  ',
  'Number of excluded blocks: 0  ',
  'Number of unreachable blocks: 0  ',
  'Number of covered branches: 2 of 2  ',
  'Number of uncovered branches: 0 of 2  ',
  'Number of excluded branches: 0  ',
  'Number of unreachable branches: 0  ',
  'Number of covered statements: 2 of 2  ',
  'Number of uncovered statements: 0 of 2  ',
  'Number of excluded statements: 0  ',
  'Number of unreachable statements: 0  ',
  'Count Block #Stmt Line Kind Origin Source Code  ',
  '------ ----- ---- ---- ---- ------------------  ',
  '1      1     0    24   ternary 1 true * 24 assign CLK_OUT_TO_PCIEPLL = cell_on ? CLK_IN : 1\'b0 ;  ',
  '1      2     0    24   ternary 1 false * 24 assign CLK_OUT_TO_PCIEPLL = cell_on ? CLK_IN : 1\'b0 ;  ',
  '1      3     2    1    (analog_bb_line_pciepll_powerpin_sim.v) code block 1 (analog_bb_line_pciepll_powerpin_sim.v) initial begin  ',
  '(*) indicates a branch',
].join('\n');

describe('parseDetailReport（IMC detail.txt instance 级解析）', () => {
  it('提取真实样例中的 instance/type/file 与 blocks/branches/statements 覆盖计数', async () => {
    const dir = await makeTempDir();
    const detailPath = join(dir, 'detail.txt');
    await writeFile(detailPath, REAL_DETAIL_TXT, 'utf-8');

    const result = parser.parseDetailReport(detailPath);

    expect(result.instanceCount).toBe(2);
    expect(result.instances).toHaveLength(2);

    const usb = result.instances[0];
    expect(usb.instance).toBe('tb_top.chip_top.dut.u_analog_bb_line_usb');
    expect(usb.type).toBe('analog_bb_line_usb');
    expect(usb.file).toBe(
      '/tech_phys/chips/KunlunN02/D_die/analog/v0p9/analog_bb_line_usb_20260618-14:42/verilog/analog_bb_line_usb.v',
    );
    expect(usb.blocks).toEqual({ covered: 3, total: 3, percentage: 100 });
    expect(usb.branches).toEqual({ covered: 2, total: 2, percentage: 100 });
    expect(usb.statements).toEqual({ covered: 2, total: 2, percentage: 100 });
  });

  it('容忍双空格结尾行（pciepll 段）并 trim 所有字段', async () => {
    const dir = await makeTempDir();
    const detailPath = join(dir, 'detail.txt');
    await writeFile(detailPath, REAL_DETAIL_TXT, 'utf-8');

    const result = parser.parseDetailReport(detailPath);
    const pciepll = result.instances[1];

    expect(pciepll.instance).toBe('tb_top.chip_top.dut.u_analog_bb_line_pciepll');
    expect(pciepll.type).toBe('analog_bb_line_pciepll');
    expect(pciepll.file).toBe(
      '/tech_phys/chips/KunlunN02/D_die/analog/v0p9/analog_bb_line_pciepll_20260618-14:42/verilog/analog_bb_line_pciepll.v',
    );
    expect(pciepll.blocks).toEqual({ covered: 3, total: 3, percentage: 100 });
    expect(pciepll.branches).toEqual({ covered: 2, total: 2, percentage: 100 });
    expect(pciepll.statements).toEqual({ covered: 2, total: 2, percentage: 100 });
  });

  it('计算覆盖率百分比（covered/total*100）', async () => {
    const dir = await makeTempDir();
    const detailPath = join(dir, 'detail.txt');
    await writeFile(
      detailPath,
      [
        'Covered+Uncovered+Excluded+UNR Block Detail Report, Instance Based',
        '================================================================================',
        'Instance name: tb_top.dut.u_core',
        'Type name: core',
        'File name: /proj/rtl/core.v',
        'Number of covered blocks: 1 of 4',
        'Number of uncovered blocks: 3 of 4',
        'Number of excluded blocks: 0',
        'Number of unreachable blocks: 0',
        'Number of covered branches: 2 of 8',
        'Number of uncovered branches: 6 of 8',
        'Number of excluded branches: 0',
        'Number of unreachable branches: 0',
        'Number of covered statements: 5 of 10',
        'Number of uncovered statements: 5 of 10',
        'Number of excluded statements: 0',
        'Number of unreachable statements: 0',
        'Count   Block #Stmt Line Kind                  Origin Source Code',
        '1       1     0     24 ternary 1 true *        24     assign a = b ? c : d ;',
        '0       2     0     25 code block             25     if (x) begin',
      ].join('\n'),
      'utf-8',
    );

    const result = parser.parseDetailReport(detailPath);
    expect(result.instanceCount).toBe(1);
    const inst = result.instances[0];
    expect(inst.blocks.covered).toBe(1);
    expect(inst.blocks.total).toBe(4);
    expect(inst.blocks.percentage).toBe(25);
    expect(inst.branches.percentage).toBe(25);
    expect(inst.statements.percentage).toBe(50);
  });

  it('文件缺失时抛错（fail-closed）', async () => {
    const dir = await makeTempDir();
    expect(() => parser.parseDetailReport(join(dir, 'nope.txt'))).toThrow();
  });

  /**
   * 性能上限验证：合成 20 万 instance × 30 块明细行 ≈ 630 万行 / 200MB 级文本，
   * 解析必须在 30 秒内完成且结果完整（生产 300 万行约为该规模的一半）。
   */
  it('性能：百万行级文件单遍扫描秒级完成', { timeout: 120_000 }, async () => {
    const dir = await makeTempDir();
    const detailPath = join(dir, 'detail.txt');

    // 流式合成大文件：20 万 instance，每段 20 字段/表头行 + 30 块明细行
    const INSTANCE_COUNT = 200_000;
    const BLOCK_ROWS = 30;
    const fsp = await import('node:fs/promises');
    const handle = await fsp.open(detailPath, 'w');
    try {
      await handle.write(
        'Covered+Uncovered+Excluded+UNR Block Detail Report, Instance Based\n' +
        '================================================================================\n\n',
      );
      for (let i = 0; i < INSTANCE_COUNT; i++) {
        const seg = [
          `Instance name: tb_top.chip_top.dut.u_core_${i.toString().padStart(6, '0')}`,
          `Type name: core_${i}`,
          `File name: /proj/rtl/core_${i}.v`,
          'Include Files:',
          `    /proj/rtl/core_${i}_sim.v`,
          'Number of covered blocks: 3 of 3',
          'Number of uncovered blocks: 0 of 3',
          'Number of excluded blocks: 0',
          'Number of unreachable blocks: 0',
          'Number of covered branches: 2 of 2',
          'Number of uncovered branches: 0 of 2',
          'Number of excluded branches: 0',
          'Number of unreachable branches: 0',
          'Number of covered statements: 2 of 2',
          'Number of uncovered statements: 0 of 2',
          'Number of excluded statements: 0',
          'Number of unreachable statements: 0',
          '',
          'Count   Block #Stmt Line Kind                  Origin Source Code',
          '--------------------------------------------------------------------------------',
        ];
        for (let b = 0; b < BLOCK_ROWS; b++) {
          seg.push(
            `1       ${b + 1}     0     24 code block             24     assign sig_${b} = a_${i} ? b : c ; // padding padding padding padding`,
          );
        }
        seg.push('(*) indicates a branch', '');
        await handle.write(seg.join('\n'));
      }
    } finally {
      await handle.close();
    }

    const stat = await fsp.stat(detailPath);
    const result = parser.parseDetailReport(detailPath);

    // 完整性：一个 instance 不漏
    expect(result.instanceCount).toBe(INSTANCE_COUNT);
    expect(result.instances[INSTANCE_COUNT - 1].instance).toBe(
      `tb_top.chip_top.dut.u_core_${(INSTANCE_COUNT - 1).toString().padStart(6, '0')}`,
    );
    expect(result.instances[0].blocks.percentage).toBe(100);
    // 速度上限：200MB 级文件 < 30s（CI 波动下仍留充分余量）
    expect(result.parseMs).toBeLessThan(30_000);
    console.log(
      `[perf] ${INSTANCE_COUNT} instances, file ${(stat.size / 1024 / 1024).toFixed(0)}MB, parse ${result.parseMs}ms`,
    );
  });
});
