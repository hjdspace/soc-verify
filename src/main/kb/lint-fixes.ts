/**
 * Lint Fixes — 从 finding 生成修复提案并绑定证据（spec §9，issue 27）。
 *
 * 请求修复固定 finding 证据 hash 和相关页基线，复用 staging/publish 链路：
 *  1. 读取 finding → 验证 open 状态 → 检查无已存在的 fixChangeSetId
 *  2. 加载涉及页面正文 → 构建修复提示词 → LLM 生成修复提案
 *  3. 通过 stageProposal 持久化为变更集（origin='fix'）
 *  4. 回写 finding.fixChangeSetId
 *
 * 拒绝或修复失败保留待处理状态：
 *  - LLM 失败 → llmFailed，finding 不变
 *  - staging 失败 → stagingFailed，finding 不变
 *  - 审阅拒绝 → 清除 fixChangeSetId，finding 保持 open
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §9
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFindings, updateFindingFixFields } from './finding-store';
import { stageProposal } from './staging';
import { readWikiManifest } from './wiki-layout';
import { scanWikiCatalog } from './wiki-catalog';
import type {
  WikiLintFixResult,
  WikiSourceRef,
  WikiStructuralFinding,
} from '@shared/kb-types';

// ── 模型调用边界 ────────────────────────────────────────────────

export type FixLlmCallResultLike =
  | string
  | {
      text: string;
      finishReason?: string | null;
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
    };

/** 修复用模型入口。null = 无凭证。 */
export type FixLlm = {
  invoke: (req: { system: string; user: string; maxTokens: number }) => Promise<FixLlmCallResultLike>;
};

// ── 输入 ────────────────────────────────────────────────────────

export type RequestFixInput = {
  /** 要修复的 finding ID */
  findingId: string;
  /** 模型入口；null = 无凭证 */
  llm: FixLlm | null;
  /** 来源引用（用于 staging） */
  sourceRefs: WikiSourceRef[];
  /** 注入时钟（测试用） */
  now?: string;
};

// ── 实现 ────────────────────────────────────────────────────────

/**
 * 从 finding 请求修复。
 *
 * 1. 读取 finding → 验证 open → 检查无已存在的 fixChangeSetId
 * 2. 加载涉及页面正文 → 构建修复提示词 → LLM 生成 FILE 提案
 * 3. stageProposal 持久化（origin='fix'）
 * 4. 回写 finding.fixChangeSetId
 */
export async function requestFix(
  kbPath: string,
  input: RequestFixInput,
): Promise<WikiLintFixResult> {
  const now = input.now ?? new Date().toISOString();

  // 读取 finding
  const findingsResult = await readFindings(kbPath);
  if (!findingsResult.ok) {
    return { ok: false, code: 'findingNotFound', message: findingsResult.message };
  }
  const finding = findingsResult.findings.find((f) => f.findingId === input.findingId);
  if (!finding) {
    return { ok: false, code: 'findingNotFound', message: `Finding ${input.findingId} 不存在` };
  }

  // 验证 open 状态
  if (finding.status !== 'open') {
    return { ok: false, code: 'findingNotOpen', message: `Finding 状态为 ${finding.status}，只有 open 才能请求修复` };
  }

  // 检查无已存在的未发布修复
  if (finding.fixChangeSetId) {
    return { ok: false, code: 'alreadyRequested', message: `Finding 已有关联的修复提案 ${finding.fixChangeSetId}` };
  }

  // 无 LLM 配置
  if (input.llm === null) {
    return { ok: false, code: 'noLlmConfig', message: '修复需要 LLM 配置（无凭证）' };
  }

  // 加载涉及页面正文
  const catalog = await scanWikiCatalog(kbPath);
  if (!catalog.ok) {
    return { ok: false, code: 'stagingFailed', message: 'wiki/ 目录或 schema 无法解析' };
  }

  const pages: Array<{ pageId: string; title: string; body: string }> = [];
  for (const pageId of finding.pageIds) {
    const page = catalog.catalog.pages.find((p) => p.pageId === pageId);
    if (!page || !page.parse.ok) continue;
    try {
      const content = await readFile(join(kbPath, page.relPath), 'utf-8');
      const body = extractBody(content);
      pages.push({
        pageId,
        title: page.parse.frontmatter.title,
        body,
      });
    } catch {
      // 页面读取失败，跳过
    }
  }

  if (pages.length === 0) {
    return { ok: false, code: 'stagingFailed', message: '无法加载 finding 涉及页面的正文' };
  }

  // 构建修复提示词
  const prompt = buildFixPrompt(finding, pages);

  // 调用 LLM 生成修复提案
  let proposalText: string;
  try {
    const result = await input.llm.invoke({
      system: '你是严谨的知识库编辑员。根据发现的问题生成修复提案。',
      user: prompt,
      maxTokens: 8192,
    });
    proposalText = typeof result === 'string' ? result : result.text;
  } catch (err) {
    return { ok: false, code: 'llmFailed', message: `LLM 调用失败: ${String(err)}` };
  }

  // 计算页面基线 hash
  const pageBaseline: Array<{ pageId: string; hash: string | null }> = [];
  for (const pageId of finding.pageIds) {
    const page = catalog.catalog.pages.find((p) => p.pageId === pageId);
    if (!page) {
      pageBaseline.push({ pageId, hash: null });
      continue;
    }
    try {
      const content = await readFile(join(kbPath, page.relPath), 'utf-8');
      pageBaseline.push({ pageId, hash: createHash('sha256').update(content, 'utf-8').digest('hex') });
    } catch {
      pageBaseline.push({ pageId, hash: null });
    }
  }

  // 获取 kbId
  const manifestRes = await readWikiManifest(kbPath);
  const kbId = manifestRes.ok ? manifestRes.manifest.kbId : 'unknown';

  // 通过 stageProposal 持久化
  const staged = await stageProposal(kbPath, {
    kbId,
    taskId: `fix-${finding.findingId}`,
    origin: 'fix',
    sourceRefs: input.sourceRefs,
    proposalText,
    readBaseline: pageBaseline.map((p) => ({ pageId: p.pageId, hash: p.hash })),
    findings: [finding],
    now,
  });

  if (!staged.ok) {
    return { ok: false, code: 'stagingFailed', message: `Staging 失败: ${staged.error.message}` };
  }

  const changeSetId = staged.value.changeSet.changeSetId;

  // 回写 finding.fixChangeSetId
  await updateFindingFixFields(kbPath, finding.findingId, {
    fixChangeSetId: changeSetId,
  }, now);

  return {
    ok: true,
    changeSetId,
    findingId: finding.findingId,
    evidenceHashes: finding.evidenceHashes,
    pageBaseline,
    createdAt: now,
  };
}

/**
 * 清除 finding 的 fixChangeSetId（拒绝修复后调用）。
 *
 * 拒绝或修复失败保留待处理状态：finding 保持 open，fixChangeSetId 清除后可重新请求修复。
 */
export async function clearFixChangeSetId(kbPath: string, findingId: string): Promise<void> {
  await updateFindingFixFields(kbPath, findingId, { fixChangeSetId: null });
}

function extractBody(content: string): string {
  const match = /^---\n[\s\S]*?\n---\n/.exec(content);
  if (!match) return content;
  return content.slice(match[0].length);
}

function buildFixPrompt(
  finding: WikiStructuralFinding,
  pages: Array<{ pageId: string; title: string; body: string }>,
): string {
  const pagesText = pages
    .map((p) => `--- 页面: ${p.pageId} ---\n标题: ${p.title}\n正文:\n${p.body}`)
    .join('\n\n');

  const evidenceText = finding.evidenceQuotes
    ?.map((q) => `- ${q.pageId}: "${q.quote}" (${q.location ?? '未知位置'})`)
    .join('\n') ?? '无短引';

  return [
    '发现以下知识问题，请生成修复提案。',
    '',
    `问题类型: ${finding.kind}`,
    `描述: ${finding.description ?? '无描述'}`,
    `证据:`,
    evidenceText,
    '',
    '请生成 FILE 提案修复上述问题。只修改需要修正的页面，不要修改无关页面。',
    '输出格式为 FILE 块（---FILE: wiki/<path>.md--- ... ---END FILE---）。',
    '',
    '--- 涉及页面 ---',
    '',
    pagesText,
  ].join('\n');
}
