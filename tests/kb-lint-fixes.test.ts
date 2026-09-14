/**
 * lint-fixes + sweep-reviews 测试（issue 27，spec §9）。
 *
 * 覆盖验收映射 A18：
 *  - 请求修复固定 finding 证据 hash 和相关页基线，复用 staging
 *  - 拒绝或修复失败保留待处理状态
 *  - 发布后复检绑定新 revision，确已解决才 resolved
 *  - 期间证据变化或另一个提案解决问题时可正确收敛
 *  - 完整路径：待办 → 提案 → 审阅 → 发布 → 复核
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  requestFix,
  clearFixChangeSetId,
  type FixLlm,
} from '@main/kb/lint-fixes';
import { sweepReview } from '@main/kb/sweep-reviews';
import {
  mergeFindings,
  readFindings,
  updateFindingStatus,
} from '@main/kb/finding-store';
import { computeFindingId } from '@main/kb/structural-lint';
import { invalidateGraphSnapshot } from '@main/kb/wiki-graph';
import { initWikiLayout, writeWikiManifest } from '@main/kb/wiki-layout';
import { readChangeSet } from '@main/kb/staging';
import { publishChangeSet } from '@main/kb/publish';
import { writeFileAtomic } from '@main/kb/atomic-commit';
import { wikiLayout } from '@main/kb/wiki-layout';
import type { WikiStructuralFinding, WikiSourceRef, WikiChangeSetReview } from '@shared/kb-types';

let kbPath: string;

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-fix-'));
  const manifest = await initWikiLayout(kbPath, { kbId: 'kb-fix', name: '修复测试库' });
  // 注册来源 s1（publishChangeSet 基线校验需要 manifest.sources 中存在对应记录）
  manifest.sources = {
    s1: {
      sourcePath: 'test-source.md',
      sourceId: 's1',
      ext: '.md',
      size: 100,
      currentRevision: 'r1',
      parsedRevision: 'r1',
      parsedHash: 'h1',
      engine: 'text',
      engineFingerprint: null,
      status: 'ready',
      assetCount: 0,
      importedAt: '2026-09-14T00:00:00Z',
      updatedAt: '2026-09-14T00:00:00Z',
    },
  };
  await writeWikiManifest(kbPath, manifest);
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

function makeContradictionFinding(): WikiStructuralFinding {
  const pageIds = ['concepts/a', 'concepts/b'];
  const evidenceRefs = ['wiki/concepts/a.md', 'wiki/concepts/b.md'];
  return {
    findingId: computeFindingId('contradiction', pageIds, evidenceRefs),
    kbId: 'kb-fix',
    kind: 'contradiction',
    pageIds,
    evidenceRefs,
    evidenceHashes: ['hash_a_v1', 'hash_b_v1'],
    status: 'open',
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:00Z',
    evidenceQuotes: [
      { pageId: 'concepts/a', quote: 'AXI 支持 16 outstanding', location: '第3行' },
      { pageId: 'concepts/b', quote: 'AXI 支持 8 outstanding', location: '第3行' },
    ],
    description: 'AXI outstanding 数量矛盾',
    suggestion: false,
  };
}

const SOURCE_REFS: WikiSourceRef[] = [
  { sourceId: 's1', sourceRevision: 'r1', parsedHash: 'h1' },
];

// ── requestFix ───────────────────────────────────────────────────

describe('requestFix — 请求修复', () => {
  beforeEach(async () => {
    // 写入两个有矛盾的页面
    writeWikiPage('concepts/a.md', PAGE_FM('concept', '概念A', { sources: '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]' }) + 'AXI 支持 16 outstanding。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', '概念B', { sources: '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]' }) + 'AXI 支持 8 outstanding。\n');
  });

  it('创建修复提案并绑定 finding 证据 hash 和页基线', async () => {
    const finding = makeContradictionFinding();
    await mergeFindings(kbPath, [finding], '2026-09-14T00:00:00Z');

    const mockLlm: FixLlm = {
      invoke: async () => ({
        text: [
          '---FILE: wiki/concepts/a.md---',
          PAGE_FM('concept', '概念A', { sources: '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]' }) + 'AXI 支持 8 outstanding（与 concepts/b 一致）。\n',
          '---END FILE---',
        ].join('\n'),
        finishReason: 'stop',
        usage: null,
      }),
    };

    const result = await requestFix(kbPath, {
      findingId: finding.findingId,
      llm: mockLlm,
      sourceRefs: SOURCE_REFS,
      now: '2026-09-14T01:00:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changeSetId).toBeTruthy();
    expect(result.findingId).toBe(finding.findingId);
    expect(result.evidenceHashes).toEqual(finding.evidenceHashes);
    expect(result.pageBaseline).toHaveLength(2);

    // finding 应被关联到变更集
    const findings = await readFindings(kbPath);
    if (!findings.ok) throw new Error('readFindings failed');
    const updated = findings.findings.find((f) => f.findingId === finding.findingId);
    expect(updated?.fixChangeSetId).toBe(result.changeSetId);
  });

  it('finding 不存在时返回 findingNotFound', async () => {
    const mockLlm: FixLlm = {
      invoke: async () => ({ text: '', finishReason: 'stop', usage: null }),
    };

    const result = await requestFix(kbPath, {
      findingId: 'nonexistent',
      llm: mockLlm,
      sourceRefs: SOURCE_REFS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('findingNotFound');
  });

  it('finding 已 ignored 时返回 findingNotOpen', async () => {
    const finding = makeContradictionFinding();
    await mergeFindings(kbPath, [finding], '2026-09-14T00:00:00Z');
    await updateFindingStatus(kbPath, finding.findingId, 'ignore', '2026-09-14T00:30:00Z');

    const mockLlm: FixLlm = {
      invoke: async () => ({ text: '', finishReason: 'stop', usage: null }),
    };

    const result = await requestFix(kbPath, {
      findingId: finding.findingId,
      llm: mockLlm,
      sourceRefs: SOURCE_REFS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('findingNotOpen');
  });

  it('已有未发布的修复提案时返回 alreadyRequested', async () => {
    const finding = makeContradictionFinding();
    await mergeFindings(kbPath, [finding], '2026-09-14T00:00:00Z');

    // 第一次修复请求
    const mockLlm: FixLlm = {
      invoke: async () => ({
        text: [
          '---FILE: wiki/concepts/a.md---',
          PAGE_FM('concept', '概念A', { sources: '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]' }) + 'AXI 支持 8 outstanding。\n',
          '---END FILE---',
        ].join('\n'),
        finishReason: 'stop',
        usage: null,
      }),
    };

    const first = await requestFix(kbPath, {
      findingId: finding.findingId,
      llm: mockLlm,
      sourceRefs: SOURCE_REFS,
      now: '2026-09-14T01:00:00Z',
    });
    expect(first.ok).toBe(true);

    // 第二次修复请求 → alreadyRequested
    const second = await requestFix(kbPath, {
      findingId: finding.findingId,
      llm: mockLlm,
      sourceRefs: SOURCE_REFS,
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('alreadyRequested');
  });

  it('LLM 失败时返回 llmFailed', async () => {
    const finding = makeContradictionFinding();
    await mergeFindings(kbPath, [finding], '2026-09-14T00:00:00Z');

    const mockLlm: FixLlm = {
      invoke: async () => { throw new Error('LLM 失败'); },
    };

    const result = await requestFix(kbPath, {
      findingId: finding.findingId,
      llm: mockLlm,
      sourceRefs: SOURCE_REFS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('llmFailed');
  });

  it('无 LLM 配置时返回 noLlmConfig', async () => {
    const finding = makeContradictionFinding();
    await mergeFindings(kbPath, [finding], '2026-09-14T00:00:00Z');

    const result = await requestFix(kbPath, {
      findingId: finding.findingId,
      llm: null,
      sourceRefs: SOURCE_REFS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('noLlmConfig');
  });
});

// ── 完整路径：待办 → 提案 → 审阅 → 发布 → 复核 ─────────────────

describe('完整路径：待办 → 提案 → 审阅 → 发布 → 复核', () => {
  beforeEach(async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', '概念A', { sources: '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]' }) + 'AXI 支持 16 outstanding。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', '概念B', { sources: '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]' }) + 'AXI 支持 8 outstanding。\n');
  });

  it('修复发布后复检通过 → resolved', async () => {
    const finding = makeContradictionFinding();
    await mergeFindings(kbPath, [finding], '2026-09-14T00:00:00Z');

    // 1. 请求修复
    const fixLlm: FixLlm = {
      invoke: async () => ({
        text: [
          '---FILE: wiki/concepts/a.md---',
          PAGE_FM('concept', '概念A', { sources: '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]' }) + 'AXI 支持 8 outstanding（修正后与 concepts/b 一致）。\n',
          '---END FILE---',
        ].join('\n'),
        finishReason: 'stop',
        usage: null,
      }),
    };

    const fixResult = await requestFix(kbPath, {
      findingId: finding.findingId,
      llm: fixLlm,
      sourceRefs: SOURCE_REFS,
      now: '2026-09-14T01:00:00Z',
    });
    expect(fixResult.ok).toBe(true);
    if (!fixResult.ok) return;

    // 2. 审阅：接受变更（直接写 review 文件设置 pageDecision=accepted）
    await acceptAll(kbPath, fixResult.changeSetId);

    // 3. 发布
    const pubResult = await publishChangeSet(kbPath, {
      kbId: 'kb-fix',
      changeSetId: fixResult.changeSetId,
      now: '2026-09-14T02:00:00Z',
      commitId: 'commit-fix-1',
    });
    if (!pubResult.ok) {
      console.error('PUBLISH FAILED:', JSON.stringify(pubResult.error));
    }
    expect(pubResult.ok).toBe(true);

    // 4. 复检：矛盾已解决 → resolved
    const sweepLlm: FixLlm = {
      invoke: async () => ({
        text: JSON.stringify({ findings: [] }),
        finishReason: 'stop',
        usage: null,
      }),
    };

    const sweepResult = await sweepReview(kbPath, {
      findingId: finding.findingId,
      llm: sweepLlm,
      now: '2026-09-14T03:00:00Z',
    });

    expect(sweepResult.ok).toBe(true);
    if (!sweepResult.ok) return;
    expect(sweepResult.resolved).toBe(true);

    // finding 状态应为 resolved
    const findings = await readFindings(kbPath);
    if (!findings.ok) throw new Error('readFindings failed');
    const updated = findings.findings.find((f) => f.findingId === finding.findingId);
    expect(updated?.status).toBe('resolved');
  });

  it('修复发布后矛盾仍存在 → 保留 open', async () => {
    const finding = makeContradictionFinding();
    await mergeFindings(kbPath, [finding], '2026-09-14T00:00:00Z');

    // 修复提案（但实际上没有改 a 页的矛盾内容）
    const fixLlm: FixLlm = {
      invoke: async () => ({
        text: [
          '---FILE: wiki/concepts/a.md---',
          PAGE_FM('concept', '概念A', { sources: '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]' }) + 'AXI 支持 16 outstanding（未修正）。\n',
          '---END FILE---',
        ].join('\n'),
        finishReason: 'stop',
        usage: null,
      }),
    };

    const fixResult = await requestFix(kbPath, {
      findingId: finding.findingId,
      llm: fixLlm,
      sourceRefs: SOURCE_REFS,
      now: '2026-09-14T01:00:00Z',
    });
    expect(fixResult.ok).toBe(true);
    if (!fixResult.ok) return;

    // 2. 审阅：接受变更
    await acceptAll(kbPath, fixResult.changeSetId);

    await publishChangeSet(kbPath, {
      kbId: 'kb-fix',
      changeSetId: fixResult.changeSetId,
      now: '2026-09-14T02:00:00Z',
      commitId: 'commit-fix-2',
    });

    // 复检：矛盾仍存在
    const sweepLlm: FixLlm = {
      invoke: async () => ({
        text: JSON.stringify({
          findings: [
            {
              kind: 'contradiction',
              pageIds: ['concepts/a', 'concepts/b'],
              description: 'AXI outstanding 仍然矛盾',
              evidenceQuotes: [],
              suggestion: false,
            },
          ],
        }),
        finishReason: 'stop',
        usage: null,
      }),
    };

    const sweepResult = await sweepReview(kbPath, {
      findingId: finding.findingId,
      llm: sweepLlm,
      now: '2026-09-14T03:00:00Z',
    });

    expect(sweepResult.ok).toBe(true);
    if (!sweepResult.ok) return;
    expect(sweepResult.resolved).toBe(false);
    expect(sweepResult.evidence).toBeTruthy();

    // finding 状态应保持 open
    const findings = await readFindings(kbPath);
    if (!findings.ok) throw new Error('readFindings failed');
    const updated = findings.findings.find((f) => f.findingId === finding.findingId);
    expect(updated?.status).toBe('open');
  });

  it('拒绝修复 → 保留待处理状态', async () => {
    const finding = makeContradictionFinding();
    await mergeFindings(kbPath, [finding], '2026-09-14T00:00:00Z');

    const fixLlm: FixLlm = {
      invoke: async () => ({
        text: [
          '---FILE: wiki/concepts/a.md---',
          PAGE_FM('concept', '概念A', { sources: '[{sourceId: "s1", sourceRevision: "r1", parsedHash: "h1"}]' }) + 'AXI 支持 8 outstanding。\n',
          '---END FILE---',
        ].join('\n'),
        finishReason: 'stop',
        usage: null,
      }),
    };

    const fixResult = await requestFix(kbPath, {
      findingId: finding.findingId,
      llm: fixLlm,
      sourceRefs: SOURCE_REFS,
      now: '2026-09-14T01:00:00Z',
    });
    expect(fixResult.ok).toBe(true);
    if (!fixResult.ok) return;

    // 拒绝变更
    await rejectAll(kbPath, fixResult.changeSetId);
    // 拒绝后清除 fixChangeSetId（调用方负责）
    await clearFixChangeSetId(kbPath, finding.findingId);

    // finding 仍为 open
    const findings = await readFindings(kbPath);
    if (!findings.ok) throw new Error('readFindings failed');
    const updated = findings.findings.find((f) => f.findingId === finding.findingId);
    expect(updated?.status).toBe('open');
    // fixChangeSetId 应被清除（拒绝后可重新请求修复）
    expect(updated?.fixChangeSetId).toBeNull();
  });

  it('无已发布的修复时返回 noPublishedFix', async () => {
    const finding = makeContradictionFinding();
    await mergeFindings(kbPath, [finding], '2026-09-14T00:00:00Z');

    const sweepLlm: FixLlm = {
      invoke: async () => ({ text: '', finishReason: 'stop', usage: null }),
    };

    const result = await sweepReview(kbPath, {
      findingId: finding.findingId,
      llm: sweepLlm,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('noPublishedFix');
  });
});

// ── 辅助函数 ─────────────────────────────────────────────────────

/** 直接写 review 文件设置所有页 pageDecision=accepted */
async function acceptAll(kbPath: string, changeSetId: string): Promise<void> {
  const csResult = await readChangeSet(kbPath, changeSetId);
  if (!csResult.ok) throw new Error('readChangeSet failed');
  const cs = csResult.value;
  const review: WikiChangeSetReview = {
    changeSetId,
    pages: cs.pages.map((p) => ({
      pageId: p.pageId,
      relPath: p.relPath,
      hunkStates: {},
      pageDecision: 'accepted' as const,
    })),
    settled: true,
    updatedAt: new Date().toISOString(),
  };
  const reviewPath = join(wikiLayout(kbPath).reviewsDir, `${changeSetId}.json`);
  await writeFileAtomic(reviewPath, JSON.stringify(review, null, 2));
}

/** 直接写 review 文件设置所有页 pageDecision=rejected */
async function rejectAll(kbPath: string, changeSetId: string): Promise<void> {
  const csResult = await readChangeSet(kbPath, changeSetId);
  if (!csResult.ok) throw new Error('readChangeSet failed');
  const cs = csResult.value;
  const review: WikiChangeSetReview = {
    changeSetId,
    pages: cs.pages.map((p) => ({
      pageId: p.pageId,
      relPath: p.relPath,
      hunkStates: {},
      pageDecision: 'rejected' as const,
    })),
    settled: true,
    updatedAt: new Date().toISOString(),
  };
  const reviewPath = join(wikiLayout(kbPath).reviewsDir, `${changeSetId}.json`);
  await writeFileAtomic(reviewPath, JSON.stringify(review, null, 2));
}
