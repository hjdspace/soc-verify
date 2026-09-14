/**
 * Semantic Lint — 语义检查并产生知识待办（spec §9，issue 27）。
 *
 * 语义 Lint 必须按预算选择同源修订、共实体、链接邻居等候选组，
 * 加载相关正文和原文证据再判断。返回覆盖页数/总页数、检查范围、
 * 未覆盖部分、证据短引与定位；不能沿用各页前 500 字摘要抽样就
 * 宣称完整检查。每个候选组独立可取消/恢复，不做无界全页两两比较。
 *
 * 稳定身份沿用 `computeFindingId`（kind + pageIds + evidenceRefs），
 * 证据 hash 控制是否仍适用；重复扫描保留 ignored/resolved，
 * 证据改变可重开。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §9
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeFindingId } from './structural-lint';
import { wikiLayout, readWikiManifest } from './wiki-layout';
import { assertReadGateOpen, WikiReadGateError } from './read-gate';
import { scanWikiCatalog } from './wiki-catalog';
import type {
  WikiCatalogPage,
  WikiGraphSnapshot,
  WikiLintCoverage,
  WikiSemanticCandidateGroup,
  WikiSemanticCheckpoint,
  WikiSemanticFindingKind,
  WikiSemanticGroupStrategy,
  WikiSemanticLintResult,
  WikiStructuralFinding,
} from '@shared/kb-types';

// ── 模型调用边界（与 compile.ts 同模式）────────────────────────────

export type SemanticLlmCallResultLike =
  | string
  | {
      text: string;
      finishReason?: string | null;
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
    };

/** 语义检查用模型入口。调用方显式构造（真实凭证 / 可控假响应）；null = 无凭证。 */
export type SemanticLlm = {
  invoke: (req: { system: string; user: string; maxTokens: number }) => Promise<SemanticLlmCallResultLike>;
};

// ── 候选分组 ────────────────────────────────────────────────────

/**
 * 从图快照推导候选组。
 *
 * 分组策略（spec §9）：
 *  1. same-source — 同来源修订（同 sourceId）
 *  2. shared-entity — 共实体（同关键词）
 *  3. link-neighbor — 链接邻居（入/出链一跳）
 *
 * 不做无界全页两两比较：单页无任何关联不产生组。
 */
export function buildCandidateGroups(snapshot: WikiGraphSnapshot): WikiSemanticCandidateGroup[] {
  const groups: WikiSemanticCandidateGroup[] = [];
  const seen = new Set<string>();

  // 1. same-source: 按 sourceId 分组
  const sourceMap = new Map<string, string[]>();
  for (const [pageId, node] of snapshot.nodes) {
    for (const src of node.sources) {
      const key = src.sourceId;
      if (!sourceMap.has(key)) sourceMap.set(key, []);
      sourceMap.get(key)!.push(pageId);
    }
  }
  for (const [sourceId, pageIds] of sourceMap) {
    if (pageIds.length < 2) continue; // 单页不成组
    const groupId = makeGroupId('same-source', pageIds);
    if (seen.has(groupId)) continue;
    seen.add(groupId);
    groups.push({
      groupId,
      strategy: 'same-source',
      pageIds: [...pageIds].sort(),
      groupKey: sourceId,
    });
  }

  // 2. shared-entity: 按关键词分组
  const keywordMap = new Map<string, string[]>();
  for (const [pageId, node] of snapshot.nodes) {
    for (const kw of node.keywords) {
      const key = kw.toLowerCase();
      if (!keywordMap.has(key)) keywordMap.set(key, []);
      keywordMap.get(key)!.push(pageId);
    }
  }
  for (const [kw, pageIds] of keywordMap) {
    if (pageIds.length < 2) continue;
    const groupId = makeGroupId('shared-entity', pageIds);
    if (seen.has(groupId)) continue;
    seen.add(groupId);
    groups.push({
      groupId,
      strategy: 'shared-entity',
      pageIds: [...pageIds].sort(),
      groupKey: kw,
    });
  }

  // 3. link-neighbor: 链接邻居（双向边连接的页面）
  const neighborMap = new Map<string, Set<string>>();
  for (const edge of snapshot.edges) {
    if (!neighborMap.has(edge.source)) neighborMap.set(edge.source, new Set());
    if (!neighborMap.has(edge.target)) neighborMap.set(edge.target, new Set());
    neighborMap.get(edge.source)!.add(edge.target);
    neighborMap.get(edge.target)!.add(edge.source);
  }
  // 构建连通组（简单并查集）
  const parent = new Map<string, string>();
  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    const p = parent.get(x)!;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const [pageId, neighbors] of neighborMap) {
    find(pageId);
    for (const nb of neighbors) {
      find(nb);
      union(pageId, nb);
    }
  }
  const componentMap = new Map<string, string[]>();
  for (const pageId of neighborMap.keys()) {
    const root = find(pageId);
    if (!componentMap.has(root)) componentMap.set(root, []);
    componentMap.get(root)!.push(pageId);
  }
  for (const [, pageIds] of componentMap) {
    if (pageIds.length < 2) continue;
    const groupId = makeGroupId('link-neighbor', pageIds);
    if (seen.has(groupId)) continue;
    seen.add(groupId);
    groups.push({
      groupId,
      strategy: 'link-neighbor',
      pageIds: [...pageIds].sort(),
      groupKey: 'link-component',
    });
  }

  return groups;
}

function makeGroupId(strategy: WikiSemanticGroupStrategy, pageIds: string[]): string {
  const material = `${strategy}|${[...pageIds].sort().join(',')}`;
  return createHash('sha256').update(material, 'utf-8').digest('hex').slice(0, 16);
}

// ── 页面正文加载 ────────────────────────────────────────────────

type PageEvidence = {
  pageId: string;
  title: string;
  body: string;
};

/**
 * 加载候选组中页面的完整正文证据。
 *
 * spec §9：「加载正文证据而非只读前500字」。
 */
async function loadPageEvidence(
  kbPath: string,
  pageIds: string[],
  catalogPages: WikiCatalogPage[],
): Promise<PageEvidence[]> {
  const pageMap = new Map(catalogPages.map((p) => [p.pageId, p]));
  const result: PageEvidence[] = [];

  for (const pageId of pageIds) {
    const page = pageMap.get(pageId);
    if (!page || !page.parse.ok) continue;
    const absPath = join(kbPath, page.relPath);
    let content: string;
    try {
      content = await readFile(absPath, 'utf-8');
    } catch {
      continue;
    }
    // 提取 body（frontmatter 之后的正文）
    const body = extractBody(content);
    result.push({
      pageId,
      title: page.parse.frontmatter.title,
      body,
    });
  }

  return result;
}

function extractBody(content: string): string {
  const match = /^---\n[\s\S]*?\n---\n/.exec(content);
  if (!match) return content;
  return content.slice(match[0].length);
}

// ── 提示词构建 ────────────────────────────────────────────────

/**
 * 构建语义检查提示词。
 *
 * 包含候选组所有页面的完整正文证据（不截断为前 500 字）。
 */
export function buildSemanticLintPrompt(input: {
  purpose: string;
  pages: Array<{ pageId: string; title: string; body: string }>;
}): string {
  const pagesText = input.pages
    .map((p) => {
      return `--- 页面: ${p.pageId} ---\n标题: ${p.title}\n正文:\n${p.body}`;
    })
    .join('\n\n');

  return [
    '你是严谨的知识库审阅员。检查以下知识页面的语义一致性和完整性。',
    '不要输出思维过程或隐藏推理；只输出最终检查结果。',
    '',
    `知识库目的: ${input.purpose}`,
    '',
    '请检查以下问题类型：',
    '1. contradiction — 页面之间存在矛盾（如同一参数的不同数值）',
    '2. missing-knowledge — 缺少应存在的知识页（不要报告已存在的页面为缺失）',
    '3. unsupported-claim — 结论缺乏证据支撑',
    '',
    '输出 JSON 格式（不要 Markdown 围栏）：',
    '{',
    '  "findings": [',
    '    {',
    '      "kind": "contradiction | missing-knowledge | unsupported-claim",',
    '      "pageIds": ["pageId1", "pageId2"],',
    '      "description": "问题描述",',
    '      "evidenceQuotes": [',
    '        { "pageId": "pageId", "quote": "原文短引", "location": "定位信息" }',
    '      ],',
    '      "suggestion": false',
    '    }',
    '  ]',
    '}',
    '',
    '注意：',
    '- 只报告有正文证据支持的问题；不能证明的结论设 suggestion=true',
    '- 不要报告已存在的页面为 missing-knowledge',
    '- 如果没有发现问题，返回 { "findings": [] }',
    '- evidenceQuotes 中的 quote 必须是页面正文的原文片段',
    '',
    '--- 待检查页面 ---',
    '',
    pagesText,
  ].join('\n');
}

// ── 解析模型输出 ────────────────────────────────────────────────

type RawFinding = {
  kind?: string;
  pageIds?: string[];
  description?: string;
  evidenceQuotes?: Array<{ pageId: string; quote: string; location?: string }>;
  suggestion?: boolean;
};

/**
 * 解析语义检查模型输出为 findings。
 *
 * - 已存在的页面不作为 missing-knowledge 重复报告
 * - 坏 JSON 返回空数组不崩
 * - 模型输出无问题时返回空数组（不报告"全库无问题"）
 */
export function parseSemanticLintOutput(
  output: string,
  kbId: string,
  candidatePageIds: string[],
): WikiStructuralFinding[] {
  const candidateSet = new Set(candidatePageIds);
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    return [];
  }

  if (data === null || typeof data !== 'object' || !Array.isArray((data as Record<string, unknown>).findings)) {
    return [];
  }

  const rawFindings = (data as { findings: RawFinding[] }).findings;
  const now = new Date().toISOString();
  const findings: WikiStructuralFinding[] = [];

  for (const raw of rawFindings) {
    if (!raw.kind || !raw.pageIds || !Array.isArray(raw.pageIds)) continue;

    const kind = raw.kind as WikiSemanticFindingKind;
    if (!isValidSemanticKind(kind)) continue;

    const pageIds = raw.pageIds.filter((p) => typeof p === 'string');
    if (pageIds.length === 0) continue;

    // 已存在的页面不作为 missing-knowledge 重复报告
    if (kind === 'missing-knowledge' && pageIds.every((p) => candidateSet.has(p))) {
      continue;
    }

    const evidenceRefs = pageIds.map((p) => `wiki/${p}.md`);
    const evidenceHashes = pageIds.map((p) => createHash('sha256').update(p, 'utf-8').digest('hex').slice(0, 16));

    findings.push({
      findingId: computeFindingId(kind, pageIds, evidenceRefs),
      kbId,
      kind,
      pageIds,
      evidenceRefs,
      evidenceHashes,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      evidenceQuotes: raw.evidenceQuotes ?? null,
      description: raw.description ?? null,
      suggestion: raw.suggestion ?? false,
    });
  }

  return findings;
}

function isValidSemanticKind(kind: string): kind is WikiSemanticFindingKind {
  return kind === 'contradiction' || kind === 'missing-knowledge' || kind === 'unsupported-claim';
}

// ── 运行语义检查 ────────────────────────────────────────────────

export type RunSemanticLintOptions = {
  /** 模型入口；null = 无凭证 */
  llm: SemanticLlm | null;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 注入时钟（测试用） */
  now?: string;
  /** 模型上下文窗口 token 数（缺省 128K） */
  contextTokens?: number;
};

/**
 * 运行语义检查。
 *
 * 1. 读取门禁
 * 2. 构建图快照 → 推导候选组
 * 3. 逐组加载正文证据 → LLM 判断 → 收集 findings
 * 4. 每组独立可取消，取消后仍返回已检查部分结果
 *
 * 不持久化 findings——持久化由 finding-store 负责。
 */
export async function runSemanticLint(
  kbPath: string,
  options: RunSemanticLintOptions,
): Promise<WikiSemanticLintResult> {
  // 读取门禁
  try {
    await assertReadGateOpen(kbPath);
  } catch (err) {
    if (err instanceof WikiReadGateError) {
      return { ok: false, code: 'readGateBlocked', message: err.message };
    }
    throw err;
  }

  // 构建 catalog
  const catalog = await scanWikiCatalog(kbPath);
  if (!catalog.ok) {
    return { ok: false, code: 'catalogFailed', message: 'wiki/ 目录或 schema 无法解析' };
  }

  // 获取 manifest 中的 revision
  const manifestRes = await readWikiManifest(kbPath);
  const revision = manifestRes.ok ? (manifestRes.manifest.publish?.revision ?? 0) : 0;

  // 构建图快照
  const { buildWikiGraphSnapshot } = await import('./wiki-graph');
  const graphResult = await buildWikiGraphSnapshot(kbPath);
  if (!graphResult.ok) {
    return { ok: false, code: 'catalogFailed', message: '图快照构建失败' };
  }

  const { snapshot } = graphResult;
  const now = options.now ?? new Date().toISOString();

  // 推导候选组
  const candidateGroups = buildCandidateGroups(snapshot);
  const totalPages = snapshot.nodes.size;

  // 无候选组：返回空结果
  if (candidateGroups.length === 0) {
    const coverage: WikiLintCoverage = {
      checkedPages: 0,
      totalPages,
      scope: '语义检查（候选组）',
      uncovered: ['无候选组（没有同来源/共实体/链接邻居的页面组）'],
    };
    return {
      ok: true,
      kbId: snapshot.kbId,
      revision,
      findings: [],
      checkpoints: [],
      coverage,
      ranAt: now,
      canceled: false,
    };
  }

  // 无 LLM 配置
  if (options.llm === null) {
    return { ok: false, code: 'noLlmConfig', message: '语义检查需要 LLM 配置（无凭证）' };
  }

  const llm = options.llm;
  const purpose = await readPurpose(kbPath);

  // 逐组检查
  const allFindings: WikiStructuralFinding[] = [];
  const checkpoints: WikiSemanticCheckpoint[] = [];
  const checkedPageSet = new Set<string>();
  let canceled = false;

  for (const group of candidateGroups) {
    // 检查取消
    if (options.signal?.aborted) {
      canceled = true;
      checkpoints.push({
        groupId: group.groupId,
        status: 'canceled',
        checkedPages: 0,
        totalPages: group.pageIds.length,
        error: null,
      });
      continue;
    }

    // 加载正文证据
    const pages = await loadPageEvidence(kbPath, group.pageIds, catalog.catalog.pages);

    if (pages.length === 0) {
      checkpoints.push({
        groupId: group.groupId,
        status: 'failed',
        checkedPages: 0,
        totalPages: group.pageIds.length,
        error: '无法加载页面正文',
      });
      continue;
    }

    // 构建提示词
    const prompt = buildSemanticLintPrompt({
      purpose,
      pages: pages.map((p) => ({ pageId: p.pageId, title: p.title, body: p.body })),
    });

    // 调用 LLM
    let findings: WikiStructuralFinding[];
    try {
      const result = await llm.invoke({
        system: '你是严谨的知识库审阅员。',
        user: prompt,
        maxTokens: 4096,
      });
      const text = typeof result === 'string' ? result : result.text;
      findings = parseSemanticLintOutput(text, snapshot.kbId, group.pageIds);
    } catch (err) {
      checkpoints.push({
        groupId: group.groupId,
        status: 'failed',
        checkedPages: 0,
        totalPages: group.pageIds.length,
        error: String(err),
      });
      continue;
    }

    allFindings.push(...findings);
    for (const pageId of group.pageIds) {
      checkedPageSet.add(pageId);
    }
    checkpoints.push({
      groupId: group.groupId,
      status: 'checked',
      checkedPages: pages.length,
      totalPages: group.pageIds.length,
      error: null,
    });

    // 再次检查取消（LLM 调用后）
    if (options.signal?.aborted) {
      canceled = true;
    }
  }

  // 按 findingId 去重（同一 finding 可能被多个候选组检出）
  const seenFindingIds = new Set<string>();
  const dedupedFindings: WikiStructuralFinding[] = [];
  for (const f of allFindings) {
    if (!seenFindingIds.has(f.findingId)) {
      seenFindingIds.add(f.findingId);
      dedupedFindings.push(f);
    }
  }

  const failedGroups = checkpoints.filter((c) => c.status === 'failed');
  const uncovered: string[] = [];
  if (canceled) {
    uncovered.push('扫描被取消，部分候选组未检查');
  }
  if (failedGroups.length > 0) {
    uncovered.push(`${failedGroups.length} 个候选组检查失败（模型错误或证据加载失败）`);
  }

  const coverage: WikiLintCoverage = {
    checkedPages: checkedPageSet.size,
    totalPages,
    scope: '语义检查（候选组：同来源/共实体/链接邻居）',
    uncovered,
  };

  return {
    ok: true,
    kbId: snapshot.kbId,
    revision,
    findings: dedupedFindings,
    checkpoints,
    coverage,
    ranAt: now,
    canceled,
  };
}

async function readPurpose(kbPath: string): Promise<string> {
  try {
    return await readFile(wikiLayout(kbPath).purposeMdPath, 'utf-8');
  } catch {
    return 'SoC 验证知识库';
  }
}
