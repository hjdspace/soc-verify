/**
 * kb-compile-repair.test.ts — 流完整度、有界修复与失败诊断行为测试（issue 09）。
 *
 * 验收（spec §4 / §5）：
 *  - finish reason 为 length 或缺失必需来源摘要页时最多一次有界修复，
 *    修复目标仅限「缺失/截断的既定路径」；修复输出中的其他路径一律丢弃；
 *  - 修复仍失败 → 保留诊断（已完成阶段/usage/未补齐路径）并报失败，
 *    绝不发布 fallback 摘要页冒充完整成功；
 *  - 认证/坏模型停止自动重试；网络/429 有界退避并遵循 Retry-After；
 *  - 中止不再修复、不写 staging；错误信息不含凭证。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { compileWikiSource, type CompileLlm, type LlmCallResultLike } from '../src/main/kb/compile';
import { LlmCallError, configHintForStatus } from '../src/main/kb/llm-call';
import { initWikiLayout, writeWikiManifest, wikiLayout, SCHEMA_MD_SKELETON, type WikiKbManifest } from '../src/main/kb/wiki-layout';
import type { WikiSourceRecord } from '@shared/kb-types';

const KB_ID = 'kb-compile-repair';
const SOURCE_ID = 'a'.repeat(64);
const REVISION = 'b'.repeat(64);
const SOURCE_PATH = 'note.md';
const PARSED_CONTENT = '来源正文：AXI 协议详解。';
const PARSED_HASH = createHash('sha256').update(PARSED_CONTENT, 'utf-8').digest('hex');
const SRC_REF = { sourceId: SOURCE_ID, sourceRevision: REVISION, parsedHash: PARSED_HASH };
const SUMMARY_PATH = `wiki/sources/${SOURCE_ID}.md`;

let kbPath: string;

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-repair-'));
  await initWikiLayout(kbPath, { kbId: KB_ID, name: '修复测试库' });
  writeFileSync(join(wikiLayout(kbPath).rawParsedDir, `${SOURCE_PATH}.md`), PARSED_CONTENT, 'utf-8');
  const manifest: WikiKbManifest = {
    manifestVersion: 1,
    format: 'wiki',
    kbId: KB_ID,
    name: '修复测试库',
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:00Z',
    sources: {
      [SOURCE_ID]: {
        sourcePath: SOURCE_PATH,
        sourceId: SOURCE_ID,
        ext: '.md',
        size: PARSED_CONTENT.length,
        currentRevision: REVISION,
        parsedRevision: REVISION,
        parsedHash: PARSED_HASH,
        engine: 'text',
        engineFingerprint: 'text',
        status: 'ready',
        assetCount: 0,
        importedAt: '2026-09-14T00:00:00Z',
        updatedAt: '2026-09-14T00:00:00Z',
      } satisfies WikiSourceRecord,
    },
  };
  await writeWikiManifest(kbPath, manifest);
  writeFileSync(wikiLayout(kbPath).purposeMdPath, '记录验证知识与踩坑。', 'utf-8');
  writeFileSync(wikiLayout(kbPath).schemaMdPath, SCHEMA_MD_SKELETON, 'utf-8');
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

// ── 提案文本工具 ────────────────────────────────────────────────

function frontmatter(type: string, title: string): string {
  return [
    '---',
    `type: ${type}`,
    `title: "${title}"`,
    'summary: 摘要。',
    'keywords: [AXI]',
    'tags: []',
    'sources:',
    `  - sourceId: "${SRC_REF.sourceId}"`,
    `    sourceRevision: "${SRC_REF.sourceRevision}"`,
    `    parsedHash: "${SRC_REF.parsedHash}"`,
    'created: "2026-09-14T00:00:00Z"',
    'updated: "2026-09-14T00:00:00Z"',
    '---',
  ].join('\n');
}

const fileBlock = (p: string, body: string): string => `---FILE: ${p}---\n${body}\n---END FILE---`;
const summaryPage = (): string => `${frontmatter('source', 'AXI 来源')}\n\n# AXI 来源\n\n概述。`;
const conceptPage = (): string => `${frontmatter('concept', 'AXI')}\n\n# AXI\n\n握手协议。`;

// ── 可控假模型 ──────────────────────────────────────────────────

type Step = LlmCallResultLike | { throw: unknown };
type RecordedRequest = { system: string; user: string };

function fakeLlm(
  steps: Step[],
  onInvoke?: (req: RecordedRequest, index: number) => void,
): CompileLlm & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  let i = 0;
  const impl = {
    model: 'fake-repair-model',
    requests,
    invoke: async (req: RecordedRequest) => {
      const index = i;
      requests.push({ system: req.system, user: req.user });
      onInvoke?.(req, index);
      const step = steps[i++];
      if (step === undefined) throw new Error('fake LLM 脚本耗尽');
      if (typeof step === 'object' && step !== null && 'throw' in step) throw step.throw;
      if (typeof step === 'string') return { text: step, finishReason: 'stop', usage: null };
      return step;
    },
  };
  return impl as unknown as CompileLlm & { requests: RecordedRequest[] };
}

const ANALYSIS_OK: LlmCallResultLike = {
  text: '## 关键实体\n- AXI',
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
};

const compile = (llm: CompileLlm, signal?: AbortSignal, retryBaseDelayMs = 0) =>
  compileWikiSource(
    kbPath,
    { kbId: KB_ID, taskId: 'task-r1', sourceId: SOURCE_ID },
    { llm, signal, retryBaseDelayMs },
  );

const stagingFiles = (): string[] =>
  readdirSync(wikiLayout(kbPath).stagingDir).filter((f) => f.endsWith('.json'));

// ── 有界修复：触发条件 ──────────────────────────────────────────

describe('compileWikiSource — 有界修复（issue 09）', () => {
  it('finishReason=length + 截断的来源摘要块 → 恰一次修复调用补齐后成功', async () => {
    const llm = fakeLlm([
      ANALYSIS_OK,
      // 生成被 max_tokens 截断：摘要块未闭合
      { text: `---FILE: ${SUMMARY_PATH}---\n${summaryPage()}\n`, finishReason: 'length', usage: { outputTokens: 20 } },
      // 修复：只补齐既定目标
      { text: fileBlock(SUMMARY_PATH, summaryPage()), finishReason: 'stop', usage: { outputTokens: 30 } },
    ]);
    const res = await compile(llm);

    expect(res.ok).toBe(true);
    if (!res.ok || 'cached' in res) return;
    expect(llm.requests).toHaveLength(3);            // 分析 + 生成 + 修复（不重复修复）
    expect(res.repairAttempted).toBe(true);
    expect(res.changeSet.pages.map((p) => p.pageId)).toEqual([`sources/${SOURCE_ID}`]);
    expect(res.usage).toHaveLength(3);
    expect(stagingFiles()).toHaveLength(1);
    // 修复提示词只允许既定路径
    expect(llm.requests[2]!.user).toContain(SUMMARY_PATH);
  });

  it('缺必需来源摘要页（无截断）→ 一次修复只请求该固定路径', async () => {
    const llm = fakeLlm([
      ANALYSIS_OK,
      fileBlock('wiki/concepts/axi.md', conceptPage()),
      fileBlock(SUMMARY_PATH, summaryPage()),
    ]);
    const res = await compile(llm);
    expect(res.ok).toBe(true);
    if (!res.ok || 'cached' in res) return;
    expect(llm.requests).toHaveLength(3);
    expect(res.repairAttempted).toBe(true);
    expect(res.changeSet.pages.map((p) => p.pageId).sort()).toEqual(
      [`sources/${SOURCE_ID}`, 'concepts/axi'].sort(),
    );
  });

  it('finishReason=length 但输出完整（无缺失目标）→ 不触发修复，但记录可见说明', async () => {
    const llm = fakeLlm([
      ANALYSIS_OK,
      {
        text: [fileBlock(SUMMARY_PATH, summaryPage()), fileBlock('wiki/concepts/axi.md', conceptPage())].join('\n\n'),
        finishReason: 'length',
        usage: { outputTokens: 40 },
      },
    ]);
    const res = await compile(llm);
    expect(res.ok).toBe(true);
    if (!res.ok || 'cached' in res) return;
    expect(llm.requests).toHaveLength(2);
    expect(res.repairAttempted).toBe(false);
    // length 只作为原因信号被记录，不凭空指定修复目标
    expect(res.changeSet.warnings.join('\n')).toContain('length');
  });

  it('修复输出含未请求路径 → 丢弃并留下可见警告（不写入 staging）', async () => {
    const llm = fakeLlm([
      ANALYSIS_OK,
      fileBlock('wiki/concepts/axi.md', conceptPage()),
      [
        fileBlock(SUMMARY_PATH, summaryPage()),
        fileBlock('wiki/concepts/other.md', conceptPage()),   // 未请求
      ].join('\n\n'),
    ]);
    const res = await compile(llm);
    expect(res.ok).toBe(true);
    if (!res.ok || 'cached' in res) return;
    expect(res.changeSet.pages.map((p) => p.pageId).sort()).toEqual(
      [`sources/${SOURCE_ID}`, 'concepts/axi'].sort(),
    );
    expect(res.changeSet.warnings.join('\n')).toContain('未请求');
    expect(res.changeSet.pages.some((p) => p.pageId === 'concepts/other')).toBe(false);
  });

  it('修复仍截断 → llmFailed + 诊断（不发布 fallback 页，不落 staging）', async () => {
    const llm = fakeLlm([
      ANALYSIS_OK,
      { text: `---FILE: ${SUMMARY_PATH}---\n${summaryPage()}\n`, finishReason: 'length', usage: { outputTokens: 20 } },
      { text: `---FILE: ${SUMMARY_PATH}---\n又没结束`, finishReason: 'length', usage: { outputTokens: 20 } },
    ]);
    const res = await compile(llm);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('llmFailed');
    expect(res.diagnostics.repairAttempted).toBe(true);
    expect(res.diagnostics.unresolvedPaths).toContain(SUMMARY_PATH);
    expect(res.diagnostics.completedPhases).toContain('analyzing');
    // 恰一次修复：不会再有第二次补齐调用
    expect(llm.requests).toHaveLength(3);
    // 分析 + 生成 + 修复的 usage 都保留
    expect(res.diagnostics.usage).toHaveLength(3);
    expect(stagingFiles()).toHaveLength(0);
    expect(res.message).toContain(SUMMARY_PATH);
  });

  it('修复只补齐部分目标（漏项）→ llmFailed，不发布不完整输出', async () => {
    const llm = fakeLlm([
      ANALYSIS_OK,
      [
        fileBlock(SUMMARY_PATH, summaryPage()),
        '---FILE: wiki/concepts/trunc.md---\n未闭合',
      ].join('\n\n'),
      // 修复只给出摘要页，漏掉 concepts/trunc
      fileBlock(SUMMARY_PATH, summaryPage()),
    ]);
    const res = await compile(llm);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('llmFailed');
    expect(res.diagnostics.unresolvedPaths).toContain('wiki/concepts/trunc.md');
    expect(res.message).toContain('wiki/concepts/trunc.md');
    expect(stagingFiles()).toHaveLength(0);
  });

  it('坏输出不可修复（证据不符）→ 不调用修复，直接 llmFailed', async () => {
    const noRef = `${['---', 'type: concept', 'title: "AXI"', 'summary: s', 'keywords: []', 'tags: []', 'sources: []', 'created: "2026-09-14T00:00:00Z"', 'updated: "2026-09-14T00:00:00Z"', '---'].join('\n')}\n\n# AXI`;
    const llm = fakeLlm([
      ANALYSIS_OK,
      [fileBlock(SUMMARY_PATH, summaryPage()), fileBlock('wiki/concepts/axi.md', noRef)].join('\n\n'),
    ]);
    const res = await compile(llm);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('llmFailed');
    expect(res.diagnostics.repairAttempted).toBe(false);
    expect(llm.requests).toHaveLength(2);
    expect(stagingFiles()).toHaveLength(0);
  });

  it('截断路径不在 schema 路由内 → 不作为修复目标（仍以原诊断失败）', async () => {
    const llm = fakeLlm([
      ANALYSIS_OK,
      [
        fileBlock(SUMMARY_PATH, summaryPage()),
        `---FILE: wiki/misc/bogus.md---\n未闭合`,
      ].join('\n\n'),
    ]);
    const res = await compile(llm);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('llmFailed');
    // 只在沙箱内的既定目标才允许请求修复 → 无可修复目标 → 不调用修复
    expect(llm.requests).toHaveLength(2);
    expect(res.diagnostics.unresolvedPaths).toContain('wiki/misc/bogus.md');
  });
});

// ── 重试策略：可重试 vs 不可重试 ────────────────────────────────

describe('compileWikiSource — 重试策略（issue 09）', () => {
  it('网络错误有界退避：退避后成功，retryCount 可观察', async () => {
    let calls = 0;
    const llm: CompileLlm = {
      model: 'fake',
      invoke: async () => {
        calls += 1;
        if (calls <= 2) throw new LlmCallError('网络错误: 连接被重置', true);
        if (calls === 3) return ANALYSIS_OK;
        return { text: fileBlock(SUMMARY_PATH, summaryPage()), finishReason: 'stop', usage: null };
      },
    };
    const res = await compile(llm);
    expect(res.ok).toBe(true);
    if (!res.ok || 'cached' in res) return;
    expect(calls).toBe(4);                 // 分析：2 次失败 + 1 次成功；生成：1 次
    expect(res.retryCount).toBe(2);
  });

  it('可重试错误超过上限 → 3 次尝试后 llmFailed（有界），诊断保留重试数', async () => {
    let calls = 0;
    const llm: CompileLlm = {
      model: 'fake',
      invoke: async () => {
        calls += 1;
        throw new LlmCallError(`网络错误 #${calls}`, true);
      },
    };
    const res = await compile(llm);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('llmFailed');
    expect(calls).toBe(3);
    expect(res.diagnostics.retryCount).toBe(2);
    expect(res.message).toContain('网络错误 #3');
  });

  it('认证失败（401，不可重试）→ 不重试，仅一次调用且提示配置入口', async () => {
    const err401 = new LlmCallError(
      `LLM API 返回 401: Unauthorized（模型 m @ http://x/v1/chat/completions）${configHintForStatus(401)}`,
      false,
    );
    Object.assign(err401, { status: 401 });
    const llm = fakeLlm([{ throw: err401 }]);
    const res = await compile(llm);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('llmFailed');
    expect(llm.requests).toHaveLength(1);
    expect(res.diagnostics.retryCount).toBe(0);
    expect(res.diagnostics.completedPhases).toEqual([]);
    expect(res.message).toContain('凭证');
  });

  it('Retry-After 建议等待被采信（429 退避重试后成功）', async () => {
    const retryable = () => {
      const e = new LlmCallError('LLM API 返回 429: too many requests', true);
      Object.assign(e, { status: 429, retryAfterMs: 1 });
      return e;
    };
    let calls = 0;
    const llm: CompileLlm = {
      model: 'fake',
      invoke: async () => {
        calls += 1;
        if (calls === 1) throw retryable();
        if (calls === 2) return ANALYSIS_OK;
        return { text: fileBlock(SUMMARY_PATH, summaryPage()), finishReason: 'stop', usage: null };
      },
    };
    const res = await compile(llm);
    expect(res.ok).toBe(true);
    if (!res.ok || 'cached' in res) return;
    expect(res.retryCount).toBe(1);
  });

  it('错误信息不含凭证', async () => {
    const err = new LlmCallError('LLM API 返回 401: Unauthorized（模型 m @ http://gw.local/v1/chat/completions）', false);
    const llm = fakeLlm([{ throw: err }]);
    const res = await compile(llm);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).not.toContain('sk-');
    expect(res.message).not.toContain('Bearer');
  });
});

// ── 中止：不修复、不写盘、保留诊断 ──────────────────────────────

describe('compileWikiSource — 中止语义（issue 09）', () => {
  it('生成被截断且此时取消 → aborted，不调用修复，不写 staging', async () => {
    const controller = new AbortController();
    const llm = fakeLlm(
      [
        ANALYSIS_OK,
        { text: `---FILE: ${SUMMARY_PATH}---\n${summaryPage()}\n`, finishReason: 'length', usage: { outputTokens: 20 } },
      ],
      (_req, index) => {
        if (index === 1) controller.abort();
      },
    );
    const res = await compile(llm, controller.signal);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('aborted');
    expect(llm.requests).toHaveLength(2);            // 没有第三次（修复）调用
    expect(res.diagnostics.repairAttempted).toBe(false);
    expect(res.diagnostics.completedPhases).toContain('analyzing');
    expect(stagingFiles()).toHaveLength(0);
  });

  it('分析阶段即中止 → aborted，usage 为空、无阶段完成', async () => {
    const controller = new AbortController();
    controller.abort();
    const llm = fakeLlm([ANALYSIS_OK]);
    const res = await compile(llm, controller.signal);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('aborted');
    expect(llm.requests).toHaveLength(0);
    expect(res.diagnostics.completedPhases).toEqual([]);
    expect(res.diagnostics.usage).toEqual([]);
    expect(stagingFiles()).toHaveLength(0);
  });
});
