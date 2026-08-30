// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    system: {
      openExternal: { mutate: vi.fn() },
    },
  },
}));

vi.mock('@renderer/stores/diff-review', () => ({
  openReviewAwareFile: vi.fn(),
}));

vi.mock('@renderer/components/chat/MermaidDiagram', () => ({
  MermaidDiagram: ({ code }: { code: string }) => <div data-testid="mermaid-stub">{code}</div>,
}));

import { MarkdownRenderer, extractMessageReferences } from '@renderer/components/chat/MarkdownRenderer';

// 来自真实会话 session_1787143666156_26e85o.json 的 LLM 答复片段：
// 无语言标记的 fenced code block 内含目录树
const TREE_BLOCK = [
  '### 项目架构总览',
  '',
  '```',
  'soc-verify/',
  '├── src/                          # 源码主目录',
  '│   ├── main/                     # Electron 主进程',
  '│   ├── renderer/                 # 渲染进程 (React UI)',
  '│   └── shared/                   # 前后端共享类型/工具',
  '├── plugins/                      # 插件系统 (6 种类型)',
  '└── tests/                        # 测试套件',
  '```',
].join('\n');

describe('MarkdownRenderer 代码块换行', () => {
  it('流式追加图表后的文本时保持多个已完成 Mermaid 组件挂载', () => {
    const diagrams = [
      '```mermaid',
      'flowchart LR',
      'A --> B',
      '```',
      '',
      '```mermaid',
      'sequenceDiagram',
      'A->>B: ping',
      '```',
    ].join('\n');
    const { rerender, getAllByTestId } = render(<MarkdownRenderer content={diagrams} />);
    const renderedDiagrams = getAllByTestId('mermaid-stub');

    rerender(<MarkdownRenderer content={`${diagrams}\n\n后续回复仍在流式生成`} />);

    getAllByTestId('mermaid-stub').forEach((diagram, index) => {
      expect(diagram).toBe(renderedDiagrams[index]);
    });
  });

  it('无语言标记的 fenced code block 应渲染为 pre 块并保留换行', () => {
    const { container } = render(<MarkdownRenderer content={TREE_BLOCK} />);

    // 目录树必须渲染在 <pre> 内（浏览器对 pre 保留 white-space），
    // 否则 \n 会被折叠、整棵树挤压成一行
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();

    const text = pre?.textContent ?? '';
    expect(text).toContain('soc-verify/');
    expect(text).toContain('├── src/');
    // 换行必须保留：树有多行
    expect(text.split('\n').length).toBeGreaterThan(5);
    // 缩进对齐字符必须逐行保留
    expect(text).toContain('│   ├── main/');
  });

  it('有语言标记的 fenced code block 正常渲染为 pre 块', () => {
    const { container } = render(
      <MarkdownRenderer content={'```python\nprint(1)\nprint(2)\n```'} />,
    );
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain('print(1)\nprint(2)');
  });

  it('行内 code 保持行内样式（不带复制按钮的块容器）', () => {
    const { container } = render(
      <MarkdownRenderer content={'段落中的 `inline_code` 引用'} />,
    );
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe('inline_code');
    // inline code 不应被渲染成带块容器的 CodeBlock（无复制按钮）
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('MarkdownRenderer 流式尾缘', () => {
  it('streaming 时末尾文本出现模糊尾缘，行内光标渲染在最后一个段落内部', () => {
    const { container } = render(
      <MarkdownRenderer content="这是一段正在流式生成的回复文本" streaming />,
    );
    const tail = container.querySelector('.ap-stream-tail');
    expect(tail).not.toBeNull();
    // 尾缘只覆盖末尾 6 个字符，前面正文保持清晰
    expect(tail?.textContent).toBe('成的回复文本');

    // 光标行内渲染：位于段落元素内部（而非独立成行的兄弟节点）
    const cursors = container.querySelectorAll('.ap-cursor');
    expect(cursors.length).toBe(1);
    const lastP = container.querySelector('p');
    expect(lastP?.contains(cursors[0])).toBe(true);
    // 正文完整保留
    expect(container.querySelector('p')?.textContent).toBe('这是一段正在流式生成的回复文本');
  });

  it('非 streaming 渲染不产生尾缘与光标', () => {
    const { container } = render(
      <MarkdownRenderer content="这是一段已完成的回复文本" />,
    );
    expect(container.querySelector('.ap-stream-tail')).toBeNull();
    expect(container.querySelector('.ap-cursor')).toBeNull();
  });

  it('流式中 settled 部分的文件引用仍被 chip 化', () => {
    const { container } = render(
      <MarkdownRenderer content="查看 src/main/foo.sv:42 的实现说明" streaming />,
    );
    // settled 末尾是 "src/main/foo.sv:"，应被识别为文件引用 chip
    const chip = container.querySelector('button.ap-chip');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('src/main/foo.sv');
  });

  it('以代码块结尾时无光标但不崩溃，代码内容完整', () => {
    const { container } = render(
      <MarkdownRenderer content={'```python\nprint(1)\n```'} streaming />,
    );
    expect(container.querySelector('.ap-cursor')).toBeNull();
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain('print(1)');
  });

  it('嵌套列表只应用一次尾缘（无重复光标）', () => {
    const { container } = render(
      <MarkdownRenderer content={'- 外层项\n  - 内层项文本'} streaming />,
    );
    expect(container.querySelectorAll('.ap-cursor').length).toBe(1);
    expect(container.querySelectorAll('.ap-stream-tail').length).toBe(1);
    // 列表文本完整
    expect(container.querySelector('li')?.textContent).toContain('外层项');
  });

  it('多块内容流式时仅最后一个文本块有尾缘与光标（兄弟块级不得各自应用）', () => {
    const { container } = render(
      <MarkdownRenderer
        content={'开头段落文本。\n\n### 小节标题\n\n- 列表项甲\n- 列表项乙\n- 列表项丙\n\n收尾段落文本。'}
        streaming
      />,
    );
    // 全文只能有一个尾缘与一个光标：每个已完成块（标题/列表项/段落）的
    // 末尾字符如果被各自应用尾缘，会永久停留在模糊态直到消息结束
    expect(container.querySelectorAll('.ap-stream-tail').length).toBe(1);
    expect(container.querySelectorAll('.ap-cursor').length).toBe(1);
    // 尾缘位于最后一个块（收尾段落）内，且只覆盖末尾 6 个字符
    const tail = container.querySelector('.ap-stream-tail');
    expect(tail?.textContent).toBe('尾段落文本。');
    const lastP = container.querySelector('p:last-of-type');
    expect(lastP?.contains(tail ?? null)).toBe(true);
  });

  it('流式结束后重渲染移除尾缘与光标', () => {
    const { rerender, container } = render(
      <MarkdownRenderer content="流式中的回复" streaming />,
    );
    expect(container.querySelector('.ap-cursor')).not.toBeNull();
    rerender(<MarkdownRenderer content="流式中的回复已完成" />);
    expect(container.querySelector('.ap-cursor')).toBeNull();
    expect(container.querySelector('.ap-stream-tail')).toBeNull();
  });
});

describe('extractMessageReferences 引用来源提取', () => {
  it('提取文件引用（含行号）与 host URI，按首次出现去重排序', () => {
    const content = [
      '先看 src/main/foo.sv:42 的实现，再对比 src/main/foo.sv:42。',
      '运行结果见 case:///run/123，日志在 log:///run/123/main.log。',
      '涉及 tests/tb_top.v:100-105 与 case:///run/123。',
    ].join('\n');

    const refs = extractMessageReferences(content);

    expect(refs).toHaveLength(4);

    expect(refs[0]).toMatchObject({ kind: 'file', path: 'src/main/foo.sv', line: 42 });
    expect(refs[1]).toMatchObject({ kind: 'uri', uri: 'case:///run/123' });
    expect(refs[2]).toMatchObject({ kind: 'uri', uri: 'log:///run/123/main.log' });
    expect(refs[3]).toMatchObject({ kind: 'file', path: 'tests/tb_top.v', line: 100, endLine: 105 });
  });

  it('无引用内容返回空数组', () => {
    expect(extractMessageReferences('普通文本，没有可识别的引用。')).toEqual([]);
  });

  it('名称罗列（所有段大写开头，如 Tavily/Exa/Firecrawl/Z.AI）不判为文件引用', () => {
    const content = '免密钥方案只剩 Tavily/Exa/Firecrawl/Z.AI 可选，任选一家配置即可。';
    expect(extractMessageReferences(content)).toEqual([]);
  });

  it('未识别扩展名但含小写段的项目路径仍识别为文件引用', () => {
    const refs = extractMessageReferences('脚本见 tools/gen_regs.pl 生成寄存器。');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: 'file', path: 'tools/gen_regs.pl' });
  });
});
