// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

// Import after mocks
import { EditorStatusBar } from '@renderer/components/editor/EditorStatusBar';

describe('EditorStatusBar', () => {
  it('renders save status as "已保存" when not dirty', () => {
    render(
      <EditorStatusBar
        fileName="alu_add.sv"
        isDirty={false}
        cursorPos={{ line: 1, col: 1 }}
        tabSize={2}
      />,
    );

    expect(screen.getByTestId('status-save-status').textContent).toContain('已保存');
  });

  it('renders save status as "已修改" when dirty', () => {
    render(
      <EditorStatusBar
        fileName="alu_add.sv"
        isDirty={true}
        cursorPos={{ line: 1, col: 1 }}
        tabSize={2}
      />,
    );

    expect(screen.getByTestId('status-save-status').textContent).toContain('已修改');
  });

  it('renders cursor position as "Ln 42, Col 16"', () => {
    render(
      <EditorStatusBar
        fileName="alu_add.sv"
        isDirty={false}
        cursorPos={{ line: 42, col: 16 }}
        tabSize={2}
      />,
    );

    expect(screen.getByTestId('status-cursor').textContent).toBe('Ln 42, Col 16');
  });

  it('renders cursor position for line 1 col 1', () => {
    render(
      <EditorStatusBar
        fileName="alu_add.sv"
        isDirty={false}
        cursorPos={{ line: 1, col: 1 }}
        tabSize={2}
      />,
    );

    expect(screen.getByTestId('status-cursor').textContent).toBe('Ln 1, Col 1');
  });

  it('renders language label as SystemVerilog for .sv files', () => {
    render(
      <EditorStatusBar
        fileName="alu_add.sv"
        isDirty={false}
        cursorPos={{ line: 1, col: 1 }}
        tabSize={2}
      />,
    );

    expect(screen.getByTestId('status-language').textContent).toBe('SystemVerilog');
  });

  it('renders language label as Python for .py files', () => {
    render(
      <EditorStatusBar
        fileName="test.py"
        isDirty={false}
        cursorPos={{ line: 1, col: 1 }}
        tabSize={2}
      />,
    );

    expect(screen.getByTestId('status-language').textContent).toBe('Python');
  });

  it('renders language label as JSON for .json files', () => {
    render(
      <EditorStatusBar
        fileName="settings.json"
        isDirty={false}
        cursorPos={{ line: 1, col: 1 }}
        tabSize={2}
      />,
    );

    expect(screen.getByTestId('status-language').textContent).toBe('JSON');
  });

  it('renders language label as TypeScript for .ts files', () => {
    render(
      <EditorStatusBar
        fileName="index.ts"
        isDirty={false}
        cursorPos={{ line: 1, col: 1 }}
        tabSize={2}
      />,
    );

    expect(screen.getByTestId('status-language').textContent).toBe('TypeScript');
  });

  it('renders language label as Markdown for .md files', () => {
    render(
      <EditorStatusBar
        fileName="README.md"
        isDirty={false}
        cursorPos={{ line: 1, col: 1 }}
        tabSize={2}
      />,
    );

    expect(screen.getByTestId('status-language').textContent).toBe('Markdown');
  });

  it('renders language label as YAML for .yaml files', () => {
    render(
      <EditorStatusBar
        fileName="config.yaml"
        isDirty={false}
        cursorPos={{ line: 1, col: 1 }}
        tabSize={2}
      />,
    );

    expect(screen.getByTestId('status-language').textContent).toBe('YAML');
  });

  it('renders language label as Plain Text for unknown extensions', () => {
    render(
      <EditorStatusBar
        fileName="unknown.xyz"
        isDirty={false}
        cursorPos={{ line: 1, col: 1 }}
        tabSize={2}
      />,
    );

    expect(screen.getByTestId('status-language').textContent).toBe('Plain Text');
  });

  it('renders encoding as UTF-8', () => {
    render(
      <EditorStatusBar
        fileName="alu_add.sv"
        isDirty={false}
        cursorPos={{ line: 1, col: 1 }}
        tabSize={2}
      />,
    );

    expect(screen.getByTestId('status-encoding').textContent).toBe('UTF-8');
  });

  it('renders indent size as "Tab: 2" when tabSize is 2', () => {
    render(
      <EditorStatusBar
        fileName="alu_add.sv"
        isDirty={false}
        cursorPos={{ line: 1, col: 1 }}
        tabSize={2}
      />,
    );

    expect(screen.getByTestId('status-indent').textContent).toBe('Tab: 2');
  });

  it('renders indent size as "Tab: 4" when tabSize is 4', () => {
    render(
      <EditorStatusBar
        fileName="alu_add.sv"
        isDirty={false}
        cursorPos={{ line: 1, col: 1 }}
        tabSize={4}
      />,
    );

    expect(screen.getByTestId('status-indent').textContent).toBe('Tab: 4');
  });

  it('renders line ending as LF by default', () => {
    render(
      <EditorStatusBar
        fileName="alu_add.sv"
        isDirty={false}
        cursorPos={{ line: 1, col: 1 }}
        tabSize={2}
      />,
    );

    expect(screen.getByTestId('status-line-ending').textContent).toBe('LF');
  });

  it('renders line ending as CRLF when content has Windows line endings', () => {
    render(
      <EditorStatusBar
        fileName="alu_add.sv"
        isDirty={false}
        cursorPos={{ line: 1, col: 1 }}
        tabSize={2}
        lineEnding="CRLF"
      />,
    );

    expect(screen.getByTestId('status-line-ending').textContent).toBe('CRLF');
  });
});
