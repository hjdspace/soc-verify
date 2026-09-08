/**
 * Knowledge Base Indexer 测试。
 *
 * 覆盖场景：
 *  - 骨架截取（extractSkeleton）
 *  - Prompt 组装（buildClassificationPrompt）
 *  - LLM 响应解析（parseClassificationResponse）
 *  - LLM 调用（classifyWithLlm）mock fetch — openai / anthropic / gemini 三协议
 *  - 协议推导（protocolForProvider）
 *  - 单文档分类流程（classifyMarkdownFile）
 *  - index.md 条目写入（upsertIndexEntry：清旧条目 + 最终路径）
 *  - index.md 增量合并（mergeEntry / removeEntry / parseIndexMd）
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
  protocolForProvider,
  classifyMarkdownFile,
  upsertIndexEntry,
  mergeEntry,
  removeEntry,
  parseIndexMd,
  listCategoriesFromIndex,
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

  it('超长行（PDF 表格/内联内容）截断到单行上限，防止 prompt 体积失控', () => {
    // 60 行 × 每行 5000 字符 = 30 万字符 —— 未修复时直接拖垮 LLM 生成耗时
    const md = Array.from({ length: 60 }, (_, i) => `第${i}行 ${'x'.repeat(5000)}`).join('\n');
    const skeleton = extractSkeleton(md);

    for (const line of skeleton.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(201); // 200 + 截断省略号
    }
    expect(skeleton.length).toBeLessThanOrEqual(60 * 201);
  });

  it('骨架总体积不超过字符上限（超长行场景的真实保险丝）', () => {
    const md = Array.from({ length: 60 }, (_, i) => `第${i}行 ${'x'.repeat(300)}`).join('\n');
    const skeleton = extractSkeleton(md);

    // 60 行 × 300+ 字符 ≈ 1.8 万字符，超过 4000 上限后停止收集
    expect(skeleton.length).toBeLessThanOrEqual(4_000 + 60);
    expect(skeleton.split('\n').length).toBeLessThan(60);
  });

  it('标题行同样受单行截断约束', () => {
    const md = `# ${'超长标题'.repeat(200)}`;
    const skeleton = extractSkeleton(md);
    expect(skeleton.length).toBeLessThanOrEqual(201);
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

  /** openai chat/completions 成功响应 mock（json + text 双形状） */
  const okResponse = (payload: unknown): Response => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response);

  it('成功调用 LLM 并返回分类结果', async () => {
    const mockResponse = okResponse({
      choices: [{
        message: {
          content: '{"category": "协议手册", "title": "DDR5", "summary": "DDR5协议", "keywords": ["DDR5"]}',
        },
      }],
    });

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

  it('apiFormat=openai-responses 时请求 /responses 端点并解析 output_text', async () => {
    const mockResponse = okResponse({
      output: [
        { type: 'reasoning', summary: [] },
        {
          type: 'message',
          content: [{
            type: 'output_text',
            text: '{"category": "协议手册", "title": "DDR5", "summary": "DDR5协议", "keywords": ["DDR5"]}',
          }],
        },
      ],
    });

    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    const result = await classifyWithLlm('骨架', [], {
      ...config,
      apiFormat: 'openai-responses',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.category).toBe('协议手册');
      expect(result.result.title).toBe('DDR5');
    }

    // 验证请求 URL 和 Responses 请求体形状
    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[0]).toBe('http://localhost:8557/responses');
    const init = callArgs[1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'test-model',
      max_output_tokens: expect.any(Number),
    });
    expect(body).not.toHaveProperty('messages');
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('anthropic 凭证走 /messages 端点 + x-api-key 头', async () => {
    const mockResponse = okResponse({
      content: [
        { type: 'text', text: '{"category": "验证计划", "title": "PLAN", "summary": "验证计划文档", "keywords": ["UVM"]}' },
      ],
    });

    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    const result = await classifyWithLlm('骨架', [], {
      ...config,
      providerId: 'anthropic',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.category).toBe('验证计划');
    }

    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[0]).toBe('http://localhost:8557/messages');
    const init = callArgs[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('gemini 凭证走 generateContent 端点（key 查询参数）', async () => {
    const mockResponse = okResponse({
      candidates: [{
        content: { parts: [{ text: '{"category": "协议手册", "title": "AXI", "summary": "AXI协议", "keywords": ["AXI"]}' }] },
      }],
    });

    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    const result = await classifyWithLlm('骨架', [], {
      ...config,
      providerId: 'gemini',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.category).toBe('协议手册');
    }

    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[0]).toBe('http://localhost:8557/v1beta/models/test-model:generateContent?key=sk-test');
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
    const mockResponse = okResponse({ choices: [{ message: {} }] });

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

  // ── 超时富化 + 自动重试（修复：This operation was aborted 裸报错）──

  /** 构造 AbortController 触发后 fetch 的拒绝形态（Node 下只有裸 message，靠 name 识别） */
  const abortRejection = (): Promise<never> => {
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    return Promise.reject(err);
  };

  it('请求超时时返回富化的超时错误（含模型/端点/时限），不再是裸 aborted', async () => {
    // mock fetch 立即以 AbortError 拒绝（等价于 AbortController 120s 触发后的状态，
    // 不等待真实计时器，避免测试超时）
    const fetchMock = vi.fn().mockImplementation(() => abortRejection());

    const result = await classifyWithLlm('骨架', [], { ...config, fetchFn: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('超时');
      expect(result.error).toContain('test-model');
      expect(result.error).toContain('localhost:8557');
      expect(result.error).not.toContain('This operation was aborted');
      expect(result.error).not.toContain('sk-test'); // 绝不泄漏 key
    }
  });

  it('超时后自动重试，第二次成功则返回成功结果', async () => {
    const ok = okResponse({
      choices: [{ message: { content: '{"category": "验证方法", "title": "T", "summary": "s", "keywords": []}' } }],
    });
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) return abortRejection(); // 首次超时
      return Promise.resolve(ok); // 重试成功
    });

    const result = await classifyWithLlm('骨架', [], { ...config, fetchFn: fetchMock as unknown as typeof fetch });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.category).toBe('验证方法');
    }
  });

  it('4xx 客户端错误不重试（凭证/请求问题重试无意义）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as unknown as Response);

    const result = await classifyWithLlm('骨架', [], { ...config, fetchFn: fetchMock as unknown as typeof fetch });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });

  it('429/5xx 服务端错误自动重试，重试耗尽后错误注明重试次数', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'Bad Gateway',
    } as unknown as Response);

    const result = await classifyWithLlm('骨架', [], { ...config, fetchFn: fetchMock as unknown as typeof fetch });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('502');
      expect(result.error).toContain('重试');
    }
  });

  it('200 但返回非 JSON（网关 HTML 错误页）时给出可读错误', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html><body>502 Bad Gateway (nginx)</body></html>',
    } as unknown as Response);

    const result = await classifyWithLlm('骨架', [], { ...config, fetchFn: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('网关异常');
    }
  });

  it('网络错误信息附带 cause 与模型/端点', async () => {
    const err = new Error('fetch failed');
    (err as Error & { cause?: unknown }).cause = new Error('getaddrinfo ENOTFOUND relay.example');
    const fetchMock = vi.fn().mockRejectedValue(err);

    const result = await classifyWithLlm('骨架', [], { ...config, fetchFn: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('网络错误');
      expect(result.error).toContain('ENOTFOUND');
      expect(result.error).toContain('test-model');
    }
  });

  it('AI 返回非 JSON content 时给出可读解析错误', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: '分类：协议手册（不是 JSON）' } }] }),
    );

    const result = await classifyWithLlm('骨架', [], { ...config, fetchFn: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('JSON 无法解析');
    }
  });
});

// ── protocolForProvider ─────────────────────────────────────────

describe('protocolForProvider', () => {
  it('按 providerId 推导调用协议', () => {
    expect(protocolForProvider('openai')).toBe('openai');
    expect(protocolForProvider('openai-compatible')).toBe('openai');
    expect(protocolForProvider('deepseek')).toBe('openai');
    expect(protocolForProvider('anthropic')).toBe('anthropic');
    expect(protocolForProvider('claude')).toBe('anthropic');
    expect(protocolForProvider('google')).toBe('gemini');
    expect(protocolForProvider('gemini')).toBe('gemini');
    expect(protocolForProvider(undefined)).toBe('openai');
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

// ── classifyMarkdownFile（单文档分类流程）──────────────────────

describe('classifyMarkdownFile', () => {
  let dir: string;
  let mdPath: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kb-classify-test-'));
    mdPath = join(dir, 'DDR5.md');
    await writeFile(mdPath, '# DDR5 协议\n\nDDR5 是新一代内存标准。\n', 'utf-8');
    cleanup = async () => { await rm(dir, { recursive: true, force: true }); };
  });

  it('LLM 成功时返回分类结果，不写 index.md', async () => {
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
      text: async () => JSON.stringify({
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

    const { classification, degraded } = await classifyMarkdownFile(mdPath, ['协议手册'], config);

    expect(degraded).toBe(false);
    expect(classification.title).toBe('DDR5');
    expect(classification.category).toBe('协议手册');
    expect(classification.summary).toBe('DDR5协议');

    await cleanup();
  });

  it('LLM 调用失败时降级为未分类，并返回降级原因', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network error'));
    const config: LlmConfig = {
      baseUrl: 'http://localhost:8557',
      apiKey: 'sk-test',
      model: 'test-model',
      fetchFn: fetchMock as unknown as typeof fetch,
    };

    const { classification, degraded, error } = await classifyMarkdownFile(mdPath, ['协议手册'], config);

    expect(degraded).toBe(true);
    expect(error).toContain('network error');
    expect(classification.category).toBe('未分类');
    expect(classification.title).toBe('DDR5');
    expect(classification.summary).toBe('');

    await cleanup();
  });

  it('无 LLM 配置时直接降级，error 提示配置凭证', async () => {
    const { classification, degraded, error } = await classifyMarkdownFile(mdPath, [], null);

    expect(degraded).toBe(true);
    expect(error).toContain('LLM 凭证');
    expect(classification.category).toBe('未分类');

    await cleanup();
  });
});

// ── upsertIndexEntry（最终路径写入 + 清除旧条目）──────────────

describe('upsertIndexEntry', () => {
  let dir: string;
  let indexMdPath: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kb-upsert-test-'));
    indexMdPath = join(dir, 'index.md');
    await mkdir(dir, { recursive: true });
    cleanup = async () => { await rm(dir, { recursive: true, force: true }); };
  });

  it('空 index.md 插入条目', async () => {
    await upsertIndexEntry(indexMdPath, 'DDR5', {
      title: 'DDR5',
      path: '协议手册/DDR5.md',
      category: '协议手册',
      summary: 'DDR5协议',
      keywords: ['DDR5'],
    });

    const { entries, categoryOrder } = parseIndexMd(await readFile(indexMdPath, 'utf-8'));
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('协议手册/DDR5.md');
    expect(categoryOrder).toEqual(['协议手册']);

    await cleanup();
  });

  it('重复上传/跨分类移动后：清除同文档的所有旧路径条目，只保留新条目', async () => {
    // 模拟历史脏数据：同一文档两条条目（一条脏路径）
    await writeFile(indexMdPath, [
      '# 知识库索引',
      '',
      '## 未分类',
      '',
      '### DDR5',
      '- **路径**: `未分类/未分类/DDR5.md`',
      '- **摘要**: （暂无摘要）',
      '',
      '### DDR5',
      '- **路径**: `未分类/DDR5.md`',
      '- **摘要**: （暂无摘要）',
      '',
      '## 协议手册',
      '',
      '### LPDDR',
      '- **路径**: `协议手册/LPDDR.md`',
      '- **摘要**: LPDDR',
      '',
    ].join('\n'), 'utf-8');

    await upsertIndexEntry(indexMdPath, 'DDR5', {
      title: 'DDR5',
      path: '协议手册/DDR5.md',
      category: '协议手册',
      summary: 'DDR5协议',
      keywords: [],
    });

    const { entries } = parseIndexMd(await readFile(indexMdPath, 'utf-8'));
    // DDR5 只剩一条新路径条目，LPDDR 不受影响
    const ddr5 = entries.filter((e) => e.path.endsWith('DDR5.md'));
    expect(ddr5).toHaveLength(1);
    expect(ddr5[0].path).toBe('协议手册/DDR5.md');
    expect(entries.some((e) => e.path === '协议手册/LPDDR.md')).toBe(true);

    await cleanup();
  });

  it('无条目的分类节在重写后不残留', async () => {
    await writeFile(indexMdPath, [
      '# 知识库索引',
      '',
      '## 未分类',
      '',
      '### OLD',
      '- **路径**: `未分类/OLD.md`',
      '- **摘要**: （暂无摘要）',
      '',
    ].join('\n'), 'utf-8');

    await upsertIndexEntry(indexMdPath, 'OLD', {
      title: 'OLD',
      path: '新分类/OLD.md',
      category: '新分类',
      summary: 'x',
      keywords: [],
    });

    const content = await readFile(indexMdPath, 'utf-8');
    expect(content).toContain('## 新分类');
    expect(content).not.toContain('## 未分类');

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
