/**
 * kb-compile.test.ts — 短来源两阶段编译行为测试（issue 08）。
 *
 * 验收：
 *  - 先简洁分析再生成，不输出隐藏思维链（提示词约束）；
 *  - 任务固定库/来源修订/规则快照（sourceRef 由应用从 manifest 固定）；
 *  - 读当前目录（index）形成上下文；来源摘要路径与证据由应用绑定；
 *  - 基本坏输出必须拒绝（缺摘要页/伪造其他来源页/证据不符/未闭合块）；
 *  - 模型失败、预算不足、无凭证状态明确；
 *  - 输出仅经既有 staging（不直接写 wiki/）；
 *  - 取消可观察；既有同页更新带「待来源合并」提示。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  compileWikiSource,
  type CompileLlm,
  type LlmCallResultLike,
} from '../src/main/kb/compile';
import { buildAnalysisPrompt, buildGenerationPrompt } from '../src/main/kb/compile-prompts';
import { initWikiLayout, writeWikiManifest, wikiLayout, SCHEMA_MD_SKELETON, type WikiKbManifest } from '../src/main/kb/wiki-layout';
import type { WikiSourceRecord } from '@shared/kb-types';

let kbPath: string;

const SOURCE_ID = 'a'.repeat(64);
const REVISION = 'b'.repeat(64);
const PARSED_HASH = createHash('sha256').update('来源正文：AXI 协议详解。\n信号表略。', 'utf-8').digest('hex');
const SRC_REF = { sourceId: SOURCE_ID, sourceRevision: REVISION, parsedHash: PARSED_HASH };

const PARSED_CONTENT = '来源正文：AXI 协议详解。\n信号表略。';

/** fake LLM：按脚本依序返回，记录调用请求 */
function fakeLlm(
  responses: LlmCallResultLike[],
  opts: { onInvoke?: (req: { system: string; user: string }) => void } = {},
): CompileLlm & { requests: Array<{ system: string; user: string }> } {
  const requests: Array<{ system: string; user: string }> = [];
  let i = 0;
  return {
    model: 'fake-model',
    requests,
    invoke: async (req: { system: string; user: string }) => {
      requests.push({ system: req.system, user: req.user });
      opts.onInvoke?.(req);
      const r = responses[i++];
      if (!r) throw new Error('fake LLM 脚本耗尽');
      if (typeof r === 'string') return { text: r, finishReason: 'stop', usage: null };
      return r;
    },
  } as unknown as CompileLlm & { requests: Array<{ system: string; user: string }> };
}

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-compile-'));
  await initWikiLayout(kbPath, { kbId: 'kb-compile-1', name: '编译测试库' });
  // 写入 ready 来源 + parsed 全文
  writeFileSync(join(wikiLayout(kbPath).rawParsedDir, `${SOURCE_PATH}.md`), PARSED_CONTENT, 'utf-8');
  const manifest: WikiKbManifest = {
    manifestVersion: 1,
    format: 'wiki',
    kbId: 'kb-compile-1',
    name: '编译测试库',
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
  // purpose / schema / index（schema 使用应用骨架，保证可解析）
  writeFileSync(wikiLayout(kbPath).purposeMdPath, '记录验证知识与踩坑。', 'utf-8');
  writeFileSync(wikiLayout(kbPath).schemaMdPath, SCHEMA_MD_SKELETON, 'utf-8');
  writeFileSync(join(kbPath, 'wiki', 'index.md'), '# 知识库索引\n\n## 概念\n\n### AXI\n- **路径**: `concepts/axi.md`\n', 'utf-8');
});

const SOURCE_PATH = 'note.md';

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

// ── 提案文本工具 ────────────────────────────────────────────────

function pageFrontmatter(type: string, title: string, withSourceRef = true): string {
  return [
    '---',
    `type: ${type}`,
    `title: "${title}"`,
    'summary: 摘要。',
    'keywords: [AXI]',
    'tags: []',
    withSourceRef
      ? [
          'sources:',
          `  - sourceId: "${SRC_REF.sourceId}"`,
          `    sourceRevision: "${SRC_REF.sourceRevision}"`,
          `    parsedHash: "${SRC_REF.parsedHash}"`,
        ].join('\n')
      : 'sources: []',
    'created: "2026-09-14T00:00:00Z"',
    'updated: "2026-09-14T00:00:00Z"',
    '---',
  ].join('\n');
}

const fileBlock = (p: string, body: string): string => `---FILE: ${p}---\n${body}\n---END FILE---`;

function summaryPage(): string {
  return `${pageFrontmatter('source', 'AXI 来源')}\n\n# AXI 来源\n\n概述。`;
}

function conceptPage(): string {
  return `${pageFrontmatter('concept', 'AXI')}\n\n# AXI\n\n握手协议。`;
}

/** 标准两段脚本：分析 → 生成 */
function standardScript(): LlmCallResultLike[] {
  return [
    { text: '## 关键实体\n- AXI', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } },
    {
      text: [fileBlock(`wiki/sources/${SOURCE_ID}.md`, summaryPage()), '', fileBlock('wiki/concepts/axi.md', conceptPage())].join('\n'),
      finishReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 40 },
    },
  ];
}

const compile = (llm: CompileLlm | null, signal?: AbortSignal) =>
  compileWikiSource(
    kbPath,
    { kbId: 'kb-compile-1', taskId: 'task-c1', sourceId: SOURCE_ID },
    { llm, signal },
  );

// ── 提示词 ──────────────────────────────────────────────────────

describe('compile-prompts — 提示词契约', () => {
  it('分析提示词：含来源全文/purpose/schema/index，明确不输出思维链', () => {
    const p = buildAnalysisPrompt({
      purpose: '记录验证知识。',
      schema: '# Schema',
      index: '# 索引',
      sourceContent: '来源正文',
    });
    expect(p).toContain('来源正文');
    expect(p).toContain('记录验证知识。');
    expect(p).toContain('# Schema');
    expect(p).toContain('# 索引');
    expect(p).toContain('思维');
    expect(p).toContain('结构化');
  });

  it('生成提示词：FILE 模板 + 应用固定的来源摘要路径 + 应用绑定的证据行', () => {
    const p = buildGenerationPrompt({
      purpose: 'p',
      schema: '# Schema',
      index: '# 索引',
      analysis: '分析结果',
      sourceName: 'note.md',
      sourceSummaryRelPath: `wiki/sources/${SOURCE_ID}.md`,
      sourceRefYaml: [
        'sources:',
        `  - sourceId: "${SRC_REF.sourceId}"`,
        `    sourceRevision: "${SRC_REF.sourceRevision}"`,
        `    parsedHash: "${SRC_REF.parsedHash}"`,
      ].join('\n'),
      today: '2026-09-14T00:00:00Z',
      pageTypes: ['source', 'entity', 'concept', 'comparison', 'synthesis', 'query', 'pitfall', 'interface'],
    });
    expect(p).toContain(`wiki/sources/${SOURCE_ID}.md`);
    expect(p).toContain(`- sourceId: "${SRC_REF.sourceId}"`);
    expect(p).toContain('---FILE:');
    expect(p).toContain('---END FILE---');
    expect(p).toContain('2026-09-14T00:00:00Z');
    // 不允许模型生成聚合页
    expect(p).toContain('index.md');
    expect(p).toContain('overview.md');
    // 八类路由
    expect(p).toContain('pitfall');
  });
});

// ── compileWikiSource ───────────────────────────────────────────

describe('compileWikiSource — 成功路径', () => {
  it('两阶段调用 → stageProposal 落 staging，不直接写 wiki/', async () => {
    const llm = fakeLlm(standardScript());
    const res = await compile(llm);

    expect(res.ok).toBe(true);
    if (!res.ok || 'cached' in res) return;
    expect(llm.requests).toHaveLength(2);
    // 分析阶段拿到来源全文与 index；生成阶段拿到分析结果
    expect(llm.requests[0]!.user).toContain(PARSED_CONTENT);
    expect(llm.requests[0]!.user).toContain('AXI');
    expect(llm.requests[1]!.user).toContain('## 关键实体');

    // usage 汇总（可获得的 usage，不伪造）
    expect(res.usage).toHaveLength(2);
    expect(res.usage[0]).toEqual({ inputTokens: 10, outputTokens: 5 });

    // staging 落盘 + 契约字段
    const stagingDir = wikiLayout(kbPath).stagingDir;
    const files = readdirSync(stagingDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const cs = res.changeSet;
    expect(cs.taskId).toBe('task-c1');
    expect(cs.origin).toBe('compile');
    expect(cs.sources).toEqual([SRC_REF]);
    expect(cs.pages.map((p) => p.pageId).sort()).toEqual([`sources/${SOURCE_ID}`, 'concepts/axi'].sort());

    // 正式 wiki/ 未被编译直接写入（index 未变）
    expect(readFileSync(join(kbPath, 'wiki', 'index.md'), 'utf-8')).toContain('### AXI');
    expect(existsSync(join(kbPath, 'wiki', 'concepts', 'axi.md'))).toBe(false);
  });

  it('既有同页更新：staging 保留 before，warnings 提示待来源合并能力', async () => {
    mkdirSync(join(kbPath, 'wiki', 'concepts'), { recursive: true });
    writeFileSync(join(kbPath, 'wiki', 'concepts', 'axi.md'), conceptPage(), 'utf-8');
    const llm = fakeLlm(standardScript());
    const res = await compile(llm);
    expect(res.ok).toBe(true);
    if (!res.ok || 'cached' in res) return;
    const axi = res.changeSet.pages.find((p) => p.pageId === 'concepts/axi');
    expect(axi?.before).not.toBeNull();
    expect(res.changeSet.warnings.join('\n')).toContain('来源感知合并');
  });
});

describe('compileWikiSource — 坏输出必须拒绝', () => {
  it('缺少应用固定的来源摘要页 → llmFailed，不落 staging', async () => {
    const llm = fakeLlm([
      '分析',
      fileBlock('wiki/concepts/axi.md', conceptPage()),
    ]);
    const res = await compile(llm);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('llmFailed');
    expect(res.message).toContain(`sources/${SOURCE_ID}`);
    expect(readdirSync(wikiLayout(kbPath).stagingDir)).toHaveLength(0);
  });

  it('模型伪造其他来源的摘要页 → llmFailed（归属由应用绑定）', async () => {
    const forged = `${pageFrontmatter('source', '别的来源')}\n\n# 别的来源`;
    const llm = fakeLlm([
      '分析',
      fileBlock('wiki/sources/deadbeef.md', forged),
    ]);
    const res = await compile(llm);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('llmFailed');
    expect(res.message).toContain(`sources/${SOURCE_ID}`);
  });

  it('页面证据不含本来源 sourceRef → llmFailed（证据绑定校验）', async () => {
    const noRef = `${pageFrontmatter('concept', 'AXI', false)}\n\n# AXI`;
    const llm = fakeLlm([
      '分析',
      [fileBlock(`wiki/sources/${SOURCE_ID}.md`, summaryPage()), '', fileBlock('wiki/concepts/axi.md', noRef)].join('\n'),
    ]);
    const res = await compile(llm);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('llmFailed');
    expect(res.message).toContain('concepts/axi.md');
    expect(readdirSync(wikiLayout(kbPath).stagingDir)).toHaveLength(0);
  });

  it('未闭合块（流截断）→ llmFailed，不落 staging', async () => {
    const llm = fakeLlm([
      '分析',
      `---FILE: wiki/sources/${SOURCE_ID}.md---\n${summaryPage()}\n`,
    ]);
    const res = await compile(llm);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('llmFailed');
    expect(readdirSync(wikiLayout(kbPath).stagingDir)).toHaveLength(0);
  });
});

describe('compileWikiSource — 状态明确的失败', () => {
  it('无凭证（llm=null）→ noCredential', async () => {
    const res = await compile(null);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('noCredential');
    expect(res.message).toContain('凭证');
  });

  it('来源不存在 → sourceNotFound', async () => {
    const res = await compileWikiSource(
      kbPath,
      { kbId: 'kb-compile-1', taskId: 't', sourceId: 'f'.repeat(64) },
      { llm: fakeLlm(standardScript()) },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('sourceNotFound');
  });

  it('来源未就绪（parsedRevision 落后）→ sourceNotReady，不调用模型', async () => {
    // 直接改 manifest：当前修订推进但未重转
    const read = JSON.parse(readFileSync(wikiLayout(kbPath).manifestPath, 'utf-8')) as WikiKbManifest;
    const rec = read.sources![SOURCE_ID]!;
    rec.currentRevision = 'c'.repeat(64);
    await writeWikiManifest(kbPath, read);
    const llm = fakeLlm(standardScript());
    const res = await compile(llm);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('sourceNotReady');
    expect(llm.requests).toHaveLength(0);
  });

  it('预算不足以放最小原子证据 → contextBudgetExceeded，不调用模型（issue 10：不裁掉参数表）', async () => {
    const llm = fakeLlm(standardScript());
    (llm as { contextTokens?: number }).contextTokens = 1_000;
    const res = await compile(llm);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('contextBudgetExceeded');
    expect(llm.requests).toHaveLength(0);
    // 诊断带预算分解（可操作：规则/已有知识/输出预留/可用输入）
    expect(res.diagnostics.budget?.availableInputTokens).toBe(0);
  });

  it('模型调用失败 → llmFailed 且消息可读', async () => {
    const llm = fakeLlm([]);
    llm.invoke = async () => {
      throw new Error('LLM API 返回 502: Bad Gateway');
    };
    const res = await compile(llm);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('llmFailed');
    expect(res.message).toContain('502');
  });
});

describe('compileWikiSource — 取消可观察', () => {
  it('signal 已中止 → aborted，不调用模型', async () => {
    const controller = new AbortController();
    controller.abort();
    const llm = fakeLlm(standardScript());
    const res = await compile(llm, controller.signal);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('aborted');
    expect(llm.requests).toHaveLength(0);
  });

  it('分析阶段调用中被取消 → aborted，不进入生成阶段', async () => {
    const controller = new AbortController();
    const llm = fakeLlm(standardScript(), {
      onInvoke: () => controller.abort(),
    });
    const res = await compile(llm, controller.signal);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('aborted');
    expect(llm.requests).toHaveLength(1);
  });
});
