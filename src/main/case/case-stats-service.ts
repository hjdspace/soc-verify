/**
 * CaseStatsService — 用例聚合统计共享服务（UI tRPC 与 AI HostTools 的单一 source of truth）。
 *
 * ADR 0017 Issue #4: 全面从 DB 读取，移除 PluginBackedDiscovery 依赖。
 * - status 从 simulation_runs 表查询最近一次终态（pass/fail/error/aborted）
 * - running 状态从 SimulationManager.getActiveRuns() 覆盖
 * - pending 表示未跑过（DB 中无终态记录）
 * - 概览不再缓存 TTL（DB 查询足够快）
 * - getCaseToSubsysMap 从 cases 表直接查询
 */

import type { CaseInfo, CaseStatus, SubsysInfo } from '../host/discovery';
import type { SimulationManager } from '../simulation/simulation-manager';
import type { SimulationStatus } from '@shared/types';
import type { CaseRow } from './db/case-repository';
import type { CaseDatabase } from './db/case-database';

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
  /** 用例数据库实例（ADR 0017 — 必需，所有读取走 DB）。 */
  db: CaseDatabase;
  /** 仿真管理器（用于 running 状态覆盖，可选；为 null 时无 running 状态）。 */
  simulationManager?: SimulationManager | null;
};

/**
 * 用例聚合统计服务（ADR 0017 Issue #4 — 全量从 DB 读取）。
 *
 * UI tRPC（project.getOverview / getCases / getSubsystems）与 AI HostTools
 *（get_case_stats / get_project_overview / list_cases）共用此服务。
 *
 * 数据源：cases.db（subsystems + cases + simulation_runs 表）。
 * status 从 simulation_runs 表查最近一次终态；running 从 SimulationManager.activeRuns 覆盖。
 */
export class CaseStatsService {
  private readonly db: CaseDatabase;
  private simulationManager: SimulationManager | null;

  constructor(opts: CaseStatsServiceOptions) {
    this.db = opts.db;
    this.simulationManager = opts.simulationManager ?? null;
  }

  /** 注入仿真管理器（SimulationManager 可能在 service 创建后才被创建）。 */
  setSimulationManager(mgr: SimulationManager | null): void {
    this.simulationManager = mgr;
  }

  /** No-op（ADR 0017 — DB 是 source of truth，无 discovery 缓存可清除）。
   * 保留方法签名以兼容调用方（project-router.refreshCases / violation-router.autoFillSubsys）。 */
  clearDiscoveryCache(_subsys?: string): void {
    // No-op — DB is the single source of truth, no cache to clear.
    // The scanner handles updating the DB; callers just read fresh data.
  }

  // ─── 列表（带实时 status） ─────────────────────────────

  /**
   * 列出指定子系统的用例，status 从 simulation_runs 表 join（最近一次终态）。
   * running 状态从 SimulationManager.activeRuns 覆盖。
   * 未跑过的用例 status = 'pending'。
   *
   * 这是 list_cases 工具与 project.getCases tRPC 的共享实现。
   */
  async listCasesWithStatus(subsys?: string): Promise<CaseInfo[]> {
    if (!subsys) return [];

    const { getCases, getLatestStatusBySubsys } = await import('./db/case-repository');
    const rows = getCases(this.db, subsys);
    if (rows.length === 0) return [];

    // 从 simulation_runs 表取最近一次终态状态
    const statusByCaseName = getLatestStatusBySubsys(this.db, subsys);

    // 从 activeRuns 取 running 状态（覆盖 DB 终态）
    this.overlayRunningStatus(subsys, statusByCaseName);

    return rows.map((r) => {
      const raw = statusByCaseName.get(r.name);
      return caseRowToInfo(r, raw as CaseStatus | undefined);
    });
  }

  /**
   * 搜索用例（LIKE 子串匹配，从 DB 查询）。
   * 万级数据 < 5ms。
   */
  async searchCases(
    query: string,
    subsys?: string,
    limit = 200,
  ): Promise<CaseInfo[]> {
    const { searchCases } = await import('./db/case-repository');
    const rows = searchCases(this.db, query, subsys, limit);
    return rows.map((r) => caseRowToInfo(r, undefined));
  }

  /**
   * 列出子系统，并填充真实的 caseCount（从 DB 读取，秒开）。
   */
  async listSubsysWithCaseCount(filter?: string): Promise<SubsysInfo[]> {
    const { getSubsysWithCaseCount } = await import('./db/case-repository');
    const rows = getSubsysWithCaseCount(this.db, filter);
    return rows.map((r) => ({
      name: r.name,
      path: r.path ?? '',
      caseCount: r.caseCount,
      description: r.description ?? undefined,
    }));
  }

  // ─── Case → Subsys 映射 ─────────────────────────────

  /**
   * 构建用例名 → 子系统名的映射表（从 cases 表查询）。
   *
   * 用于时序违例分布图：当 vio_summary.log 解析出的 subsys 为空时，
   * 可用用例名反查子系统。
   */
  async getCaseToSubsysMap(): Promise<Map<string, string>> {
    const { getCaseNameToSubsysMap } = await import('./db/case-repository');
    return getCaseNameToSubsysMap(this.db);
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
   *
   * ADR 0017 Issue #4：从 DB 聚合查询，无 TTL 缓存（DB 查询足够快）。
   * 全局状态映射通过 getAllLatestStatuses 一次查询获取。
   */
  async getProjectOverview(): Promise<ProjectOverview> {
    const { getSubsysWithCaseCount, getAllLatestStatuses, getCases } = await import('./db/case-repository');

    const subsysRows = getSubsysWithCaseCount(this.db);
    if (subsysRows.length === 0) {
      return { subsysCount: 0, totalCases: 0, bySubsys: [] };
    }

    // 一次查询获取全局终态状态映射
    const globalStatusMap = getAllLatestStatuses(this.db);

    // 构建 running 覆盖映射（subsys → Set<caseName>）
    const runningBySubsys = this.buildRunningMap();

    // 并行处理所有子系统（虽然都是同步 DB 查询，但保持 Promise.all 模式）
    const results: SubsysOverview[] = subsysRows.map((s) => {
      const cases = getCases(this.db, s.name);
      const subsysStatusMap = globalStatusMap.get(s.name) ?? new Map<string, string>();
      const runningSet = runningBySubsys.get(s.name) ?? new Set<string>();

      const breakdown = emptyBreakdown();
      for (const c of cases) {
        const terminalStatus = subsysStatusMap.get(c.name);
        if (runningSet.has(c.name)) {
          bumpBreakdown(breakdown, 'running');
        } else if (terminalStatus) {
          bumpBreakdown(breakdown, terminalStatus as SimulationStatus);
        } else {
          bumpBreakdown(breakdown, 'pending');
        }
      }

      return {
        name: s.name,
        caseCount: s.caseCount,
        byStatus: breakdown,
      } satisfies SubsysOverview;
    });

    const totalCases = results.reduce((sum, r) => sum + r.caseCount, 0);
    return {
      subsysCount: subsysRows.length,
      totalCases,
      bySubsys: results,
    };
  }

  // ─── 内部方法 ─────────────────────────────────────────

  /**
   * 将 running 状态从 activeRuns 覆盖到 statusMap 中。
   * running 优先级最高：正在跑的 case 状态为 running，覆盖 DB 中的终态。
   */
  private overlayRunningStatus(subsys: string, statusMap: Map<string, string>): void {
    if (!this.simulationManager) return;
    for (const run of this.simulationManager.getActiveRuns()) {
      if (run.options.subsys !== subsys) continue;
      const runStatus = run.status.status;
      if (runStatus !== 'running') continue;
      const caseName = run.options.caseName ?? run.options.caseId;
      if (!caseName) continue;
      statusMap.set(caseName, 'running');
    }
  }

  /**
   * 构建 subsys → Set<caseName> 的 running 映射（用于 getProjectOverview）。
   */
  private buildRunningMap(): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    if (!this.simulationManager) return map;
    for (const run of this.simulationManager.getActiveRuns()) {
      const runStatus = run.status.status;
      if (runStatus !== 'running') continue;
      const caseName = run.options.caseName ?? run.options.caseId;
      if (!caseName) continue;
      const subsysName = run.options.subsys;
      let set = map.get(subsysName);
      if (!set) {
        set = new Set();
        map.set(subsysName, set);
      }
      set.add(caseName);
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

// ─── CaseRow → CaseInfo 转换 ───────────────────────────────

/**
 * 将 DB CaseRow 转换为 CaseInfo，附加 status。
 *
 * status 为 undefined 时默认 'pending'。
 */
function caseRowToInfo(
  row: CaseRow,
  status?: CaseStatus | undefined,
): CaseInfo {
  return {
    name: row.name,
    subsys: row.subsys,
    path: row.path,
    status: status ?? ('pending' as CaseStatus),
    filePath: row.filePath,
    baseCase: row.baseCase,
    base: row.base,
    block: row.block,
    phase: row.phase,
  };
}
