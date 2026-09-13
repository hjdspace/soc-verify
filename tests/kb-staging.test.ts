/**
 * KB staging 持久化测试（issue 05 后半）。
 *
 * 验收：
 *  - 持久保存 changeSetId、任务身份、read/write baseline、before/proposed
 *    与来源引用；
 *  - 重开仍可审阅，正式 Wiki/索引没有改变；
 *  - 完整 FILE 块经过同一个路径/真实父目录沙箱（聚合页、原件、应用状态
 *    不可成为模型目标）；
 *  - 重复目标、缺结束、坏类型/来源失败可见；源摘要归属由应用固定；
 *  - 知识待办输出暂保存为结构化附件（issue 25 消费同一结构）；
 *  - 决策持久：逐 hunk 接受/拒绝可读回。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  stageProposal,
  listChangeSets,
  readChangeSet,
  recordDecision,
  readReview,
  invalidateReview,
} from '../src/main/kb/staging';
import { initWikiLayout, SCHEMA_MD_SKELETON, PURPOSE_MD_SKELETON, wikiLayout } from '../src/main/kb/wiki-layout';
import type { WikiSourceRef } from '@shared/kb-types';

let kbPath: string;

const SRC_REF: WikiSourceRef = {
  sourceId: 'a'.repeat(64),
  sourceRevision: 'b'.repeat(64),
  parsedHash: 'c'.repeat(64),
};

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-staging-'));
  await initWikiLayout(kbPath, { kbId: 'kb-1', name: 'KB' });
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

function pageBody(type: string, title: string, sources: WikiSourceRef[] = []): string {
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
    '正文。',
  ].join('\n');
}

/** 通过公开生产边界投递提案文本（FILE 块字符串） */
const fileBlock = (p: string, body: string): string => `---FILE: ${p}---\n${body}\n---END FILE---`;

describe('stageProposal — 接受 FILE 提案并持久', () => {
  it('持久保存 changeSetId、任务身份、baseline、before/proposed 与来源引用', async () => {
    const res = await stageProposal(kbPath, {
      kbId: 'kb-1',
      taskId: 'task-1',
      origin: 'compile',
      sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/axi.md', pageBody('concept', 'AXI', [SRC_REF])),
      schemaHash: 'sh',
      purposeHash: 'ph',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const cs = res.value.changeSet;
    expect(cs.changeSetId).toBeTruthy();
    expect(cs.taskId).toBe('task-1');
    expect(cs.pages).toHaveLength(1);
    expect(cs.pages[0].relPath).toBe('wiki/concepts/axi.md');
    expect(cs.pages[0].before).toBeNull(); // 新页
    expect(cs.pages[0].proposed).toContain('# AXI');

    // 磁盘持久：staging 文件存在
    const stagingDir = wikiLayout(kbPath).stagingDir;
    const files = readdirSync(stagingDir).filter((f) => f.endsWith('.json'));
    expect(files).toContain(`${cs.changeSetId}.json`);
  });

  it('正式 wiki/ 在 staging 阶段没有改变', async () => {
    await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/axi.md', pageBody('concept', 'AXI', [SRC_REF])),
      schemaHash: 'sh', purposeHash: 'ph',
    });
    expect(existsSync(join(kbPath, 'wiki', 'concepts', 'axi.md'))).toBe(false);
  });

  it('重开仍可审阅（读回同一变更集）', async () => {
    const res = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/a.md', pageBody('concept', 'A', [SRC_REF])),
      schemaHash: 'sh', purposeHash: 'ph',
    });
    if (!res.ok) throw new Error('stage');
    const reread = await readChangeSet(kbPath, res.value.changeSet.changeSetId);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.value.pages[0].proposed).toContain('# A');
  });

  it('已有页提案保存 before 与 baselineHash', async () => {
    // 预置一个已发布页
    const published = pageBody('concept', 'AXI 旧版');
    mkdirSync(join(kbPath, 'wiki', 'concepts'), { recursive: true });
    writeFileSync(join(kbPath, 'wiki', 'concepts', 'axi.md'), published, 'utf-8');

    const res = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/axi.md', pageBody('concept', 'AXI 新版', [SRC_REF])),
      schemaHash: 'sh', purposeHash: 'ph',
    });
    if (!res.ok) throw new Error('stage');
    const page = res.value.changeSet.pages[0];
    expect(page.before).toBe(published);
    expect(page.baselineHash).toBe(createHash('sha256').update(published).digest('hex'));
    // 已发布页未被改写
    expect(readFileSync(join(kbPath, 'wiki', 'concepts', 'axi.md'), 'utf-8')).toBe(published);
  });

  it('新页提案 before 与 baselineHash 同为 null（不设哨兵字符串）', async () => {
    const res = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/new.md', pageBody('concept', '新页', [SRC_REF])),
      schemaHash: 'sh', purposeHash: 'ph',
    });
    if (!res.ok) throw new Error('stage');
    const page = res.value.changeSet.pages[0];
    expect(page.before).toBeNull();
    expect(page.baselineHash).toBeNull();
    // 序列化往返后不退化出占位字符串
    const reread = await readChangeSet(kbPath, res.value.changeSet.changeSetId);
    if (!reread.ok) throw new Error('reread');
    expect(reread.value.pages[0].baselineHash).toBeNull();
  });

  it('完整 FILE 块经路径沙箱：聚合页/原件/应用状态不可成为目标', async () => {
    for (const bad of ['wiki/index.md', 'raw/sources/x.md', '.kb/manifest.json', 'wiki/misc/x.md']) {
      const res = await stageProposal(kbPath, {
        kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
        proposalText: fileBlock(bad, pageBody('concept', 'Bad')),
        schemaHash: 'sh', purposeHash: 'ph',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('invalidTarget');
    }
  });

  it('重复目标失败可见', async () => {
    const text = [fileBlock('wiki/concepts/dup.md', pageBody('concept', 'D1')), fileBlock('wiki/concepts/dup.md', pageBody('concept', 'D2'))].join('\n');
    const res = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: text, schemaHash: 'sh', purposeHash: 'ph',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('duplicateTarget');
    // 无任何 staging 文件落盘
    expect(readdirSync(wikiLayout(kbPath).stagingDir).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('坏 frontmatter 类型失败可见', async () => {
    const bad = ['---', 'type: notatype', 'title: "X"', 'summary: s', 'keywords: []', 'tags: []', 'sources: []',
      'created: "2026-09-13T00:00:00Z"', 'updated: "2026-09-13T00:00:00Z"', '---', '', '# X'].join('\n');
    const res = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/x.md', bad), schemaHash: 'sh', purposeHash: 'ph',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invalidTarget');
  });

  it('未闭合块不产出文件，warnings 可见', async () => {
    const res = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: '---FILE: wiki/concepts/trunc.md---\n没结束',
      schemaHash: 'sh', purposeHash: 'ph',
    });
    // 没有可发布文件 → 视为无候选
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invalidTarget');
  });

  it('源摘要归属由应用固定：模型不能为别的 source 伪造来源页', async () => {
    // 请求固定 sourcePageId，但提案写的是别的路径 → 该块被丢弃并警告可见，
    // 无任何可发布候选 → 不落 staging（不产生空提案）
    const res = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/sources/other.md', pageBody('source', 'Other')),
      schemaHash: 'sh', purposeHash: 'ph',
      fixedSourcePageId: 'sources/axi-spec',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('invalidTarget');
      expect(res.error.message).toMatch(/归属/);
    }
    expect(readdirSync(wikiLayout(kbPath).stagingDir).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('固定来源页与提案一致时该块正常接受', async () => {
    const res = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/sources/axi-spec.md', pageBody('source', 'AXI 摘要', [SRC_REF])),
      schemaHash: 'sh', purposeHash: 'ph',
      fixedSourcePageId: 'sources/axi-spec',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.changeSet.pages).toHaveLength(1);
    expect(res.value.changeSet.pages[0].pageId).toBe('sources/axi-spec');
  });

  it('findings 结构化字段落盘（issue 25 共用）', async () => {
    const res = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/a.md', pageBody('concept', 'A')),
      schemaHash: 'sh', purposeHash: 'ph',
      findings: [{
        findingId: 'f1', kbId: 'kb-1', kind: 'broken-link',
        pageIds: ['concepts/a'], evidenceRefs: [], evidenceHashes: [],
        status: 'open', createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z',
      }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.changeSet.findings).toHaveLength(1);
    expect(res.value.changeSet.findings[0].findingId).toBe('f1');
  });
});

describe('recordDecision / readReview — 选择持久', () => {
  it('逐 hunk 接受/拒绝持久可读回', async () => {
    const staged = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/a.md', pageBody('concept', 'A')),
      schemaHash: 'sh', purposeHash: 'ph',
    });
    if (!staged.ok) throw new Error('stage');
    const csId = staged.value.changeSet.changeSetId;

    const rec = await recordDecision(kbPath, {
      changeSetId: csId, pageRelPath: 'wiki/concepts/a.md', hunkIds: [0, 1], decision: 'accepted',
    });
    expect(rec.ok).toBe(true);

    const review = await readReview(kbPath, csId);
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    const page = review.value.pages.find((p) => p.relPath === 'wiki/concepts/a.md');
    expect(page?.hunkStates[0]).toBe('accepted');
    expect(page?.hunkStates[1]).toBe('accepted');
  });

  it('未知变更集失败可见', async () => {
    const rec = await recordDecision(kbPath, {
      changeSetId: 'nope', pageRelPath: 'wiki/concepts/a.md', hunkIds: [0], decision: 'accepted',
    });
    expect(rec.ok).toBe(false);
    if (!rec.ok) expect(rec.error.code).toBe('changeSetNotFound');
  });

  it('未知页失败可见', async () => {
    const staged = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/a.md', pageBody('concept', 'A')),
      schemaHash: 'sh', purposeHash: 'ph',
    });
    if (!staged.ok) throw new Error('stage');
    const rec = await recordDecision(kbPath, {
      changeSetId: staged.value.changeSet.changeSetId, pageRelPath: 'wiki/concepts/nope.md',
      hunkIds: [0], decision: 'accepted',
    });
    expect(rec.ok).toBe(false);
    if (!rec.ok) expect(rec.error.code).toBe('unknownPage');
  });
});

describe('listChangeSets', () => {
  it('列出变更集摘要，正式 wiki 未变', async () => {
    await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't1', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/a.md', pageBody('concept', 'A')),
      schemaHash: 'sh', purposeHash: 'ph',
    });
    const list = await listChangeSets(kbPath, 'kb-1');
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(1);
    expect(list.value[0].pageCount).toBe(1);
    expect(list.value[0].newPageCount).toBe(1);
  });

  it('kbId 不符的变更集不列出（不跨库泄漏）', async () => {
    await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/a.md', pageBody('concept', 'A')),
      schemaHash: 'sh', purposeHash: 'ph',
    });
    const list = await listChangeSets(kbPath, 'kb-other');
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(0);
  });
});

describe('schema/purpose hash 基线', () => {
  it('schemaHash/purposeHash 从库内文件计算，不由调用方决定', async () => {
    const res = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/a.md', pageBody('concept', 'A')),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const expectedSchema = createHash('sha256').update(SCHEMA_MD_SKELETON).digest('hex');
    const expectedPurpose = createHash('sha256').update(PURPOSE_MD_SKELETON).digest('hex');
    expect(res.value.changeSet.schemaHash).toBe(expectedSchema);
    expect(res.value.changeSet.purposeHash).toBe(expectedPurpose);
  });
});

describe('invalidateReview — 失效旧批准（issue 06 基线变动）', () => {
  it('决策重置为 pending、记录 stale 原因与时间，且不触碰 wiki/', async () => {
    const staged = await stageProposal(kbPath, {
      kbId: 'kb-1', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/a.md', pageBody('concept', 'A')),
    });
    if (!staged.ok) throw new Error('stage');
    const csId = staged.value.changeSet.changeSetId;
    await recordDecision(kbPath, { changeSetId: csId, pageRelPath: 'wiki/concepts/a.md', hunkIds: [0], decision: 'accepted' });

    const res = await invalidateReview(kbPath, csId, ['写集基线变动：内容不一致'], '2026-09-13T10:00:00Z');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.stale).toEqual({ detectedAt: '2026-09-13T10:00:00Z', reasons: ['写集基线变动：内容不一致'] });
    expect(res.value.settled).toBe(false);
    expect(res.value.pages[0].hunkStates[0]).toBe('pending');

    // 重开仍是失效后的状态
    const reread = await readReview(kbPath, csId);
    expect(reread.ok).toBe(true);
    if (reread.ok) {
      expect(reread.value.stale?.reasons).toHaveLength(1);
      expect(reread.value.pages[0].hunkStates[0]).toBe('pending');
    }
    // 正式 wiki/ 未被触碰
    expect(existsSync(join(kbPath, 'wiki', 'concepts', 'a.md'))).toBe(false);
  });

  it('未知变更集 → changeSetNotFound', async () => {
    const res = await invalidateReview(kbPath, 'nope', ['x']);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('changeSetNotFound');
  });
});
