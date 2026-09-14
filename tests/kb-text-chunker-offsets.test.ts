/**
 * text-chunker 偏移与覆盖报告测试（issue 22，spec §8/§10）。
 *
 * 验收映射 A15：
 *  - 分块带标题面包屑与**原文偏移**（start/end 字符偏移，相对于去 frontmatter 后的 body）
 *  - 超大原子块保留全文并报告向量未覆盖（不静默截短成功）
 *  - 覆盖报告：totalChunks / coveredChunks / skippedChunks + skipReasons
 *  - 偏移可正确用于回溯原文片段
 */
import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from '../src/main/kb/text-chunker';

describe('chunkMarkdown — 原文偏移', () => {
  it('每个 chunk 有 start/end 偏移，且偏移对应 body 中的原文', () => {
    const input = '# Title\n\nSome content here.';
    const chunks = chunkMarkdown(input, 1000, 200);
    expect(chunks.length).toBe(1);
    const chunk = chunks[0];
    expect(chunk.start).toBeDefined();
    expect(chunk.end).toBeDefined();
    // 偏移是相对于去 frontmatter 后的 body
    // body = '# Title\n\nSome content here.' (与 input 相同，无 frontmatter)
    expect(chunk.start).toBeGreaterThanOrEqual(0);
    expect(chunk.end).toBeLessThanOrEqual(input.length);
    // 用偏移截取 body 应包含 chunk text 的核心内容
    const body = input; // no frontmatter
    const slice = body.slice(chunk.start, chunk.end);
    expect(slice).toContain('Some content');
  });

  it('多个 chunk 的偏移不重叠（非 overlap 分块时）', () => {
    const input = '# A\n\nText A\n\n# B\n\nText B';
    const chunks = chunkMarkdown(input, 1000, 0); // overlap=0
    expect(chunks.length).toBe(2);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].start).toBeGreaterThanOrEqual(chunks[i - 1].end);
    }
  });

  it('frontmatter 存在时偏移相对于 body（去 frontmatter 后）', () => {
    const input = '---\ntitle: Test\n---\n# Title\n\nContent here.';
    const chunks = chunkMarkdown(input, 1000, 200);
    expect(chunks.length).toBe(1);
    const chunk = chunks[0];
    // body = '# Title\n\nContent here.'
    const body = '# Title\n\nContent here.';
    expect(body.slice(chunk.start, chunk.end)).toContain('Content here.');
  });

  it('CRLF 内容偏移正确', () => {
    const input = '# Title\r\n\r\nContent one.\r\n\r\n## Sub\r\n\r\nContent two.\r\n';
    const chunks = chunkMarkdown(input, 1000, 200);
    expect(chunks.length).toBe(2);
    // body is CRLF-normalized to LF
    const body = '# Title\n\nContent one.\n\n## Sub\n\nContent two.\n';
    for (const chunk of chunks) {
      expect(chunk.start).toBeGreaterThanOrEqual(0);
      expect(chunk.end).toBeLessThanOrEqual(body.length);
    }
  });
});

describe('chunkMarkdown — 超大原子块覆盖报告', () => {
  it('超大原子块保留全文不截短，标记 oversize=true', () => {
    const longCode = 'x'.repeat(500);
    const input = `# Page\n\n\`\`\`text\n${longCode}\n\`\`\`\n`;
    const chunks = chunkMarkdown(input, 100, 20);
    // 超大块不被截短 — 保留全文
    const oversizeChunks = chunks.filter((c) => c.oversize === true);
    expect(oversizeChunks.length).toBeGreaterThan(0);
    // oversize chunk 包含完整原文
    for (const c of oversizeChunks) {
      expect(c.text).toContain(longCode);
    }
  });

  it('覆盖报告：totalChunks / coveredChunks / skippedChunks', () => {
    const longCode = 'x'.repeat(500);
    const input = `# Page\n\nShort text.\n\n\`\`\`text\n${longCode}\n\`\`\`\n`;
    const result = chunkMarkdown(input, 100, 20, { reportCoverage: true });
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.coverage).toBeDefined();
    expect(result.coverage!.totalChunks).toBe(result.chunks.length);
    expect(result.coverage!.coveredChunks).toBeLessThan(result.coverage!.totalChunks);
    expect(result.coverage!.skippedChunks).toBeGreaterThan(0);
    expect(result.coverage!.skipReasons).toBeDefined();
    expect(result.coverage!.skipReasons!.length).toBeGreaterThan(0);
  });

  it('正常分块（无超大块）覆盖报告全覆盖', () => {
    const input = '# Title\n\nSome content.\n\n## Sub\n\nMore content.';
    const result = chunkMarkdown(input, 1000, 200, { reportCoverage: true });
    expect(result.coverage!.totalChunks).toBe(result.chunks.length);
    expect(result.coverage!.coveredChunks).toBe(result.coverage!.totalChunks);
    expect(result.coverage!.skippedChunks).toBe(0);
  });

  it('不带 reportCoverage 选项时返回兼容格式（chunks 数组）', () => {
    const input = '# Title\n\nContent.';
    const chunks = chunkMarkdown(input, 1000, 200);
    // 不带选项时仍返回 EmbeddingChunk[]（向后兼容）
    expect(Array.isArray(chunks)).toBe(true);
    expect(chunks.length).toBe(1);
  });

  it('超大表格保留全文不截短', () => {
    const rows = Array.from({ length: 50 }, (_, i) => `| Row ${i} | ${'x'.repeat(20)} |`).join('\n');
    const input = `# Page\n\n${rows}\n`;
    const chunks = chunkMarkdown(input, 100, 20);
    // 表格作为原子块保留全文
    const tableChunk = chunks.find((c) => c.text.includes('Row 0'));
    expect(tableChunk).toBeDefined();
    expect(tableChunk!.text).toContain('Row 49');
  });
});
