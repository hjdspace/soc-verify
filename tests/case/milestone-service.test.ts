import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryDatabase, closeDatabase, type CaseDatabase } from '../../src/main/case/db/case-database';
import {
  insertSubsystems,
  insertCases,
  insertSimulationRun,
  setCasePostSim,
} from '../../src/main/case/db/case-repository';
import { computeMilestones } from '../../src/main/case/milestone-service';
import { computeMilestoneStatuses } from '../../src/shared/types/milestone';
import { appendGenHistory } from '../../src/main/tools/sysbase-gen/gen-history';

describe('Milestone Service', () => {
  let db: CaseDatabase;
  let projectRoot: string;

  beforeEach(() => {
    db = createMemoryDatabase();
    projectRoot = mkdtempSync(join(tmpdir(), 'soc-milestone-'));
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function seedCases(names: string[]) {
    insertSubsystems(db, [{ name: 'cpu' }]);
    insertCases(db, names.map((name) => ({ name, subsys: 'cpu', path: `/proj/cpu/${name}` })));
  }

  let runSeq = 0;
  function seedRun(caseName: string, status: string) {
    runSeq += 1;
    // start_time 递增，确保 ROW_NUMBER() 按时间取最新终态时顺序稳定
    const startTime = new Date(Date.UTC(2026, 0, 1, 0, 0, runSeq)).toISOString();
    insertSimulationRun(db, {
      caseName,
      subsys: 'cpu',
      status,
      startTime,
    });
  }

  async function seedEnvGenSuccess() {
    await appendGenHistory(projectRoot, {
      genLevel: 'subsys',
      subsys: 'cpu',
      outputDir: '/proj/cpu/env',
      success: true,
      exitCode: 0,
      timestamp: new Date().toISOString(),
    });
  }

  /** 计算并返回 id → status 映射 */
  async function statusById(): Promise<Record<string, string>> {
    const nodes = computeMilestoneStatuses(await computeMilestones(db, projectRoot));
    return Object.fromEntries(nodes.map((n) => [n.id, n.status]));
  }

  it('fresh project → 需求导入 is current, all subsequent pending', async () => {
    const byId = await statusById();
    expect(byId['requirement-import']).toBe('current');
    expect(byId['env-gen']).toBe('pending');
    expect(byId['case-dev']).toBe('pending');
    expect(byId['smoke']).toBe('pending');
    expect(byId['functional']).toBe('pending');
    expect(byId['post-sim']).toBe('pending');
    expect(byId['signoff']).toBe('pending');
  });

  it('需求导入完成 = 子系统与用例均已导入（环境生成成为 current）', async () => {
    seedCases(['t1', 't2']);
    const byId = await statusById();
    expect(byId['requirement-import']).toBe('done');
    expect(byId['case-dev']).toBe('done');
    expect(byId['env-gen']).toBe('current');
  });

  it('冒烟测试完成 = 存在首条 pass 用例（此前 fail 不算）', async () => {
    seedCases(['t1']);
    await seedEnvGenSuccess();
    seedRun('t1', 'fail');
    let byId = await statusById();
    expect(byId['smoke']).toBe('current');

    seedRun('t1', 'pass');
    byId = await statusById();
    // t1 是唯一用例且已通过，功能验证也完成 → 覆盖率收敛成为 current
    expect(byId['smoke']).toBe('done');
    expect(byId['functional']).toBe('done');
    expect(byId['coverage']).toBe('current');
  });

  it('功能验证完成 = 全部用例最新终态均为 pass', async () => {
    seedCases(['t1', 't2']);
    await seedEnvGenSuccess();
    seedRun('t1', 'pass');
    seedRun('t2', 'pass');

    const nodes = computeMilestoneStatuses(await computeMilestones(db, projectRoot));
    const functional = nodes.find((n) => n.id === 'functional');
    expect(functional!.status).toBe('done');
    expect(functional!.hint).toContain('2/2');
  });

  it('功能验证未完成时提示真实调通进度', async () => {
    seedCases(['t1', 't2', 't3']);
    await seedEnvGenSuccess();
    seedRun('t1', 'pass');
    seedRun('t2', 'fail');

    const nodes = computeMilestoneStatuses(await computeMilestones(db, projectRoot));
    const functional = nodes.find((n) => n.id === 'functional');
    expect(functional!.status).toBe('current');
    expect(functional!.hint).toContain('1/3');
  });

  it('环境生成完成 = gen-history 存在 success 记录', async () => {
    seedCases(['t1']);
    let byId = await statusById();
    expect(byId['env-gen']).toBe('current');

    await seedEnvGenSuccess();
    byId = await statusById();
    expect(byId['env-gen']).toBe('done');
  });

  it('环境生成失败记录不算完成', async () => {
    seedCases(['t1']);
    await appendGenHistory(projectRoot, {
      genLevel: 'subsys',
      subsys: 'cpu',
      outputDir: '/proj/cpu/env',
      success: false,
      exitCode: 1,
      timestamp: new Date().toISOString(),
    });
    const nodes = computeMilestoneStatuses(await computeMilestones(db, projectRoot));
    const envGen = nodes.find((n) => n.id === 'env-gen');
    expect(envGen!.status).not.toBe('done');
    expect(envGen!.hint).toContain('尚无成功生成');
  });

  it('后仿验证完成 = 至少标记一条后仿用例', async () => {
    seedCases(['t1', 't2']);
    await seedEnvGenSuccess();
    seedRun('t1', 'pass');
    seedRun('t2', 'pass');
    setCasePostSim(db, 't1', 'cpu', true);

    const nodes = computeMilestoneStatuses(await computeMilestones(db, projectRoot));
    const postSim = nodes.find((n) => n.id === 'post-sim');
    expect(postSim!.status).toBe('done');
    expect(postSim!.hint).toContain('1 条后仿用例');
  });

  it('回归签核完成 = TO 清单全部 done', async () => {
    seedCases(['t1']);
    await seedEnvGenSuccess();
    seedRun('t1', 'pass');

    const socverifyDir = join(projectRoot, '.socverify');
    mkdirSync(socverifyDir, { recursive: true });
    writeFileSync(join(socverifyDir, 'to-checklist.json'), JSON.stringify([
      { id: 'a', status: 'done' },
      { id: 'b', status: 'done' },
    ], null, 2), 'utf-8');

    const nodes = computeMilestoneStatuses(await computeMilestones(db, projectRoot));
    const signoff = nodes.find((n) => n.id === 'signoff');
    expect(signoff!.status).toBe('done');
    expect(signoff!.hint).toContain('2/2');
  });
});

describe('computeMilestoneStatuses', () => {
  it('marks the leftmost non-done node as current, done nodes stay done', () => {
    const result = computeMilestoneStatuses([
      { id: 'requirement-import', label: '需求导入', done: true },
      { id: 'env-gen', label: '环境生成', done: false },
      { id: 'case-dev', label: '用例开发', done: true },
    ]);
    expect(result.map((n) => n.status)).toEqual(['done', 'current', 'done']);
  });

  it('done nodes are independent of earlier incomplete nodes', () => {
    const result = computeMilestoneStatuses([
      { id: 'requirement-import', label: '需求导入', done: true },
      { id: 'env-gen', label: '环境生成', done: false },
      { id: 'case-dev', label: '用例开发', done: true },
      { id: 'smoke', label: '冒烟测试', done: true },
      { id: 'functional', label: '功能验证', done: false },
    ]);
    expect(result.map((n) => n.status)).toEqual(['done', 'current', 'done', 'done', 'pending']);
  });
});
