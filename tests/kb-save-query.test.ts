/**
 * KB 主动保存问答为 query 页提案测试（issue 18，spec §7）。
 *
 * 验收（A19；User Story 79）：
 *  - 只保存选定消息与必要引用，任务固定项目/kbId 与来源/页面 revision；
 *  - 同消息选择 hash + 引用 revision 去重，双击不产生重复任务；
 *  - 没有证据的判断标推测，不把聊天语句伪装原始事实；失效引用明确反馈；
 *  - 复用既有 staging 与发布，跳过转换/提图；删除聊天不丢已保存提案；
 *  - 从真实 UI 消息选择 → 审阅 → query 页与检索可见的闭环测试通过。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  saveQueryMessages,
  computeSelectionHash,
  type SaveQueryInput,
} from '../src/main/kb/save-query';
import { initWikiLayout, writeWikiManifest, wikiLayout, type WikiKbManifest } from '../src/main/kb/wiki-layout';
import { listChangeSets, readChangeSet } from '../src/main/kb/staging';
import { publishChangeSet } from '../src/main/kb/publish';
import { searchWiki } from '../src/main/kb/wiki-search';
import type { WikiSourceRef } from '@shared/kb-types';

let kbPath: string;

const KB_ID = 'kb-save-query-test';
const SOURCE_ID = 'a'.repeat(64);
const SOURCE_REVISION = 'b'.repeat(64);
const PARSED_HASH = createHash('sha256').update('来源正文：AXI 协议。\n关键参数：AWLEN=128', 'utf-8').digest('hex');
const SOURCE_PATH = 'axi-spec';

const SRC_REF: WikiSourceRef = {
  sourceId: SOURCE_ID,
  sourceRevision: SOURCE_REVISION,
  parsedHash: PARSED_HASH,
};

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-save-query-'));
  await initWikiLayout(kbPath, { kbId: KB_ID, name: 'SaveQuery 测试库' });
  // 写入 ready 来源 + parsed 全文
  writeFileSync(join(wikiLayout(kbPath).rawParsedDir, `${SOURCE_PATH}.md`), '来源正文：AXI 协议。\n关键参数：AWLEN=128', 'utf-8');
  const manifest: WikiKbManifest = {
    manifestVersion: 1,
    format: 'wiki',
    kbId: KB_ID,
    name: 'SaveQuery 测试库',
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:00Z',
    sources: {
      [SOURCE_ID]: {
        sourcePath: SOURCE_PATH,
        sourceId: SOURCE_ID,
        ext: '.md',
        size: 100,
        currentRevision: SOURCE_REVISION,
        parsedRevision: SOURCE_REVISION,
        parsedHash: PARSED_HASH,
        engine: 'text',
        engineFingerprint: 'text',
        status: 'ready',
        assetCount: 0,
        importedAt: '2026-09-14T00:00:00Z',
        updatedAt: '2026-09-14T00:00:00Z',
      },
    },
  };
  await writeWikiManifest(kbPath, manifest);
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

/** 构造一组问答消息 */
function makeMessages(over: Partial<SaveQueryInput['messages'][0]>[] = []): SaveQueryInput['messages'] {
  const defaults = [
    { role: 'user' as const, content: 'AXI 的 outstanding 限制是多少？', id: 'msg-1' },
    { role: 'assistant' as const, content: 'AXI 协议允许最多 16 个 outstanding 事务。', id: 'msg-2' },
  ];
  return defaults.map((d, i) => ({ ...d, ...over[i] }));
}

describe('computeSelectionHash', () => {
  it('相同消息选择产生相同 hash', () => {
    const msgs = makeMessages();
    const h1 = computeSelectionHash(msgs);
    const h2 = computeSelectionHash(msgs);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('不同消息选择产生不同 hash', () => {
    const msgs1 = makeMessages();
    const msgs2 = makeMessages([{ content: '不同的问题' }]);
    expect(computeSelectionHash(msgs1)).not.toBe(computeSelectionHash(msgs2));
  });

  it('消息顺序影响 hash', () => {
    const msgs1 = makeMessages();
    const msgs2 = [msgs1[1]!, msgs1[0]!];
    expect(computeSelectionHash(msgs1)).not.toBe(computeSelectionHash(msgs2));
  });
});

describe('saveQueryMessages — 基本行为', () => {
  it('保存选定问答为 query 类型提案，进入 staging 审阅入口', async () => {
    const input: SaveQueryInput = {
      kbId: KB_ID,
      messages: makeMessages(),
      title: 'AXI outstanding 限制',
      summary: 'AXI 协议允许的 outstanding 事务数量',
      sourceRefs: [SRC_REF],
    };
    const result = await saveQueryMessages(kbPath, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changeSet.origin).toBe('saveQuery');
    expect(result.changeSet.pages).toHaveLength(1);
    const page = result.changeSet.pages[0]!;
    expect(page.type).toBe('query');
    expect(page.relPath).toContain('queries/');
    expect(page.before).toBeNull(); // 新页
  });

  it('提案包含问题、答案、适用条件与引用', async () => {
    const input: SaveQueryInput = {
      kbId: KB_ID,
      messages: makeMessages(),
      title: 'AXI outstanding 限制',
      summary: 'AXI 协议允许的 outstanding 事务数量',
      sourceRefs: [SRC_REF],
    };
    const result = await saveQueryMessages(kbPath, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const page = result.changeSet.pages[0]!;
    expect(page.proposed).toContain('AXI 的 outstanding 限制是多少？');
    expect(page.proposed).toContain('AXI 协议允许最多 16 个 outstanding 事务');
    expect(page.proposed).toContain('适用条件');
    // frontmatter 包含来源引用
    expect(page.proposed).toContain(SOURCE_ID);
    expect(page.proposed).toContain(SOURCE_REVISION);
  });

  it('发布后成为 query 页并可在检索中找到', async () => {
    const input: SaveQueryInput = {
      kbId: KB_ID,
      messages: makeMessages(),
      title: 'AXI outstanding 限制',
      summary: 'AXI 协议允许的 outstanding 事务数量',
      sourceRefs: [SRC_REF],
    };
    const staged = await saveQueryMessages(kbPath, input);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;

    // 审阅接受
    const { recordDecision } = await import('../src/main/kb/staging');
    const page = staged.changeSet.pages[0]!;
    await recordDecision(kbPath, {
      changeSetId: staged.changeSet.changeSetId,
      pageRelPath: page.relPath,
      hunkIds: [0],
      decision: 'accepted',
    });

    // 发布
    const published = await publishChangeSet(kbPath, {
      kbId: KB_ID,
      changeSetId: staged.changeSet.changeSetId,
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.pages).toHaveLength(1);
    expect(published.pages[0]!.pageId).toContain('queries/');

    // 检索可见
    const searchResult = await searchWiki(kbPath, { query: 'outstanding' });
    expect(searchResult.ok).toBe(true);
    if (!searchResult.ok) return;
    const hits = searchResult.result.hits.filter((h) => h.kind === 'wiki');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.pageType === 'query')).toBe(true);
  });
});

describe('saveQueryMessages — 去重', () => {
  it('同消息选择 + 引用 revision 去重，双击不产生重复任务', async () => {
    const input: SaveQueryInput = {
      kbId: KB_ID,
      messages: makeMessages(),
      title: 'AXI outstanding 限制',
      summary: 'AXI 协议允许的 outstanding 事务数量',
      sourceRefs: [SRC_REF],
    };
    const result1 = await saveQueryMessages(kbPath, input);
    expect(result1.ok).toBe(true);

    // 相同输入再次调用
    const result2 = await saveQueryMessages(kbPath, input);
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;

    // 应返回同一个 changeSetId（去重）
    if (!result1.ok) return;
    expect(result2.changeSet.changeSetId).toBe(result1.changeSet.changeSetId);
  });

  it('不同消息选择不去重', async () => {
    const input1: SaveQueryInput = {
      kbId: KB_ID,
      messages: makeMessages(),
      title: 'AXI outstanding 限制',
      summary: 'AXI 协议允许的 outstanding 事务数量',
      sourceRefs: [SRC_REF],
    };
    const input2: SaveQueryInput = {
      kbId: KB_ID,
      messages: makeMessages([{ content: '不同的问题' }]),
      title: '另一个问题',
      summary: '另一个回答',
      sourceRefs: [SRC_REF],
    };
    const result1 = await saveQueryMessages(kbPath, input1);
    const result2 = await saveQueryMessages(kbPath, input2);
    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (!result1.ok || !result2.ok) return;
    expect(result2.changeSet.changeSetId).not.toBe(result1.changeSet.changeSetId);
  });
});

describe('saveQueryMessages — 证据标记', () => {
  it('无证据的判断标为推测，不伪装原始事实', async () => {
    const input: SaveQueryInput = {
      kbId: KB_ID,
      messages: makeMessages([
        {},
        { content: '根据经验，通常不超过 8 个，但不确定。' },
      ]),
      title: 'AXI outstanding 推测',
      summary: '推测性回答',
      sourceRefs: [], // 无来源引用
    };
    const result = await saveQueryMessages(kbPath, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const page = result.changeSet.pages[0]!;
    expect(page.proposed).toContain('推测');
  });

  it('有来源引用时标明来源修订', async () => {
    const input: SaveQueryInput = {
      kbId: KB_ID,
      messages: makeMessages(),
      title: 'AXI outstanding 限制',
      summary: 'AXI 协议允许的 outstanding 事务数量',
      sourceRefs: [SRC_REF],
    };
    const result = await saveQueryMessages(kbPath, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const page = result.changeSet.pages[0]!;
    expect(page.proposed).toContain(SOURCE_ID);
    expect(page.sources).toHaveLength(1);
    expect(page.sources[0]!.sourceId).toBe(SOURCE_ID);
  });
});

describe('saveQueryMessages — 失效引用反馈', () => {
  it('引用不存在的来源返回明确错误', async () => {
    const badRef: WikiSourceRef = {
      sourceId: 'x'.repeat(64),
      sourceRevision: 'y'.repeat(64),
      parsedHash: 'z'.repeat(64),
    };
    const input: SaveQueryInput = {
      kbId: KB_ID,
      messages: makeMessages(),
      title: '引用失效',
      summary: '失效引用测试',
      sourceRefs: [badRef],
    };
    const result = await saveQueryMessages(kbPath, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalidSourceRef');
    expect(result.error.message).toContain('不存在');
  });
});

describe('saveQueryMessages — 跳过转换/提图', () => {
  it('不创建转换任务，直接进 staging', async () => {
    const input: SaveQueryInput = {
      kbId: KB_ID,
      messages: makeMessages(),
      title: 'AXI outstanding 限制',
      summary: 'AXI 协议允许的 outstanding 事务数量',
      sourceRefs: [SRC_REF],
    };
    const result = await saveQueryMessages(kbPath, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 只有一个 changeSet，无队列任务
    const list = await listChangeSets(kbPath, KB_ID);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(1);
    expect(list.value[0]!.origin).toBe('saveQuery');
  });
});

describe('saveQueryMessages — 删除聊天不丢已保存提案', () => {
  it('提案自包含问答与来源，不依赖原聊天会话', async () => {
    const input: SaveQueryInput = {
      kbId: KB_ID,
      messages: makeMessages(),
      title: 'AXI outstanding 限制',
      summary: 'AXI 协议允许的 outstanding 事务数量',
      sourceRefs: [SRC_REF],
    };
    const result = await saveQueryMessages(kbPath, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 读取 staging 确认内容自包含
    const stored = await readChangeSet(kbPath, result.changeSet.changeSetId);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const page = stored.value.pages[0]!;
    expect(page.proposed).toContain('AXI 的 outstanding 限制是多少？');
    expect(page.proposed).toContain('AXI 协议允许最多 16 个 outstanding 事务');
    // 来源引用已固化在提案中
    expect(page.sources[0]!.sourceId).toBe(SOURCE_ID);
    expect(page.sources[0]!.sourceRevision).toBe(SOURCE_REVISION);
  });
});
