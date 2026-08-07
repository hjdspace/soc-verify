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
import type { CaseRow } from './db/case-repository';

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
  /** 用例数据库实例（可选）。提供时 listSubsysWithCaseCount 从 DB 读取，秒开。 */
  db?: import('./db/case-database').CaseDatabase | null;
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
  private readonly db: import('./db/case-database').CaseDatabase | null;
  /** 概览缓存（TTL 5s，避免频繁切换概览页时重复全量计算）。 */
  private overviewCache: { data: ProjectOverview; timestamp: number } | null = null;
  private static readonly OVERVIEW_CACHE_TTL_MS = 5_000;

  constructor(opts: CaseStatsServiceOptions) {
    this.discovery = opts.discovery;
    this.simulationManager = opts.simulationManager ?? null;
    this.db = opts.db ?? null;
  }

  /** 注入仿真管理器（SimulationManager 可能在 service 创建后才被创建）。
   * 同时清除概览缓存，因为仿真状态变化会影响概览数据。 */
  setSimulationManager(mgr: SimulationManager | null): void {
    this.simulationManager = mgr;
    this.overviewCache = null;
  }

  /** 清除 discovery 内部缓存（case_cfg 修改后刷新用）。
   * 传入 subsys 时仅清除该子系统的用例缓存；不传时清除全部缓存。
   * 同时清除概览缓存，确保下次 getProjectOverview 返回最新数据。 */
  clearDiscoveryCache(subsys?: string): void {
    this.discovery.clearCache?.(subsys);
    this.overviewCache = null;
  }

  // ─── 列表（带实时 status） ─────────────────────────────

  /**
   * 列出指定子系统的用例，status 实时 join 自 SimulationManager 历史（最近一次 run）。
   * 未跑过的用例 status = 'pending'。
   *
   * 当 DB 可用时，从 DB 读取 cases（ADR 0017），status 仍从 SimulationManager
   * 内存 join（混合模式，transitional）。
   * 当 DB 不可用时，回退到插件 discovery（原行为）。
   *
   * 这是 list_cases 工具与 project.getCases tRPC 的共享实现。
   */
  async listCasesWithStatus(subsys?: string): Promise<CaseInfo[]> {
    if (!subsys) return [];

    // DB 路径：从 cases 表读取（ADR 0017）
    if (this.db) {
      const { getCases } = await import('./db/case-repository');
      const rows = getCases(this.db, subsys);
      if (rows.length === 0) return [];

      const statusByCaseName = this.buildLatestStatusMap(subsys);
      return rows.map((r) => caseRowToInfo(r, statusByCaseName.get(r.name)));
    }

    // 回退路径：插件 discovery（原行为）
    const cases = await this.discovery.listCases(subsys);
    if (cases.length === 0) return [];

    const statusByCaseName = this.buildLatestStatusMap(subsys);
    return cases.map((c) => ({
      ...c,
      status: statusByCaseName.get(c.name) ?? ('pending' as CaseStatus),
    }));
  }

  /**
   * 搜索用例（LIKE 子串匹配，从 DB 查询）。
   *
   * 当 DB 可用时，使用 SQL LIKE 查询替代内存倒排索引（ADR 0017）。
   * 万级数据 < 5ms。
   * 当 DB 不可用时，返回空数组。
   */
  async searchCases(
    query: string,
    subsys?: string,
    limit = 200,
  ): Promise<CaseInfo[]> {
    if (!this.db) return [];
    const { searchCases } = await import('./db/case-repository');
    const rows = searchCases(this.db, query, subsys, limit);
    return rows.map((r) => caseRowToInfo(r, undefined));
  }

  /**
   * 列出子系统，并填充真实的 caseCount。
   *
   * 当 DB 可用时，从 DB 读取（秒开，后台扫描后自动更新）。
   * 当 DB 不可用时，回退到插件 discovery（原行为）。
   */
  async listSubsysWithCaseCount(filter?: string): Promise<SubsysInfo[]> {
    // DB 路径：从 cases.db 读取（ADR 0017）
    if (this.db) {
      const { getSubsysWithCaseCount } = await import('./db/case-repository');
      const rows = getSubsysWithCaseCount(this.db, filter);
      return rows.map((r) => ({
        name: r.name,
        path: r.path ?? '',
        caseCount: r.caseCount,
        description: r.description ?? undefined,
      }));
    }

    // 回退路径：插件 discovery（原行为）
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

  // ─── Case → Subsys 映射 ─────────────────────────────

  /**
   * 构建用例名 → 子系统名的映射表。
   *
   * 遍历所有子系统下的用例，生成 caseName → subsys 映射。
   * 用于时序违例分布图：当 vio_summary.log 解析出的 subsys 为空时，
   * 可用用例名反查子系统。
   */
  async getCaseToSubsysMap(): Promise<Map<string, string>> {
    const subsys = await this.discovery.listSubsys();
    const map = new Map<string, string>();
    for (const s of subsys) {
      const cases = await this.discovery.listCases(s.name);
      for (const c of cases) {
        map.set(c.name, s.name);
      }
    }
    return map;
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
   * 优化：
   * - 5 秒 TTL 缓存，避免频繁切换概览页时重复全量计算
   * - 并行处理所有子系统（Promise.all），而非串行 for 循环
   * - 全局状态映射只构建一次（buildGlobalStatusMap），而非每个子系统遍历全部历史
   */
  async getProjectOverview(): Promise<ProjectOverview> {
    // 检查缓存
    if (this.overviewCache) {
      const elapsed = Date.now() - this.overviewCache.timestamp;
      if (elapsed < CaseStatsService.OVERVIEW_CACHE_TTL_MS) {
        return this.overviewCache.data;
      }
      this.overviewCache = null;
    }

    const subsys = await this.discovery.listSubsys();
    if (subsys.length === 0) {
      const empty = { subsysCount: 0, totalCases: 0, bySubsys: [] };
      this.overviewCache = { data: empty, timestamp: Date.now() };
      return empty;
    }

    // 全局状态映射只构建一次（O(N) total），而非每个子系统遍历全部历史（O(N×M)）
    const globalStatusMap = this.buildGlobalStatusMap();

    // 并行处理所有子系统
    const results = await Promise.all(
      subsys.map(async (s) => {
        const cases = await this.discovery.listCases(s.name);
        const statusMap = globalStatusMap.get(s.name) ?? new Map<string, CaseStatus>();
        const casesWithStatus = cases.map((c) => ({
          ...c,
          status: statusMap.get(c.name) ?? ('pending' as CaseStatus),
        }));
        return {
          name: s.name,
          caseCount: cases.length,
          byStatus: tallyStatuses(casesWithStatus),
        } satisfies SubsysOverview;
      }),
    );

    const totalCases = results.reduce((sum, r) => sum + r.caseCount, 0);
    const overview: ProjectOverview = {
      subsysCount: subsys.length,
      totalCases,
      bySubsys: results,
    };
    this.overviewCache = { data: overview, timestamp: Date.now() };
    return overview;
  }

  // ─── 内部方法 ─────────────────────────────────────────

  /**
   * 构建全局「subsys → caseName → 最近一次状态」映射（O(N) 一次遍历）。
   *
   * 替代 buildLatestStatusMap 的逐子系统遍历方案（O(N×M)）。
   * 用于 getProjectOverview 并行处理时，每个子系统 O(1) 查找。
   */
  private buildGlobalStatusMap(): Map<string, Map<string, CaseStatus>> {
    const globalMap = new Map<string, Map<string, CaseStatus>>();
    if (!this.simulationManager) return globalMap;

    // 1. history 取终态（倒序，第一次遇到 = 最新）
    const history = this.simulationManager.getHistory();
    for (const entry of history) {
      if (!TERMINAL_STATUSES.has(entry.status)) continue;
      let subsysMap = globalMap.get(entry.subsys);
      if (!subsysMap) {
        subsysMap = new Map();
        globalMap.set(entry.subsys, subsysMap);
      }
      if (!subsysMap.has(entry.caseName)) {
        subsysMap.set(entry.caseName, entry.status as CaseStatus);
      }
    }

    // 2. activeRuns 取 running 状态（覆盖 history）
    for (const run of this.simulationManager.getActiveRuns()) {
      const subsysName = run.options.subsys;
      const runStatus = run.status.status;
      if (runStatus !== 'running') continue;
      const caseName = run.options.caseName ?? run.options.caseId;
      if (!caseName) continue;
      let subsysMap = globalMap.get(subsysName);
      if (!subsysMap) {
        subsysMap = new Map();
        globalMap.set(subsysName, subsysMap);
      }
      subsysMap.set(caseName, 'running');
    }

    return globalMap;
  }

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
  };
}
