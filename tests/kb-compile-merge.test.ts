/**
 * kb-compile-merge.test.ts — 来源感知合并端到端测试（issue 16，验收 A08/A09）。
 *
 * 测试缝：compileWikiSource 的真实 staging + page-merge 合并逻辑。
 * 不模拟整个队列，直接调用 compileWikiSource 注入可控假 LLM 响应。
 *
 * 验收映射：
 *  - A08：单来源页允许替换正文而不 union 保留已撤回断言
 *  - A09：跨来源合并保留各来源贡献，冲突保留适用范围
 *  - 来源引用确定性去重，类型/标题/创建时间锁定
 *  - 异常收缩/LLM 失败时保留旧页
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importWikiSources, convertWikiSource } from '../src/main/kb/source-import';
import { initWikiLayout, wikiLayout, SCHEMA_MD_SKELETON } from '../src/main/kb/wiki-layout';
import { readChangeSet } from '../src/main/kb/staging';
import { compileWikiSource, type CompileLlm } from '../src/main/kb/compile';
import type { WikiSourceRecord } from '@shared/kb-types';

const KB_ID = 'kb-merge';

let kbPath: string;
let workDir: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'sv-kb-merge-src-'));
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-merge-'));
  await initWikiLayout(kbPath, { kbId: KB_ID, name: '合并测试库' });
  writeFileSync(wikiLayout(kbPath).schemaMdPath, SCHEMA_MD_SKELETON, 'utf-8');
  writeFileSync(join(kbPath, 'purpose.md'), '沉淀验证协议知识。', 'utf-8');
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────

/** 写入一份文本来源并返回 ready 的 sourceRecord */
async function importTextSource(fileName: string, content: string): Promise<WikiSourceRecord> {
  const srcAbs = join(workDir, fileName);
  writeFileSync(srcAbs, content, 'utf-8');
  const imported = await importWikiSources(kbPath, [{ absolutePath: srcAbs }]);
  if (!imported[0]?.ok) throw new Error(`import failed: ${imported[0]?.ok === false ? imported[0].error.message : 'no result'}`);
  const rec = imported[0].source;
  if (rec.parsedRevision !== rec.currentRevision) {
    const conv = await convertWikiSource(kbPath, rec.sourceId, {});
    if (!conv.ok) throw new Error(`convert failed: ${conv.error.message}`);
  }
  // 重新读取 manifest 以获取更新后的 rec
  const { readWikiManifest } = await import('../src/main/kb/wiki-layout');
  const manifest = await readWikiManifest(kbPath);
  if (!manifest.ok) throw new Error('manifest read failed');
  const updated = manifest.manifest.sources?.[rec.sourceId];
  if (!updated) throw new Error('source not found after convert');
  return updated;
}

/** 组装一个 wiki 页面内容 */
function makePage(
  type: string,
  title: string,
  sourcesYaml: string,
  body: string,
  created = '2026-09-14T00:00:00Z',
  updated = '2026-09-14T00:00:00Z',
): string {
  return [
    '---',
    `type: ${type}`,
    `title: "${title}"`,
    `summary: ${title}的摘要`,
    'keywords: [AXI]',
    'tags: [协议]',
    sourcesYaml,
    `created: "${created}"`,
    `updated: "${updated}"`,
    '---',
    '',
    body,
  ].join('\n');
}

/** 组装 FILE 块提案 */
function makeProposal(sourceId: string, sourceRefYaml: string, pages: Array<{ path: string; content: string }>): string {
  return pages.map((p) =>
    `---FILE: ${p.path}---\n${p.content}\n---END FILE---`,
  ).join('\n\n');
}

/** 创建可控假 LLM：按顺序返回预设响应 */
function createScriptedLlm(responses: Array<{ text: string }>): CompileLlm {
  const script = [...responses];
  return {
    model: 'fake-merge-test',
    invoke: async () => {
      const step = script.shift() ?? { text: 'unexpected' };
      return { text: step.text, finishReason: 'stop', usage: { outputTokens: 2 } };
    },
  };
}

// ── 测试 ──────────────────────────────────────────────────────────

describe('来源感知合并端到端（issue 16）', () => {
  it('A08：单来源修订 → 替换正文，旧论断不残留', async () => {
    // ── 1. 第一份来源：AXI outstanding 限制为 16 ──
    const rec1 = await importTextSource('axi-v1.txt', '# AXI Outstanding\n\n协议允许最多 16 个 outstanding。\n');
    const sourceRef1 = {
      sourceId: rec1.sourceId,
      sourceRevision: rec1.currentRevision,
      parsedHash: rec1.parsedHash!,
    };
    const sourceRefYaml1 = [
      'sources:',
      `  - sourceId: "${sourceRef1.sourceId}"`,
      `    sourceRevision: "${sourceRef1.sourceRevision}"`,
      `    parsedHash: "${sourceRef1.parsedHash}"`,
    ].join('\n');

    // 第一次编译：生成来源摘要 + 概念页
    const proposal1 = makeProposal(rec1.sourceId, sourceRefYaml1, [
      { path: `wiki/sources/${rec1.sourceId}.md`, content: makePage('source', 'AXI 来源', sourceRefYaml1, '## 来源概述\n\nAXI 协议笔记。') },
      { path: 'wiki/concepts/axi-outstanding.md', content: makePage('concept', 'AXI outstanding', sourceRefYaml1, '## 定义\n\n协议允许最多 16 个 outstanding。') },
    ]);

    const llm1 = createScriptedLlm([
      { text: '## 关键实体\n- AXI outstanding' },
      { text: proposal1 },
    ]);

    const result1 = await compileWikiSource(kbPath, {
      kbId: KB_ID,
      taskId: 'task-1',
      sourceId: rec1.sourceId,
    }, { llm: llm1, now: '2026-09-14T00:00:00Z', retryBaseDelayMs: 0 });

    expect(result1.ok).toBe(true);
    if (!result1.ok) return;

    // 发布第一个变更集
    const { publishChangeSet } = await import('../src/main/kb/publish');
    const changeSetId1 = result1.changeSet.changeSetId;
    const { recordDecision } = await import('../src/main/kb/staging');
    const cs1 = await readChangeSet(kbPath, changeSetId1);
    if (!cs1.ok) throw new Error('readChangeSet failed');
    const { wikiRealHunkIds } = await import('@shared/wiki-hunks');
    for (const p of cs1.value.pages) {
      await recordDecision(kbPath, { changeSetId: changeSetId1, pageRelPath: p.relPath, hunkIds: wikiRealHunkIds(p), decision: 'accepted' });
    }
    const pub1 = await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: changeSetId1 });
    expect(pub1.ok).toBe(true);

    // 验证已发布页包含旧论断
    const publishedPage = readFileSync(join(kbPath, 'wiki', 'concepts', 'axi-outstanding.md'), 'utf-8');
    expect(publishedPage).toContain('最多 16');

    // ── 2. 同来源新修订：纠正为 8 ──
    // 上传同路径新版本
    const srcAbs = join(workDir, 'axi-v1.txt');
    writeFileSync(srcAbs, '# AXI Outstanding\n\n协议允许最多 8 个 outstanding（修订纠正）。\n', 'utf-8');
    const reImported = await importWikiSources(kbPath, [{ absolutePath: srcAbs }]);
    if (!reImported[0]?.ok) throw new Error('re-import failed');
    const rec2 = reImported[0].source;
    if (rec2.parsedRevision !== rec2.currentRevision) {
      const conv = await convertWikiSource(kbPath, rec2.sourceId, {});
      if (!conv.ok) throw new Error(`convert failed: ${conv.error.message}`);
    }
    const { readWikiManifest } = await import('../src/main/kb/wiki-layout');
    const manifest2 = await readWikiManifest(kbPath);
    if (!manifest2.ok) throw new Error('manifest read failed');
    const updatedRec = manifest2.manifest.sources?.[rec2.sourceId];
    if (!updatedRec) throw new Error('source not found after re-convert');

    const sourceRef2 = {
      sourceId: updatedRec.sourceId,
      sourceRevision: updatedRec.currentRevision,
      parsedHash: updatedRec.parsedHash!,
    };
    const sourceRefYaml2 = [
      'sources:',
      `  - sourceId: "${sourceRef2.sourceId}"`,
      `    sourceRevision: "${sourceRef2.sourceRevision}"`,
      `    parsedHash: "${sourceRef2.parsedHash}"`,
    ].join('\n');

    // 第二次编译：同来源修订，新提案应替换旧正文
    const proposal2 = makeProposal(updatedRec.sourceId, sourceRefYaml2, [
      { path: `wiki/sources/${updatedRec.sourceId}.md`, content: makePage('source', 'AXI 来源', sourceRefYaml2, '## 来源概述\n\nAXI 协议笔记（修订）。') },
      { path: 'wiki/concepts/axi-outstanding.md', content: makePage('concept', 'AXI outstanding', sourceRefYaml2, '## 定义\n\n协议允许最多 8 个 outstanding（修订纠正）。') },
    ]);

    const llm2 = createScriptedLlm([
      { text: '## 关键实体\n- AXI outstanding（修订）' },
      { text: proposal2 },
    ]);

    const result2 = await compileWikiSource(kbPath, {
      kbId: KB_ID,
      taskId: 'task-2',
      sourceId: updatedRec.sourceId,
    }, { llm: llm2, now: '2026-09-14T01:00:00Z', retryBaseDelayMs: 0 });

    expect(result2.ok).toBe(true);
    if (!result2.ok) return;

    // 验证 staging 中该页的 proposed 不含旧论断
    const cs2 = await readChangeSet(kbPath, result2.changeSet.changeSetId);
    if (!cs2.ok) throw new Error('readChangeSet 2 failed');
    const conceptPage = cs2.value.pages.find((p) => p.pageId === 'concepts/axi-outstanding');
    expect(conceptPage).toBeDefined();
    expect(conceptPage!.before).not.toBeNull();
    expect(conceptPage!.proposed).toContain('最多 8');
    // 旧论断「16」不应残留在 proposed 中
    expect(conceptPage!.proposed).not.toContain('最多 16');
  });

  it('A09：跨来源合并 → 保留各来源贡献，来源引用 union', async () => {
    // ── 1. 第一份来源（来源 A）：协议手册说最多 16 ──
    const recA = await importTextSource('amba-axi.txt', '# AMBA AXI\n\n协议允许最多 16 个 outstanding。\n');
    const sourceRefA = {
      sourceId: recA.sourceId,
      sourceRevision: recA.currentRevision,
      parsedHash: recA.parsedHash!,
    };
    const sourceRefYamlA = [
      'sources:',
      `  - sourceId: "${sourceRefA.sourceId}"`,
      `    sourceRevision: "${sourceRefA.sourceRevision}"`,
      `    parsedHash: "${sourceRefA.parsedHash}"`,
    ].join('\n');

    const proposalA = makeProposal(recA.sourceId, sourceRefYamlA, [
      { path: `wiki/sources/${recA.sourceId}.md`, content: makePage('source', 'AMBA AXI', sourceRefYamlA, '## 来源概述\n\nAMBA AXI 协议手册。') },
      { path: 'wiki/concepts/axi-outstanding.md', content: makePage('concept', 'AXI outstanding', sourceRefYamlA, '## 定义\n\nAXI 协议允许的 outstanding 上限。\n\n## 协议允许\n\n最多 16。') },
    ]);

    const llmA = createScriptedLlm([
      { text: '## 关键实体\n- AXI outstanding' },
      { text: proposalA },
    ]);

    const resultA = await compileWikiSource(kbPath, {
      kbId: KB_ID,
      taskId: 'task-a',
      sourceId: recA.sourceId,
    }, { llm: llmA, now: '2026-09-14T00:00:00Z', retryBaseDelayMs: 0 });

    expect(resultA.ok).toBe(true);
    if (!resultA.ok) return;

    // 发布第一个变更集
    const { publishChangeSet } = await import('../src/main/kb/publish');
    const { recordDecision } = await import('../src/main/kb/staging');
    const { wikiRealHunkIds } = await import('@shared/wiki-hunks');
    const csIdA = resultA.changeSet.changeSetId;
    const csA = await readChangeSet(kbPath, csIdA);
    if (!csA.ok) throw new Error('readChangeSet A failed');
    for (const p of csA.value.pages) {
      await recordDecision(kbPath, { changeSetId: csIdA, pageRelPath: p.relPath, hunkIds: wikiRealHunkIds(p), decision: 'accepted' });
    }
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: csIdA });

    // ── 2. 第二份来源（来源 B）：DUT spec 说限制 8 ──
    const recB = await importTextSource('dut-spec.txt', '# DUT Spec\n\n本 DUT 限制为 8 个 outstanding。\n');
    const sourceRefB = {
      sourceId: recB.sourceId,
      sourceRevision: recB.currentRevision,
      parsedHash: recB.parsedHash!,
    };
    const sourceRefYamlB = [
      'sources:',
      `  - sourceId: "${sourceRefB.sourceId}"`,
      `    sourceRevision: "${sourceRefB.sourceRevision}"`,
      `    parsedHash: "${sourceRefB.parsedHash}"`,
    ].join('\n');

    // 第二次编译提案：来源 B 对同一概念页有贡献
    // LLM 合并输出保留两份贡献
    const mergedBody = '## 定义\n\nAXI 协议允许的 outstanding 上限。\n\n## 协议允许\n\n最多 16。\n\n## DUT 实现\n\n本 DUT 限制为 8 个 outstanding。';
    // 合并后的来源引用（两个来源都引用）
    const mergedSourceRefYaml = [
      'sources:',
      `  - sourceId: "${sourceRefA.sourceId}"`,
      `    sourceRevision: "${sourceRefA.sourceRevision}"`,
      `    parsedHash: "${sourceRefA.parsedHash}"`,
      `  - sourceId: "${sourceRefB.sourceId}"`,
      `    sourceRevision: "${sourceRefB.sourceRevision}"`,
      `    parsedHash: "${sourceRefB.parsedHash}"`,
    ].join('\n');

    const proposalB = makeProposal(recB.sourceId, sourceRefYamlB, [
      { path: `wiki/sources/${recB.sourceId}.md`, content: makePage('source', 'DUT Spec', sourceRefYamlB, '## 来源概述\n\nDUT 规格书。') },
      { path: 'wiki/concepts/axi-outstanding.md', content: makePage('concept', 'AXI outstanding', sourceRefYamlB, '## DUT 实现\n\n本 DUT 限制为 8 个 outstanding。') },
    ]);

    // LLM 响应：分析 → 生成 → 合并（第三次调用是跨来源合并）
    const llmMergeOutput = makePage('concept', 'AXI outstanding', mergedSourceRefYaml, mergedBody);
    const llmB = createScriptedLlm([
      { text: '## 关键实体\n- AXI outstanding（DUT 补充）' },
      { text: proposalB },
      { text: llmMergeOutput }, // 合并阶段输出
    ]);

    const resultB = await compileWikiSource(kbPath, {
      kbId: KB_ID,
      taskId: 'task-b',
      sourceId: recB.sourceId,
    }, { llm: llmB, now: '2026-09-14T01:00:00Z', retryBaseDelayMs: 0 });

    expect(resultB.ok).toBe(true);
    if (!resultB.ok) return;

    // 验证 staging 中概念页
    const csB = await readChangeSet(kbPath, resultB.changeSet.changeSetId);
    if (!csB.ok) throw new Error('readChangeSet B failed');
    const conceptPage = csB.value.pages.find((p) => p.pageId === 'concepts/axi-outstanding');
    expect(conceptPage).toBeDefined();
    expect(conceptPage!.before).not.toBeNull();

    // 两份来源贡献都在
    expect(conceptPage!.proposed).toContain('最多 16');
    expect(conceptPage!.proposed).toContain('限制为 8');

    // 来源引用 union：两个来源 ID 都出现
    expect(conceptPage!.proposed).toContain(sourceRefA.sourceId);
    expect(conceptPage!.proposed).toContain(sourceRefB.sourceId);

    // 锁定字段：type 和 title 保持旧值
    expect(conceptPage!.proposed).toContain('type: concept');
    expect(conceptPage!.proposed).toContain('title: "AXI outstanding"');

    // warnings 包含合并说明
    expect(csB.value.warnings.some((w) => w.includes('来源感知合并'))).toBe(true);
  });
});
