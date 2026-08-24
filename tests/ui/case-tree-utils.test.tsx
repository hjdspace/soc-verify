// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  buildCaseTree,
  CaseTreeItem,
  getCaseId,
  type CaseData,
} from '@renderer/components/project/case-tree-utils';

/**
 * buildCaseTree + CaseTreeItem 渲染测试：
 *
 * 重点验证：当多个 case 共享同一个 path / filePath（即同一 .cfg 文件中的
 * 多个用例）时，buildCaseTree 不会丢失用例，CaseTreeItem 也不会因 React key
 * 冲突而只渲染最后一条。
 */
describe('buildCaseTree', () => {
  it('groups cases by filePath into file nodes', () => {
    const cases: CaseData[] = [
      { name: 'case_a', subsys: 'top', path: '/env/top/case.cfg', filePath: '/env/top/case.cfg' },
      { name: 'case_b', subsys: 'top', path: '/env/top/case.cfg', filePath: '/env/top/case.cfg' },
    ];
    const tree = buildCaseTree(cases);
    expect(tree).toHaveLength(1);
    expect(tree[0].type).toBe('file');
    expect(tree[0].children).toHaveLength(2);
  });

  it('builds parent-child hierarchy via baseCase', () => {
    const cases: CaseData[] = [
      { name: 'root_case', subsys: 'top', path: '/env/top/case.cfg', filePath: '/env/top/case.cfg' },
      { name: 'child_case', subsys: 'top', path: '/env/top/case.cfg', filePath: '/env/top/case.cfg', baseCase: 'root_case' },
    ];
    const tree = buildCaseTree(cases);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].name).toBe('root_case');
    expect(tree[0].children[0].children).toHaveLength(1);
    expect(tree[0].children[0].children[0].name).toBe('child_case');
  });

  it('returns flat list when no filePath is present', () => {
    const cases: CaseData[] = [
      { name: 'case_a', subsys: 'top', path: '/env/top/a' },
      { name: 'case_b', subsys: 'top', path: '/env/top/b' },
    ];
    const tree = buildCaseTree(cases);
    expect(tree).toHaveLength(2);
    expect(tree.every((n) => n.type === 'case')).toBe(true);
  });

  it('does not lose cases that share the same path', () => {
    const cases: CaseData[] = [
      { name: 'mini_1', subsys: 'top', path: '/env/top/mini.cfg', filePath: '/env/top/mini.cfg' },
      { name: 'mini_2', subsys: 'top', path: '/env/top/mini.cfg', filePath: '/env/top/mini.cfg' },
      { name: 'mini_3', subsys: 'top', path: '/env/top/mini.cfg', filePath: '/env/top/mini.cfg' },
    ];
    const tree = buildCaseTree(cases);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(3);
    const names = tree[0].children.map((c) => c.name).sort();
    expect(names).toEqual(['mini_1', 'mini_2', 'mini_3']);
  });
});

describe('CaseTreeItem rendering with shared paths', () => {
  const noop = () => {};

  it('renders all cases sharing the same path without losing any', () => {
    const cases: CaseData[] = [
      { name: 'mini_a', subsys: 'top', path: '/env/top/mini.cfg', filePath: '/env/top/mini.cfg' },
      { name: 'mini_b', subsys: 'top', path: '/env/top/mini.cfg', filePath: '/env/top/mini.cfg' },
      { name: 'mini_c', subsys: 'top', path: '/env/top/mini.cfg', filePath: '/env/top/mini.cfg' },
    ];
    const tree = buildCaseTree(cases);
    render(
      <div>
        {tree.map((node, idx) => (
          <CaseTreeItem
            key={`${node.path}::${node.name}::${idx}`}
            node={node}
            level={0}
            expandedFiles={new Set([node.path])}
            expandedCases={new Set()}
            toggleFile={noop}
            toggleCase={noop}
            batchMode={false}
            selectedCases={new Set()}
            selectedCaseId={null}
            toggleCaseSelection={noop}
            onCaseSelect={noop}
            onContextMenu={noop}
            onFileContextMenu={noop}
            onRunCase={noop}
          />
        ))}
      </div>,
    );
    expect(screen.getByText('mini_a')).toBeInTheDocument();
    expect(screen.getByText('mini_b')).toBeInTheDocument();
    expect(screen.getByText('mini_c')).toBeInTheDocument();
  });
});

describe('getCaseId', () => {
  it('uses id when available', () => {
    const c: CaseData = { id: 'xyz', name: 'test', subsys: 'top', path: '/p' };
    expect(getCaseId(c)).toBe('xyz');
  });

  it('falls back to path::name', () => {
    const c: CaseData = { name: 'test', subsys: 'top', path: '/p' };
    expect(getCaseId(c)).toBe('/p::test');
  });
});
