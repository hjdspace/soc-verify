/**
 * CaseIndexManager — 用例索引单例管理器
 *
 * 核心问题：当前 searchCases 每次调用都 new PluginBackedDiscovery()，
 * 导致 caseCache 丢失，每次搜索都重新解析所有用例配置文件。
 * 万级用例下，每次搜索耗时 2-5 秒。
 *
 * 解决方案：单例管理器在首次搜索时加载所有用例并构建倒排索引，
 * 后续搜索直接查内存索引，耗时 < 10ms。
 *
 * 缓存失效：通过 invalidate(projectId) 手动触发（由文件监听器调用）。
 */

import type { CaseInfo, SubsysInfo } from '../host/discovery';
import type { PluginRegistry } from '@shared/plugin-types';
import { PluginBackedDiscovery } from '../plugin-adapters/discovery';
import { InvertedIndex } from './inverted-index';

// ─── Types ──────────────────────────────────────────────────

type ScoredCase = CaseInfo & { _score: number };

interface ProjectIndex {
  /** 扁平用例数组 */
  cases: CaseInfo[];
  /** 子系统名列表 */
  subsysNames: string[];
  /** subsys name → 用例索引数组 */
  subsysToCases: Map<string, number[]>;
  /** 倒排索引 */
  invertedIndex: InvertedIndex;
  /** 构建时间戳 */
  builtAt: number;
  /** 构建耗时（ms） */
  buildMs: number;
  /** 构建中的 Promise（防止并发重建） */
  building?: Promise<void>;
}

export interface IndexStats {
  caseCount: number;
  subsysCount: number;
  tokenCount: number;
  builtAt: number;
  buildMs: number;
}

// ─── CaseIndexManager ──────────────────────────────────────

class CaseIndexManagerImpl {
  private indexes = new Map<string, ProjectIndex>();

  /**
   * 确保索引已构建。如果正在构建则等待现有构建完成。
   *
   * 首次调用会触发全量加载（并行），后续调用直接返回。
   */
  async ensureIndex(
    projectId: string,
    rootPath: string,
    registry: PluginRegistry,
  ): Promise<void> {
    const existing = this.indexes.get(projectId);
    if (existing && !existing.building) return;
    if (existing?.building) {
      await existing.building;
      return;
    }

    // Start building
    const building = this.buildIndex(projectId, rootPath, registry);
    // Store the promise so concurrent callers can await it
    const placeholder: ProjectIndex = {
      cases: [],
      subsysNames: [],
      subsysToCases: new Map(),
      invertedIndex: new InvertedIndex(),
      builtAt: 0,
      buildMs: 0,
      building,
    };
    this.indexes.set(projectId, placeholder);

    await building;
  }

  /**
   * 构建索引：并行加载所有子系统用例，构建倒排索引。
   */
  private async buildIndex(
    projectId: string,
    rootPath: string,
    registry: PluginRegistry,
  ): Promise<void> {
    const startTime = Date.now();
    console.log(`[case-index-manager] Building index for project ${projectId}...`);

    const discovery = new PluginBackedDiscovery(rootPath, registry);

    // 1. 获取所有子系统
    const subsystems: SubsysInfo[] = await discovery.listSubsys();
    const subsysNames = subsystems.map((s) => s.name);

    // 2. 并行加载所有子系统的用例
    const casesPerSubsys = await Promise.all(
      subsystems.map(async (s) => ({
        subsys: s.name,
        cases: await discovery.listCases(s.name),
      })),
    );

    // 3. 构建扁平数组 + 倒排索引
    const allCases: CaseInfo[] = [];
    const subsysToCases = new Map<string, number[]>();
    const invertedIndex = new InvertedIndex();

    for (const { subsys, cases } of casesPerSubsys) {
      const indices: number[] = [];
      for (const c of cases) {
        const idx = allCases.length;
        allCases.push(c);
        indices.push(idx);

        // 索引关键字段（权重通过 fuzzyScore 体现，索引只负责召回）
        invertedIndex.add(idx, c.name);
        invertedIndex.add(idx, c.filePath ?? '');
        invertedIndex.add(idx, c.baseCase ?? '');
        invertedIndex.add(idx, subsys);
        // 路径中的目录名也作为 token（如 "case_cfg" → "case", "cfg"）
        invertedIndex.add(idx, c.path);
      }
      subsysToCases.set(subsys, indices);
    }

    const buildMs = Date.now() - startTime;
    console.log(
      `[case-index-manager] Index built: ${allCases.length} cases, ` +
        `${subsysNames.length} subsystems, ${invertedIndex.tokenCount} tokens, ${buildMs}ms`,
    );

    const index: ProjectIndex = {
      cases: allCases,
      subsysNames,
      subsysToCases,
      invertedIndex,
      builtAt: Date.now(),
      buildMs,
    };
    this.indexes.set(projectId, index);
  }

  /**
   * 搜索用例。
   *
   * 流程：
   * 1. 倒排索引召回候选集（< 5ms）
   * 2. 如果候选为空，尝试子串兜底召回
   * 3. subsys 范围过滤
   * 4. fuzzyScore 精排（仅对候选集，而非全量）
   * 5. 取 Top N
   */
  search(
    projectId: string,
    query: string,
    subsys?: string,
    limit = 200,
  ): CaseInfo[] {
    const index = this.indexes.get(projectId);
    if (!index || index.cases.length === 0) return [];

    const q = query.toLowerCase().trim();
    if (!q) return [];

    // 1. 倒排索引召回
    let candidates = index.invertedIndex.search(q);

    // 2. 子串兜底召回（当倒排索引未命中时）
    if (candidates.size === 0) {
      candidates = index.invertedIndex.substringSearch(q);
    }

    // 3. subsys 范围过滤
    if (subsys) {
      const subsysIndices = index.subsysToCases.get(subsys);
      if (!subsysIndices) return [];
      const subsysSet = new Set(subsysIndices);
      candidates = new Set([...candidates].filter((i) => subsysSet.has(i)));
    }

    // 4. fuzzyScore 精排
    const scored: ScoredCase[] = [];
    for (const idx of candidates) {
      const c = index.cases[idx];
      if (!c) continue;
      const score = this.computeScore(q, c);
      if (score > 0) {
        scored.push({ ...c, _score: score });
      }
    }

    // 5. 排序 + 截断
    scored.sort((a, b) => b._score - a._score);
    return scored.slice(0, limit).map(({ _score: _unused, ...rest }) => rest);
  }

  /**
   * 计算用例的综合匹配分数。
   *
   * 对 5 个字段分别做 fuzzyScore，取最高加权分数。
   */
  private computeScore(query: string, c: CaseInfo): number {
    const haystacks = [
      { text: c.name, weight: 10 },
      { text: c.subsys, weight: 5 },
      { text: c.filePath ?? '', weight: 3 },
      { text: c.path, weight: 2 },
      { text: c.baseCase ?? '', weight: 1 },
    ];

    let bestScore = -1;
    for (const { text, weight } of haystacks) {
      if (!text) continue;
      const score = fuzzyScore(query, text.toLowerCase());
      if (score > 0 && score * weight > bestScore) {
        bestScore = score * weight;
      }
    }
    return bestScore;
  }

  /** 获取索引统计信息 */
  getStats(projectId: string): IndexStats | null {
    const index = this.indexes.get(projectId);
    if (!index || index.builtAt === 0) return null;
    return {
      caseCount: index.cases.length,
      subsysCount: index.subsysNames.length,
      tokenCount: index.invertedIndex.tokenCount,
      builtAt: index.builtAt,
      buildMs: index.buildMs,
    };
  }

  /** 获取所有子系统名（用于前端范围选择） */
  getSubsysNames(projectId: string): string[] {
    const index = this.indexes.get(projectId);
    if (!index) return [];
    return index.subsysNames;
  }

  /** 失效指定项目的索引（下次搜索时重建） */
  invalidate(projectId: string): void {
    const existing = this.indexes.get(projectId);
    if (existing && !existing.building) {
      this.indexes.delete(projectId);
      console.log(`[case-index-manager] Invalidated index for project ${projectId}`);
    }
  }

  /** 失效所有项目的索引 */
  invalidateAll(): void {
    for (const [id, index] of this.indexes) {
      if (!index.building) this.indexes.delete(id);
    }
  }

  /** 检查索引是否已构建 */
  isReady(projectId: string): boolean {
    const index = this.indexes.get(projectId);
    return !!index && !index.building && index.builtAt > 0;
  }
}

// ─── Singleton export ──────────────────────────────────────

export const caseIndexManager = new CaseIndexManagerImpl();

// ─── Fuzzy match scoring ──────────────────────────────────

/**
 * Fuzzy match scoring: returns a positive score if `query` matches `target`,
 * 0 if no match. Higher scores indicate better matches.
 *
 * Matching strategy (best of):
 * 1. **Substring match** — query appears as a contiguous substring.
 *    Score = 100 + bonus for prefix/word-boundary match.
 * 2. **Subsequence match** — all query characters appear in order.
 *    Score = 50 - (gaps between matched characters), rewarding compact matches.
 */
export function fuzzyScore(query: string, target: string): number {
  if (!query || !target) return 0;
  if (query.length > target.length) return 0;

  // 1. Substring match
  const substrIdx = target.indexOf(query);
  if (substrIdx !== -1) {
    let score = 100;
    // Prefix match bonus
    if (substrIdx === 0) score += 50;
    // Word boundary bonus (preceded by separator)
    if (substrIdx > 0 && /[\s_\-./\\]/.test(target[substrIdx - 1]!)) score += 20;
    // Exact match bonus
    if (query.length === target.length) score += 30;
    return score;
  }

  // 2. Subsequence (fuzzy) match
  let qi = 0;
  let prevMatchIdx = -1;
  let totalGap = 0;
  let firstMatchIdx = -1;

  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      if (firstMatchIdx === -1) firstMatchIdx = ti;
      if (prevMatchIdx !== -1) {
        totalGap += ti - prevMatchIdx - 1;
      }
      prevMatchIdx = ti;
      qi++;
    }
  }

  if (qi < query.length) return 0; // Not all query chars matched

  let score = 50 - totalGap;
  // First match at start of target bonus
  if (firstMatchIdx === 0) score += 10;
  // Compact match bonus (low gap ratio)
  const matchLength = query.length;
  const span = prevMatchIdx - firstMatchIdx + 1;
  if (span === matchLength) score += 10; // Contiguous subsequence

  return Math.max(score, 1);
}
