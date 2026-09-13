/**
 * 多页变更集与逐 hunk 审阅发布测试（issue 07）。
 *
 * 覆盖验收：
 *  - 事务写集扩展为多页，同一次提交更新所有页/聚合/历史；重放不重复日志；
 *  - 所有未决页须处置（pendingDecisions）；新链接、来源与读依赖按最终候选集验证；
 *  - 拒绝目标新页却接受入链 → 阻止发布并定位 hunk；既有断链不阻断整库；
 *  - 新页与 frontmatter 整体审阅，已有正文支持 hunk；差异重算后旧决定失效；
 *  - 部分接受标 published_partial（result/review 携带 partial）；
 *  - 第二页写失败、相邻任务发布与外部修改的真目录故障测试。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildPublishPlan,
  publishChangeSet,
  preparePublish,
  completePublish,
} from '../src/main/kb/publish';
import { stageProposal, recordDecision, readReview } from '../src/main/kb/staging';
import { initWikiLayout, wikiLayout, readWikiManifest, writeWikiManifest } from '../src/main/kb/wiki-layout';
import { buildWikiPageDiff, wikiPageDiffFingerprint, wikiRealHunkIds } from '../src/shared/wiki-hunks';
import type { WikiPageHistoryEntry, WikiSourceRef, WikiStagedPage } from '@shared/kb-types';

let kbPath: string;

const SRC_REF: WikiSourceRef = {
  sourceId: 'a'.repeat(64),
  sourceRevision: 'b'.repeat(64),
  parsedHash: 'c'.repeat(64),
};

const sha = (text: string): string => createHash('sha256').update(text, 'utf-8').digest('hex');

async function registerSource(ref: WikiSourceRef, currentRevision = ref.sourceRevision): Promise<void> {
  const manifest = await readWikiManifest(kbPath);
  if (!manifest.ok) throw new Error('manifest');
  await writeWikiManifest(kbPath, {
    ...manifest.manifest,
    sources: {
      ...(manifest.manifest.sources ?? {}),
      [ref.sourceId]: {
        sourcePath: 'axi.pdf',
        sourceId: ref.sourceId,
        ext: '.pdf',
        size: 1,
        currentRevision,
        parsedRevision: currentRevision,
        parsedHash: ref.parsedHash,
        engine: 'anydoc',
        engineFingerprint: 'fp',
        status: 'ready',
        assetCount: 0,
        importedAt: '2026-09-13T00:00:00Z',
        updatedAt: '2026-09-13T00:00:00Z',
      },
    },
  });
}

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-publish-multi-'));
  await initWikiLayout(kbPath, { kbId: 'kb-1', name: 'KB' });
  await registerSource(SRC_REF);
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

// ── fixture ─────────────────────────────────────────────────────

function pageBody(title: string, body: string, sources: WikiSourceRef[] = [], type = 'concept'): string {
  const srcLines = sources.length === 0
    ? 'sources: []'
    : ['sources:', ...sources.flatMap((s) => [
        `  - sourceId: "${s.sourceId}"`,
        `    sourceRevision: "${s.sourceRevision}"`,
        `    parsedHash: "${s.parsedHash}"`,
      ])].join('\n');
  return [
    '---',
    `type: ${type}`,
    `title: "${title}"`,
    'summary: 摘要。',
    'keywords: [AXI]',
    'tags: []',
    srcLines,
    'created: "2026-09-13T00:00:00Z"',
    'updated: "2026-09-13T00:00:00Z"',
    '---',
    '',
    `# ${title}`,
    '',
    body,
  ].join('\n');
}

const fileBlock = (p: string, body: string): string => `---FILE: ${p}---\n${body}\n---END FILE---`;

/** 通过公开生产边界投递多页提案，并按 relPath → decision 映射整页处置 */
async function stageMulti(
  pages: Array<{ relPath: string; content: string }>,
  decisions: Record<string, 'accepted' | 'rejected'>,
  extra: { readBaseline?: Array<{ pageId: string; hash: string | null }> } = {},
): Promise<string> {
  const staged = await stageProposal(kbPath, {
    kbId: 'kb-1',
    taskId: 'task-multi',
    origin: 'compile',
    sourceRefs: [SRC_REF],
    proposalText: pages.map((p) => fileBlock(p.relPath, p.content)).join('\n'),
    ...extra,
  });
  if (!staged.ok) throw new Error(`stage: ${staged.error.code} ${staged.error.message}`);
  const changeSetId = staged.value.changeSet.changeSetId;
  for (const p of pages) {
    const decision = decisions[p.relPath];
    if (!decision) continue;
    const stagedPage: WikiStagedPage | undefined = staged.value.changeSet.pages.find((x) => x.relPath === p.relPath);
    if (!stagedPage) throw new Error('staged page missing');
    const rec = await recordDecision(kbPath, {
      changeSetId,
      pageRelPath: p.relPath,
      hunkIds: wikiRealHunkIds(stagedPage),
      decision,
    });
    if (!rec.ok) throw new Error(`decide: ${rec.error.code}`);
  }
  return changeSetId;
}

/** 对已接受页记录逐 hunk 选择（接受 acceptedIds，其余真实 hunk 全部拒绝） */
async function decideHunks(
  changeSetId: string,
  page: WikiStagedPage,
  acceptedIds: number[],
): Promise<void> {
  const all = wikiRealHunkIds(page);
  const rejected = all.filter((id) => !acceptedIds.includes(id));
  const acc = await recordDecision(kbPath, { changeSetId, pageRelPath: page.relPath, hunkIds: acceptedIds, decision: 'accepted' });
  if (!acc.ok) throw new Error(`decide: ${acc.error.code}`);
  if (rejected.length > 0) {
    const rej = await recordDecision(kbPath, { changeSetId, pageRelPath: page.relPath, hunkIds: rejected, decision: 'rejected' });
    if (!rej.ok) throw new Error(`decide: ${rej.error.code}`);
  }
}

const pagePath = (relPath: string): string => join(kbPath, relPath);

// ── 多页一次提交 ────────────────────────────────────────────────

describe('publishChangeSet — 多页变更集', () => {
  it('两个新页同一次提交发布：写集/聚合/历史/manifest 全量更新', async () => {
    const bodyA = pageBody('AXI', '正文 A。', [SRC_REF]);
    const bodyB = pageBody('APB', '正文 B。', [SRC_REF], 'entity');
    const csId = await stageMulti([
      { relPath: 'wiki/concepts/axi.md', content: bodyA },
      { relPath: 'wiki/entities/apb.md', content: bodyB },
    ], {
      'wiki/concepts/axi.md': 'accepted',
      'wiki/entities/apb.md': 'accepted',
    });

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId, now: '2026-09-13T12:00:00Z' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.revision).toBe(1);
    expect(res.partial).toBe(false);
    expect(res.pages.map((p) => p.pageId).sort()).toEqual(['concepts/axi', 'entities/apb']);

    // 两个正式页都在
    expect(readFileSync(pagePath('wiki/concepts/axi.md'), 'utf-8')).toBe(bodyA);
    expect(readFileSync(pagePath('wiki/entities/apb.md'), 'utf-8')).toBe(bodyB);
    // 聚合页包含两页
    const index = readFileSync(join(kbPath, 'wiki', 'index.md'), 'utf-8');
    expect(index).toContain('[[concepts/axi|AXI]]');
    expect(index).toContain('[[entities/apb|APB]]');
    expect(readFileSync(join(kbPath, 'wiki', 'overview.md'), 'utf-8')).toContain('共 2 页');
    // 同一 commit 更新所有页面的历史
    for (const pid of ['concepts/axi', 'entities/apb']) {
      const line = readFileSync(join(kbPath, '.kb', 'page-history', `${pid.replace('/', '__')}.jsonl`), 'utf-8').trim();
      const entry = JSON.parse(line) as WikiPageHistoryEntry;
      expect(entry.commitId).toBe(res.commitId);
    }
    // 重放不重复日志：commitId 只出现一次
    const log = readFileSync(join(kbPath, 'wiki', 'log.md'), 'utf-8');
    expect(log).toContain('## [2026-09-13T12:00:00Z] publish |');
    expect(log.match(new RegExp(res.commitId, 'g'))).toHaveLength(1);
    // manifest revision 与事务清理
    const manifest = await readWikiManifest(kbPath);
    expect(manifest.ok && manifest.manifest.publish?.revision).toBe(1);
    expect(readdirSync(wikiLayout(kbPath).transactionsDir)).toHaveLength(0);
  });

  it('规划写集天然多页：页写入在前，聚合/历史/manifest/reviews 在后', async () => {
    const csId = await stageMulti([
      { relPath: 'wiki/concepts/a.md', content: pageBody('A', 'A。') },
      { relPath: 'wiki/concepts/b.md', content: pageBody('B', 'B。') },
    ], { 'wiki/concepts/a.md': 'accepted', 'wiki/concepts/b.md': 'accepted' });

    const built = await buildPublishPlan(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const rel = built.plan.writes.map((w) => w.relPath);
    expect(rel.filter((r) => r.startsWith('wiki/concepts/'))).toHaveLength(2);
    expect(rel.indexOf('wiki/concepts/a.md')).toBeLessThan(rel.indexOf('wiki/index.md'));
    expect(built.plan.meta.pages).toHaveLength(2);
  });

  it('有未决页 → pendingDecisions 阻止发布并定位页面，不写任何正式资产', async () => {
    const csId = await stageMulti([
      { relPath: 'wiki/concepts/a.md', content: pageBody('A', 'A。') },
      { relPath: 'wiki/concepts/b.md', content: pageBody('B', 'B。') },
    ], { 'wiki/concepts/a.md': 'accepted' });

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('pendingDecisions');
      expect(res.error.detail?.join(' ')).toContain('wiki/concepts/b.md');
    }
    expect(existsSync(pagePath('wiki/concepts/a.md'))).toBe(false);
    expect(existsSync(join(kbPath, 'wiki', 'index.md'))).toBe(false);
    expect(readdirSync(wikiLayout(kbPath).transactionsDir)).toHaveLength(0);
  });

  it('全部拒绝 → nothingAccepted，不改变任何正式资产', async () => {
    const oldBody = pageBody('AXI 旧', '旧正文。');
    mkdirSync(join(kbPath, 'wiki', 'concepts'), { recursive: true });
    writeFileSync(pagePath('wiki/concepts/axi.md'), oldBody, 'utf-8');

    const csId = await stageMulti([
      { relPath: 'wiki/concepts/new.md', content: pageBody('新页', '新。') },
      { relPath: 'wiki/concepts/axi.md', content: pageBody('AXI 新', '新正文。') },
    ], {
      'wiki/concepts/new.md': 'rejected',
      'wiki/concepts/axi.md': 'rejected',
    });

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('nothingAccepted');
    expect(readFileSync(pagePath('wiki/concepts/axi.md'), 'utf-8')).toBe(oldBody);
    expect(existsSync(pagePath('wiki/concepts/new.md'))).toBe(false);
    expect(existsSync(join(kbPath, 'wiki', 'log.md'))).toBe(false);
  });
});

// ── 跨页链接校验 ────────────────────────────────────────────────

describe('跨页链接校验（最终候选集）', () => {
  it('拒绝目标新页却接受入链 → 阻止发布并定位到 hunk', async () => {
    const bodyA = pageBody('A', '参见 [[concepts/b|B 页]]。', [SRC_REF]);
    const csId = await stageMulti([
      { relPath: 'wiki/concepts/a.md', content: bodyA },
      { relPath: 'wiki/concepts/b.md', content: pageBody('B', 'B 正文。') },
    ], {
      'wiki/concepts/a.md': 'accepted',
      'wiki/concepts/b.md': 'rejected',
    });

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('unresolvedLink');
      const detail = res.error.detail?.join(' ') ?? '';
      expect(detail).toContain('wiki/concepts/a.md');
      expect(detail).toContain('concepts/b');
    }
    expect(existsSync(pagePath('wiki/concepts/a.md'))).toBe(false);
  });

  it('同一变更集内互链（目标页也被接受）→ 发布成功', async () => {
    const csId = await stageMulti([
      { relPath: 'wiki/concepts/a.md', content: pageBody('A', '参见 [[concepts/b]]。', [SRC_REF]) },
      { relPath: 'wiki/concepts/b.md', content: pageBody('B', '回链 [[concepts/a]]。', [SRC_REF]) },
    ], { 'wiki/concepts/a.md': 'accepted', 'wiki/concepts/b.md': 'accepted' });

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(true);
  });

  it('新增链接指向已发布页 → 发布成功；既有断链不阻断整库', async () => {
    // 预置一个已发布页（含历史断链 [[ghost]]）与目标页
    const seedP = pageBody('P', '历史断链 [[ghost]] 与目标 [[concepts/target]]。');
    mkdirSync(join(kbPath, 'wiki', 'concepts'), { recursive: true });
    writeFileSync(pagePath('wiki/concepts/p.md'), seedP, 'utf-8');
    writeFileSync(pagePath('wiki/concepts/target.md'), pageBody('Target', 'T。'), 'utf-8');

    // 更新 P：保留既有断链（非本次新增），新增一个指向已发布 target 的链接
    const updatedP = pageBody('P', '历史断链 [[ghost]] 与目标 [[concepts/target]]。另见 [[concepts/target]] 新增引用。');
    const csId = await stageMulti(
      [{ relPath: 'wiki/concepts/p.md', content: updatedP }],
      { 'wiki/concepts/p.md': 'accepted' },
    );

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.warnings.join(' ')).toContain('ghost');
    }
  });

  it('新增链接指向不存在的目标 → 阻止并定位', async () => {
    const csId = await stageMulti(
      [{ relPath: 'wiki/concepts/a.md', content: pageBody('A', '引用 [[concepts/missing]]。', [SRC_REF]) }],
      { 'wiki/concepts/a.md': 'accepted' },
    );
    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('unresolvedLink');
  });
});

// ── 逐 hunk 审阅与部分接受 ──────────────────────────────────────

describe('逐 hunk 审阅与 published_partial', () => {
  function seedExisting(): string {
    const oldBody = [
      '---',
      'type: concept',
      'title: "AXI"',
      'summary: 旧摘要。',
      'keywords: [AXI]',
      'tags: []',
      'sources: []',
      'created: "2026-09-13T00:00:00Z"',
      'updated: "2026-09-13T00:00:00Z"',
      '---',
      '',
      '# AXI',
      '',
      '第一段保持不变。',
      '第二段将被修改。',
      '第三段保持不变。',
      '第四段将被删除。',
    ].join('\n');
    mkdirSync(join(kbPath, 'wiki', 'concepts'), { recursive: true });
    writeFileSync(pagePath('wiki/concepts/axi.md'), oldBody, 'utf-8');
    return oldBody;
  }

  function proposedTwoHunks(): string {
    return [
      '---',
      'type: concept',
      'title: "AXI"',
      'summary: 新摘要。',
      'keywords: [AXI]',
      'tags: []',
      'sources: []',
      'created: "2026-09-13T00:00:00Z"',
      'updated: "2026-09-13T00:00:00Z"',
      '---',
      '',
      '# AXI',
      '',
      '第一段保持不变。',
      '第二段已被修改。',
      '第三段保持不变。',
    ].join('\n');
  }

  async function stageExistingUpdate(): Promise<{ csId: string; page: WikiStagedPage; oldBody: string }> {
    const oldBody = seedExisting();
    const staged = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/axi.md', proposedTwoHunks()),
    });
    if (!staged.ok) throw new Error(`stage: ${staged.error.code}`);
    const page = staged.value.changeSet.pages[0];
    return { csId: staged.value.changeSet.changeSetId, page, oldBody };
  }

  it('接受 frontmatter 块、拒绝正文块：frontmatter 更新、正文回退旧行，partial 标记', async () => {
    const { csId, page, oldBody } = await stageExistingUpdate();
    const diff = buildWikiPageDiff(page);
    expect(diff).not.toBeNull();
    const fmHunk = diff!.hunks.find((h) => h.kind === 'frontmatter');
    const bodyHunks = diff!.hunks.filter((h) => h.kind === 'body');
    expect(fmHunk).toBeDefined();
    expect(bodyHunks.length).toBeGreaterThan(0);

    await decideHunks(csId, page, [fmHunk!.id]);

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.partial).toBe(true);

    const published = readFileSync(pagePath('wiki/concepts/axi.md'), 'utf-8');
    expect(published).toContain('新摘要。'); // frontmatter 整体接受
    expect(published).toContain('第二段将被修改。'); // 拒绝的正文块回退旧行
    expect(published).toContain('第四段将被删除。');
    expect(published).not.toContain('第二段已被修改。');

    // review.published 携带 partial（published_partial 不冒充完整发布）
    const review = await readReview(kbPath, csId);
    expect(review.ok && review.value.published?.partial).toBe(true);
    // 历史记录的是重建后的最终候选
    const entry = JSON.parse(readFileSync(
      join(kbPath, '.kb', 'page-history', 'concepts__axi.jsonl'), 'utf-8',
    ).trim()) as WikiPageHistoryEntry;
    expect(entry.beforeHash).toBe(sha(oldBody));
    expect(entry.afterHash).toBe(sha(published));
  });

  it('接受部分正文 hunk：最终候选只含接受的改动（published_partial）', async () => {
    const oldBody = seedExisting();
    // 两个独立正文改动：第二段修改 + 第四段删除
    const proposed = [
      '---',
      'type: concept',
      'title: "AXI"',
      'summary: 旧摘要。',
      'keywords: [AXI]',
      'tags: []',
      'sources: []',
      'created: "2026-09-13T00:00:00Z"',
      'updated: "2026-09-13T00:00:00Z"',
      '---',
      '',
      '# AXI',
      '',
      '第一段保持不变。',
      '第二段已被修改。',
      '第三段保持不变。',
    ].join('\n');
    const staged = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/axi.md', proposed),
    });
    if (!staged.ok) throw new Error('stage');
    const csId = staged.value.changeSet.changeSetId;
    const page = staged.value.changeSet.pages[0];
    const diff = buildWikiPageDiff(page);
    expect(diff).not.toBeNull();
    const bodyHunks = diff!.hunks.filter((h) => h.kind === 'body');
    expect(bodyHunks.length).toBe(2);
    // 只接受第一个正文 hunk（第二段修改），拒绝删除第四段的 hunk
    await decideHunks(csId, page, [bodyHunks[0].id]);

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.partial).toBe(true);

    const published = readFileSync(pagePath('wiki/concepts/axi.md'), 'utf-8');
    expect(published).toContain('第二段已被修改。');
    expect(published).toContain('第四段将被删除。');
    expect(published).not.toBe(oldBody);
    expect(published).not.toBe(proposed);
  });

  it('所有 hunk 接受 == proposed（partial=false）', async () => {
    const { csId, page } = await stageExistingUpdate();
    await decideHunks(csId, page, wikiRealHunkIds(page));
    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.partial).toBe(false);
      expect(readFileSync(pagePath('wiki/concepts/axi.md'), 'utf-8')).toBe(proposedTwoHunks());
    }
  });

  it('已接受页 + 另一页有未处置 hunk → pendingDecisions 定位 hunk id', async () => {
    seedExisting();
    // 同一变更集：已有页更新 + 新页
    const staged = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't2', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: [
        fileBlock('wiki/concepts/axi.md', proposedTwoHunks()),
        fileBlock('wiki/concepts/new2.md', pageBody('新2', '新内容。')),
      ].join('\n'),
    });
    if (!staged.ok) throw new Error(`stage: ${staged.error.code}`);
    const csId = staged.value.changeSet.changeSetId;
    const page = staged.value.changeSet.pages.find((p) => p.relPath === 'wiki/concepts/axi.md');
    const newPage = staged.value.changeSet.pages.find((p) => p.relPath === 'wiki/concepts/new2.md');
    if (!page || !newPage) throw new Error('staged pages missing');
    const diff = buildWikiPageDiff(page)!;
    const bodyHunks = diff.hunks.filter((h) => h.kind === 'body');
    // 新页整页接受；已有页只处置第一个正文 hunk（frontmatter 与第二个正文块仍待决）
    const recNew = await recordDecision(kbPath, { changeSetId: csId, pageRelPath: newPage.relPath, hunkIds: [0], decision: 'accepted' });
    if (!recNew.ok) throw new Error('decide new');
    const recBody = await recordDecision(kbPath, { changeSetId: csId, pageRelPath: page.relPath, hunkIds: [bodyHunks[0].id], decision: 'accepted' });
    if (!recBody.ok) throw new Error('decide body');

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('pendingDecisions');
      // detail 定位未处置的 hunk id（含第二个正文块）
      const detail = res.error.detail?.join(' ') ?? '';
      expect(detail).toContain(page.relPath);
      expect(detail).toMatch(new RegExp(`hunk [0-9, ]*${bodyHunks[1].id}`));
    }
  });

  it('recordDecision 持久差异指纹；差异重算后旧决定失效（stale）', async () => {
    const { csId, page } = await stageExistingUpdate();
    await decideHunks(csId, page, wikiRealHunkIds(page));

    // 指纹已随选择持久
    const review = await readReview(kbPath, csId);
    expect(review.ok && review.value.pages[0].hunksHash).toBe(wikiPageDiffFingerprint(page));

    // 模拟候选重新生成：直接改 staging 的 proposed（旧决定基于旧差异）
    const layout = wikiLayout(kbPath);
    const stagingFile = join(layout.stagingDir, `${csId}.json`);
    const cs = JSON.parse(readFileSync(stagingFile, 'utf-8')) as { pages: Array<Record<string, unknown>> };
    cs.pages[0].proposed = (cs.pages[0].proposed as string).replace('新摘要。', '重算摘要。');
    writeFileSync(stagingFile, JSON.stringify(cs, null, 2), 'utf-8');

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('stale');
      expect(res.error.detail?.join(' ')).toMatch(/差异|重新|失效/);
    }
    // 旧批准已重置
    const after = await readReview(kbPath, csId);
    if (after.ok) {
      const states = Object.values(after.value.pages[0].hunkStates);
      expect(states.length).toBeGreaterThan(0);
      expect(states.every((s) => s === 'pending')).toBe(true);
    }
  });
});

// ── 故障与并发 ──────────────────────────────────────────────────

describe('多页发布故障与并发', () => {
  it('第二页写失败（complete 阶段）→ 进程内回滚，第一页也不存在（完整旧版）', async () => {
    const csId = await stageMulti([
      { relPath: 'wiki/concepts/a.md', content: pageBody('A', 'A。') },
      { relPath: 'wiki/concepts/b.md', content: pageBody('B', 'B。') },
    ], { 'wiki/concepts/a.md': 'accepted', 'wiki/concepts/b.md': 'accepted' });

    const prepared = await preparePublish(kbPath, { kbId: 'kb-1', changeSetId: csId, commitId: 'tx-page2' });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    // 故障注入：第二页目标被目录占位 → rename 必败
    mkdirSync(pagePath('wiki/concepts/b.md'), { recursive: true });

    const done = await completePublish(kbPath, prepared.plan.commitId);
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error.code).toBe('ioError');

    // 已应用的第一页被回滚
    expect(existsSync(pagePath('wiki/concepts/a.md'))).toBe(false);
    expect(statSync(pagePath('wiki/concepts/b.md')).isDirectory()).toBe(true);
    expect(readdirSync(wikiLayout(kbPath).transactionsDir)).toHaveLength(0);
  });

  it('相邻任务发布串行化：并发发布不交错，revision 单调递增', async () => {
    const csA = await stageMulti([{ relPath: 'wiki/concepts/a.md', content: pageBody('A', 'A。') }], { 'wiki/concepts/a.md': 'accepted' });
    const csB = await stageMulti([{ relPath: 'wiki/concepts/b.md', content: pageBody('B', 'B。') }], { 'wiki/concepts/b.md': 'accepted' });

    const [ra, rb] = await Promise.all([
      publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csA }),
      publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csB }),
    ]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    if (ra.ok && rb.ok) {
      expect([ra.revision, rb.revision].sort()).toEqual([1, 2]);
      // 两个任务的聚合视图一致：index 同时含两页
      const index = readFileSync(join(kbPath, 'wiki', 'index.md'), 'utf-8');
      expect(index).toContain('[[concepts/a|A]]');
      expect(index).toContain('[[concepts/b|B]]');
    }
  });

  it('相邻任务写同一页：后者基线已变 → stale，不覆盖前者的发布', async () => {
    const oldBody = pageBody('AXI 旧', '旧。');
    mkdirSync(join(kbPath, 'wiki', 'concepts'), { recursive: true });
    writeFileSync(pagePath('wiki/concepts/axi.md'), oldBody, 'utf-8');

    const csA = await stageMulti([{ relPath: 'wiki/concepts/axi.md', content: pageBody('AXI A', 'A 版。') }], { 'wiki/concepts/axi.md': 'accepted' });
    const csB = await stageMulti([{ relPath: 'wiki/concepts/axi.md', content: pageBody('AXI B', 'B 版。') }], { 'wiki/concepts/axi.md': 'accepted' });

    const ra = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csA });
    expect(ra.ok).toBe(true);
    const rb = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csB });
    expect(rb.ok).toBe(false);
    if (!rb.ok) expect(rb.error.code).toBe('stale');
    expect(readFileSync(pagePath('wiki/concepts/axi.md'), 'utf-8')).toBe(pageBody('AXI A', 'A 版。'));
  });

  it('外部修改第二页 → stale 且 detail 定位到该页', async () => {
    const oldB = pageBody('B 旧', '旧正文。');
    mkdirSync(join(kbPath, 'wiki', 'concepts'), { recursive: true });
    writeFileSync(pagePath('wiki/concepts/b.md'), oldB, 'utf-8');

    const csId = await stageMulti([
      { relPath: 'wiki/concepts/a.md', content: pageBody('A', 'A。') },
      { relPath: 'wiki/concepts/b.md', content: pageBody('B 新', '新正文。') },
    ], { 'wiki/concepts/a.md': 'accepted', 'wiki/concepts/b.md': 'accepted' });

    writeFileSync(pagePath('wiki/concepts/b.md'), pageBody('B 外部', '外部改。'), 'utf-8');

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('stale');
      expect(res.error.detail?.join(' ')).toContain('wiki/concepts/b.md');
    }
    // 两页都未发布
    expect(existsSync(pagePath('wiki/concepts/a.md'))).toBe(false);
  });
});
