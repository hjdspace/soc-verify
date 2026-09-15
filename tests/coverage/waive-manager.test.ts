/**
 * WaiveManager 集成测试 — 端到端生成流程 + 历史记录 CRUD。
 *
 * 场景（docs/coverage_auto_waive.md 全链路）：
 * - 临时项目根 + <sessionId>-detail.json + 真实 RTL 文件（fixture 内联写盘）
 * - generate() 产出三件套：.vRefine / waive-analysis.json / waive-log.txt
 * - 不可读 RTL 文件记 warning 跳过
 * - 可重复生成（两次 runId 不同，历史最新在前）
 * - deleteHistoryEntry 删除目录与记录；非法 runId 拒绝
 * - loadAnalysis 读取中间产物
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WaiveManager } from '../../src/main/coverage/waive/waive-manager';
import type { CoverageDetailData } from '@shared/types';

let projectRoot: string;
let rtlDir: string;

const SUB_RTL = `module sub_mod (
  input x,
  input y,
  output c,
  output d
);
  assign c = x & y;
  assign d = x | y;
endmodule
`;

const TOP_RTL = `module top_mod (input clk, input a, output c);
  // 固定值 assign（应识别）
  assign AVDD_3P3 = 1'b0;
  assign [3:0] fixed_bus = 4'h0;
  // 正常 assign（不识别）
  assign c = a;
  // 子例化：y tie 常量、d 省略悬空
  sub_mod u_sub (
    .x(a),
    .y(1'b0),
    .c(c),
    .d()      // 显式悬空
  );
endmodule
`;

function writeDetail(instances: CoverageDetailData['instances']): void {
  const covDir = join(projectRoot, '.socverify', 'coverage');
  mkdirSync(covDir, { recursive: true });
  const detail: CoverageDetailData = {
    sessionId: 'merge_test',
    parsedAt: Date.now(),
    instanceCount: instances.length,
    instances,
  };
  writeFileSync(join(covDir, 'merge_test-detail.json'), JSON.stringify(detail));
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'soc-verify-waive-'));
  rtlDir = join(projectRoot, 'rtl');
  mkdirSync(rtlDir, { recursive: true });
  writeFileSync(join(rtlDir, 'top.v'), TOP_RTL);
  writeFileSync(join(rtlDir, 'sub.v'), SUB_RTL);
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('WaiveManager.generate 端到端', () => {
  it('生成 .vRefine + 中间产物 + 历史记录，进度事件全程推送', async () => {
    writeDetail([
      {
        instance: 'tb_top.chip_top.dut.u_top',
        type: 'top_mod',
        file: join(rtlDir, 'top.v'),
        blocks: { covered: 1, total: 2, percentage: 50 },
        branches: { covered: 1, total: 1, percentage: 100 },
        statements: { covered: 1, total: 1, percentage: 100 },
      },
      {
        instance: 'tb_top.chip_top.dut.u_top.u_sub',
        type: 'sub_mod',
        file: join(rtlDir, 'sub.v'),
        blocks: { covered: 2, total: 2, percentage: 100 },
        branches: { covered: 0, total: 0, percentage: null },
        statements: { covered: 2, total: 2, percentage: 100 },
      },
    ]);

    const mgr = new WaiveManager(projectRoot);
    const steps: string[] = [];
    const entry = await mgr.generate(
      { sessionId: 'merge_test' },
      (e) => steps.push(e.step),
    );

    // 进度步骤全链路
    expect(steps[0]).toBe('load_detail');
    expect(steps).toContain('analyze_rtl');
    expect(steps).toContain('render_xml');
    expect(steps).toContain('write_output');
    expect(steps[steps.length - 1]).toBe('done');

    // 信号识别：const_assign 2 + input_tie 1（y）+ output_floating 1（d 显式悬空 + 省略 d）
    expect(entry.signalCounts.const_assign).toBe(2);
    expect(entry.signalCounts.input_tie).toBeGreaterThanOrEqual(1);
    expect(entry.signalCounts.output_floating).toBeGreaterThanOrEqual(1);

    // 产物三件套存在
    const runDir = join(projectRoot, '.socverify', 'coverage', 'waive', entry.runId);
    expect(existsSync(entry.outputPath)).toBe(true);
    expect(entry.outputPath).toBe(join(runDir, `${entry.runId}.vRefine`));
    expect(existsSync(join(runDir, 'waive-analysis.json'))).toBe(true);
    expect(existsSync(join(runDir, 'waive-log.txt'))).toBe(true);

    // .vRefine 内容：top scope 前缀 + toggle rule
    const xml = readFileSync(entry.outputPath, 'utf-8');
    expect(xml).toContain('<refinement-file-root>');
    expect(xml).toContain('entityName="tb_top/chip_top/dut/u_top/AVDD_3P3"');
    expect(xml).toContain('entityName="tb_top/chip_top/dut/u_top/fixed_bus"');
    expect(xml).toContain('entityName="tb_top/chip_top/dut/u_top/u_sub/y"');
    expect(xml).toContain('entityType="toggle"');

    // cache-map 含 RTL 文件路径（top.v）
    expect(xml).toContain('top.v');

    // 历史记录
    const history = await mgr.listHistory();
    expect(history).toHaveLength(1);
    expect(history[0].runId).toBe(entry.runId);
    expect(history[0].sessionId).toBe('merge_test');
  });

  it('detail 未解析时 fail-closed 抛错', async () => {
    const mgr = new WaiveManager(projectRoot);
    await expect(mgr.generate({ sessionId: 'nope' })).rejects.toThrow();
  });

  it('RTL 文件不可读时记 warning 并继续分析其余文件', async () => {
    writeDetail([
      {
        instance: 'tb_top.u_top',
        type: 'top_mod',
        file: join(rtlDir, 'top.v'),
        blocks: { covered: 0, total: 0, percentage: null },
        branches: { covered: 0, total: 0, percentage: null },
        statements: { covered: 0, total: 0, percentage: null },
      },
      {
        instance: 'tb_top.u_ghost',
        type: 'ghost_mod',
        file: '/nonexistent/path/ghost.v',
        blocks: { covered: 0, total: 0, percentage: null },
        branches: { covered: 0, total: 0, percentage: null },
        statements: { covered: 0, total: 0, percentage: null },
      },
    ]);

    const mgr = new WaiveManager(projectRoot);
    const entry = await mgr.generate({ sessionId: 'merge_test' });
    expect(entry.warnings.join('\n')).toContain('ghost.v');
    // 可读文件仍产出信号
    expect(entry.ruleCount).toBeGreaterThan(0);

    // 中间产物可回读
    const analysis = await mgr.loadAnalysis(entry.runId);
    expect(analysis).not.toBeNull();
    expect(analysis!.warnings.length).toBeGreaterThan(0);
    expect(analysis!.fileStats.find((f) => f.warning === 'file not found')).toBeDefined();
  });

  it('可重复生成：两次 runId 不同，历史最新在前', async () => {
    writeDetail([
      {
        instance: 'tb_top.u_top',
        type: 'top_mod',
        file: join(rtlDir, 'top.v'),
        blocks: { covered: 0, total: 0, percentage: null },
        branches: { covered: 0, total: 0, percentage: null },
        statements: { covered: 0, total: 0, percentage: null },
      },
    ]);
    const mgr = new WaiveManager(projectRoot);
    const e1 = await mgr.generate({ sessionId: 'merge_test' });
    const e2 = await mgr.generate({ sessionId: 'merge_test' });
    expect(e1.runId).not.toBe(e2.runId);
    const history = await mgr.listHistory();
    expect(history).toHaveLength(2);
    expect(history[0].runId).toBe(e2.runId);
  });

  it('deleteHistoryEntry 删除目录与记录；非法 runId 拒绝', async () => {
    writeDetail([
      {
        instance: 'tb_top.u_top',
        type: 'top_mod',
        file: join(rtlDir, 'top.v'),
        blocks: { covered: 0, total: 0, percentage: null },
        branches: { covered: 0, total: 0, percentage: null },
        statements: { covered: 0, total: 0, percentage: null },
      },
    ]);
    const mgr = new WaiveManager(projectRoot);
    const entry = await mgr.generate({ sessionId: 'merge_test' });
    expect((await mgr.listHistory())).toHaveLength(1);

    // 非法 runId fail-closed（防止路径穿越删除任意目录）
    await expect(mgr.deleteHistoryEntry('../evil')).rejects.toThrow();

    const ok = await mgr.deleteHistoryEntry(entry.runId);
    expect(ok).toBe(true);
    expect((await mgr.listHistory())).toHaveLength(0);
    expect(existsSync(join(projectRoot, '.socverify', 'coverage', 'waive', entry.runId))).toBe(false);
  });

  it('pathPrefixMap 将 imc 路径映射到本地镜像路径', async () => {
    writeDetail([
      {
        instance: 'tb_top.u_top',
        type: 'top_mod',
        file: '/proj/Remote/view/de/top.v', // imc 视角路径，本地在 rtlDir
        blocks: { covered: 0, total: 0, percentage: null },
        branches: { covered: 0, total: 0, percentage: null },
        statements: { covered: 0, total: 0, percentage: null },
      },
      {
        instance: 'tb_top.u_top.u_sub',
        type: 'sub_mod',
        file: '/proj/Remote/view/de/sub.v',
        blocks: { covered: 0, total: 0, percentage: null },
        branches: { covered: 0, total: 0, percentage: null },
        statements: { covered: 0, total: 0, percentage: null },
      },
    ]);
    const mgr = new WaiveManager(projectRoot);
    const entry = await mgr.generate({
      sessionId: 'merge_test',
      pathPrefixMap: { '/proj/Remote/view/de': rtlDir },
    });
    // 映射成功 → 两个文件都读到 → assign + tie + floating 全识别
    expect(entry.signalCounts.const_assign).toBe(2);
    expect(entry.signalCounts.input_tie).toBeGreaterThanOrEqual(1);
    expect(entry.warnings).toHaveLength(0);
  });
});
