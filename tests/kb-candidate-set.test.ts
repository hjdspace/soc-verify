/**
 * 跨页候选集与链接校验测试（issue 07）。
 *
 * 覆盖验收：
 *  - 所有未决页须处置（unsettled）；全拒绝不改变任何正式资产（nothingAccepted）；
 *  - 拒绝目标新页却接受入链时阻止发布并定位 hunk；
 *  - 不相关既有断链不阻断整库（只作可见警告）；
 *  - 差异重算后旧 hunk 决定失效；
 *  - 部分接受被识别（partial → published_partial）。
 */

import { describe, it, expect } from 'vitest';
import { resolveCandidateSet, validateCandidateLinks } from '../src/main/kb/candidate-set';
import { wikiPageDiffFingerprint } from '@shared/wiki-hunks';
import type { WikiChangeSet, WikiChangeSetReview, WikiStagedPage } from '@shared/kb-types';

const SRC = [{ sourceId: 'a'.repeat(64), sourceRevision: 'b'.repeat(64), parsedHash: 'c'.repeat(64) }];

function pageText(title: string, body: string, extra: string[] = []): string {
  return [
    '---',
    'type: concept',
    `title: "${title}"`,
    'summary: 摘要。',
    'keywords: []',
    'tags: []',
    'sources: []',
    ...extra,
    'created: "2026-09-13T00:00:00Z"',
    'updated: "2026-09-13T00:00:00Z"',
    '---',
    '',
    `# ${title}`,
    '',
    body,
  ].join('\n');
}

const staged = (
  relPath: string,
  before: string | null,
  proposed: string,
): WikiStagedPage => ({
  relPath,
  pageId: relPath.slice('wiki/'.length, -3),
  type: 'concept',
  before,
  proposed,
  baselineHash: before === null ? null : 'baseline',
  sources: before === null ? SRC : [],
});

function changeSet(pages: WikiStagedPage[]): WikiChangeSet {
  return {
    changeSetId: 'cs-1',
    kbId: 'kb-1',
    taskId: 't-1',
    origin: 'compile',
    sources: SRC,
    schemaHash: 'schema-hash',
    purposeHash: 'purpose-hash',
    readBaseline: [],
    pages,
    findings: [],
    warnings: [],
    createdAt: '2026-09-13T00:00:00Z',
    updatedAt: '2026-09-13T00:00:00Z',
  };
}

/** 审阅态：hunksHash 由页面内容算出（等价于 recordDecision 的落盘结果） */
function review(
  pages: WikiStagedPage[],
  decisions: Record<string, { pageDecision?: 'pending' | 'accepted' | 'rejected'; hunks?: Record<number, 'pending' | 'accepted' | 'rejected'> }>,
  opts: { withFingerprint?: boolean } = {},
): WikiChangeSetReview {
  return {
    changeSetId: 'cs-1',
    pages: pages.map((p) => {
      const d = decisions[p.relPath] ?? {};
      return {
        pageId: p.pageId,
        relPath: p.relPath,
        hunkStates: d.hunks ?? {},
        pageDecision: d.pageDecision ?? 'pending',
        ...(opts.withFingerprint === false ? {} : { hunksHash: wikiPageDiffFingerprint(p) }),
      };
    }),
    settled: false,
    updatedAt: '2026-09-13T00:00:00Z',
  };
}

// ── 候选集 ──────────────────────────────────────────────────────

describe('resolveCandidateSet — 未决页与部分接受', () => {
  it('多页全部处置：逐页给出 operation 与 afterHash', () => {
    const a = staged('wiki/concepts/a.md', null, pageText('A', 'A。'));
    const b = staged('wiki/concepts/b.md', null, pageText('B', 'B。'));
    const cs = changeSet([a, b]);
    const res = resolveCandidateSet(cs, review([a, b], {
      'wiki/concepts/a.md': { pageDecision: 'accepted' },
      'wiki/concepts/b.md': { pageDecision: 'accepted' },
    }));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pages.map((p) => p.page.pageId)).toEqual(['concepts/a', 'concepts/b']);
    expect(res.pages.every((p) => p.operation === 'create' && p.partial === false)).toBe(true);
    expect(res.pages[0].content).toBe(pageText('A', 'A。'));
  });

  it('全拒绝 → nothingAccepted（不产生任何正式改动）', () => {
    const a = staged('wiki/concepts/a.md', null, pageText('A', 'A。'));
    const cs = changeSet([a]);
    const res = resolveCandidateSet(cs, review([a], {
      'wiki/concepts/a.md': { pageDecision: 'rejected' },
    }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('nothingAccepted');
  });

  it('单页未处置 → nothingAccepted（与既有口径一致）', () => {
    const a = staged('wiki/concepts/a.md', null, pageText('A', 'A。'));
    const res = resolveCandidateSet(changeSet([a]), review([a], {}));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('nothingAccepted');
  });

  it('已有接受页但另有未决页 → unsettled 并逐项列出', () => {
    const a = staged('wiki/concepts/a.md', null, pageText('A', 'A。'));
    const b = staged('wiki/concepts/b.md', null, pageText('B', 'B。'));
    const cs = changeSet([a, b]);
    const res = resolveCandidateSet(cs, review([a, b], {
      'wiki/concepts/a.md': { pageDecision: 'accepted' },
    }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('unsettled');
      expect(res.error.detail?.join(' ')).toContain('wiki/concepts/b.md');
    }
  });

  it('review 缺条目的页按未处置处理（不静默丢弃，code-review 加固）', () => {
    const a = staged('wiki/concepts/a.md', null, pageText('A', 'A。'));
    const b = staged('wiki/concepts/b.md', null, pageText('B', 'B。'));
    const cs = changeSet([a, b]);
    // review 只物化 a 的条目，b 缺失 → 不得绕过「所有未决项必须明确处置」
    const partialReview = review([a], { 'wiki/concepts/a.md': { pageDecision: 'accepted' } });
    const res = resolveCandidateSet(cs, partialReview);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('unsettled');
      expect(res.error.detail?.join(' ')).toContain('wiki/concepts/b.md');
    }
  });

  it('已有页部分接受：正文按选择重建，partial=true', () => {
    const before = pageText('A', '旧正文。');
    const after = [
      '---', 'type: concept', 'title: "A"', 'summary: 新摘要。', 'keywords: []', 'tags: []',
      'sources: []', 'created: "2026-09-13T00:00:00Z"', 'updated: "2026-09-13T00:00:00Z"',
      '---', '', '# A', '', '新正文。',
    ].join('\n');
    const p = staged('wiki/concepts/a.md', before, after);
    const res = resolveCandidateSet(changeSet([p]), review([p], {
      'wiki/concepts/a.md': { hunks: { 1: 'accepted', 2: 'rejected' } },
    }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pages[0].partial).toBe(true);
    expect(res.pages[0].operation).toBe('update');
    expect(res.pages[0].content).toContain('summary: 新摘要。');
    expect(res.pages[0].content).not.toContain('新正文。');
    expect(res.pages[0].content).toContain('旧正文。');
  });

  it('差异重算（hunksHash 不符）→ stale，旧 hunk 决定失效', () => {
    const p = staged('wiki/concepts/a.md', null, pageText('A', 'A。'));
    const cs = changeSet([p]);
    const stale = review([p], { 'wiki/concepts/a.md': { pageDecision: 'accepted' } });
    stale.pages[0].hunksHash = 'fnv1a64:0000000000000000';

    const res = resolveCandidateSet(cs, stale);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('stale');
      expect(res.error.detail?.join(' ')).toContain('差异');
    }
  });

  it('无 hunksHash 的旧审阅记录不因指纹缺失而失败（向后兼容）', () => {
    const p = staged('wiki/concepts/a.md', null, pageText('A', 'A。'));
    const r = review([p], { 'wiki/concepts/a.md': { pageDecision: 'accepted' } }, { withFingerprint: false });
    expect(resolveCandidateSet(changeSet([p]), r).ok).toBe(true);
  });
});

// ── 跨页链接校验 ────────────────────────────────────────────────

describe('validateCandidateLinks — 最终候选集上的引用检查', () => {
  const candidate = (relPath: string, before: string | null, content: string) => ({
    page: staged(relPath, before, content),
    content,
    partial: false,
    operation: 'create' as const,
    beforeHash: null,
    afterHash: 'h',
  });

  it('新链接指向同批被接受的新页 → 通过', () => {
    const linkPage = pageText('A', '见 [[concepts/b|B页]]。');
    const target = pageText('B', 'B 正文。');
    const res = validateCandidateLinks({
      candidates: [candidate('wiki/concepts/a.md', null, linkPage), candidate('wiki/concepts/b.md', null, target)],
      published: [],
    });
    expect(res.ok).toBe(true);
  });

  it('拒绝目标新页却接受入链 → 阻止发布并把问题定位到 hunk', () => {
    const linkPage = pageText('A', '见 [[concepts/b|B页]]。');
    const res = validateCandidateLinks({
      candidates: [candidate('wiki/concepts/a.md', null, linkPage)],
      published: [],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const err = res.errors.find((e) => e.target === 'concepts/b');
    expect(err).toBeDefined();
    expect(err!.relPath).toBe('wiki/concepts/a.md');
    // 新页整页是一个 hunk（id 0）——问题定位到该 hunk
    expect(err!.hunkId).toBe(0);
  });

  it('既有断链（before 中已存在且本批未改动）只记警告，不阻断整库', () => {
    const before = pageText('A', '旧：[[concepts/gone|已失联]]。');
    const after = pageText('A', '新：[[concepts/gone|已失联]] 保留，另加正文。');
    const res = validateCandidateLinks({
      candidates: [candidate('wiki/concepts/a.md', before, after)],
      published: [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warnings.join(' ')).toContain('concepts/gone');
  });

  it('本次新增的断链（before 没有）→ 阻止发布', () => {
    const before = pageText('A', '旧正文。');
    const after = pageText('A', '旧正文。\n\n见 [[concepts/never|不存在]]。');
    const res = validateCandidateLinks({
      candidates: [candidate('wiki/concepts/a.md', before, after)],
      published: [],
    });
    expect(res.ok).toBe(false);
  });

  it('围栏代码块内的伪链接不参与校验', () => {
    const after = pageText('A', '示例：\n\n```\n[[concepts/never|示例]]\n```');
    const res = validateCandidateLinks({
      candidates: [candidate('wiki/concepts/a.md', null, after)],
      published: [],
    });
    expect(res.ok).toBe(true);
  });

  it('指向已发布既有页的链接不受本批影响 → 通过', () => {
    const res = validateCandidateLinks({
      candidates: [candidate('wiki/concepts/a.md', null, pageText('A', '见 [[concepts/old|旧页]]。'))],
      published: [{ pageId: 'concepts/old', relPath: 'wiki/concepts/old.md', title: '旧页' }],
    });
    expect(res.ok).toBe(true);
  });

  it('被本批删除/不再存在的目标：新旧入链都纳入校验', () => {
    // 目标页在磁盘上存在（before 侧可解析），但本批不再产出它 → 入链变断
    const res = validateCandidateLinks({
      candidates: [candidate('wiki/concepts/a.md', null, pageText('A', '见 [[concepts/going|即将消失]]。'))],
      published: [{ pageId: 'concepts/gone', relPath: 'wiki/concepts/gone.md', title: '早已丢失' }],
    });
    expect(res.ok).toBe(false);
  });
});
