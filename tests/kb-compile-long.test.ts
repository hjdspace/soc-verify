/**
 * kb-compile-long.test.ts — 长手册分段编译与断点恢复（issue 10，spec §4；A05/A12）。
 *
 * 验收：
 *  - 超预算手册按章节分段处理，覆盖清单证明所有行/章节/原子证据都处理过；
 *  - 100 页 fixture 的首/中/末精确参数都能在提案里定位到原文行；
 *  - checkpoint 指纹不匹配即重算；取消后已完成分析保留，重试只重做未完成段；
 *  - 预算不足 → 明确 blocked（contextBudgetExceeded），不静默裁切、不写 staging；
 *  - 覆盖清单与分段信息持久化在 changeSet.warnings，可在审阅入口核对。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { compileWikiSource, type CompileLlm, type LlmCallResultLike } from '../src/main/kb/compile';
import { estimateTokens } from '../src/main/kb/token-budget';
import { longSourceCheckpointPath } from '../src/main/kb/long-source-checkpoint';
import {
  initWikiLayout,
  writeWikiManifest,
  wikiLayout,
  SCHEMA_MD_SKELETON,
  type WikiKbManifest,
} from '../src/main/kb/wiki-layout';
import type { WikiSourceRecord } from '@shared/kb-types';

let kbPath: string;

const SOURCE_ID = 'a'.repeat(64);
const SOURCE_PATH = 'amba-100p.md';
const REVISION = 'b'.repeat(64);

/** 首/中/末尾埋点：精确参数 + 其源行号（1-based） */
type Mark = { label: string; param: string; line: number };

type Manual = { content: string; marks: Mark[] };

/**
 * 100 页手册 fixture：每页含说明段落 + 一处表格，首/中/末三页各埋一处精确参数。
 * 表格是原子证据，用于验证分段不会把表切成半个。
 */
function manual100(pages = 100): Manual {
  const lines: string[] = [];
  const marks: Mark[] = [];
  const push = (l: string): void => { lines.push(l); };

  push('# 例如 AMBA AXI 手册（100 页 fixture）');
  push('');
  const special: Record<number, { label: string; param: string }> = {
    1: { label: 'HEAD', param: 'REG_HEAD_AWLEN = 0x10（复位值 0x10）' },
    50: { label: 'MID', param: 'REG_MID_T_RCD = 18ns（最小 ACT 到读命令）' },
    100: { label: 'TAIL', param: 'REG_TAIL_OUTSTANDING_LIMIT = 16（DUT 实现上限）' },
  };

  for (let p = 1; p <= pages; p += 1) {
    push(`## 第 ${p} 页 — 章节 ${p}`);
    push('');
    push(`本页描述协议手册第 ${p} 部分的机制、位段与时序约束，包含寄存器字段、单位与复位值等结构化信息。`);
    push(`本节还说明与第 ${p} 节相关的验证要点、信号命名与边界条件，供验证工程师对照实现。`);
    push('');
    push('| 字段 | 位宽 | 复位值 |');
    push('| --- | --- | --- |');
    push(`| FIELD_${p}_A | 4 | 0x0 |`);
    push(`| FIELD_${p}_B | 32 | 0x0 |`);
    push('');
    const s = special[p];
    if (s) {
      marks.push({ label: s.label, param: s.param, line: lines.length + 1 });
      push(`- 精确参数：${s.param}`);
      push('');
    }
  }
  return { content: `${lines.join('\n')}\n`, marks };
}

function pageFrontmatter(type: string, title: string, parsedHash: string): string {
  return [
    '---',
    `type: ${type}`,
    `title: "${title}"`,
    'summary: 摘要。',
    'keywords: [AXI]',
    'tags: []',
    'sources:',
    `  - sourceId: "${SOURCE_ID}"`,
    `    sourceRevision: "${REVISION}"`,
    `    parsedHash: "${parsedHash}"`,
    'created: "2026-09-14T00:00:00Z"',
    'updated: "2026-09-14T00:00:00Z"',
    '---',
  ].join('\n');
}

const fileBlock = (p: string, body: string): string => `---FILE: ${p}---\n${body}\n---END FILE---`;

/** 从分段分析提示词里取出精确参数行（模拟模型读本段并保留精确参数） */
function extractParams(user: string): string[] {
  return user
    .split('\n')
    .filter((line) => line.includes('精确参数：'))
    .map((line) => line.trim());
}

type FakeCall = { kind: 'chunk' | 'analysis' | 'generation' | 'repair'; user: string };

/**
 * 分段感知的假模型：
 *  - 分段分析：保留该段出现的精确参数（写进「分块分析」与「全局摘要」）；
 *  - 生成：把「生成依据」整段带进页面正文（模拟模型按分析写页）；
 *  - 可选在指定第 N 次分段调用时触发取消（模拟用户取消在途请求）。
 */
function longFakeLlm(opts: {
  contextTokens: number;
  parsedHash: string;
  abortController?: AbortController;
  abortBeforeChunk?: number;
  /** 给每段结论追加的填充字符数（用于触发「结论超上界」的可见告警） */
  padChunkAnalysis?: number;
  onCall?: (call: FakeCall) => void;
}): CompileLlm & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let chunkCalls = 0;
  const llm = {
    model: 'fake-long-model',
    contextTokens: opts.contextTokens,
    calls,
    invoke: async (req: { system: string; user: string }): Promise<LlmCallResultLike> => {
      const kind: FakeCall['kind'] = req.system.includes('分块分析')
        ? 'chunk'
        : req.system.includes('只输出 FILE 块')
          ? 'generation'
          : req.system.includes('只补齐被请求')
            ? 'repair'
            : 'analysis';
      const call: FakeCall = { kind, user: req.user };
      calls.push(call);
      opts.onCall?.(call);

      if (kind === 'chunk') {
        chunkCalls += 1;
        if (opts.abortBeforeChunk !== undefined && chunkCalls >= opts.abortBeforeChunk) {
          opts.abortController?.abort();
        }
        const params = extractParams(req.user);
        const filler = opts.padChunkAnalysis ? '补充说明。'.repeat(Math.ceil(opts.padChunkAnalysis / 5)) : '';
        return {
          text: `## 分块分析\n${params.length > 0 ? params.join('\n') : '（本段无精确参数）'}${filler}`
            + `\n\n## 全局摘要\n已处理 ${chunkCalls} 段，保留上述精确参数。`,
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      if (kind === 'generation') {
        const idx = req.user.indexOf('## 第一阶段的结构化分析（生成依据）');
        const analysis = idx >= 0 ? req.user.slice(idx) : req.user;
        return {
          text: fileBlock(
            `wiki/sources/${SOURCE_ID}.md`,
            `${pageFrontmatter('source', 'AMBA 手册来源', opts.parsedHash)}\n\n# AMBA 手册来源\n\n${analysis}`,
          ),
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 900 },
        };
      }
      return { text: '## 关键实体\n- AXI', finishReason: 'stop', usage: null };
    },
  };
  return llm as unknown as CompileLlm & { calls: FakeCall[] };
}

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-long-'));
  await initWikiLayout(kbPath, { kbId: 'kb-long-1', name: '长来源编译库' });
  writeFileSync(wikiLayout(kbPath).purposeMdPath, '记录验证知识。', 'utf-8');
  writeFileSync(wikiLayout(kbPath).schemaMdPath, SCHEMA_MD_SKELETON, 'utf-8');
  writeFileSync(join(kbPath, 'wiki', 'index.md'), '# 知识库索引\n\n（空）\n', 'utf-8');
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

/** 写入来源 + manifest，返回 parsedHash */
async function prepareSource(manual: Manual): Promise<string> {
  writeFileSync(join(wikiLayout(kbPath).rawParsedDir, `${SOURCE_PATH}.md`), manual.content, 'utf-8');
  const hash = createHash('sha256').update(manual.content, 'utf-8').digest('hex');
  const manifest: WikiKbManifest = {
    manifestVersion: 1,
    format: 'wiki',
    kbId: 'kb-long-1',
    name: '长来源编译库',
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:00Z',
    sources: {
      [SOURCE_ID]: {
        sourcePath: SOURCE_PATH,
        sourceId: SOURCE_ID,
        ext: '.md',
        size: manual.content.length,
        currentRevision: REVISION,
        parsedRevision: REVISION,
        parsedHash: hash,
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
  return hash;
}

/** 让「可用输入」≈ 来源的 1/3：必然分段，但不至于 blocked */
function contextFor(manual: Manual): number {
  return Math.ceil(estimateTokens(manual.content) / 3) + 8_192 + 5_000;
}

const compile = (llm: CompileLlm, signal?: AbortSignal) =>
  compileWikiSource(
    kbPath,
    { kbId: 'kb-long-1', taskId: 'task-long', sourceId: SOURCE_ID },
    { llm, signal, retryBaseDelayMs: 0 },
  );

/** 覆盖清单里的分段源行范围 */
function manifestRanges(manifest: string): Array<[number, number]> {
  return [...manifest.matchAll(/源行 (\d+)-(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

// ── 100 页手册分段编译 ──────────────────────────────────────────

describe('compileWikiSource — 100 页手册分段编译（A05）', () => {
  it('按段处理全文，覆盖清单证明所有行/章节/原子证据处理过', async () => {
    const manual = manual100(100);
    const hash = await prepareSource(manual);
    const llm = longFakeLlm({ contextTokens: contextFor(manual), parsedHash: hash });

    const res = await compile(llm);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const chunking = res.chunking;
    expect(chunking).not.toBeNull();
    if (!chunking) return;

    expect(chunking.total).toBeGreaterThan(1);
    expect(chunking.coverage.uncoveredLines).toEqual([]);
    expect(chunking.coverage.coveredLines).toBe(chunking.coverage.totalLines);
    expect(chunking.coverage.coveredSections.length).toBe(chunking.coverage.sections.length);
    expect(chunking.coverage.tableBlocks).toBeGreaterThan(0);
    expect(chunking.coverage.coveredTableRowLines).toBe(chunking.coverage.tableRowLines);

    // 覆盖清单进入 changeSet.warnings（审阅入口可核对）
    const warnings = res.changeSet.warnings.join('\n');
    expect(warnings).toContain('【长来源分段覆盖清单】');
    expect(warnings).toMatch(/未覆盖 0/);
    expect(warnings).toMatch(/分段 \d+ 段/);
    expect(warnings).toMatch(/章节：覆盖 \d+\/\d+/);
    expect(warnings).toMatch(/源行 \d+-\d+/);

    // 每段都真的调用过模型（不是只读前若干字符）
    expect(llm.calls.filter((c) => c.kind === 'chunk')).toHaveLength(chunking.total);
    expect(chunking.completed).toBe(chunking.total);
    expect(chunking.resumedFrom).toBe(0);

    // 覆盖清单也送进生成提示词（提案必须覆盖首/中/末）
    const generation = llm.calls.find((c) => c.kind === 'generation');
    expect(generation?.user).toContain('【长来源分段覆盖清单】');
    expect(generation?.user).toContain('开头、中段与末尾的精确参数');
  });

  it('首/中/末尾精确参数都能在提案里定位到原文行', async () => {
    const manual = manual100(100);
    const hash = await prepareSource(manual);
    const llm = longFakeLlm({ contextTokens: contextFor(manual), parsedHash: hash });

    const res = await compile(llm);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(manual.marks).toHaveLength(3);
    const page = res.changeSet.pages.find((p) => p.relPath.endsWith(`sources/${SOURCE_ID}.md`));
    expect(page).toBeDefined();
    const body = page?.proposed ?? '';
    const ranges = manifestRanges(res.changeSet.warnings.join('\n'));
    expect(ranges.length).toBeGreaterThan(1);

    for (const mark of manual.marks) {
      // 1) 精确参数逐字进入提案
      expect(body).toContain(mark.param);
      // 2) 该参数所在源行确实落在某个被处理的分段行范围内
      expect(ranges.some(([a, b]) => mark.line >= a && mark.line <= b)).toBe(true);
    }
  });

  it('编译成功清除分段 checkpoint（不是成功缓存）', async () => {
    const manual = manual100(100);
    const hash = await prepareSource(manual);
    const llm = longFakeLlm({ contextTokens: contextFor(manual), parsedHash: hash });
    const res = await compile(llm);
    expect(res.ok).toBe(true);
    expect(existsSync(longSourceCheckpointPath(kbPath, SOURCE_ID))).toBe(false);
  });

  it('单段结论超出上界 → 可见告警（来源原文不裁剪，结论裁剪明示）', async () => {
    const manual = manual100(100);
    const hash = await prepareSource(manual);
    const llm = longFakeLlm({
      contextTokens: contextFor(manual),
      parsedHash: hash,
      padChunkAnalysis: 3_000, // 远超单段结论上界（2000 tokens）
    });
    const res = await compile(llm);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const warnings = res.changeSet.warnings.join('\n');
    expect(warnings).toMatch(/结论超出单段结论上界/);
    expect(warnings).toMatch(/未静默丢弃/);
    // 首段精确参数在裁剪后仍保留（裁剪只砍结论尾部，不动来源与段首结论）
    const page = res.changeSet.pages.find((p) => p.relPath.endsWith(`sources/${SOURCE_ID}.md`));
    expect(page?.proposed).toContain('REG_HEAD_AWLEN = 0x10');
  });
});

// ── 取消恢复（A12 / AC5） ──────────────────────────────────────

describe('compileWikiSource — 取消后从 checkpoint 恢复', () => {
  it('取消保留已完成分析；重试只重做未完成段，段序不重复', async () => {
    const manual = manual100(100);
    const hash = await prepareSource(manual);
    const contextTokens = contextFor(manual);

    // 第 1 轮：第 3 次分段调用时取消（前 2 段已完成并落 checkpoint）
    const controller = new AbortController();
    const first = longFakeLlm({
      contextTokens,
      parsedHash: hash,
      abortController: controller,
      abortBeforeChunk: 3,
    });
    const interrupted = await compile(first, controller.signal);

    expect(interrupted.ok).toBe(false);
    if (interrupted.ok) return;
    expect(interrupted.code).toBe('aborted');
    expect(interrupted.diagnostics.chunking?.completed).toBe(2);

    // checkpoint 保留已完成段（已完成分析不丢）
    const cpPath = longSourceCheckpointPath(kbPath, SOURCE_ID);
    expect(existsSync(cpPath)).toBe(true);
    const cp = JSON.parse(readFileSync(cpPath, 'utf-8')) as { completedThrough: number; analyses: string[]; fingerprint: string };
    expect(cp.completedThrough).toBe(2);
    expect(cp.analyses).toHaveLength(2);
    expect(cp.analyses[0]).toContain('REG_HEAD_AWLEN = 0x10');

    // 第 2 轮：同一指纹 → 从第 3 段继续，只做剩余段
    const second = longFakeLlm({ contextTokens, parsedHash: hash });
    const resumed = await compile(second);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.chunking?.resumedFrom).toBe(2);
    expect(resumed.chunking?.total).toBeGreaterThan(2);
    expect(second.calls.filter((c) => c.kind === 'chunk')).toHaveLength(resumed.chunking!.total - 2);
    expect(resumed.changeSet.warnings.join('\n')).toContain('checkpoint');

    // 恢复运行仍保留前 2 段结论（首段参数仍在提案里）
    const page = resumed.changeSet.pages.find((p) => p.relPath.endsWith(`sources/${SOURCE_ID}.md`));
    expect(page?.proposed).toContain('REG_HEAD_AWLEN = 0x10');
  });

  it('来源内容变化 → checkpoint 指纹不匹配 → 全部重算', async () => {
    const manual = manual100(60);
    const hash = await prepareSource(manual);
    const contextTokens = contextFor(manual);

    const controller = new AbortController();
    const first = longFakeLlm({
      contextTokens,
      parsedHash: hash,
      abortController: controller,
      abortBeforeChunk: 2,
    });
    const interrupted = await compile(first, controller.signal);
    expect(interrupted.ok).toBe(false);
    expect(existsSync(longSourceCheckpointPath(kbPath, SOURCE_ID))).toBe(true);

    // 来源内容改变（parsedHash 变）后重编：旧 checkpoint 不得复用
    const changed = manual100(60);
    changed.content = `${changed.content}\n# 追加章节\n\n- 精确参数：REG_NEW_TAIL = 7ns\n`;
    const newHash = await prepareSource(changed);
    expect(newHash).not.toBe(hash);

    const second = longFakeLlm({ contextTokens, parsedHash: newHash });
    const res2 = await compile(second);
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    expect(res2.chunking?.resumedFrom).toBe(0);
    expect(second.calls.filter((c) => c.kind === 'chunk')).toHaveLength(res2.chunking!.total);
    const page = res2.changeSet.pages.find((p) => p.relPath.endsWith(`sources/${SOURCE_ID}.md`));
    expect(page?.proposed).toContain('REG_NEW_TAIL = 7ns');
  });
});

// ── 预算不足（AC5） ────────────────────────────────────────────

describe('compileWikiSource — 预算不足明确 blocked', () => {
  it('可用输入低于最小原子证据 → contextBudgetExceeded，不调用模型、不写 staging', async () => {
    const manual = manual100(100);
    const hash = await prepareSource(manual);
    const llm = longFakeLlm({ contextTokens: 9_000, parsedHash: hash });

    const res = await compile(llm);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('contextBudgetExceeded');
    expect(res.message).toMatch(/预算|最小原子证据/);
    expect(llm.calls).toHaveLength(0);
    expect(res.diagnostics.budget).not.toBeNull();
    expect(res.diagnostics.chunking).toBeNull();

    const staging = wikiLayout(kbPath).stagingDir;
    expect(existsSync(staging) ? readdirSync(staging).length : 0).toBe(0);
  });

  it('分段结论无法随生成提示词送入 → 明确 blocked，不裁剪段落结论凑预算', async () => {
    const manual = manual100(100);
    const hash = await prepareSource(manual);
    // 段数多（目标小）+ 每段结论冗长 → 归并分析放不进可用输入
    const llm = longFakeLlm({
      contextTokens: 12_500,
      parsedHash: hash,
      padChunkAnalysis: 3_000,
    });

    const res = await compile(llm);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('contextBudgetExceeded');
    expect(res.message).toMatch(/无法在不丢失段落结论的情况下生成提案/);
    // 已完成段保留在 checkpoint（重试只重做未完成段；不重复付费）
    expect(existsSync(longSourceCheckpointPath(kbPath, SOURCE_ID))).toBe(true);
    expect(res.diagnostics.chunking?.total).toBeGreaterThan(1);
    const staging = wikiLayout(kbPath).stagingDir;
    expect(existsSync(staging) ? readdirSync(staging).length : 0).toBe(0);
  });
});
