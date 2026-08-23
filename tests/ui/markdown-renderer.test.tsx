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

import { MarkdownRenderer } from '@renderer/components/chat/MarkdownRenderer';

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
