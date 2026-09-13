/**
 * 单页发布服务测试（issue 06）。
 *
 * 覆盖验收：
 *  - 整页接受/拒绝持久保存；发布前校验读/写集与来源/规则基线，变动转 stale 并失效旧批准；
 *  - 旧内容快照、事务清单与 commitId 持久后才替换；重启读取门禁先恢复；
 *  - 正式页与确定性 index/overview/log/manifest 属同一次提交；日志与历史幂等；
 *  - 创建页 before 不存在、失败/拒绝无正式改动；外部改文件可检测，权限不扩至项目外；
 *  - 每步故障注入验证完整旧版或完整新版。
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
  appendHistoryEntryIdempotent,
  historyFilePath,
} from '../src/main/kb/publish';
import { stageProposal, recordDecision, readReview, readChangeSet } from '../src/main/kb/staging';
import { wikiRealHunkIds } from '../src/shared/wiki-hunks';
import { initWikiLayout, SCHEMA_MD_SKELETON, wikiLayout, readWikiManifest, writeWikiManifest } from '../src/main/kb/wiki-layout';
import { recoverTransactions } from '../src/main/kb/atomic-commit';
import { readGateStatus } from '../src/main/kb/read-gate';
import type { WikiPageHistoryEntry, WikiSourceRef } from '@shared/kb-types';

let kbPath: string;

const SRC_REF: WikiSourceRef = {
  sourceId: 'a'.repeat(64),
  sourceRevision: 'b'.repeat(64),
  parsedHash: 'c'.repeat(64),
};

const sha = (text: string): string => createHash('sha256').update(text, 'utf-8').digest('hex');

/** 在 manifest 中登记提案引用的来源修订（真实编译链路的等价前置） */
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
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-publish-'));
  await initWikiLayout(kbPath, { kbId: 'kb-1', name: 'KB' });
  // 提案引用的来源修订必须已登记（来源撤回/未登记会被判 stale）
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

/** 通过公开生产边界（stageProposal）投递提案并落一条整页接受决策 */
async function stageAndAccept(
  relPath: string,
  content: string,
  extra: { fixedSourcePageId?: string; readBaseline?: Array<{ pageId: string; hash: string | null }> } = {},
): Promise<string> {
  const staged = await stageProposal(kbPath, {
    kbId: 'kb-1',
    taskId: 'task-1',
    origin: 'compile',
    sourceRefs: [SRC_REF],
    proposalText: fileBlock(relPath, content),
    ...extra,
  });
  if (!staged.ok) throw new Error(`stage: ${staged.error.code} ${staged.error.message}`);
  const changeSetId = staged.value.changeSet.changeSetId;
  const page = staged.value.changeSet.pages.find((p) => p.relPath === relPath);
  if (!page) throw new Error('staged page missing');
  // 整页接受 = 处置全部真实 hunk（新页为 hunk 0；已有页为 1..n，issue 07）
  const rec = await recordDecision(kbPath, {
    changeSetId,
    pageRelPath: relPath,
    hunkIds: wikiRealHunkIds(page),
    decision: 'accepted',
  });
  if (!rec.ok) throw new Error(`decide: ${rec.error.code}`);
  return changeSetId;
}

const publishedPagePath = (relPath: string): string => join(kbPath, relPath);

// ── 新页发布 ────────────────────────────────────────────────────

describe('publishChangeSet — 新建页', () => {
  it('正式页与确定性 index/overview/log/manifest 属同一次提交', async () => {
    const body = pageBody('AXI 限制', '正文 A。', [SRC_REF]);
    const csId = await stageAndAccept('wiki/concepts/axi.md', body);

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId, now: '2026-09-13T10:00:00Z' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.commitId).toBeTruthy();
    expect(res.revision).toBe(1);
    expect(res.pages).toEqual([{
      pageId: 'concepts/axi',
      relPath: 'wiki/concepts/axi.md',
      operation: 'create',
      beforeHash: null,
      afterHash: sha(body),
    }]);

    // 正式页
    expect(readFileSync(publishedPagePath('wiki/concepts/axi.md'), 'utf-8')).toBe(body);
    // 确定性聚合
    expect(readFileSync(join(kbPath, 'wiki', 'index.md'), 'utf-8')).toContain('[[concepts/axi|AXI 限制]]');
    expect(readFileSync(join(kbPath, 'wiki', 'overview.md'), 'utf-8')).toContain('共 1 页');
    // 日志（含 commitId）
    const log = readFileSync(join(kbPath, 'wiki', 'log.md'), 'utf-8');
    expect(log).toContain('## [2026-09-13T10:00:00Z] publish | wiki/concepts/axi.md');
    expect(log).toContain(res.commitId);
    // manifest 发布 revision
    const manifest = await readWikiManifest(kbPath);
    expect(manifest.ok).toBe(true);
    if (manifest.ok) {
      expect(manifest.manifest.publish?.revision).toBe(1);
      expect(manifest.manifest.publish?.commitId).toBe(res.commitId);
    }
    // 事务目录清理（读取门禁放行）
    expect(readdirSync(wikiLayout(kbPath).transactionsDir)).toHaveLength(0);
    expect((await readGateStatus(kbPath)).blocked).toBe(false);
  });

  it('创建页 before 不存在：历史记 create 且 beforeHash 为 null', async () => {
    const body = pageBody('新页', '新内容。');
    const csId = await stageAndAccept('wiki/concepts/new.md', body);
    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(true);

    const history = readFileSync(historyFilePath(kbPath, 'concepts/new'), 'utf-8').trim().split('\n');
    expect(history).toHaveLength(1);
    const entry = JSON.parse(history[0]) as WikiPageHistoryEntry;
    expect(entry.operation).toBe('create');
    expect(entry.beforeHash).toBeNull();
    expect(entry.afterHash).toBe(sha(body));
    expect(entry.pageId).toBe('concepts/new');
  });

  it('纯规划 buildPublishPlan 返回同一次提交的完整写集，且不改动磁盘', async () => {
    const csId = await stageAndAccept('wiki/concepts/axi.md', pageBody('AXI', 'A。'));
    const built = await buildPublishPlan(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const rel = built.plan.writes.map((w) => w.relPath).sort();
    expect(rel).toEqual([
      '.kb/manifest.json',
      `.kb/page-history/concepts__axi.jsonl`,
      `.kb/reviews/${csId}.json`,
      'wiki/concepts/axi.md',
      'wiki/index.md',
      'wiki/log.md',
      'wiki/overview.md',
    ]);
    // 规划阶段不写盘
    expect(existsSync(join(kbPath, 'wiki', 'concepts', 'axi.md'))).toBe(false);
    expect(existsSync(join(kbPath, 'wiki', 'index.md'))).toBe(false);
  });
});

// ── 已有页更新 ──────────────────────────────────────────────────

describe('publishChangeSet — 更新已发布页', () => {
  it('替换正式页、写 update 历史（含旧内容 hash）并刷新聚合', async () => {
    const oldBody = pageBody('AXI 旧版', '旧正文。');
    mkdirSync(join(kbPath, 'wiki', 'concepts'), { recursive: true });
    writeFileSync(join(kbPath, 'wiki', 'concepts', 'axi.md'), oldBody, 'utf-8');

    const newBody = pageBody('AXI 新版', '新正文。');
    const csId = await stageAndAccept('wiki/concepts/axi.md', newBody);
    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pages[0].operation).toBe('update');
    expect(res.pages[0].beforeHash).toBe(sha(oldBody));

    expect(readFileSync(publishedPagePath('wiki/concepts/axi.md'), 'utf-8')).toBe(newBody);
    expect(readFileSync(join(kbPath, 'wiki', 'index.md'), 'utf-8')).toContain('AXI 新版');

    const entry = JSON.parse(readFileSync(historyFilePath(kbPath, 'concepts/axi'), 'utf-8').trim().split('\n')[0]) as WikiPageHistoryEntry;
    expect(entry.beforeHash).toBe(sha(oldBody));
    expect(entry.afterHash).toBe(sha(newBody));
  });

  it('第二次发布 revision 递增', async () => {
    const cs1 = await stageAndAccept('wiki/concepts/a.md', pageBody('A', 'A。'));
    const r1 = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: cs1 });
    expect(r1.ok && r1.revision).toBe(1);

    const cs2 = await stageAndAccept('wiki/concepts/b.md', pageBody('B', 'B。'));
    const r2 = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: cs2 });
    expect(r2.ok && r2.revision).toBe(2);
  });
});

// ── 拒绝 / 未处置 ───────────────────────────────────────────────

describe('publishChangeSet — 拒绝保持原样', () => {
  it('整页拒绝：不写任何正式资产，返回 nothingAccepted', async () => {
    const staged = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/axi.md', pageBody('AXI', 'A。')),
    });
    if (!staged.ok) throw new Error('stage');
    const csId = staged.value.changeSet.changeSetId;
    await recordDecision(kbPath, { changeSetId: csId, pageRelPath: 'wiki/concepts/axi.md', hunkIds: [0], decision: 'rejected' });

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('nothingAccepted');

    expect(existsSync(join(kbPath, 'wiki', 'concepts', 'axi.md'))).toBe(false);
    expect(existsSync(join(kbPath, 'wiki', 'index.md'))).toBe(false);
    expect(existsSync(join(kbPath, 'wiki', 'log.md'))).toBe(false);
    expect(readdirSync(wikiLayout(kbPath).transactionsDir)).toHaveLength(0);
  });

  it('未处置（pending）不发布：nothingAccepted（与既有口径一致）', async () => {
    const staged = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/axi.md', pageBody('AXI', 'A。')),
    });
    if (!staged.ok) throw new Error('stage');
    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: staged.value.changeSet.changeSetId });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('nothingAccepted');
  });
});

// ── 基线校验 → stale ────────────────────────────────────────────

describe('publishChangeSet — 基线变动转 stale 并失效旧批准', () => {
  it('外部改写目标页 → stale，旧批准被重置，提案内容未发布', async () => {
    const oldBody = pageBody('AXI 旧版', '旧正文。');
    mkdirSync(join(kbPath, 'wiki', 'concepts'), { recursive: true });
    writeFileSync(join(kbPath, 'wiki', 'concepts', 'axi.md'), oldBody, 'utf-8');

    const csId = await stageAndAccept('wiki/concepts/axi.md', pageBody('AXI 新版', '新正文。'));
    // 外部改文件（不经过审阅/发布流程）
    const external = pageBody('AXI 被外部改', '别人改的。');
    writeFileSync(join(kbPath, 'wiki', 'concepts', 'axi.md'), external, 'utf-8');

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('stale');
      expect(res.error.detail?.join(' ')).toMatch(/基线/);
    }
    // 未覆盖外部内容
    expect(readFileSync(publishedPagePath('wiki/concepts/axi.md'), 'utf-8')).toBe(external);
    // 旧批准已失效
    const review = await readReview(kbPath, csId);
    expect(review.ok).toBe(true);
    if (review.ok) {
      expect(review.value.stale).toBeTruthy();
      const states = Object.values(review.value.pages[0].hunkStates);
      expect(states.length).toBeGreaterThan(0);
      expect(states.every((s) => s === 'pending')).toBe(true);
      expect(review.value.settled).toBe(false);
    }
  });

  it('新页目标被外部创建 → stale', async () => {
    const csId = await stageAndAccept('wiki/concepts/new.md', pageBody('新页', '新。'));
    mkdirSync(join(kbPath, 'wiki', 'concepts'), { recursive: true });
    writeFileSync(join(kbPath, 'wiki', 'concepts', 'new.md'), pageBody('外部版', '外部。'), 'utf-8');

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('stale');
  });

  it('规则（schema）基线变动 → stale', async () => {
    const csId = await stageAndAccept('wiki/concepts/axi.md', pageBody('AXI', 'A。'));
    writeFileSync(join(kbPath, 'schema.md'), `${SCHEMA_MD_SKELETON}\n额外写作要求。\n`, 'utf-8');

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('stale');
      expect(res.error.detail?.join(' ')).toMatch(/schema/);
    }
  });

  it('来源修订变动 → stale', async () => {
    const csId = await stageAndAccept('wiki/concepts/axi.md', pageBody('AXI', 'A。', [SRC_REF]));
    // 来源被重新导入（修订推进）后，旧提案的固定修订已过时
    await registerSource(SRC_REF, 'f'.repeat(64));

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('stale');
      expect(res.error.detail?.join(' ')).toMatch(/来源/);
    }
  });

  it('来源已撤回（manifest 无记录）→ stale', async () => {
    const csId = await stageAndAccept('wiki/concepts/axi.md', pageBody('AXI', 'A。', [SRC_REF]));
    const manifest = await readWikiManifest(kbPath);
    if (!manifest.ok) throw new Error('manifest');
    await writeWikiManifest(kbPath, { ...manifest.manifest, sources: {} });

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('stale');
  });

  it('读集（readBaseline）页内容变动 → stale', async () => {
    const otherBody = pageBody('其它页', '其它正文。');
    mkdirSync(join(kbPath, 'wiki', 'concepts'), { recursive: true });
    writeFileSync(join(kbPath, 'wiki', 'concepts', 'other.md'), otherBody, 'utf-8');

    const csId = await stageAndAccept('wiki/concepts/axi.md', pageBody('AXI', 'A。'), {
      readBaseline: [{ pageId: 'concepts/other', hash: sha(otherBody) }],
    });
    writeFileSync(join(kbPath, 'wiki', 'concepts', 'other.md'), pageBody('其它页改', '改了。'), 'utf-8');

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('stale');
      expect(res.error.detail?.join(' ')).toMatch(/读集|concepts\/other/);
    }
  });
});

// ── 边界与权限 ──────────────────────────────────────────────────

describe('publishChangeSet — 边界', () => {
  it('变更集不存在 → changeSetNotFound', async () => {
    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: 'nope' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('changeSetNotFound');
  });

  it('kbId 不符 → kbIdMismatch', async () => {
    const csId = await stageAndAccept('wiki/concepts/axi.md', pageBody('AXI', 'A。'));
    const res = await publishChangeSet(kbPath, { kbId: 'kb-other', changeSetId: csId });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('kbIdMismatch');
  });

  it('多页变更集存在未决页 → pendingDecisions（issue 07：多页须全部处置）', async () => {
    const staged = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: [
        fileBlock('wiki/concepts/a.md', pageBody('A', 'A。')),
        fileBlock('wiki/concepts/b.md', pageBody('B', 'B。')),
      ].join('\n'),
    });
    if (!staged.ok) throw new Error('stage');
    const csId = staged.value.changeSet.changeSetId;
    await recordDecision(kbPath, { changeSetId: csId, pageRelPath: 'wiki/concepts/a.md', hunkIds: [0], decision: 'accepted' });

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('pendingDecisions');
      expect(res.error.detail?.join(' ')).toContain('wiki/concepts/b.md');
    }
  });

  it('写入目标越出受管范围（被篡改的 staging）→ invalidTarget，不落盘', async () => {
    const csId = await stageAndAccept('wiki/concepts/axi.md', pageBody('AXI', 'A。'));
    // 篡改 staging：目标改为 raw/（模型不可写），决策同步改键以绕不过「已接受」检查
    const layout = wikiLayout(kbPath);
    const stagingFile = join(layout.stagingDir, `${csId}.json`);
    const cs = JSON.parse(readFileSync(stagingFile, 'utf-8')) as { pages: Array<Record<string, unknown>> };
    cs.pages[0].relPath = 'raw/sources/evil.md';
    cs.pages[0].pageId = 'sources/evil';
    writeFileSync(stagingFile, JSON.stringify(cs, null, 2), 'utf-8');

    const reviewFile = join(layout.reviewsDir, `${csId}.json`);
    const review = JSON.parse(readFileSync(reviewFile, 'utf-8')) as { pages: Array<Record<string, unknown>> };
    review.pages[0].relPath = 'raw/sources/evil.md';
    review.pages[0].hunkStates = { 0: 'accepted' };
    writeFileSync(reviewFile, JSON.stringify(review, null, 2), 'utf-8');

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invalidTarget');
    expect(existsSync(join(kbPath, 'raw', 'sources', 'evil.md'))).toBe(false);
    expect(readdirSync(layout.transactionsDir)).toHaveLength(0);
  });
});

// ── 故障注入：完整旧版 / 完整新版 ───────────────────────────────

describe('发布事务故障注入', () => {
  it('prepare 阶段失败（镜像写不进）→ 完整旧版，无任何正式改动', async () => {
    const oldBody = pageBody('AXI 旧版', '旧正文。');
    mkdirSync(join(kbPath, 'wiki', 'concepts'), { recursive: true });
    writeFileSync(join(kbPath, 'wiki', 'concepts', 'axi.md'), oldBody, 'utf-8');

    const csId = await stageAndAccept('wiki/concepts/axi.md', pageBody('AXI 新版', '新正文。'));

    // 故障注入：用目录占位 log.md 目标 → prepare 读 before 镜像必败
    mkdirSync(join(kbPath, 'wiki', 'log.md'), { recursive: true });

    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('ioError');

    // 完整旧版：正式页仍是旧内容，聚合页/日志未生成，事务现场清理
    expect(readFileSync(publishedPagePath('wiki/concepts/axi.md'), 'utf-8')).toBe(oldBody);
    expect(existsSync(join(kbPath, 'wiki', 'index.md'))).toBe(false);
    expect(statSync(join(kbPath, 'wiki', 'log.md')).isDirectory()).toBe(true);
    expect(readdirSync(wikiLayout(kbPath).transactionsDir)).toHaveLength(0);
  });

  it('complete 阶段 rename 失败 → 进程内回滚，保持完整旧版', async () => {
    const csId = await stageAndAccept('wiki/concepts/axi.md', pageBody('AXI 新版', '新正文。'));
    const prepared = await preparePublish(kbPath, { kbId: 'kb-1', changeSetId: csId, commitId: 'tx-inject' });
    if (!prepared.ok) throw new Error(`plan: ${prepared.error.code}`);

    // 事务清单与旧内容快照先持久，目标尚未改变
    expect(existsSync(join(kbPath, 'wiki', 'concepts', 'axi.md'))).toBe(false);

    // 故障注入：用目录占位后续写入目标 → rename 必败
    mkdirSync(join(kbPath, 'wiki', 'index.md'), { recursive: true });

    const done = await completePublish(kbPath, prepared.plan.commitId);
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error.code).toBe('ioError');

    // 已应用的写入被回滚：新页不存在（完整旧版）
    expect(existsSync(join(kbPath, 'wiki', 'concepts', 'axi.md'))).toBe(false);
    expect(statSync(join(kbPath, 'wiki', 'index.md')).isDirectory()).toBe(true);
    expect(readdirSync(wikiLayout(kbPath).transactionsDir)).toHaveLength(0);
  });

  it('prepare 后中断 → 读取门禁阻塞；恢复后 roll-forward 到完整新版', async () => {
    const body = pageBody('AXI', 'A。');
    const csId = await stageAndAccept('wiki/concepts/axi.md', body);
    const prepared = await preparePublish(kbPath, { kbId: 'kb-1', changeSetId: csId, commitId: 'tx-crash' });
    if (!prepared.ok) throw new Error(`plan: ${prepared.error.code}`);

    // 模拟崩溃：prepared 清单已持久、rename 未做 → 重启时读取必须先暂停
    const gate = await readGateStatus(kbPath);
    expect(gate.blocked).toBe(true);
    expect(gate.pending).toEqual(['tx-crash']);

    // 事务清单已持久化读/写集 hash、目标 revision 与 commitId（spec §6）
    const txManifest = JSON.parse(readFileSync(
      join(wikiLayout(kbPath).transactionsDir, 'tx-crash', 'manifest.json'),
      'utf-8',
    )) as { txId: string; state: string; meta: { revision: number; writeSetHash: string; readSetHash: string } };
    expect(txManifest.txId).toBe('tx-crash');
    expect(txManifest.state).toBe('prepared');
    expect(txManifest.meta.revision).toBe(1);
    expect(txManifest.meta.writeSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(txManifest.meta.readSetHash).toMatch(/^[0-9a-f]{64}$/);

    const report = await recoverTransactions(kbPath);
    expect(report.rolledForward).toBe(1);

    // 完整新版
    expect(readFileSync(publishedPagePath('wiki/concepts/axi.md'), 'utf-8')).toBe(body);
    expect(readFileSync(join(kbPath, 'wiki', 'index.md'), 'utf-8')).toContain('[[concepts/axi|AXI]]');
    expect(readFileSync(join(kbPath, 'wiki', 'log.md'), 'utf-8')).toContain('tx-crash');
    expect((await readGateStatus(kbPath)).blocked).toBe(false);
  });
});

// ── 幂等 ────────────────────────────────────────────────────────

describe('日志与历史幂等', () => {
  it('同一 commitId 的日志不重复追加', async () => {
    const csId = await stageAndAccept('wiki/concepts/axi.md', pageBody('AXI', 'A。'));
    const res = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId, commitId: 'fixed-commit' });
    expect(res.ok).toBe(true);
    const log = readFileSync(join(kbPath, 'wiki', 'log.md'), 'utf-8');
    expect(log.match(/fixed-commit/g)).toHaveLength(1);
  });

  it('appendHistoryEntryIdempotent：同 commitId 不重复，不同 commitId 追加', () => {
    const base: WikiPageHistoryEntry = {
      commitId: 'c1', changeSetId: 'cs', pageId: 'concepts/a', relPath: 'wiki/concepts/a.md',
      operation: 'create', beforeHash: null, afterHash: 'h1', sources: [], at: '2026-09-13T00:00:00Z',
    };
    const once = appendHistoryEntryIdempotent(null, base);
    expect(appendHistoryEntryIdempotent(once, base)).toBe(once);

    const second = { ...base, commitId: 'c2', afterHash: 'h2' };
    const twice = appendHistoryEntryIdempotent(once, second);
    expect(twice.trim().split('\n')).toHaveLength(2);
  });

  it('同一变更集重复发布：第二次不再改动（staging 保留 published 记录）', async () => {
    const csId = await stageAndAccept('wiki/concepts/axi.md', pageBody('AXI', 'A。'));
    const first = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId, commitId: 'c-first' });
    expect(first.ok).toBe(true);

    const reread = await readChangeSet(kbPath, csId);
    expect(reread.ok).toBe(true);
    const review = await readReview(kbPath, csId);
    expect(review.ok).toBe(true);
    if (review.ok) expect(review.value.published?.commitId).toBe('c-first');

    const logAfterFirst = readFileSync(join(kbPath, 'wiki', 'log.md'), 'utf-8');
    const second = await publishChangeSet(kbPath, { kbId: 'kb-1', changeSetId: csId, commitId: 'c-second' });
    // 已发布过的提案不再静默重复发布
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('alreadyPublished');
    expect(readFileSync(join(kbPath, 'wiki', 'log.md'), 'utf-8')).toBe(logAfterFirst);
  });
});
