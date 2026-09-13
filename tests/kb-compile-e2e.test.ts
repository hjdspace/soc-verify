/**
 * kb-compile-e2e.test.ts — 文字导入→编译任务→审阅→发布→知识页与索引
 * 首个真实闭环（issue 08，验收 A06 / User Stories 12, 16, 17, 18）。
 *
 * 全程只走公开生产边界：importWikiSources → 队列 enqueueCompile（注入
 * 可控假响应）→ stageProposal → recordDecision → publishChangeSet。
 * 验证编译不直接写 wiki/，发布后知识页 + 聚合索引更新。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WikiIngestQueueManager } from '../src/main/kb/ingest-queue';
import { importWikiSources, convertWikiSource } from '../src/main/kb/source-import';
import { initWikiLayout, wikiLayout, SCHEMA_MD_SKELETON } from '../src/main/kb/wiki-layout';
import { listChangeSets, recordDecision } from '../src/main/kb/staging';
import { publishChangeSet } from '../src/main/kb/publish';
import type { CompileLlm } from '../src/main/kb/compile';
import { wikiRealHunkIds } from '@shared/wiki-hunks';
import type { WikiSourceRecord } from '@shared/kb-types';

const KB_ID = 'kb-e2e';
const SOURCE_TEXT = '# AXI 握手协议\n\nAXI 使用 VALID/READY 握手。VALID 拉高后不得撤销。\n';

let kbPath: string;
let workDir: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'sv-kb-e2e-src-'));
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-e2e-'));
  await initWikiLayout(kbPath, { kbId: KB_ID, name: 'E2E 测试库' });
  writeFileSync(wikiLayout(kbPath).schemaMdPath, SCHEMA_MD_SKELETON, 'utf-8');
  writeFileSync(join(kbPath, 'purpose.md'), '沉淀验证协议知识。', 'utf-8');
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe('文字导入 → 任务 → 审阅 → 知识页与索引（issue 08 闭环）', () => {
  it('完整闭环：导入 .txt → compileSource 任务 → 逐页接受 → 发布更新 wiki/ 与索引', async () => {
    // ── 1. 文字导入 ──
    const srcAbs = join(workDir, 'axi-note.txt');
    writeFileSync(srcAbs, SOURCE_TEXT, 'utf-8');
    const imported = await importWikiSources(kbPath, [{ absolutePath: srcAbs }]);
    if (!imported[0]?.ok) throw new Error(`import: ${imported[0]?.ok === false ? imported[0].error.message : 'no result'}`);
    const rec: WikiSourceRecord = imported[0].source;
    // 保障就绪（文本导入通常已即时转换；幂等）
    if (rec.parsedRevision !== rec.currentRevision) {
      const conv = await convertWikiSource(kbPath, rec.sourceId, {});
      if (!conv.ok) throw new Error(`convert: ${conv.error.message}`);
    }
    const sourceRef = {
      sourceId: rec.sourceId,
      sourceRevision: rec.currentRevision,
      parsedHash: rec.parsedHash!,
    };

    // ── 2. 编译任务（可控假响应：分析 → FILE 提案）──
    const sourceRefYaml = [
      'sources:',
      `  - sourceId: "${sourceRef.sourceId}"`,
      `    sourceRevision: "${sourceRef.sourceRevision}"`,
      `    parsedHash: "${sourceRef.parsedHash}"`,
    ].join('\n');

    const page = (type: string, dir: string, pageId: string, title: string, body: string): string =>
      [
        '---',
        `type: ${type}`,
        `title: "${title}"`,
        `summary: ${title}的结构化摘要。`,
        'keywords: [AXI]',
        'tags: [协议]',
        sourceRefYaml,
        'created: "2026-09-14T00:00:00Z"',
        'updated: "2026-09-14T00:00:00Z"',
        '---',
        '',
        `# ${title}`,
        '',
        body,
      ].join('\n');

    const proposalText = [
      `---FILE: wiki/sources/${rec.sourceId}.md---`,
      page('source', 'sources', rec.sourceId, 'AXI 笔记', '## 来源概述\n\nAXI 协议笔记全文摘要。\n\n## 关键内容\n\n- VALID/READY 握手'),
      '---END FILE---',
      '',
      '---FILE: wiki/concepts/axi-handshake.md---',
      page('concept', 'concepts', 'concepts/axi-handshake', 'AXI 握手', '## 定义\n\nVALID/READY 双向握手。\n\n## 规则\n\nVALID 拉高后不得撤销，直到握手完成。'),
      '---END FILE---',
    ].join('\n');

    let script: Array<{ text: string }> = [{ text: '## 关键实体\n- AXI 握手' }, { text: proposalText }];
    const queue = new WikiIngestQueueManager({
      notify: () => undefined,
      compileLlmFactory: async () =>
        ({
          model: 'fake-e2e',
          invoke: async () => {
            const step = script.shift() ?? { text: 'unexpected' };
            return { text: step.text, finishReason: 'stop', usage: { outputTokens: 2 } };
          },
        }) as unknown as CompileLlm,
    });
    const attach = await queue.attach(kbPath, KB_ID);
    if (!attach.ok) throw new Error('attach failed');

    const task = await queue.enqueueCompile(KB_ID, rec.sourceId);
    await vi.waitFor(
      () => {
        const snap = queue.snapshot(KB_ID);
        const t = snap?.tasks.find((x) => x.taskId === task.taskId);
        if (t?.phase !== 'done') throw new Error(`phase=${t?.phase} lastError=${JSON.stringify(t?.lastError)}`);
      },
      { timeout: 5_000, interval: 25 },
    );

    // staging 落盘；正式 wiki/ 未变
    const listed = await listChangeSets(kbPath, KB_ID);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
    const changeSetId = listed.value[0]!.changeSetId;
    expect(existsSync(join(kbPath, 'wiki', 'concepts', 'axi-handshake.md'))).toBe(false);

    // ── 3. 审阅：全部接受 ──
    const { readChangeSet } = await import('../src/main/kb/staging');
    const cs = await readChangeSet(kbPath, changeSetId);
    if (!cs.ok) throw new Error('readChangeSet failed');
    for (const p of cs.value.pages) {
      const dec = await recordDecision(kbPath, {
        changeSetId,
        pageRelPath: p.relPath,
        hunkIds: wikiRealHunkIds(p),
        decision: 'accepted',
      });
      expect(dec.ok).toBe(true);
    }

    // ── 4. 发布 ──
    const published = await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId });
    expect(published.ok).toBe(true);

    // ── 5. 知识页与索引 ──
    const summaryAbs = join(kbPath, 'wiki', 'sources', `${rec.sourceId}.md`);
    const conceptAbs = join(kbPath, 'wiki', 'concepts', 'axi-handshake.md');
    expect(existsSync(summaryAbs)).toBe(true);
    expect(existsSync(conceptAbs)).toBe(true);
    expect(readFileSync(conceptAbs, 'utf-8')).toContain('VALID 拉高后不得撤销');

    // 聚合索引由发布确定性重建（wikilink 形式，pageId 不带 .md）
    const indexContent = readFileSync(join(kbPath, 'wiki', 'index.md'), 'utf-8');
    expect(indexContent).toContain('AXI 握手');
    expect(indexContent).toContain('concepts/axi-handshake');
    expect(indexContent).toContain('AXI 笔记');

    // 操作日志有本次 ingest 记录
    const logContent = readFileSync(join(kbPath, 'wiki', 'log.md'), 'utf-8');
    expect(logContent).toContain('commitId');
  });
});
