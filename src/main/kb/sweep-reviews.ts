/**
 * Sweep Reviews — 发布后复检（spec §9，issue 27）。
 *
 * 发布后复检绑定新 revision，确已解决才 resolved，仍存在保留并显示证据：
 *  1. 读取 finding → 验证有已发布的修复（fixRevision 非空）
 *  2. 加载涉及页面当前正文 → 构建复检提示词 → LLM 判断问题是否仍存在
 *  3. 问题已解决 → finding.status = resolved
 *  4. 问题仍存在 → finding.status 保持 open，记录证据
 *
 * 期间证据变化或另一个提案解决问题时可正确收敛：
 *  - 复检基于当前正文（不是修复时的旧文本）
 *  - 如果另一个提案已经解决了问题，复检同样会判定 resolved
 *  - 不重复发布过时修复
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §9
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFindings, updateFindingStatus, updateFindingFixFields } from './finding-store';
import { scanWikiCatalog } from './wiki-catalog';
import { readChangeSet, readReview } from './staging';
import { parseSemanticLintOutput } from './semantic-lint';
import type { WikiSweepReviewResult, WikiStructuralFinding } from '@shared/kb-types';

// ── 模型调用边界 ────────────────────────────────────────────────

export type SweepLlmCallResultLike =
  | string
  | {
      text: string;
      finishReason?: string | null;
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
    };

/** 复检用模型入口。null = 无凭证。 */
export type SweepLlm = {
  invoke: (req: { system: string; user: string; maxTokens: number }) => Promise<SweepLlmCallResultLike>;
};

// ── 输入 ────────────────────────────────────────────────────────

export type SweepReviewInput = {
  /** 要复检的 finding ID */
  findingId: string;
  /** 模型入口；null = 无凭证 */
  llm: SweepLlm | null;
  /** 注入时钟（测试用） */
  now?: string;
};

// ── 实现 ────────────────────────────────────────────────────────

/**
 * 发布后复检。
 *
 * 1. 读取 finding → 验证有已发布的修复（fixRevision 非空或 fixChangeSetId 已发布）
 * 2. 加载涉及页面当前正文 → 构建复检提示词 → LLM 判断问题是否仍存在
 * 3. 问题已解决 → resolved
 * 4. 问题仍存在 → 保持 open，记录证据
 */
export async function sweepReview(
  kbPath: string,
  input: SweepReviewInput,
): Promise<WikiSweepReviewResult> {
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

  // 验证有已发布的修复
  // 检查 fixChangeSetId 是否存在且已发布
  if (!finding.fixChangeSetId) {
    return { ok: false, code: 'noPublishedFix', message: 'Finding 没有关联的修复提案' };
  }

  // 检查变更集是否已发布
  const csResult = await readChangeSet(kbPath, finding.fixChangeSetId);
  if (!csResult.ok) {
    return { ok: false, code: 'noPublishedFix', message: `修复变更集不可读: ${csResult.error.message}` };
  }

  const reviewResult = await readReview(kbPath, finding.fixChangeSetId);
  if (!reviewResult.ok || !reviewResult.value.published) {
    return { ok: false, code: 'noPublishedFix', message: '修复提案尚未发布' };
  }

  const revision = reviewResult.value.published.revision;

  // 无 LLM 配置
  if (input.llm === null) {
    return { ok: false, code: 'noLlmConfig', message: '复检需要 LLM 配置（无凭证）' };
  }

  // 加载涉及页面当前正文
  const catalog = await scanWikiCatalog(kbPath);
  if (!catalog.ok) {
    return { ok: false, code: 'noPublishedFix', message: 'wiki/ 目录无法解析' };
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
    return { ok: false, code: 'noPublishedFix', message: '无法加载涉及页面的正文' };
  }

  // 构建复检提示词
  const prompt = buildSweepPrompt(finding, pages);

  // 调用 LLM 判断问题是否仍存在
  let llmText: string;
  try {
    const result = await input.llm.invoke({
      system: '你是严谨的知识库审阅员。检查指定问题是否仍然存在。',
      user: prompt,
      maxTokens: 4096,
    });
    llmText = typeof result === 'string' ? result : result.text;
  } catch (err) {
    return { ok: false, code: 'llmFailed', message: `LLM 调用失败: ${String(err)}` };
  }

  // 解析 LLM 输出
  const findings = parseSemanticLintOutput(llmText, 'sweep', finding.pageIds);

  // 如果 LLM 报告了相同类型的问题 → 仍存在
  const stillExists = findings.some(
    (f) => f.kind === finding.kind
      && f.pageIds.every((p) => finding.pageIds.includes(p)),
  );

  if (!stillExists) {
    // 问题已解决
    await updateFindingStatus(kbPath, finding.findingId, 'resolve', now);
    // 清除 fixChangeSetId 和 fixRevision
    await updateFindingFixFields(kbPath, finding.findingId, {
      fixChangeSetId: null,
      fixRevision: null,
    }, now);

    return {
      ok: true,
      findingId: finding.findingId,
      revision,
      resolved: true,
      evidence: null,
      checkedAt: now,
    };
  }

  // 问题仍存在
  const evidenceFinding = findings.find(
    (f) => f.kind === finding.kind
      && f.pageIds.every((p) => finding.pageIds.includes(p)),
  );
  const evidence = evidenceFinding?.description ?? '问题仍然存在';

  return {
    ok: true,
    findingId: finding.findingId,
    revision,
    resolved: false,
    evidence,
    checkedAt: now,
  };
}

function extractBody(content: string): string {
  const match = /^---\n[\s\S]*?\n---\n/.exec(content);
  if (!match) return content;
  return content.slice(match[0].length);
}

function buildSweepPrompt(
  finding: WikiStructuralFinding,
  pages: Array<{ pageId: string; title: string; body: string }>,
): string {
  const pagesText = pages
    .map((p) => `--- 页面: ${p.pageId} ---\n标题: ${p.title}\n正文:\n${p.body}`)
    .join('\n\n');

  return [
    '此前发现以下知识问题并已尝试修复。请检查当前页面正文，判断该问题是否仍然存在。',
    '',
    `问题类型: ${finding.kind}`,
    `原描述: ${finding.description ?? '无描述'}`,
    '',
    '输出 JSON 格式（不要 Markdown 围栏）：',
    '{',
    '  "findings": [',
    '    {',
    '      "kind": "contradiction | missing-knowledge | unsupported-claim",',
    '      "pageIds": ["pageId1", "pageId2"],',
    '      "description": "问题描述",',
    '      "evidenceQuotes": [],',
    '      "suggestion": false',
    '    }',
    '  ]',
    '}',
    '',
    '如果问题已解决，返回 { "findings": [] }。',
    '',
    '--- 当前页面正文 ---',
    '',
    pagesText,
  ].join('\n');
}
