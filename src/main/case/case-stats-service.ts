/**
 * CaseStatsService — 用例聚合统计共享服务（UI tRPC 与 AI HostTools 的单一 source of truth）。
 *
 * 解决问题：
 * - AI 问「某 sys 有多少用例 / 多少 pass / 有哪些种类」时，原 list_cases 一次吐完整 JSON
 *   让 AI 自己数（token 浪费），且 status 硬编码 'pending' 答不了 pass/fail。
 * - UI tRPC 与 AI HostTools 各自 new PluginBackedDiscovery，caseCount 一个有值一个永远是 0。
 *
 * 设计（基于 grilling 8 决策）：
 * - 「功能」/「种类」= filePath 分组（一个文件 = 一个功能 = 一类）
 * - 摘要优先 + 按需下钻（getCaseStats 返回聚合，listCasesWithStatus 下钻）
 * - status 实时 join SimulationManager 历史（最近一次 run 的状态，未跑过 = pending）
 * - 扁平汇总（不返回嵌套树，token 友好）
 */

import type { CaseInfo, CaseStatus, SubsysDiscovery, SubsysInfo } from '../host/discovery';
import type { SimulationManager } from '../simulation/simulation-manager';
import type { SimulationStatus } from '@shared/types';

// ─── 公共类型 ───────────────────────────────────────────────

/** 按状态的用例计数细分。 */
export type CaseStatusBreakdown = {
  pass: number;
  fail: number;
  running: number;
  pending: number;
  error: number;
  aborted: number;
};

/** 根用例摘要（无 baseCase 的用例，及其子用例数）。 */
export type RootCaseSummary = {
  /** 根用例名。 */
  name: string;
  /** 继承自该根用例的子用例数（baseCase === name）。 */
  childCount: number;
};

/** 按 filePath 分组的用例摘要（一个文件 = 一个「功能」/「种类」）。 */
export type FileGroupSummary = {
  /** 分组文件路径（优先 filePath，回退 case.path）。 */
  filePath: string;
  /** 文件名（用于展示）。 */
  fileName: string;
  /** 该文件下的用例总数。 */
  caseCount: number;
  /** 该文件下的根用例及其子用例数。 */
  rootCases: RootCaseSummary[];
};

/** 单个子系统的用例统计摘要。 */
export type CaseStats = {
  /** 子系统名。 */
  subsys: string;
  /** 用例总数。 */
  total: number;
  /** 按状态细分。 */
  byStatus: CaseStatusBreakdown;
  /** 按 filePath 分组的摘要（每个文件 = 一个「功能」/「种类」）。 */
  byFile: FileGroupSummary[];
};

/** 单个子系统的概览（用于项目级聚合）。 */
export type SubsysOverview = {
  /** 子系统名。 */
  name: string;
  /** 用例总数。 */
  caseCount: number;
  /** 按状态细分。 */
  byStatus: CaseStatusBreakdown;
};

/** 项目级用例概览。 */
export type ProjectOverview = {
  /** 子系统总数。 */
  subsysCount: number;
  /** 用例总数。 */
  totalCases: number;
  /** 各子系统概览。 */
  bySubsys: SubsysOverview[];
};

// ─── 内部工具 ───────────────────────────────────────────────

const EMPTY_BREAKDOWN: CaseStatusBreakdown = {
  pass: 0,
  fail: 0,
  running: 0,
  pending: 0,
  error: 0,
  aborted: 0,
};

const TERMINAL_STATUSES: ReadonlySet<SimulationStatus> = new Set([
  'pass',
  'fail',
  'error',
  'aborted',
]);

function emptyBreakdown(): CaseStatusBreakdown {
  return { ...EMPTY_BREAKDOWN };
}

function bumpBreakdown(b: CaseStatusBreakdown, status: CaseStatus | SimulationStatus | undefined): void {
  // CaseStatus 是 'pass'|'fail'|'running'|'pending'|'all'；
  // SimulationStatus 多出 'error'|'aborted'。两者前 4 个完全一致，可直接合并。
  switch (status) {
    case 'pass':
      b.pass += 1;
      break;
    case 'fail':
      b.fail += 1;
      break;
    case 'running':
      b.running += 1;
      break;
    case 'error':
      b.error += 1;
      break;
    case 'aborted':
      b.aborted += 1;
      break;
    case 'all':
    case undefined:
    default:
      // 'pending' / 'all' / 未知状态都归入 pending
      b.pending += 1;
      break;
  }
}

/** 对用例列表按状态计数，返回 breakdown。 */
function tallyStatuses(cases: CaseInfo[]): CaseStatusBreakdown {
  const breakdown = emptyBreakdown();
  for (const c of cases) {
    bumpBreakdown(breakdown, c.status);
  }
  return breakdown;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] ?? p;
}

// ─── CaseStatsService ──────────────────────────────────────

export type CaseStatsServiceOptions = {
  /** 子系统/用例发现接口（通常为 PluginBackedDiscovery）。 */
  discovery: SubsysDiscovery;
  /** 仿真管理器（用于 status 实时 join，可选；为 null 时 status 一律 pending）。 */
  simulationManager?: SimulationManager | null;
};

/**
 * 用例聚合统计服务。
 *
 * UI tRPC（project.getOverview / getCases / getSubsystems）与 AI HostTools
 *（get_case_stats / get_project_overview / list_cases）共用此服务，
 * 消除双轨数据不一致。
 */
export class CaseStatsService {
  private readonly discovery: SubsysDiscovery;
  private simulationManager: SimulationManager | null;

  constructor(opts: CaseStatsServiceOptions) {
    this.discovery = opts.discovery;
    this.simulationManager = opts.simulationManager ?? null;
  }

  /** 注入仿真管理器（SimulationManager 可能在 service 创建后才被创建）。 */
  setSimulationManager(mgr: SimulationManager | null): void {
    this.simulationManager = mgr;
  }

  // ─── 列表（带实时 status） ─────────────────────────────

  /**
   * 列出指定子系统的用例，status 实时 join 自 SimulationManager 历史（最近一次 run）。
   * 未跑过的用例 status = 'pending'。
   *
   * 这是 list_cases 工具与 project.getCases tRPC 的共享实现。
   */
  async listCasesWithStatus(subsys?: string): Promise<CaseInfo[]> {
    if (!subsys) return [];
    const cases = await this.discovery.listCases(subsys);
    if (cases.length === 0) return [];

    const statusByCaseName = this.buildLatestStatusMap(subsys);
    return cases.map((c) => ({
      ...c,
      status: statusByCaseName.get(c.name) ?? ('pending' as CaseStatus),
    }));
  }

  /**
   * 列出子系统，并填充真实的 caseCount（原 PluginBackedDiscovery 永远返回 0）。
   */
  async listSubsysWithCaseCount(filter?: string): Promise<SubsysInfo[]> {
    const subsys = await this.discovery.listSubsys(filter);
    // 并行计算每个 subsys 的用例数（discovery 内部有缓存，开销可控）
    const withCounts = await Promise.all(
      subsys.map(async (s) => {
        const cases = await this.discovery.listCases(s.name);
        return { ...s, caseCount: cases.length };
      }),
    );
    return withCounts;
  }

  // ─── 聚合统计 ─────────────────────────────────────────

  /**
   * 获取单个子系统的用例统计摘要（摘要优先策略）。
   *
   * 返回扁平汇总：总数 / 按状态 / 按 filePath 分组（每个文件 = 一个「功能」）。
   * AI 想看具体用例时再调 list_cases 下钻。
   */
  async getCaseStats(subsys?: string): Promise<CaseStats | null> {
    if (!subsys) return null;
    const cases = await this.listCasesWithStatus(subsys);
    if (cases.length === 0) {
      return {
        subsys,
        total: 0,
        byStatus: emptyBreakdown(),
        byFile: [],
      };
    }

    const byStatus = tallyStatuses(cases);

    const byFile = this.groupByFile(cases);
    return { subsys, total: cases.length, byStatus, byFile };
  }

  /**
   * 获取项目级用例概览（一次性返回所有子系统的聚合，避免 N+1 工具调用）。
   */
  async getProjectOverview(): Promise<ProjectOverview> {
    const subsys = await this.discovery.listSubsys();
    if (subsys.length === 0) {
      return { subsysCount: 0, totalCases: 0, bySubsys: [] };
    }

    const bySubsys: SubsysOverview[] = [];
    let totalCases = 0;

    for (const s of subsys) {
      const cases = await this.listCasesWithStatus(s.name);
      bySubsys.push({
        name: s.name,
        caseCount: cases.length,
        byStatus: tallyStatuses(cases),
      });
      totalCases += cases.length;
    }

    return { subsysCount: subsys.length, totalCases, bySubsys };
  }

  // ─── 内部方法 ─────────────────────────────────────────

  /**
   * 为指定子系统构建「用例名 → 最近一次 run 状态」映射。
   *
   * SimulationManager.history 按 startTime 倒序（unshift），因此第一次遇到的
   * caseName 即为最近一次 run 的状态。仅取终态（pass/fail/error/aborted）；
   * running 状态由 activeRuns 提供，pending 表示未跑过。
   */
  private buildLatestStatusMap(subsys: string): Map<string, CaseStatus> {
    const map = new Map<string, CaseStatus>();
    if (!this.simulationManager) return map;

    // 1. 先从 history 取终态（倒序，第一次遇到 = 最新）
    const history = this.simulationManager.getHistory();
    for (const entry of history) {
      if (entry.subsys !== subsys) continue;
      if (!TERMINAL_STATUSES.has(entry.status)) continue;
      if (map.has(entry.caseName)) continue;
      map.set(entry.caseName, entry.status as CaseStatus);
    }

    // 2. 再从 activeRuns 取 running 状态（覆盖 history，因为正在跑的比历史新）
    for (const run of this.simulationManager.getActiveRuns()) {
      if (run.options.subsys !== subsys) continue;
      const runStatus = run.status.status;
      if (runStatus !== 'running') continue;
      const caseName = run.options.caseName ?? run.options.caseId;
      if (!caseName) continue;
      map.set(caseName, 'running');
    }

    return map;
  }

  /**
   * 按 filePath 分组用例，构建扁平汇总。
   *
   * 每个文件组内：
   * - rootCases = 无 baseCase 的用例
   * - 每个 rootCase 的 childCount = baseCase 指向它的子用例数
   */
  private groupByFile(cases: CaseInfo[]): FileGroupSummary[] {
    const groups = new Map<string, CaseInfo[]>();
    for (const c of cases) {
      const fp = c.filePath ?? c.path;
      if (!groups.has(fp)) groups.set(fp, []);
      groups.get(fp)!.push(c);
    }

    const result: FileGroupSummary[] = [];
    for (const [filePath, fileCases] of groups) {
      // 统计 baseCase 出现次数（子用例 → 根用例）
      const childCountByRoot = new Map<string, number>();
      for (const c of fileCases) {
        if (c.baseCase) {
          childCountByRoot.set(c.baseCase, (childCountByRoot.get(c.baseCase) ?? 0) + 1);
        }
      }

      // rootCases = 无 baseCase 的用例
      const rootCases: RootCaseSummary[] = [];
      for (const c of fileCases) {
        if (!c.baseCase) {
          rootCases.push({
            name: c.name,
            childCount: childCountByRoot.get(c.name) ?? 0,
          });
        }
      }

      result.push({
        filePath,
        fileName: basename(filePath),
        caseCount: fileCases.length,
        rootCases,
      });
    }

    // 按用例数降序排，便于 AI/人类快速定位主文件
    result.sort((a, b) => b.caseCount - a.caseCount);
    return result;
  }
}
