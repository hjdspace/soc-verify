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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WikiIngestQueueManager } from '../src/main/kb/ingest-queue';
import type { CompileLlm } from '../src/main/kb/compile';
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
