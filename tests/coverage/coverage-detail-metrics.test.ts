/**
 * CoverageManager.parseDetailMetrics — detail.txt 解析与持久化（分层解析扩展）。
 *
 * 用户通过 UI 按钮触发 parseDetailMetrics：
 *   1. 运行 EDA detailCommand 生成 detail.txt（imc report -detail -all -out）
 *   2. Worker Thread 中执行插件 parseDetailReport（不阻塞主进程）
 *   3. 全量 instance 数据持久化到 .socverify/coverage/<sessionId>-detail.json
 *      （waive 文件自动生成的基础数据）
 *   4. 将 blocks/branches/statements 汇总进 CoverageData：
 *      - statements → metrics.line、branches → metrics.branch（triplet 合并进树）
 *      - detail 摘要标记（instanceCount 等）写入缓存
 *   5. 更新 <sessionId>.json 缓存（与 metrics.txt 快速层持久化数据结合）
 */
import { describe, it, expect, vi } from 'vitest';
import { CoverageManager } from '../../src/main/coverage/coverage-manager';
import { CoverageReportGenerator } from '../../src/main/coverage/coverage-report-generator';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CoverageData, CoverageNode, EdaToolConfig } from '@shared/types';
import { triplet, NA_TRIPLET, DEFAULT_COVERAGE_TARGETS } from '@shared/types';

// ─── Mock 数据辅助 ─────────────────────────────────────────────

function makeMetrics(): CoverageNode['metrics'] {
  const t = () => ({ ...NA_TRIPLET });
  return {
    line: t(),
    branch: t(),
    toggle: t(),
    condition: t(),
    fsm_state: t(),
    fsm_transition: t(),
    functional: t(),
    assertion: t(),
  };
}

function makeMockData(sessionId: string): CoverageData {
  const root: CoverageNode = {
    name: 'tb_top',
    path: 'tb_top',
    depth: 0,
    metrics: makeMetrics(),
    children: [
      {
        name: 'chip_top',
        path: 'tb_top.chip_top',
        depth: 1,
        metrics: makeMetrics(),
        children: [
          {
            // 与 mock detail 数据同层级：metrics 快速层只填了 line
            name: 'u_analog_bb_line_usb',
            path: 'tb_top.chip_top.u_analog_bb_line_usb',
            depth: 2,
            metrics: { ...makeMetrics(), line: triplet(13, 15) },
            children: [],
          },
        ],
      },
    ],
  };
  return {
    sessionId,
    source: { covMergeDir: '/mock/cov_merge', edaTool: 'imc', reportGeneratedAt: Date.now() },
    root,
    targets: { ...DEFAULT_COVERAGE_TARGETS },
    summaryOnly: true,
  };
}

/** Mock adapter：parse 返回快速层数据；parseDetailReport 返回固定 instance 结果 */
function createMockAdapter(data: CoverageData, detailInstances: unknown) {
  return {
    hasParser: () => true,
    parse: vi.fn(async () => {
      const enriched = { ...data, summaryOnly: true };
      return { data: enriched, jsonStr: JSON.stringify(enriched) };
    }),
    parseDetailReport: vi.fn(async () => detailInstances),
  };
}

// ─── detail.txt 样例（与解析器测试同源） ───────────────────────

const DETAIL_INSTANCES = [
  {
    instance: 'tb_top.chip_top.u_analog_bb_line_usb',
    type: 'analog_bb_line_usb',
    file: '/tech_phys/rtl/analog_bb_line_usb.v',
    blocks: { covered: 3, total: 3, percentage: 100 },
    branches: { covered: 2, total: 2, percentage: 100 },
    statements: { covered: 2, total: 2, percentage: 100 },
  },
  {
    instance: 'tb_top.chip_top.u_analog_bb_line_pciepll',
    type: 'analog_bb_line_pciepll',
    file: '/tech_phys/rtl/analog_bb_line_pciepll.v',
    blocks: { covered: 1, total: 4, percentage: 25 },
    branches: { covered: 2, total: 8, percentage: 25 },
    statements: { covered: 5, total: 10, percentage: 50 },
  },
];

describe('CoverageManager.parseDetailMetrics（detail 解析与持久化）', () => {
  it('持久化 instance 全量数据到 <sessionId>-detail.json，并合并 branch 进 metrics 树', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'soc-verify-mgr-'));
    try {
      // 预置已导入的 session 缓存（快速层）与元数据
      const sessionId = 'merge_test';
      const covDir = join(projectRoot, '.socverify', 'coverage');
      mkdirSync(covDir, { recursive: true });
      const mockData = makeMockData(sessionId);
      writeFileSync(join(covDir, `${sessionId}.json`), JSON.stringify(mockData));
      writeFileSync(
        join(covDir, 'sessions.json'),
        JSON.stringify([
          {
            sessionId,
            covMergeDir: '/mock/cov_merge',
            edaTool: 'imc',
            createdAt: 1,
            reportDir: join(covDir, sessionId, 'reports'),
          },
        ]),
      );
      mkdirSync(join(covDir, sessionId, 'reports'), { recursive: true });

      const adapter = createMockAdapter(mockData, { instances: DETAIL_INSTANCES, instanceCount: 2, parseMs: 1 });
      const mgr = new CoverageManager({ projectRoot, coverageAdapter: adapter as never });
      // detailCommand 由 mock runner 成功执行（不实际生成文件——解析由 mock 掉）
      mgr.setReportGenerator(
        new CoverageReportGenerator({
          projectRoot,
          runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        }),
      );

      const edaConfig: EdaToolConfig = {
        tool: 'imc',
        covMergeDir: '/mock/cov_merge',
        metricsCommand: undefined,
        summaryCommand: undefined,
        gradeCommand: undefined,
        binsCommand: undefined,
        csvCommand: undefined,
        detailCommand: 'imc -load {covMergeDir} -execcmd "report -detail -all -out {reportDir}/detail.txt"',
      };
      const result = await mgr.parseDetailMetrics(sessionId, edaConfig);

      // 1. 全量明细持久化（waive 基础数据）
      const detailJsonPath = join(covDir, `${sessionId}-detail.json`);
      expect(existsSync(detailJsonPath)).toBe(true);
      const persisted = JSON.parse(readFileSync(detailJsonPath, 'utf-8')) as {
        sessionId: string;
        parsedAt: number;
        instanceCount: number;
        instances: typeof DETAIL_INSTANCES;
      };
      expect(persisted.sessionId).toBe(sessionId);
      expect(persisted.instanceCount).toBe(2);
      expect(persisted.instances[0].instance).toBe('tb_top.chip_top.u_analog_bb_line_usb');
      expect(persisted.instances[0].blocks).toEqual({ covered: 3, total: 3, percentage: 100 });
      expect(persisted.instances[1].branches).toEqual({ covered: 2, total: 8, percentage: 25 });

      // 2. 合并进 metrics 树：usb 节点 branch triplet 来自 detail（statements → line 覆盖快速层已有值）
      const usb = result.root.children[0].children[0];
      expect(usb.metrics.branch).toEqual({ percentage: 100, covered: 2, total: 2 });
      // line 保留 detail statements 值（2/2=100 覆盖快速层 13/15）
      expect(usb.metrics.line).toEqual({ percentage: 100, covered: 2, total: 2 });

      // 3. CoverageData 缓存已更新（summaryOnly 不变，detail 摘要已写入）
      const cached = JSON.parse(readFileSync(join(covDir, `${sessionId}.json`), 'utf-8')) as CoverageData;
      expect(cached.root.children[0].children[0].metrics.branch.percentage).toBe(100);
      expect(cached.detail).toBeDefined();
      if (cached.detail) {
        expect(cached.detail.instanceCount).toBe(2);
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('session 不存在时抛错（fail-closed）', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'soc-verify-mgr-'));
    try {
      const adapter = createMockAdapter(makeMockData('x'), { instances: [], instanceCount: 0, parseMs: 0 });
      const mgr = new CoverageManager({ projectRoot, coverageAdapter: adapter as never });
      await expect(
        mgr.parseDetailMetrics('merge_missing', { tool: 'imc', covMergeDir: '' }),
      ).rejects.toThrow(/not found/i);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('getDetailInstances 支持分页查询持久化数据', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'soc-verify-mgr-'));
    try {
      const sessionId = 'merge_page';
      const covDir = join(projectRoot, '.socverify', 'coverage');
      mkdirSync(covDir, { recursive: true });
      // 直接预置持久化文件（模拟已解析状态）
      writeFileSync(
        join(covDir, `${sessionId}-detail.json`),
        JSON.stringify({ sessionId, parsedAt: 1, instanceCount: 2, instances: DETAIL_INSTANCES }),
      );

      const adapter = createMockAdapter(makeMockData(sessionId), { instances: [], instanceCount: 0, parseMs: 0 });
      const mgr = new CoverageManager({ projectRoot, coverageAdapter: adapter as never });

      // 无分页参数：全量
      const all = await mgr.getDetailInstances(sessionId);
      expect(all?.instanceCount).toBe(2);
      expect(all?.instances).toHaveLength(2);

      // 分页：offset=1, limit=1 → 只返回第二个
      const page = await mgr.getDetailInstances(sessionId, { offset: 1, limit: 1 });
      expect(page?.instances).toHaveLength(1);
      expect(page?.instances[0]?.instance).toBe('tb_top.chip_top.u_analog_bb_line_pciepll');

      // 按百分比排序（blocks 升序 → pciepll 25% 在前）
      const sorted = await mgr.getDetailInstances(sessionId, { sortBy: 'blocks', sortOrder: 'asc' });
      expect(sorted?.instances[0]?.instance).toBe('tb_top.chip_top.u_analog_bb_line_pciepll');

      // 文件不存在 → null
      const none = await mgr.getDetailInstances('merge_nodetail');
      expect(none).toBeNull();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
