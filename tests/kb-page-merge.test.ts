/**
 * kb-page-merge.test.ts — 来源感知合并行为测试（issue 16，验收 A08/A09）。
 *
 * 测试缝（seam）：`src/main/kb/page-merge.ts` 的纯函数接口。
 * 不测内部实现细节，只测公开行为：
 *  - 单来源修订 → replaceExistingBody 语义（撤回旧论断）
 *  - 多来源新增 → union 合并来源引用 + LLM 正文合并
 *  - 锁定字段（type/title/created）不被覆盖
 *  - 异常收缩 → 保留旧页、阻止发布
 *  - 来源引用确定性去重
 */
import { describe, it, expect } from 'vitest';
import {
  mergePageContent,
  isOwnedOnlyBySource,
  unionSourceRefs,
  type MergePageContentInput,
} from '../src/main/kb/page-merge';
import type { WikiSourceRef } from '@shared/kb-types';

// ── helpers ──────────────────────────────────────────────────────

const SRC_A: WikiSourceRef = { sourceId: 'aaa', sourceRevision: 'rev-a-1', parsedHash: 'hash-a-1' };
const SRC_A2: WikiSourceRef = { sourceId: 'aaa', sourceRevision: 'rev-a-2', parsedHash: 'hash-a-2' };
const SRC_B: WikiSourceRef = { sourceId: 'bbb', sourceRevision: 'rev-b-1', parsedHash: 'hash-b-1' };

function makePage(
  type: string,
  title: string,
  sources: WikiSourceRef[],
  body: string,
  created = '2026-09-14T00:00:00Z',
  updated = '2026-09-14T00:00:00Z',
): string {
  const srcYaml = sources.length === 0
    ? 'sources: []'
    : [
      'sources:',
      ...sources.map((s) => [
        `  - sourceId: "${s.sourceId}"`,
        `    sourceRevision: "${s.sourceRevision}"`,
        `    parsedHash: "${s.parsedHash}"`,
      ].join('\n')),
    ].join('\n');
  return [
    '---',
    `type: ${type}`,
    `title: "${title}"`,
    `summary: ${title}的摘要`,
    'keywords: [AXI]',
    'tags: [协议]',
    srcYaml,
    `created: "${created}"`,
    `updated: "${updated}"`,
    '---',
    '',
    body,
  ].join('\n');
}

/** 可控假合并器：直接返回 `mergedContent` 作为 LLM 合并结果 */
function fakeMerger(mergedContent: string): MergePageContentInput['merger'] {
  return async () => mergedContent;
}

/** 拒绝合并器：抛异常模拟 LLM 合并失败 */
function failingMerger(): MergePageContentInput['merger'] {
  return async () => { throw new Error('LLM merge failed'); };
}

// ── isOwnedOnlyBySource ──────────────────────────────────────────

describe('isOwnedOnlyBySource', () => {
  it('单来源页且 sourceId 匹配 → true', () => {
    const page = makePage('concept', 'AXI', [SRC_A], '正文');
    expect(isOwnedOnlyBySource(page, SRC_A.sourceId)).toBe(true);
  });

  it('单来源页但 sourceId 不匹配 → false', () => {
    const page = makePage('concept', 'AXI', [SRC_A], '正文');
    expect(isOwnedOnlyBySource(page, SRC_B.sourceId)).toBe(false);
  });

  it('多来源页 → false（非单来源拥有）', () => {
    const page = makePage('concept', 'AXI', [SRC_A, SRC_B], '正文');
    expect(isOwnedOnlyBySource(page, SRC_A.sourceId)).toBe(false);
  });

  it('无来源页 → false', () => {
    const page = makePage('concept', 'AXI', [], '正文');
    expect(isOwnedOnlyBySource(page, SRC_A.sourceId)).toBe(false);
  });
});

// ── unionSourceRefs ──────────────────────────────────────────────

describe('unionSourceRefs', () => {
  it('两个来源引用去重合并', () => {
    const result = unionSourceRefs([SRC_A], [SRC_B]);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual(SRC_A);
    expect(result).toContainEqual(SRC_B);
  });

  it('相同来源引用不重复', () => {
    const result = unionSourceRefs([SRC_A], [SRC_A]);
    expect(result).toHaveLength(1);
  });

  it('同 sourceId 不同修订视为不同引用（都保留）', () => {
    const result = unionSourceRefs([SRC_A], [SRC_A2]);
    expect(result).toHaveLength(2);
  });

  it('空数组合并', () => {
    expect(unionSourceRefs([], [SRC_A])).toEqual([SRC_A]);
    expect(unionSourceRefs([SRC_A], [])).toEqual([SRC_A]);
    expect(unionSourceRefs([], [])).toEqual([]);
  });
});

// ── mergePageContent — 单来源修订 ───────────────────────────────

describe('mergePageContent — 单来源修订（replaceExistingBody）', () => {
  it('单来源页 + 同来源新修订 → 替换正文，撤回旧论断不残留', async () => {
    const existing = makePage('concept', 'AXI outstanding', [SRC_A],
      '## 定义\n\n最大 16 个 outstanding。\n\n## 限制\n\n不超过 16。');
    const incoming = makePage('concept', 'AXI outstanding', [SRC_A2],
      '## 定义\n\n最大 8 个 outstanding（修订后纠正）。\n\n## 限制\n\n不超过 8。');

    const result = await mergePageContent({
      incomingContent: incoming,
      existingContent: existing,
      incomingSourceRef: SRC_A2,
      merger: fakeMerger(incoming),
      now: '2026-09-14T01:00:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 正文是新版（旧论断「16」被撤回）
    expect(result.content).toContain('最大 8 个');
    expect(result.content).not.toContain('最大 16 个');
    // 来源引用只有新修订
    expect(result.content).toContain(SRC_A2.sourceRevision);
    expect(result.content).not.toContain(SRC_A.sourceRevision);
    // 锁定字段保留
    expect(result.content).toContain('title: "AXI outstanding"');
    expect(result.content).toContain('type: concept');
    expect(result.content).toContain('created: "2026-09-14T00:00:00Z"');
    // updated 被更新
    expect(result.content).toContain('updated: "2026-09-14T01:00:00Z"');
  });

  it('单来源修订 → 正文不残留旧论断（端到端 fixture：撤回约束不再作为当前结论）', async () => {
    const existing = makePage('pitfall', 'DDR 初始化踩坑', [SRC_A],
      '## 现象\n\n初始化失败。\n\n## 根因\n\ntRCD 必须设为 4。\n\n## 规避\n\n设置 tRCD=4。');
    const incoming = makePage('pitfall', 'DDR 初始化踩坑', [SRC_A2],
      '## 现象\n\n初始化失败。\n\n## 根因\n\ntRCD 实际应为 2（新版纠正）。\n\n## 规避\n\n设置 tRCD=2。');

    const result = await mergePageContent({
      incomingContent: incoming,
      existingContent: existing,
      incomingSourceRef: SRC_A2,
      merger: fakeMerger(incoming),
      now: '2026-09-14T01:00:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 旧论断 tRCD=4 不应作为当前结论
    expect(result.content).toContain('tRCD 实际应为 2');
    expect(result.content).not.toContain('tRCD 必须设为 4');
  });
});

// ── mergePageContent — 多来源合并 ───────────────────────────────

describe('mergePageContent — 多来源合并', () => {
  it('新来源贡献到既有页 → 正文合并、来源引用 union', async () => {
    const existing = makePage('concept', 'AXI outstanding', [SRC_A],
      '## 定义\n\nAXI 协议允许的 outstanding 上限。\n\n## 协议允许\n\n最多 16。');
    const incoming = makePage('concept', 'AXI outstanding', [SRC_B],
      '## DUT 实现\n\n本 DUT 限制为 8 个 outstanding。');

    const mergedBody = makePage('concept', 'AXI outstanding', [SRC_A, SRC_B],
      '## 定义\n\nAXI 协议允许的 outstanding 上限。\n\n## 协议允许\n\n最多 16。\n\n## DUT 实现\n\n本 DUT 限制为 8 个 outstanding。');

    const result = await mergePageContent({
      incomingContent: incoming,
      existingContent: existing,
      incomingSourceRef: SRC_B,
      merger: fakeMerger(mergedBody),
      now: '2026-09-14T01:00:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 两份来源贡献都在
    expect(result.content).toContain('最多 16');
    expect(result.content).toContain('限制为 8');
    // 来源引用 union
    expect(result.content).toContain(SRC_A.sourceId);
    expect(result.content).toContain(SRC_B.sourceId);
  });

  it('多来源冲突 → 协议与 DUT 差异保留适用范围', async () => {
    const existing = makePage('comparison', 'AXI outstanding 对比', [SRC_A],
      '## 协议手册\n\n允许 16 outstanding。\n\n## 适用范围\n\n协议上限。');
    const incoming = makePage('comparison', 'AXI outstanding 对比', [SRC_B],
      '## DUT spec\n\n限制 8 outstanding。\n\n## 适用范围\n\nDUT 实现上限。');

    const mergedBody = makePage('comparison', 'AXI outstanding 对比', [SRC_A, SRC_B],
      '## 协议手册（来源 A）\n\n允许 16 outstanding。\n\n## DUT spec（来源 B）\n\n限制 8 outstanding。\n\n## 适用范围\n\n协议上限 vs DUT 实现上限。');

    const result = await mergePageContent({
      incomingContent: incoming,
      existingContent: existing,
      incomingSourceRef: SRC_B,
      merger: fakeMerger(mergedBody),
      now: '2026-09-14T01:00:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 冲突保留（不自动以新来源覆盖旧来源）
    expect(result.content).toContain('16 outstanding');
    expect(result.content).toContain('8 outstanding');
    // 两个来源都引用
    expect(result.content).toContain(SRC_A.sourceId);
    expect(result.content).toContain(SRC_B.sourceId);
  });
});

// ── mergePageContent — 锁定字段 ─────────────────────────────────

describe('mergePageContent — 锁定字段', () => {
  it('LLM 合并结果中 type/title/created 被强制回写为旧值', async () => {
    const existing = makePage('concept', 'AXI 握手', [SRC_A], '## 定义\n\n握手。', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    const incoming = makePage('concept', 'AXI 握手', [SRC_B], '## DUT\n\n实现细节。');

    // LLM 试图改 type 和 title（不该被接受）
    const llmOutput = makePage('entity', 'AXI Handshake Protocol', [SRC_A, SRC_B],
      '## 定义\n\n握手。\n\n## DUT\n\n实现细节。', '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z');

    const result = await mergePageContent({
      incomingContent: incoming,
      existingContent: existing,
      incomingSourceRef: SRC_B,
      merger: fakeMerger(llmOutput),
      now: '2026-09-14T01:00:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // type/title/created 被锁定回旧值
    expect(result.content).toContain('type: concept');
    expect(result.content).toContain('title: "AXI 握手"');
    expect(result.content).toContain('created: "2026-01-01T00:00:00Z"');
    // updated 被设为 now
    expect(result.content).toContain('updated: "2026-09-14T01:00:00Z"');
    // 不含 LLM 试图改的值（检查 title 行，不检查 summary 以免误匹配）
    expect(result.content).not.toContain('type: entity');
    expect(result.content).not.toContain('title: "AXI Handshake Protocol"');
  });
});

// ── mergePageContent — 异常收缩 ─────────────────────────────────

describe('mergePageContent — 异常收缩检测', () => {
  it('LLM 合并正文显著短于阈值 → 保留旧页、阻止发布', async () => {
    const existingBody = '## 定义\n\nAXI 协议允许的 outstanding 上限。'.repeat(20);
    const existing = makePage('concept', 'AXI', [SRC_A], existingBody);
    const incoming = makePage('concept', 'AXI', [SRC_B], '## DUT\n\n限制 8。');

    // LLM 输出极短（远低于 70% 阈值）
    const tinyMerge = makePage('concept', 'AXI', [SRC_A, SRC_B], '简短。');

    const result = await mergePageContent({
      incomingContent: incoming,
      existingContent: existing,
      incomingSourceRef: SRC_B,
      merger: fakeMerger(tinyMerge),
      now: '2026-09-14T01:00:00Z',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('bodyShrank');
    expect(result.message).toContain('收缩');
    // 旧内容保留在 fallback
    expect(result.fallback).toContain('outstanding');
  });

  it('LLM 合并失败 → 保留旧页、阻止发布', async () => {
    const existing = makePage('concept', 'AXI', [SRC_A], '## 定义\n\n握手。');
    const incoming = makePage('concept', 'AXI', [SRC_B], '## DUT\n\n实现。');

    const result = await mergePageContent({
      incomingContent: incoming,
      existingContent: existing,
      incomingSourceRef: SRC_B,
      merger: failingMerger(),
      now: '2026-09-14T01:00:00Z',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('llmFailed');
    // fallback 保留旧页
    expect(result.fallback).toBe(existing);
  });
});

// ── mergePageContent — 无现有页 ─────────────────────────────────

describe('mergePageContent — 新页（无现有内容）', () => {
  it('existingContent=null → 直接返回 incoming（frontmatter 已绑定来源）', async () => {
    const incoming = makePage('concept', '新概念', [SRC_A], '## 定义\n\n内容。');

    const result = await mergePageContent({
      incomingContent: incoming,
      existingContent: null,
      incomingSourceRef: SRC_A,
      merger: failingMerger(), // 不应被调用
      now: '2026-09-14T01:00:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe(incoming);
  });
});

// ── mergePageContent — 来源引用确定性去重 ───────────────────────

describe('mergePageContent — 来源引用去重', () => {
  it('LLM 输出含重复来源 → 确定性去重后保留唯一', async () => {
    const existing = makePage('concept', 'AXI', [SRC_A], '## 定义\n\n握手。');
    const incoming = makePage('concept', 'AXI', [SRC_B], '## DUT\n\n实现。');

    // LLM 输出中有重复来源
    const llmOutput = makePage('concept', 'AXI', [SRC_A, SRC_B, SRC_A, SRC_B],
      '## 定义\n\n握手。\n\n## DUT\n\n实现。');

    const result = await mergePageContent({
      incomingContent: incoming,
      existingContent: existing,
      incomingSourceRef: SRC_B,
      merger: fakeMerger(llmOutput),
      now: '2026-09-14T01:00:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 来源引用去重
    const sourceIdCount = (result.content.match(new RegExp(SRC_A.sourceId, 'g')) ?? []).length;
    // sourceId 只在 sources 中出现一次（不重复）
    expect(sourceIdCount).toBe(1);
    const sourceBCount = (result.content.match(new RegExp(SRC_B.sourceId, 'g')) ?? []).length;
    expect(sourceBCount).toBe(1);
  });
});
