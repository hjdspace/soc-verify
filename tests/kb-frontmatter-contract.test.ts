import { describe, expect, it } from 'vitest';
import { buildGenerationPrompt, buildRepairPrompt } from '../src/main/kb/compile-prompts';
import { parseWikiPage } from '../src/main/kb/wiki-page';

const sourceRef = { sourceId: 'a'.repeat(64), sourceRevision: 'b'.repeat(64), parsedHash: 'c'.repeat(64) };
const input = {
  purpose: '', schema: '', index: '', analysis: 'UVM Harness 接口复用。',
  sourceName: '03_UVM-Harness.pdf',
  sourceRefYaml: ['sources:', ...Object.entries(sourceRef).map(([key, value], i) => `  ${i === 0 ? '- ' : '  '}${key}: "${value}"`)].join('\n'),
  today: '2026-09-15T00:00:00Z',
  pageTypes: ['source'] as const,
};

describe('编译提示词的 frontmatter 示例契约', () => {
  it.each(['generation', 'repair'] as const)('%s 的完整示例通过生产校验并保留应用指定证据', (phase) => {
    const path = `wiki/sources/${sourceRef.sourceId}.md`;
    const prompt = phase === 'generation'
      ? buildGenerationPrompt({ ...input, sourceSummaryRelPath: path })
      : buildRepairPrompt({ ...input, requestedPaths: [path] });
    const examples = [...prompt.matchAll(/```yaml\n([\s\S]*?)\n```/g)];
    const valid = examples.map((match) => parseWikiPage(match[1])).find((page) => page.ok);
    expect(valid, '应提供包含全部必填字段、可通过实际校验的 YAML 示例').toBeDefined();
    if (!valid?.ok) return;
    expect(valid.frontmatter.sources).toEqual([sourceRef]);
    expect(valid.frontmatter.created).toBe(input.today);
    expect(valid.frontmatter.updated).toBe(input.today);
  });
});
