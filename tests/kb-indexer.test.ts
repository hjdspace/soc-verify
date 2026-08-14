/**
 * Knowledge Base Indexer 测试。
 *
 * 覆盖场景：
 *  - 骨架截取（extractSkeleton）
 *  - Prompt 组装（buildClassificationPrompt）
 *  - LLM 响应解析（parseClassificationResponse）
 *  - LLM 调用（classifyWithLlm）mock fetch
 *  - 降级占位条目（makePlaceholderEntry）
 *  - index.md 增量合并（mergeEntry / removeEntry / parseIndexMd）
 *  - 完整索引流程（indexDocument）mock LLM + 临时文件
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';

import {
  extractSkeleton,
  buildClassificationPrompt,
  parseClassificationResponse,
  classifyWithLlm,
  makePlaceholderEntry,
  mergeEntry,
  removeEntry,
  parseIndexMd,
  listCategoriesFromIndex,
  indexDocument,
  removeFromIndex,
  type LlmConfig,
} from '../src/main/kb/indexer';

// ── extractSkeleton ──────────────────────────────────────────────

describe('extractSkeleton', () => {
  it('保留标题行和正文行，截断到最大行数', () => {
    const md = '# 标题1\n正文1\n## 子标题\n正文2\n'.repeat(20);
    const skeleton = extractSkeleton(md);
    const lines = skeleton.split('\n');
    expect(lines.length).toBeLessThanOrEqual(60);
    expect(lines[0]).toBe('# 标题1');
  });

  it('跳过空行', () => {
    const md = '# 标题\n\n\n正文\n';
    const skeleton = extractSkeleton(md);
    expect(skeleton).not.toContain('\n\n');
    expect(skeleton).toContain('# 标题');
    expect(skeleton).toContain('正文');
  });

  it('短文档全部保留', () => {
    const md = '# 标题\n正文行';
    const skeleton = extractSkeleton(md);
    expect(skeleton).toBe('# 标题\n正文行');
  });
});

// ── buildClassificationPrompt ────────────────────────────────────

describe('buildClassificationPrompt', () => {
  it('包含骨架内容和分类体系', () => {
    const prompt = buildClassificationPrompt('文档骨架', ['协议手册', '验证计划']);
    expect(prompt).toContain('文档骨架');
    expect(prompt).toContain('协议手册');
    expect(prompt).toContain('验证计划');
    expect(prompt).toContain('JSON');
  });

  it('冷启动时提示无分类体系', () => {
    const prompt = buildClassificationPrompt('骨架', []);
    expect(prompt).toContain('冷启动');
  });
});

// ── parseClassificationResponse ─────────────────────────────────

describe('parseClassificationResponse', () => {
  it('解析标准 JSON 响应', () => {
    const raw = '{"category": "协议手册", "title": "DDR5", "summary": "DDR5协议文档", "keywords": ["DDR5", "协议"]}';
    const result = parseClassificationResponse(raw);
    expect(result.category).toBe('协议手册');
    expect(result.title).toBe('DDR5');
    expect(result.summary).toBe('DDR5协议文档');
    expect(result.keywords).toEqual(['DDR5', '协议']);
  });

  it('去除 markdown 代码块标记', () => {
    const raw = '```json\n{"category": "测试", "title": "文档", "summary": "", "keywords": []}\n```';
    const result = parseClassificationResponse(raw);
    expect(result.category).toBe('测试');
    expect(result.title).toBe('文档');
  });

  it('缺失字段时使用默认值', () => {
    const raw = '{"category": "", "title": ""}';
    const result = parseClassificationResponse(raw);
    expect(result.category).toBe('未分类');
    expect(result.title).toBe('未命名文档');
    expect(result.summary).toBe('');
    expect(result.keywords).toEqual([]);
  });

  it('keywords 非数组时返回空数组', () => {
    const raw = '{"category": "A", "title": "T", "keywords": "notarray"}';
    const result = parseClassificationResponse(raw);
    expect(result.keywords).toEqual([]);
  });
});

// ── classifyWithLlm ──────────────────────────────────────────────

describe('classifyWithLlm', () => {
  const config: LlmConfig = {
    baseUrl: 'http://localhost:8557',
    apiKey: 'sk-test',
    model: 'test-model',
  };

  it('成功调用 LLM 并返回分类结果', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: '{"category": "协议手册", "title": "DDR5", "summary": "DDR5协议", "keywords": ["DDR5"]}',
          },
        }],
      }),
    } as unknown as Response;

    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    const result = await classifyWithLlm('骨架', [], { ...config, fetchFn: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.category).toBe('协议手册');
      expect(result.result.title).toBe('DDR5');
    }

    // 验证请求 URL 和 headers
    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[0]).toBe('http://localhost:8557/chat/completions');
    const init = callArgs[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('LLM 返回非 200 时返回错误', async () => {
    const mockResponse = {
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as unknown as Response;

    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    const result = await classifyWithLlm('骨架', [], { ...config, fetchFn: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('401');
    }
  });

  it('LLM 返回格式异常时返回错误', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: {} }] }),
    } as unknown as Response;

    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    const result = await classifyWithLlm('骨架', [], { ...config, fetchFn: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(false);
  });

  it('网络异常时返回错误', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network error'));
    const result = await classifyWithLlm('骨架', [], { ...config, fetchFn: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('network error');
    }
  });
});

// ── makePlaceholderEntry ─────────────────────────────────────────

describe('makePlaceholderEntry', () => {
  it('生成占位条目：标题为文档名，分类为未分类', () => {
    const entry = makePlaceholderEntry('DDR5', '未分类/DDR5.md');
    expect(entry.title).toBe('DDR5');
    expect(entry.path).toBe('未分类/DDR5.md');
    expect(entry.category).toBe('未分类');
    expect(entry.summary).toBe('');
    expect(entry.keywords).toEqual([]);
  });
});

// ── parseIndexMd ─────────────────────────────────────────────────

describe('parseIndexMd', () => {
  it('解析多分类多条目', () => {
    const content = [
      '# 知识库索引',
      '',
      '## 协议手册',
      '',
      '### DDR5',
      '- **路径**: `协议手册/DDR5.md`',
      '- **摘要**: DDR5协议文档',
      '- **关键词**: `DDR5` · `协议`',
      '',
      '## 验证计划',
      '',
      '### 验证策略',
      '- **路径**: `验证计划/策略.md`',
      '- **摘要**: 验证策略概述',
      '',
    ].join('\n');

    const { entries, categoryOrder } = parseIndexMd(content);
    expect(categoryOrder).toEqual(['协议手册', '验证计划']);
    expect(entries).toHaveLength(2);
    expect(entries[0].title).toBe('DDR5');
    expect(entries[0].path).toBe('协议手册/DDR5.md');
    expect(entries[0].category).toBe('协议手册');
    expect(entries[0].summary).toBe('DDR5协议文档');
    expect(entries[0].keywords).toEqual(['DDR5', '协议']);
    expect(entries[1].title).toBe('验证策略');
    expect(entries[1].keywords).toEqual([]);
  });

  it('空 index.md 返回空列表', () => {
    const { entries, categoryOrder } = parseIndexMd('');
    expect(entries).toEqual([]);
    expect(categoryOrder).toEqual([]);
  });
});

// ── mergeEntry ───────────────────────────────────────────────────

describe('mergeEntry', () => {
  it('插入新条目到对应分类节', () => {
    const content = '# 知识库索引\n\n## 协议手册\n\n### DDR5\n- **路径**: `协议手册/DDR5.md`\n- **摘要**: DDR5\n';
    const newEntry = {
      title: '验证策略',
      path: '验证计划/策略.md',
      category: '验证计划',
      summary: '策略',
      keywords: ['策略'],
    };

    const result = mergeEntry(content, newEntry);
    const { entries, categoryOrder } = parseIndexMd(result);
    expect(categoryOrder).toEqual(['协议手册', '验证计划']);
    expect(entries).toHaveLength(2);
    expect(entries[1].title).toBe('验证策略');
  });

  it('更新同路径条目', () => {
    const content = [
      '## 协议手册',
      '',
      '### DDR5',
      '- **路径**: `协议手册/DDR5.md`',
      '- **摘要**: 旧摘要',
      '',
    ].join('\n');

    const updated = {
      title: 'DDR5 协议',
      path: '协议手册/DDR5.md',
      category: '协议手册',
      summary: '新摘要',
      keywords: ['DDR5', '协议'],
    };

    const result = mergeEntry(content, updated);
    const { entries } = parseIndexMd(result);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('DDR5 协议');
    expect(entries[0].summary).toBe('新摘要');
    expect(entries[0].keywords).toEqual(['DDR5', '协议']);
  });

  it('空 index.md 插入第一个条目', () => {
    const entry = {
      title: 'DDR5',
      path: '协议手册/DDR5.md',
      category: '协议手册',
      summary: 'DDR5协议',
      keywords: [],
    };

    const result = mergeEntry('', entry);
    const { entries, categoryOrder } = parseIndexMd(result);
    expect(entries).toHaveLength(1);
    expect(categoryOrder).toEqual(['协议手册']);
    expect(result).toContain('# 知识库索引');
  });
});

// ── removeEntry ─────────────────────────────────────────────────

describe('removeEntry', () => {
  it('按路径移除条目', () => {
    const content = [
      '## 协议手册',
      '',
      '### DDR5',
      '- **路径**: `协议手册/DDR5.md`',
      '- **摘要**: DDR5',
      '',
      '### LPDDR',
      '- **路径**: `协议手册/LPDDR.md`',
      '- **摘要**: LPDDR',
      '',
    ].join('\n');

    const result = removeEntry(content, '协议手册/DDR5.md');
    const { entries } = parseIndexMd(result);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('LPDDR');
  });

  it('移除不存在的路径不影响内容', () => {
    const content = '## A\n\n### T\n- **路径**: `A/T.md`\n- **摘要**: s\n';
    const result = removeEntry(content, 'B/notexist.md');
    const { entries } = parseIndexMd(result);
    expect(entries).toHaveLength(1);
  });
});

// ── listCategoriesFromIndex ─────────────────────────────────────

describe('listCategoriesFromIndex', () => {
  it('返回分类列表', () => {
    const content = '## 分类A\n\n### T1\n- **路径**: `A/T1.md`\n- **摘要**: s\n\n## 分类B\n\n### T2\n- **路径**: `B/T2.md`\n- **摘要**: s\n';
    expect(listCategoriesFromIndex(content)).toEqual(['分类A', '分类B']);
  });
});

// ── indexDocument（完整流程）──────────────────────────────────

describe('indexDocument', () => {
  let docsDir: string;
  let indexMdPath: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-indexer-test-'));
    docsDir = join(dir, 'docs');
    const catDir = join(docsDir, '协议手册');
    await mkdir(catDir, { recursive: true });
    const mdPath = join(catDir, 'DDR5.md');
    await writeFile(mdPath, '# DDR5 协议\n\nDDR5 是新一代内存标准。\n', 'utf-8');
    indexMdPath = join(dir, 'index.md');
    await writeFile(indexMdPath, '# 知识库索引\n', 'utf-8');
    cleanup = async () => { await rm(dir, { recursive: true, force: true }); };
  });

  it('LLM 成功时正常分类并合并到 index.md', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: '{"category": "协议手册", "title": "DDR5", "summary": "DDR5协议", "keywords": ["DDR5", "内存"]}',
          },
        }],
      }),
    } as unknown as Response;

    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    const config: LlmConfig = {
      baseUrl: 'http://localhost:8557',
      apiKey: 'sk-test',
      model: 'test-model',
      fetchFn: fetchMock as unknown as typeof fetch,
    };

    const mdPath = join(docsDir, '协议手册', 'DDR5.md');
    const { entry, degraded } = await indexDocument(mdPath, docsDir, indexMdPath, ['协议手册'], config);

    expect(degraded).toBe(false);
    expect(entry.title).toBe('DDR5');
    expect(entry.category).toBe('协议手册');

    // index.md 已合并
    const indexContent = await readFile(indexMdPath, 'utf-8');
    expect(indexContent).toContain('DDR5');
    expect(indexContent).toContain('DDR5协议');

    await cleanup();
  });

  it('LLM 失败时降级为占位条目，不阻塞流程', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network error'));
    const config: LlmConfig = {
      baseUrl: 'http://localhost:8557',
      apiKey: 'sk-test',
      model: 'test-model',
      fetchFn: fetchMock as unknown as typeof fetch,
    };

    const mdPath = join(docsDir, '协议手册', 'DDR5.md');
    const { entry, degraded } = await indexDocument(mdPath, docsDir, indexMdPath, ['协议手册'], config);

    expect(degraded).toBe(true);
    expect(entry.category).toBe('未分类');
    expect(entry.title).toBe('DDR5');
    expect(entry.summary).toBe('');

    // index.md 仍有条目（占位）
    const indexContent = await readFile(indexMdPath, 'utf-8');
    expect(indexContent).toContain('DDR5');

    await cleanup();
  });

  it('无 LLM 配置时直接降级', async () => {
    const mdPath = join(docsDir, '协议手册', 'DDR5.md');
    const { entry, degraded } = await indexDocument(mdPath, docsDir, indexMdPath, [], null);

    expect(degraded).toBe(true);
    expect(entry.category).toBe('未分类');

    await cleanup();
  });
});

// ── removeFromIndex ──────────────────────────────────────────────

describe('removeFromIndex', () => {
  it('从 index.md 移除条目', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-indexer-rem-'));
    const indexMdPath = join(dir, 'index.md');
    const content = '## 协议手册\n\n### DDR5\n- **路径**: `协议手册/DDR5.md`\n- **摘要**: s\n';
    await writeFile(indexMdPath, content, 'utf-8');

    await removeFromIndex(indexMdPath, '协议手册/DDR5.md');

    const updated = await readFile(indexMdPath, 'utf-8');
    const { entries } = parseIndexMd(updated);
    expect(entries).toHaveLength(0);

    await rm(dir, { recursive: true, force: true });
  });
});
