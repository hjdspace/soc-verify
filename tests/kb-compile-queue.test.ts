/**
 * kb-compile-queue.test.ts — 编译任务入队/取消/暂停/失败队列行为测试（issue 08）。
 *
 * 验收：
 *  - 文字导入→任务：compileSource 任务入队、去重、跑完进入终态且
 *    提案落既有 staging；
 *  - 取消和失败从可控假响应可观察（注入 fake CompileLlm）；
 *  - 无凭证状态明确（factory 返回 null → noCredential）；
 *  - 凭证不流入任务文件（queue.json 不含 apiKey/baseUrl）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WikiIngestQueueManager } from '../src/main/kb/ingest-queue';
import type { CompileLlm } from '../src/main/kb/compile';
import { LlmCallError } from '../src/main/kb/llm-call';
import { initWikiLayout, writeWikiManifest, wikiLayout, SCHEMA_MD_SKELETON, type WikiKbManifest } from '../src/main/kb/wiki-layout';
import type { WikiSourceRecord } from '@shared/kb-types';

const KB_ID = 'kb-compile-queue';
const SOURCE_ID = 'a'.repeat(64);
const REVISION = 'b'.repeat(64);
const PARSED_HASH = createHash('sha256').update('来源正文。', 'utf-8').digest('hex');
const SOURCE_PATH = 'note.md';

let kbPath: string;

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-compile-queue-'));
  await initWikiLayout(kbPath, { kbId: KB_ID, name: '编译队列测试库' });
  writeFileSync(join(wikiLayout(kbPath).rawParsedDir, `${SOURCE_PATH}.md`), '来源正文。', 'utf-8');
  const manifest: WikiKbManifest = {
    manifestVersion: 1,
    format: 'wiki',
    kbId: KB_ID,
    name: '编译队列测试库',
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:00Z',
    sources: {
      [SOURCE_ID]: {
        sourcePath: SOURCE_PATH,
        sourceId: SOURCE_ID,
        ext: '.md',
        size: 15,
        currentRevision: REVISION,
        parsedRevision: REVISION,
        parsedHash: PARSED_HASH,
        engine: 'text',
        engineFingerprint: 'text:v1',
        status: 'ready',
        assetCount: 0,
        importedAt: '2026-09-14T00:00:00Z',
        updatedAt: '2026-09-14T00:00:00Z',
      } satisfies WikiSourceRecord,
    },
  };
  await writeWikiManifest(kbPath, manifest);
  writeFileSync(wikiLayout(kbPath).schemaMdPath, SCHEMA_MD_SKELETON, 'utf-8');
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

// ── fake 模型 ───────────────────────────────────────────────────

type ScriptStep = { text: string } | { waitAbort: true };

/** 可控假响应：按脚本返回；waitAbort = 挂起直到外部 signal 中止 */
function fakeCompileLlm(script: ScriptStep[]): CompileLlm & { calls: number } {
  const impl = {
    model: 'fake-queue-model',
    calls: 0,
    i: 0,
    invoke: (_req: { system: string; user: string; maxTokens: number }) => {
      impl.calls += 1;
      const step = script[impl.i++];
      if (!step) return Promise.resolve({ text: 'unexpected', finishReason: 'stop', usage: null });
      if ('waitAbort' in step) {
        // 挂起模拟长请求；compile.ts 在 signal.aborted 时收敛为 aborted
        return new Promise<{ text: string; finishReason: string | null; usage: null }>(() => undefined);
      }
      return Promise.resolve({ text: step.text, finishReason: 'stop', usage: { outputTokens: 1 } });
    },
  };
  return impl as unknown as CompileLlm & { calls: number };
}

const SUMMARY_BLOCK = `---FILE: wiki/sources/${SOURCE_ID}.md---\n---\ntype: source\ntitle: "N"\nsummary: s\nkeywords: []\ntags: []\nsources:\n  - sourceId: "${SOURCE_ID}"\n    sourceRevision: "${REVISION}"\n    parsedHash: "${PARSED_HASH}"\ncreated: "2026-09-14T00:00:00Z"\nupdated: "2026-09-14T00:00:00Z"\n---\n\n# N\n\n正文。\n---END FILE---`;

const CONCEPT_BLOCK = `---FILE: wiki/concepts/foo.md---\n---\ntype: concept\ntitle: "Foo"\nsummary: s\nkeywords: []\ntags: []\nsources:\n  - sourceId: "${SOURCE_ID}"\n    sourceRevision: "${REVISION}"\n    parsedHash: "${PARSED_HASH}"\ncreated: "2026-09-14T00:00:00Z"\nupdated: "2026-09-14T00:00:00Z"\n---\n\n# Foo\n\n握手。\n---END FILE---`;

function okScript(): ScriptStep[] {
  return [{ text: '分析' }, { text: `${SUMMARY_BLOCK}\n\n${CONCEPT_BLOCK}` }];
}

function makeQueue(script: ScriptStep[] | null): WikiIngestQueueManager {
  return new WikiIngestQueueManager({
    notify: () => undefined,
    compileLlmFactory: async () => (script === null ? null : fakeCompileLlm(script)),
  });
}

async function waitForPhase(
  q: WikiIngestQueueManager,
  taskId: string,
  phase: string,
  timeoutMs = 3_000,
): Promise<void> {
  await vi.waitFor(
    () => {
      const snap = q.snapshot(KB_ID);
      const t = snap?.tasks.find((x) => x.taskId === taskId);
      if (t?.phase !== phase) throw new Error(`phase=${t?.phase} 期望 ${phase}`);
    },
    { timeout: timeoutMs, interval: 20 },
  );
}

// ── 行为测试 ────────────────────────────────────────────────────

describe('enqueueCompile — 入队与去重', () => {
  it('入队 compileSource 任务并持久化', async () => {
    const q = makeQueue(null); // factory 不被调用（queued 阶段）
    await q.attach(kbPath, KB_ID);
    const task = await q.enqueueCompile(KB_ID, SOURCE_ID);
    expect(task.kind).toBe('compileSource');
    expect(task.phase).toBe('queued');
    expect(task.sourcePath).toBe(SOURCE_PATH);
    await q.cancelTask(KB_ID, task.taskId);
    // 队列文件持久
    const raw = readFileSync(join(kbPath, '.kb', 'queue.json'), 'utf-8');
    expect(raw).toContain('compileSource');
    // 凭证不入任务文件
    expect(raw).not.toContain('sk-');
    expect(raw).not.toContain('apiKey');
  });

  it('同来源活动编译任务去重', async () => {
    const q = makeQueue(null);
    await q.attach(kbPath, KB_ID);
    const t1 = await q.enqueueCompile(KB_ID, SOURCE_ID);
    const t2 = await q.enqueueCompile(KB_ID, SOURCE_ID);
    expect(t2.taskId).toBe(t1.taskId);
    await q.cancelTask(KB_ID, t1.taskId);
  });

  it('来源不存在 → sourceNotFound', async () => {
    const q = makeQueue(null);
    await q.attach(kbPath, KB_ID);
    await expect(q.enqueueCompile(KB_ID, 'f'.repeat(64))).rejects.toMatchObject({ code: 'sourceNotFound' });
  });
});

describe('编译任务运行 — 可控假响应', () => {
  it('跑完进入 done，提案落既有 staging', async () => {
    const q = makeQueue(okScript());
    await q.attach(kbPath, KB_ID);
    const task = await q.enqueueCompile(KB_ID, SOURCE_ID);
    await waitForPhase(q, task.taskId, 'done');
    const stagingFiles = readdirSync(wikiLayout(kbPath).stagingDir).filter((f) => f.endsWith('.json'));
    expect(stagingFiles).toHaveLength(1);
  });

  it('无凭证（factory=null）→ failed 且 lastError.code=noCredential', async () => {
    const q = makeQueue(null);
    await q.attach(kbPath, KB_ID);
    const task = await q.enqueueCompile(KB_ID, SOURCE_ID);
    await waitForPhase(q, task.taskId, 'failed');
    const snap = q.snapshot(KB_ID);
    expect(snap?.tasks.find((t) => t.taskId === task.taskId)?.lastError?.code).toBe('noCredential');
  });

  it('模型失败 → failed 且 lastError 可读', async () => {
    const q = makeQueue([{ text: '分析' }, { text: '不是 FILE 块的输出' }]);
    await q.attach(kbPath, KB_ID);
    const task = await q.enqueueCompile(KB_ID, SOURCE_ID);
    await waitForPhase(q, task.taskId, 'failed');
    const snap = q.snapshot(KB_ID);
    const err = snap?.tasks.find((t) => t.taskId === task.taskId)?.lastError;
    expect(err?.code).toBe('llmFailed');
    expect(err?.message).toContain('sources');
  });

  it('取消：分析阶段挂起时 cancelTask → cancelled（可观察）', async () => {
    const q = makeQueue([{ waitAbort: true }]);
    await q.attach(kbPath, KB_ID);
    const task = await q.enqueueCompile(KB_ID, SOURCE_ID);
    // 等进入编译运行（fake 已被调用即挂起）
    await vi.waitFor(
      () => {
        const snap = q.snapshot(KB_ID);
        const t = snap?.tasks.find((x) => x.taskId === task.taskId);
        if (!t || !['analyzing', 'generating', 'validating', 'converting'].includes(t.phase)) {
          throw new Error(`phase=${t?.phase}`);
        }
      },
      { timeout: 3_000, interval: 20 },
    );
    await q.cancelTask(KB_ID, task.taskId);
    await waitForPhase(q, task.taskId, 'cancelled');
  });

  it('暂停：分析阶段挂起时 pause → 回 queued（消耗 attempt）', async () => {
    const q = makeQueue([{ waitAbort: true }]);
    await q.attach(kbPath, KB_ID);
    const task = await q.enqueueCompile(KB_ID, SOURCE_ID);
    await vi.waitFor(
      () => {
        const snap = q.snapshot(KB_ID);
        const t = snap?.tasks.find((x) => x.taskId === task.taskId);
        if (!t || !['analyzing', 'generating', 'validating', 'converting'].includes(t.phase)) {
          throw new Error(`phase=${t?.phase}`);
        }
      },
      { timeout: 3_000, interval: 20 },
    );
    await q.pause(KB_ID);
    await waitForPhase(q, task.taskId, 'queued');
    const snap = q.snapshot(KB_ID);
    const t = snap?.tasks.find((x) => x.taskId === task.taskId);
    expect(t?.attempt).toBe(2);
  });
});

// ── issue 09：重试与用量对任务面板可见 ──────────────────────────

function retryableError(message: string): LlmCallError {
  const err = new LlmCallError(message, true);
  // Retry-After 走 1ms 分支：测试不空等真实退避
  Object.assign(err, { retryAfterMs: 1 });
  return err;
}

describe('编译任务 — 重试与用量（issue 09）', () => {
  it('成功后记录 usage 汇总（只累加实际给出的字段）与内部重试数', async () => {
    const q = makeQueue(okScript());
    await q.attach(kbPath, KB_ID);
    const task = await q.enqueueCompile(KB_ID, SOURCE_ID);
    await waitForPhase(q, task.taskId, 'done');
    const t = q.snapshot(KB_ID)?.tasks.find((x) => x.taskId === task.taskId);
    // 分析 + 生成各返回 { outputTokens: 1 }
    expect(t?.usage).toEqual({ outputTokens: 2 });
    expect(t?.retryCount).toBe(0);
  });

  it('失败保留诊断：failed 任务仍有 usage 与可读失败原因', async () => {
    const q = makeQueue([{ text: '分析' }, { text: '不是 FILE 块的输出' }]);
    await q.attach(kbPath, KB_ID);
    const task = await q.enqueueCompile(KB_ID, SOURCE_ID);
    await waitForPhase(q, task.taskId, 'failed');
    const t = q.snapshot(KB_ID)?.tasks.find((x) => x.taskId === task.taskId);
    expect(t?.lastError?.code).toBe('llmFailed');
    // 分析 + 生成都返回了 usage；修复调用（脚本耗尽）未给出 usage → 只累加实际字段
    expect(t?.usage).toEqual({ outputTokens: 2 });
  });

  it('可重试失败有界退避：任务 retryCount 反映内部重试次数', async () => {
    let calls = 0;
    const q = new WikiIngestQueueManager({
      notify: () => undefined,
      compileLlmFactory: async () => ({
        model: 'fake-retry',
        invoke: async () => {
          calls += 1;
          if (calls <= 2) throw retryableError(`网络错误 #${calls}`);
          if (calls === 3) return { text: '分析', finishReason: 'stop', usage: { inputTokens: 3 } };
          return { text: `${SUMMARY_BLOCK}\n\n${CONCEPT_BLOCK}`, finishReason: 'stop', usage: { outputTokens: 5 } };
        },
      }),
    });
    await q.attach(kbPath, KB_ID);
    const task = await q.enqueueCompile(KB_ID, SOURCE_ID);
    await waitForPhase(q, task.taskId, 'done');
    const t = q.snapshot(KB_ID)?.tasks.find((x) => x.taskId === task.taskId);
    expect(calls).toBe(4);                 // 分析 3 次尝试 + 生成 1 次
    expect(t?.retryCount).toBe(2);
    expect(t?.usage).toEqual({ inputTokens: 3, outputTokens: 5 });
  });

  it('usage/retryCount 持久化到队列文件，且不含凭证', async () => {
    const q = makeQueue(okScript());
    await q.attach(kbPath, KB_ID);
    const task = await q.enqueueCompile(KB_ID, SOURCE_ID);
    await waitForPhase(q, task.taskId, 'done');
    const raw = readFileSync(join(kbPath, '.kb', 'queue.json'), 'utf-8');
    expect(raw).toContain('retryCount');
    expect(raw).toContain('usage');
    expect(raw).not.toContain('sk-');
    expect(raw).not.toContain('apiKey');
  });
});

// ── issue 10：长来源分段进度与 blocked 状态 ─────────────────────

/** 长来源假模型：分段分析返回两个小节，生成返回 FILE 块（证据绑定传入的 parsedHash） */
function longSourceLlm(opts: { contextTokens: number; parsedHash: string }): CompileLlm {
  const ref = [
    'sources:',
    `  - sourceId: "${SOURCE_ID}"`,
    `    sourceRevision: "${REVISION}"`,
    `    parsedHash: "${opts.parsedHash}"`,
  ].join('\n');
  const page = (type: string, title: string, relPath: string, body: string): string => [
    `---FILE: ${relPath}---`,
    '---',
    `type: ${type}`,
    `title: "${title}"`,
    'summary: s',
    'keywords: []',
    'tags: []',
    ref,
    'created: "2026-09-14T00:00:00Z"',
    'updated: "2026-09-14T00:00:00Z"',
    '---',
    '',
    body,
    '---END FILE---',
  ].join('\n');
  return {
    model: 'fake-long-queue',
    contextTokens: opts.contextTokens,
    invoke: async (req: { system: string; user: string }) => {
      if (req.system.includes('分块分析')) {
        return { text: '## 分块分析\n本段结论。\n\n## 全局摘要\n累计。', finishReason: 'stop', usage: { outputTokens: 1 } };
      }
      if (req.system.includes('只输出 FILE 块')) {
        return {
          text: [
            page('source', 'N', `wiki/sources/${SOURCE_ID}.md`, '# N\n\n正文。'),
            page('concept', 'Foo', 'wiki/concepts/foo.md', '# Foo\n\n握手。'),
          ].join('\n\n'),
          finishReason: 'stop',
          usage: { outputTokens: 1 },
        };
      }
      return { text: '## 关键实体\n- AXI', finishReason: 'stop', usage: { outputTokens: 1 } };
    },
  };
}

/** 长来源（约 1 万 CJK token）：contextTokens 12k 时必然分段 */
const LONG_SOURCE = Array.from({ length: 150 }, (_, i) => [
  `## 第 ${i + 1} 章`,
  '',
  `本章描述第 ${i + 1} 部分的协议机制、位段与时序约束，包含寄存器字段、单位与复位值等结构化信息。`,
  `本节说明与第 ${i + 1} 节相关的验证要点、信号命名与边界条件，供验证工程师对照实现。`,
  '',
].join('\n')).join('\n');

describe('编译任务 — 分段进度与 blocked（issue 10）', () => {
  it('长来源分段推进：事件带分段进度，完成后清空', async () => {
    writeFileSync(join(wikiLayout(kbPath).rawParsedDir, `${SOURCE_PATH}.md`), LONG_SOURCE, 'utf-8');
    const hash = createHash('sha256').update(LONG_SOURCE, 'utf-8').digest('hex');
    const read = JSON.parse(readFileSync(wikiLayout(kbPath).manifestPath, 'utf-8')) as WikiKbManifest;
    read.sources![SOURCE_ID]!.parsedHash = hash;
    read.sources![SOURCE_ID]!.size = LONG_SOURCE.length;
    await writeWikiManifest(kbPath, read);
    writeFileSync(wikiLayout(kbPath).schemaMdPath, SCHEMA_MD_SKELETON, 'utf-8');

    const events: Array<{ phase: string; progress?: { done: number; total: number } | null }> = [];
    const q = new WikiIngestQueueManager({
      notify: (e) => {
        if (e.type === 'task') events.push({ phase: e.phase, progress: e.progress });
      },
      compileLlmFactory: async () => longSourceLlm({ contextTokens: 12_000, parsedHash: hash }),
    });
    await q.attach(kbPath, KB_ID);
    const task = await q.enqueueCompile(KB_ID, SOURCE_ID);
    await waitForPhase(q, task.taskId, 'done', 15_000);

    // 分段进度对面板可见：analyzing 阶段出现递增的 done/total
    const progressEvents = events.filter(
      (e) => e.progress && e.progress.total > 1,
    ) as Array<{ phase: string; progress: { done: number; total: number } }>;
    expect(progressEvents.length).toBeGreaterThan(1);
    expect(progressEvents[0]!.progress.total).toBeGreaterThan(1);
    expect(progressEvents.at(-1)!.progress.done).toBe(progressEvents.at(-1)!.progress.total);

    // 终态清空进度
    const t = q.snapshot(KB_ID)?.tasks.find((x) => x.taskId === task.taskId);
    expect(t?.phase).toBe('done');
    expect(t?.progress).toBeNull();
  }, 20_000);

  it('预算不足 → blocked（不是 failed），可重试且不再被去重挡住', async () => {
    const q = new WikiIngestQueueManager({
      notify: () => undefined,
      compileLlmFactory: async () => longSourceLlm({ contextTokens: 1_000, parsedHash: PARSED_HASH }),
    });
    await q.attach(kbPath, KB_ID);
    const task = await q.enqueueCompile(KB_ID, SOURCE_ID);
    await waitForPhase(q, task.taskId, 'blocked');

    const t = q.snapshot(KB_ID)?.tasks.find((x) => x.taskId === task.taskId);
    expect(t?.lastError?.code).toBe('contextBudgetExceeded');
    expect(t?.lastError?.message).toMatch(/预算|最小原子证据/);
    expect(t?.progress).toBeNull();

    // 持久化并可解释（内存状态先于落盘，用轮询等待持久化完成）
    await vi.waitFor(() => {
      const raw = readFileSync(join(kbPath, '.kb', 'queue.json'), 'utf-8');
      if (!raw.includes('blocked')) throw new Error('queue.json 尚未写入 blocked');
      expect(raw).not.toContain('sk-');
    });

    // 暂停调度后再做入队/重试断言（避免重试立即被再跑一次造成竞态）
    await q.pause(KB_ID);

    // blocked 是停机状态：新入队不被去重挡住（用户补齐预算后重新编译）
    const again = await q.enqueueCompile(KB_ID, SOURCE_ID);
    expect(again.taskId).not.toBe(task.taskId);
    await q.cancelTask(KB_ID, again.taskId);

    // blocked 可重试（补齐预算后继续；已完成分段保留在 checkpoint）
    await q.retryTask(KB_ID, task.taskId);
    const retried = q.snapshot(KB_ID)?.tasks.find((x) => x.taskId === task.taskId);
    expect(retried?.phase).toBe('queued');
    await q.cancelTask(KB_ID, task.taskId);
  });
});
