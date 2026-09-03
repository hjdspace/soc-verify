// @vitest-environment jsdom
/**
 * CodeHighlight 性能守卫（tab 切换卡顿修复的回归测试）。
 *
 * 根因数据：WriteBody/ReadBody/DiffLineView 逐行调用 CodeHighlight，
 * 无扩展名/未知语言（如 .drawio → plaintext）时每行都走 hljs.highlightAuto
 * 全语言探测，实测 13.3ms/行——3 个 write(227/255/253 行) + read(309 行)
 * ≈ 6.3s，即用户"切到某会话 tab 卡顿几秒"的主因。
 *
 * 守卫：单行内容、未知语言不得触发 highlightAuto；多行仍允许自动探测。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import hljs from 'highlight.js';

vi.mock('@renderer/lib/trpc', () => ({ trpc: { system: { openExternal: { mutate: vi.fn() } } } }));

import { CodeHighlight } from '@renderer/components/chat/tool-bodies/shared/CodeHighlight';

describe('CodeHighlight highlightAuto 守卫', () => {
  it('单行 + 未知语言（plaintext）不触发 highlightAuto（转义纯文本）', () => {
    const origAuto = hljs.highlightAuto.bind(hljs);
    let autoCalls = 0;
    (hljs as { highlightAuto: unknown }).highlightAuto = (...args: Parameters<typeof hljs.highlightAuto>) => {
      autoCalls++;
      return origAuto(...args);
    };
    try {
      // 模拟 WriteBody 逐行渲染 drawio 文件（detectLanguage → plaintext）
      const lines = Array.from({ length: 50 }, (_, i) => `<mxGraphModel dx="800" page="${i}">`);
      render(<div>{lines.map((l, i) => <CodeHighlight key={i} code={l} language="plaintext" />)}</div>);
      expect(autoCalls).toBe(0);
      // 内容仍正确渲染（转义纯文本）
      expect(screen.getAllByText(/mxGraphModel/).length).toBe(50);
    } finally {
      (hljs as { highlightAuto: typeof hljs.highlightAuto }).highlightAuto = origAuto;
    }
  });

  it('已知语言仍走精确高亮（hljs.highlight）', () => {
    const origHighlight = hljs.highlight.bind(hljs);
    let highlightCalls = 0;
    (hljs as { highlight: unknown }).highlight = (...args: Parameters<typeof hljs.highlight>) => {
      highlightCalls++;
      return origHighlight(...args);
    };
    try {
      render(<CodeHighlight code="module tb;" language="verilog" />);
      expect(highlightCalls).toBe(1);
    } finally {
      (hljs as { highlight: typeof hljs.highlight }).highlight = origHighlight;
    }
  });

  it('多行未知语言仍允许一次自动探测', () => {
    const origAuto = hljs.highlightAuto.bind(hljs);
    let autoCalls = 0;
    (hljs as { highlightAuto: unknown }).highlightAuto = (...args: Parameters<typeof hljs.highlightAuto>) => {
      autoCalls++;
      return origAuto(...args);
    };
    try {
      render(<CodeHighlight code={'line1\nline2\nline3'} language="plaintext" />);
      expect(autoCalls).toBe(1);
    } finally {
      (hljs as { highlightAuto: typeof hljs.highlightAuto }).highlightAuto = origAuto;
    }
  });
});
