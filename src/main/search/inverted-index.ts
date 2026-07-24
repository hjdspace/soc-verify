/**
 * Inverted Index — 轻排索引实现
 *
 * 将文本分词后建立 token → Set<caseIndex> 映射，
 * 搜索时通过 token 快速召回候选用例集，避免全量线性扫描。
 *
 * 用于 CaseIndexManager 加速万级用例的搜索。
 */

/** 分词正则：按空格、下划线、连字符、斜杠、点号、冒号拆分 */
const TOKEN_SPLIT_RE = /[\s_\-./\\:]+/;

/** 将文本分词为小写 token 数组 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(TOKEN_SPLIT_RE)
    .filter((t) => t.length > 0);
}

export class InvertedIndex {
  /** token → 用例索引集合 */
  private tokenToCases = new Map<string, Set<number>>();
  /** 按长度排序的 token 列表（用于前缀扫描），惰性构建 */
  private sortedTokens: string[] | null = null;

  /**
   * 向索引中添加一条用例的文本字段。
   *
   * @param caseIndex - 用例在扁平数组中的索引
   * @param text - 要索引的文本（用例名、文件路径、子系统名等）
   */
  add(caseIndex: number, text: string): void {
    const tokens = tokenize(text);
    for (const token of tokens) {
      let set = this.tokenToCases.get(token);
      if (!set) {
        set = new Set();
        this.tokenToCases.set(token, set);
      }
      set.add(caseIndex);
    }
    this.sortedTokens = null; // 标记需要重新排序
  }

  /**
   * 搜索：将 query 分词后，对每个 token 执行召回。
   *
   * 召回策略（取并集）：
   * 1. 精确匹配 — token 直接命中索引中的某个词
   * 2. 前缀匹配 — token 是某个索引词的前缀（如 "cgu" 匹配 "cgu_top"）
   *
   * @returns 候选用例索引集合（后续由 fuzzyScore 精排）
   */
  search(query: string): Set<number> {
    const tokens = tokenize(query);
    if (tokens.length === 0) return new Set();

    const result = new Set<number>();

    for (const token of tokens) {
      // 1. 精确匹配
      const exact = this.tokenToCases.get(token);
      if (exact) {
        for (const idx of exact) result.add(idx);
      }

      // 2. 前缀匹配 — 扫描所有以 token 开头的索引词
      //    对于万级用例，token 数量通常 < 5000，前缀扫描 < 1ms
      for (const [key, cases] of this.tokenToCases) {
        if (key.length > token.length && key.startsWith(token)) {
          for (const idx of cases) result.add(idx);
        }
      }
    }

    return result;
  }

  /**
   * 子串匹配召回 — 当 token 不在索引词的前缀中时，
   * 回退为子串扫描（如 "pu" 匹配 "apcpu"）。
   *
   * 仅在 search() 结果为空时由上层调用，作为兜底策略。
   */
  substringSearch(query: string): Set<number> {
    const tokens = tokenize(query);
    if (tokens.length === 0) return new Set();

    const result = new Set<number>();

    for (const token of tokens) {
      for (const [key, cases] of this.tokenToCases) {
        if (key.includes(token)) {
          for (const idx of cases) result.add(idx);
        }
      }
    }

    return result;
  }

  /** 索引中的 token 数量 */
  get tokenCount(): number {
    return this.tokenToCases.size;
  }

  /** 清空索引 */
  clear(): void {
    this.tokenToCases.clear();
    this.sortedTokens = null;
  }
}
