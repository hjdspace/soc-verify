/**
 * parseDetailReportInWorker 集成回归：真实 Worker Thread + 真实内置插件。
 *
 * 生产路径为 router → adapter.parseDetailReport → parseDetailReportInWorker
 * （Worker Thread 中 require builtin-coverage-parser 并执行 parseDetailReport）。
 * 验证 worker eval 代码字符串与插件 CJS 导出兼容（syntax/protocol 回归）。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDetailReportInWorker } from '../../src/main/coverage/coverage-worker';

const PLUGIN_PATH = resolve('plugins/builtin-coverage-parser/index.js');
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'soc-verify-detail-worker-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('parseDetailReportInWorker（真实插件 worker 集成）', () => {
  it('在 Worker Thread 中解析真实 detail.txt 并返回完整结果', async () => {
    const dir = await makeTempDir();
    const detailPath = join(dir, 'detail.txt');
    await writeFile(
      detailPath,
      [
        'Covered+Uncovered+Excluded+UNR Block Detail Report, Instance Based',
        '================================================================================',
        'Instance name: tb_top.chip_top.dut.u_analog_bb_line_usb',
        'Type name: analog_bb_line_usb',
        'File name: /tech_phys/rtl/analog_bb_line_usb.v',
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
        'Count   Block #Stmt Line Kind                  Origin Source Code',
        '1       1     0     24 ternary 1 true *        24     assign CLK_OUT_TO_USB = cell_on ? CLK_IN : 1\'b0 ;',
      ].join('\n'),
      'utf-8',
    );

    const result = await parseDetailReportInWorker(PLUGIN_PATH, detailPath);

    expect(result.instanceCount).toBe(1);
    expect(result.instances[0]).toEqual({
      instance: 'tb_top.chip_top.dut.u_analog_bb_line_usb',
      type: 'analog_bb_line_usb',
      file: '/tech_phys/rtl/analog_bb_line_usb.v',
      blocks: { covered: 3, total: 3, percentage: 100 },
      branches: { covered: 2, total: 2, percentage: 100 },
      statements: { covered: 2, total: 2, percentage: 100 },
    });
    expect(result.parseMs).toBeGreaterThanOrEqual(0);
  });

  it('文件缺失时 worker 路径 fail-closed 抛错', async () => {
    const dir = await makeTempDir();
    await expect(
      parseDetailReportInWorker(PLUGIN_PATH, join(dir, 'missing.txt')),
    ).rejects.toThrow(/not found/i);
  });
});
