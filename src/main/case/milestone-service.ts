/**
 * Milestone Service — 总览视图里程碑条的真实数据计算。
 *
 * 替代 DashboardView 的 DEFAULT_MILESTONES 静态配置（Issue #3 的临时方案）。
 * 每个节点的完成条件：
 *
 * 1. 需求导入   — 验证需求以「子系统 + 用例」形态由 Case Scanner 扫描导入
 *                （SubsysDiscoveryPlugin 发现子系统、CaseParserPlugin 解析
 *                case_cfg，写入 .socverify/cases.db）。
 *                完成 = 子系统数 > 0 且用例数 > 0。
 * 2. 环境生成   — 用户在「验证环境生成器」向导（sysbase-env-gen）中成功执行过
 *                sysbase_gen.py（历史记录 .socverify/sysbase-gen/gen-history.json
 *                中存在 success 记录）。完成 = 至少一次成功生成。
 * 3. 用例开发   — 用例数据库中已有用例（caseCount > 0）。
 * 4. 冒烟测试   — 用户成功调通第一条用例：simulation_runs 中存在任一 pass 记录。
 * 5. 功能验证   — 按用例最新终态统计：已调通用例数 / 总用例数。
 *                完成 = 全部用例最新终态均为 pass。
 * 6. 覆盖率收敛 — 功能覆盖率 ≥ 90%（覆盖率数据由渲染端从 coverage store 注入，
 *                服务端无法低成本获取，本节点 done 恒为 false，由渲染端覆盖）。
 * 7. 后仿验证   — 用户已在用例库中标记出需要跑后仿的用例（post_sim = 1）。
 *                节点附带两个动作：后仿用例调试（用例库筛选后仿标记）、
 *                时序用例分析（打开时序违例页面）。
 * 8. 回归签核   — TO 检查清单（.socverify/to-checklist.json）全部条目完成。
 *
 * status 推导（线性里程碑）见 @shared/types/milestone 的 computeMilestoneStatuses，
 * 由渲染端在覆盖 coverage 节点后统一计算。
 */

import type Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MilestoneNode } from '@shared/types/milestone';
import {
  getDashboardSummary,
  getRegressionProgress,
  getFirstPassRun,
  getPostSimCases,
} from './db/case-repository';
import { loadGenHistory } from '../tools/sysbase-gen/gen-history';

/**
 * 计算 8 个节点的内在完成态（done）与提示文案。
 * 返回按流程顺序排列的节点；status 由渲染端统一推导。
 *
 * @param db          Case Database（.socverify/cases.db）
 * @param projectRoot 项目根路径（读取 sysbase-gen 历史 / TO 清单）
 */
export async function computeMilestones(
  db: Database.Database,
  projectRoot: string,
): Promise<MilestoneNode[]> {
  // ─── 用例库统计（需求导入 / 用例开发） ───
  const summary = getDashboardSummary(db);
  const { subsysCount, caseCount } = summary;

  // ─── 环境生成历史 ───
  const genHistory = await loadGenHistory(projectRoot);
  const genSuccessCount = genHistory.filter((e) => e.success).length;

  // ─── 冒烟测试：首条 pass 用例 ───
  const firstPass = getFirstPassRun(db);

  // ─── 功能验证：按用例最新终态的调通进度 ───
  const progress = getRegressionProgress(db);

  // ─── 后仿验证：已标记的后仿用例 ───
  const postSimCases = getPostSimCases(db);

  // ─── 回归签核：TO 检查清单 ───
  const signoff = await readToChecklistProgress(projectRoot);

  return [
    {
      id: 'requirement-import',
      label: '需求导入',
      done: subsysCount > 0 && caseCount > 0,
      hint: subsysCount > 0 || caseCount > 0 ? `${subsysCount} 子系统 · ${caseCount} 用例` : '待扫描导入',
    },
    {
      id: 'env-gen',
      label: '环境生成',
      done: genSuccessCount > 0,
      hint: genSuccessCount > 0
        ? `已成功生成 ${genSuccessCount} 次`
        : genHistory.length > 0
          ? '尚无成功生成'
          : '待生成',
    },
    {
      id: 'case-dev',
      label: '用例开发',
      done: caseCount > 0,
      hint: caseCount > 0 ? `${caseCount} 条用例` : '无用例',
    },
    {
      id: 'smoke',
      label: '冒烟测试',
      done: firstPass !== null,
      hint: firstPass ? `首通 ${firstPass.caseName}` : '待首条用例调通',
    },
    {
      id: 'functional',
      label: '功能验证',
      done: progress.totalCases > 0 && progress.passedCases === progress.totalCases,
      hint: progress.totalCases > 0
        ? `已调通 ${progress.passedCases}/${progress.totalCases} · ${progress.passRate}%`
        : '待验证',
    },
    {
      id: 'coverage',
      label: '覆盖率收敛',
      // 覆盖率数据在渲染端注入（coverage store 已加载的 overview），服务端恒为未完成
      done: false,
      hint: '目标 ≥ 90%',
    },
    {
      id: 'post-sim',
      label: '后仿验证',
      done: postSimCases.length > 0,
      hint: postSimCases.length > 0 ? `已标记 ${postSimCases.length} 条后仿用例` : '待挑选后仿用例',
    },
    {
      id: 'signoff',
      label: '回归签核',
      done: signoff.total > 0 && signoff.doneCount === signoff.total,
      hint: signoff.total > 0 ? `TO 清单 ${signoff.doneCount}/${signoff.total}` : 'TO 清单未开始',
    },
  ];
}

/** 读取 TO 检查清单完成进度（文件缺失/损坏时视为未开始） */
async function readToChecklistProgress(
  projectRoot: string,
): Promise<{ total: number; doneCount: number }> {
  const checklistPath = join(projectRoot, '.socverify', 'to-checklist.json');
  if (!existsSync(checklistPath)) return { total: 0, doneCount: 0 };

  try {
    const content = await readFile(checklistPath, 'utf-8');
    const items = JSON.parse(content) as Array<{ status?: string }>;
    if (!Array.isArray(items)) return { total: 0, doneCount: 0 };
    const doneCount = items.filter((item) => item.status === 'done').length;
    return { total: items.length, doneCount };
  } catch {
    return { total: 0, doneCount: 0 };
  }
}
