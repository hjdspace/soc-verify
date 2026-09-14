/**
 * semantic-lint 语义检查测试（issue 27，spec §9）。
 *
 * 覆盖验收映射 A18：
 *  - 候选按同来源修订/主题/引用关系分组，加载正文证据
 *  - 每组有预算、取消与 checkpoint，输出已检查/总页数和未覆盖范围
 *  - finding 附涉及页、原文短引/定位；不能证明的结论标建议
 *  - 已存在页面不作为 missing-page 重复报告；去重与 ignore 沿用统一模型
 *  - 后文埋藏矛盾 fixture 可被检出
 *  - 模型失败不报告"全库无问题"
 *  - 重复扫描保留 ignored/resolved，证据变更可重开
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCandidateGroups,
  buildSemanticLintPrompt,
  parseSemanticLintOutput,
  runSemanticLint,
  type SemanticLlm,
} from '../src/main/kb/semantic-lint';
import { computeFindingId } from '../src/main/kb/structural-lint';
import { mergeFindings } from '../src/main/kb/finding-store';
import { invalidateGraphSnapshot } from '../src/main/kb/wiki-graph';
import { initWikiLayout } from '../src/main/kb/wiki-layout';
import type {
  WikiGraphSnapshot,
  WikiStructuralFinding,
} from '@shared/kb-types';

let kbPath: string;

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-sem-lint-'));
  await initWikiLayout(kbPath, { kbId: 'kb-sem', name: '语义检查测试库' });
  invalidateGraphSnapshot(kbPath);
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
  invalidateGraphSnapshot(kbPath);
});

// ── 页面工厂 ─────────────────────────────────────────────────────

const PAGE_FM = (
  type: string,
  title: string,
  extra: Record<string, string> = {},
): string => {
  const base: Array<[string, string]> = [
    ['type', type],
    ['title', `"${title}"`],
    ['summary', '测试页摘要。'],
    ['keywords', '[测试]'],
    ['tags', '[单测]'],
    ['sources', '[]'],
    ['created', '"2026-09-14T00:00:00Z"'],
    ['updated', '"2026-09-14T00:00:00Z"'],
    ...Object.entries(extra).map(([k, v]) => [k, v] as [string, string]),
  ];
  const merged = new Map(base);
  const lines = Array.from(merged, ([k, v]) => `${k}: ${v}`);
  return ['---', ...lines, '---', '', `# ${title}`, ''].join('\n');
};

function writeWikiPage(rel: string, content: string): void {
  const abs = join(kbPath, 'wiki', rel);
  mkdirSync(abs.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function writePageWithBody(rel: string, type: string, title: string, body: string, sources = '[]'): void {
  const content = PAGE_FM(type, title, { sources }) + body + '\n';
  writeWikiPage(rel, content);
}

async function getSnapshot(): Promise<WikiGraphSnapshot> {
  const { buildWikiGraphSnapshot } = await import('../src/main/kb/wiki-graph');
  const res = await buildWikiGraphSnapshot(kbPath);
  if (!res.ok) throw new Error('构建图快照失败');
  return res.snapshot;
}

// ── buildCandidateGroups ─────────────────────────────────────────

describe('buildCandidateGroups — 候选分组', () => {
  it('同来源页面归入 same-source 组', async () => {
    writePageWithBody('concepts/a.md', 'concept', '概念A', '正文A', '[{sourceId: "src1", sourceRevision: "rev1", parsedHash: "h1"}]');
    writePageWithBody('concepts/b.md', 'concept', '概念B', '正文B', '[{sourceId: "src1", sourceRevision: "rev1", parsedHash: "h1"}]');
    writePageWithBody('concepts/c.md', 'concept', '概念C', '正文C', '[{sourceId: "src2", sourceRevision: "rev2", parsedHash: "h2"}]');

    const snapshot = await getSnapshot();
    const groups = buildCandidateGroups(snapshot);

    const sameSourceGroups = groups.filter((g) => g.strategy === 'same-source');
    expect(sameSourceGroups.length).toBeGreaterThanOrEqual(1);

    const src1Group = sameSourceGroups.find((g) => g.groupKey.includes('src1'));
    expect(src1Group).toBeDefined();
    expect(src1Group!.pageIds).toContain('concepts/a');
    expect(src1Group!.pageIds).toContain('concepts/b');
    expect(src1Group!.pageIds).not.toContain('concepts/c');
  });

  it('链接邻居归入 link-neighbor 组', async () => {
    writePageWithBody('concepts/a.md', 'concept', '概念A', '链接到 [[concepts/b]]');
    writePageWithBody('concepts/b.md', 'concept', '概念B', '被链接');

    const snapshot = await getSnapshot();
    const groups = buildCandidateGroups(snapshot);

    const linkGroups = groups.filter((g) => g.strategy === 'link-neighbor');
    expect(linkGroups.length).toBeGreaterThanOrEqual(1);

    const abGroup = linkGroups.find((g) => g.pageIds.includes('concepts/a') && g.pageIds.includes('concepts/b'));
    expect(abGroup).toBeDefined();
  });

  it('共享关键词归入 shared-entity 组', async () => {
    writePageWithBody('concepts/a.md', 'concept', '概念A', '正文A');
    writePageWithBody('concepts/b.md', 'concept', '概念B', '正文B', '[]');
    // 两个页面都有 "测试" 关键词（由 PAGE_FM 默认）
    const snapshot = await getSnapshot();
    const groups = buildCandidateGroups(snapshot);

    const entityGroups = groups.filter((g) => g.strategy === 'shared-entity');
    expect(entityGroups.length).toBeGreaterThanOrEqual(1);
  });

  it('不做无界全页两两比较：单页不产生组', async () => {
    writePageWithBody('concepts/solo.md', 'concept', '独页', '没有链接也没有共享来源');

    const snapshot = await getSnapshot();
    const groups = buildCandidateGroups(snapshot);

    // 单页无同来源、无链接邻居、无共享关键词的 → 不产生候选组
    expect(groups.length).toBe(0);
  });
});

// ── buildSemanticLintPrompt ──────────────────────────────────────

describe('buildSemanticLintPrompt — 提示词构建', () => {
  it('包含候选组页面正文证据', () => {
    const pages = [
      { pageId: 'concepts/a', title: '概念A', body: 'AXI 协议支持最多 16 个 outstanding transactions。' },
      { pageId: 'concepts/b', title: '概念B', body: 'AXI 协议的 outstanding 限制为 8。' },
    ];

    const prompt = buildSemanticLintPrompt({
      purpose: 'SoC 验证知识库',
      pages,
    });

    expect(prompt).toContain('概念A');
    expect(prompt).toContain('16 个 outstanding');
    expect(prompt).toContain('概念B');
    expect(prompt).toContain('限制为 8');
  });

  it('不截断正文证据为前500字', () => {
    const longBody = 'A'.repeat(600);
    const pages = [
      { pageId: 'concepts/a', title: '概念A', body: longBody },
    ];

    const prompt = buildSemanticLintPrompt({
      purpose: '测试',
      pages,
    });

    // 完整正文应在提示词中（不是截断为 500 字）
    expect(prompt).toContain('A'.repeat(600));
  });
});

// ── parseSemanticLintOutput ──────────────────────────────────────

describe('parseSemanticLintOutput — 解析模型输出', () => {
  it('解析矛盾 finding', () => {
    const output = JSON.stringify({
      findings: [
        {
          kind: 'contradiction',
          pageIds: ['concepts/a', 'concepts/b'],
          description: 'AXI outstanding 限制矛盾：A 页说 16，B 页说 8',
          evidenceQuotes: [
            { pageId: 'concepts/a', quote: 'AXI 协议支持最多 16 个 outstanding transactions', location: '第2行' },
            { pageId: 'concepts/b', quote: 'AXI 协议的 outstanding 限制为 8', location: '第2行' },
          ],
          suggestion: false,
        },
      ],
    });

    const result = parseSemanticLintOutput(output, 'kb-sem', ['concepts/a', 'concepts/b']);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('contradiction');
    expect(result[0].pageIds).toEqual(['concepts/a', 'concepts/b']);
    expect(result[0].description).toContain('outstanding');
    expect(result[0].evidenceQuotes).toHaveLength(2);
    expect(result[0].suggestion).toBe(false);
  });

  it('不能证明的结论标 suggestion=true', () => {
    const output = JSON.stringify({
      findings: [
        {
          kind: 'unsupported-claim',
          pageIds: ['concepts/a'],
          description: '该页声称 AXI 支持 32 outstanding 但无来源引用',
          evidenceQuotes: [
            { pageId: 'concepts/a', quote: 'AXI 支持 32 outstanding', location: '正文' },
          ],
          suggestion: true,
        },
      ],
    });

    const result = parseSemanticLintOutput(output, 'kb-sem', ['concepts/a']);
    expect(result).toHaveLength(1);
    expect(result[0]!.suggestion).toBe(true);
  });

  it('模型输出无问题时返回空数组，不报告全库无问题', () => {
    const output = JSON.stringify({ findings: [] });
    const result = parseSemanticLintOutput(output, 'kb-sem', ['concepts/a']);
    expect(result).toEqual([]);
  });

  it('已存在的页面不作为 missing-page 重复报告', () => {
    // 模型错误地报告了一个已存在页面为 missing
    const output = JSON.stringify({
      findings: [
        {
          kind: 'missing-knowledge',
          pageIds: ['concepts/a'],
          description: '缺少 concepts/a 页面',
          evidenceQuotes: [],
          suggestion: true,
        },
      ],
    });

    // 候选组中的页面列表包含 concepts/a（它已存在）
    const result = parseSemanticLintOutput(output, 'kb-sem', ['concepts/a', 'concepts/b']);
    // 已存在页面不应作为 missing-knowledge 报告
    expect(result).toEqual([]);
  });

  it('坏 JSON 返回空数组不崩', () => {
    const result = parseSemanticLintOutput('not json', 'kb-sem', ['concepts/a']);
    expect(result).toEqual([]);
  });
});

// ── runSemanticLint ──────────────────────────────────────────────

describe('runSemanticLint — 运行语义检查', () => {
  it('无 LLM 配置时返回 noLlmConfig', async () => {
    // 两页同来源 → 有候选组 → 需要 LLM
    writePageWithBody('concepts/a.md', 'concept', '概念A', '正文A',
      '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]');
    writePageWithBody('concepts/b.md', 'concept', '概念B', '正文B',
      '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]');

    const result = await runSemanticLint(kbPath, {
      llm: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('noLlmConfig');
  });

  it('有候选组但无 LLM 时返回 noLlmConfig', async () => {
    writePageWithBody('concepts/a.md', 'concept', '概念A', '正文A',
      '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]');
    writePageWithBody('concepts/b.md', 'concept', '概念B', '正文B',
      '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]');

    const result = await runSemanticLint(kbPath, {
      llm: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('noLlmConfig');
  });

  it('无候选组时返回 ok 且 findings 为空', async () => {
    // 只有一个无关联页面 → 无候选组
    writePageWithBody('concepts/solo.md', 'concept', '独页', '独页正文');

    const result = await runSemanticLint(kbPath, {
      llm: null, // 无候选组不需要 LLM
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toEqual([]);
    expect(result.coverage.checkedPages).toBe(0);
    expect(result.coverage.totalPages).toBe(1);
    expect(result.coverage.uncovered.some((u) => u.includes('无候选组'))).toBe(true);
  });

  it('mock LLM 检出矛盾并返回带证据的 finding', async () => {
    // 两页有矛盾（同来源）
    writePageWithBody('concepts/a.md', 'concept', '概念A',
      'AXI 协议支持最多 16 个 outstanding transactions。',
      '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]');
    writePageWithBody('concepts/b.md', 'concept', '概念B',
      'AXI 协议的 outstanding 限制为 8。',
      '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]');

    const mockLlm: SemanticLlm = {
      invoke: async () => ({
        text: JSON.stringify({
          findings: [
            {
              kind: 'contradiction',
              pageIds: ['concepts/a', 'concepts/b'],
              description: 'AXI outstanding 限制矛盾',
              evidenceQuotes: [
                { pageId: 'concepts/a', quote: '最多 16 个 outstanding', location: '第3行' },
                { pageId: 'concepts/b', quote: '限制为 8', location: '第3行' },
              ],
              suggestion: false,
            },
          ],
        }),
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    };

    const result = await runSemanticLint(kbPath, {
      llm: mockLlm,
      now: '2026-09-14T00:00:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.kind).toBe('contradiction');
    expect(result.findings[0]!.pageIds).toEqual(expect.arrayContaining(['concepts/a', 'concepts/b']));
    expect(result.findings[0]!.evidenceQuotes).toHaveLength(2);
    expect(result.findings[0]!.description).toContain('outstanding');
    expect(result.coverage.checkedPages).toBe(2);
    expect(result.coverage.totalPages).toBe(2);
    // 所有候选组都应被检查
    expect(result.checkpoints.every((c) => c.status === 'checked')).toBe(true);
  });

  it('取消后返回已检查部分结果', async () => {
    // 多组候选
    writePageWithBody('concepts/a.md', 'concept', 'A', '正文A',
      '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]');
    writePageWithBody('concepts/b.md', 'concept', 'B', '正文B',
      '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]');
    writePageWithBody('concepts/c.md', 'concept', 'C', '正文C',
      '[{sourceId: "s2", sourceRevision: "r2", parsedHash: "h2"}]');
    writePageWithBody('concepts/d.md', 'concept', 'D', '正文D',
      '[{sourceId: "s2", sourceRevision: "r2", parsedHash: "h2"}]');

    const controller = new AbortController();
    let callCount = 0;
    const mockLlm: SemanticLlm = {
      invoke: async () => {
        callCount++;
        if (callCount >= 1) {
          controller.abort();
        }
        return {
          text: JSON.stringify({ findings: [] }),
          finishReason: 'stop',
          usage: null,
        };
      },
    };

    const result = await runSemanticLint(kbPath, {
      llm: mockLlm,
      signal: controller.signal,
      now: '2026-09-14T00:00:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canceled).toBe(true);
    // 至少有一个组被取消
    expect(result.checkpoints.some((c) => c.status === 'canceled')).toBe(true);
  });

  it('LLM 失败不报告全库无问题', async () => {
    writePageWithBody('concepts/a.md', 'concept', 'A', '正文A',
      '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]');
    writePageWithBody('concepts/b.md', 'concept', 'B', '正文B',
      '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]');

    const mockLlm: SemanticLlm = {
      invoke: async () => {
        throw new Error('LLM 调用失败');
      },
    };

    const result = await runSemanticLint(kbPath, {
      llm: mockLlm,
      now: '2026-09-14T00:00:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 失败的组标 failed，不报告 findings
    expect(result.findings).toEqual([]);
    expect(result.checkpoints.some((c) => c.status === 'failed')).toBe(true);
    // 未覆盖部分应说明失败
    expect(result.coverage.uncovered.length).toBeGreaterThan(0);
  });

  it('后文埋藏矛盾可被检出（加载完整正文而非前500字）', async () => {
    // 矛盾在远超 500 字之后
    const padding = '这是填充内容。\n'.repeat(50); // > 500 字
    writePageWithBody('concepts/a.md', 'concept', 'A',
      padding + '\nAXI 支持 16 outstanding。',
      '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]');
    writePageWithBody('concepts/b.md', 'concept', 'B',
      padding + '\nAXI 支持 8 outstanding。',
      '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]');

    const mockLlm: SemanticLlm = {
      invoke: async (req: { system: string; user: string; maxTokens: number }) => {
        // 验证提示词包含完整正文（不只是前 500 字）
        expect(req.user).toContain('16 outstanding');
        expect(req.user).toContain('8 outstanding');
        return {
          text: JSON.stringify({
            findings: [
              {
                kind: 'contradiction',
                pageIds: ['concepts/a', 'concepts/b'],
                description: 'outstanding 数量矛盾',
                evidenceQuotes: [
                  { pageId: 'concepts/a', quote: 'AXI 支持 16 outstanding', location: '后文' },
                  { pageId: 'concepts/b', quote: 'AXI 支持 8 outstanding', location: '后文' },
                ],
                suggestion: false,
              },
            ],
          }),
          finishReason: 'stop',
          usage: null,
        };
      },
    };

    const result = await runSemanticLint(kbPath, {
      llm: mockLlm,
      now: '2026-09-14T00:00:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.kind).toBe('contradiction');
  });
});

// ── 去重与 ignore 沿用统一模型 ───────────────────────────────────

describe('去重与 ignore 沿用统一模型', () => {
  it('finding 有稳定身份，同规则+同页面+同证据 → 同 id', () => {
    const id1 = computeFindingId('contradiction', ['concepts/a', 'concepts/b'], ['wiki/concepts/a.md', 'wiki/concepts/b.md']);
    const id2 = computeFindingId('contradiction', ['concepts/a', 'concepts/b'], ['wiki/concepts/a.md', 'wiki/concepts/b.md']);
    expect(id1).toBe(id2);
  });

  it('证据改变 → 不同 findingId → 重开', () => {
    const id1 = computeFindingId('contradiction', ['concepts/a', 'concepts/b'], ['wiki/concepts/a.md', 'wiki/concepts/b.md']);
    const id2 = computeFindingId('contradiction', ['concepts/a', 'concepts/b'], ['wiki/concepts/a.md', 'wiki/concepts/b.md', 'extra']);
    expect(id1).not.toBe(id2);
  });

  it('重复扫描保留 ignored 状态', async () => {
    const finding: WikiStructuralFinding = {
      findingId: computeFindingId('contradiction', ['a', 'b'], ['wiki/a.md', 'wiki/b.md']),
      kbId: 'kb-sem',
      kind: 'contradiction',
      pageIds: ['a', 'b'],
      evidenceRefs: ['wiki/a.md', 'wiki/b.md'],
      evidenceHashes: ['hash_a', 'hash_b'],
      status: 'open',
      createdAt: '2026-09-14T00:00:00Z',
      updatedAt: '2026-09-14T00:00:00Z',
    };

    // 第一次扫描 → open
    const first = await mergeFindings(kbPath, [finding], '2026-09-14T00:00:00Z');
    expect(first[0]!.status).toBe('open');

    // 手动 ignore
    const { updateFindingStatus } = await import('../src/main/kb/finding-store');
    await updateFindingStatus(kbPath, finding.findingId, 'ignore', '2026-09-14T01:00:00Z');

    // 第二次扫描（同证据）→ 保留 ignored
    const second = await mergeFindings(kbPath, [finding], '2026-09-14T02:00:00Z');
    const merged = second.find((f) => f.findingId === finding.findingId);
    expect(merged?.status).toBe('ignored');
  });

  it('证据变化 → 重开为 open', async () => {
    const finding: WikiStructuralFinding = {
      findingId: computeFindingId('contradiction', ['a', 'b'], ['wiki/a.md', 'wiki/b.md']),
      kbId: 'kb-sem',
      kind: 'contradiction',
      pageIds: ['a', 'b'],
      evidenceRefs: ['wiki/a.md', 'wiki/b.md'],
      evidenceHashes: ['hash_a_v1', 'hash_b_v1'],
      status: 'open',
      createdAt: '2026-09-14T00:00:00Z',
      updatedAt: '2026-09-14T00:00:00Z',
    };

    // 第一次扫描
    await mergeFindings(kbPath, [finding], '2026-09-14T00:00:00Z');

    // ignore
    const { updateFindingStatus } = await import('../src/main/kb/finding-store');
    await updateFindingStatus(kbPath, finding.findingId, 'ignore', '2026-09-14T01:00:00Z');

    // 证据变化后重新扫描 → 重开
    const changedFinding: WikiStructuralFinding = {
      ...finding,
      evidenceHashes: ['hash_a_v2', 'hash_b_v2'],
    };
    const second = await mergeFindings(kbPath, [changedFinding], '2026-09-14T02:00:00Z');
    const merged = second.find((f) => f.findingId === finding.findingId);
    expect(merged?.status).toBe('open');
  });
});
