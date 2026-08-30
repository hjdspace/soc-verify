import type { ReactNode } from 'react';

/**
 * recharts 透传 stub（vi.mock 工厂用）。
 *
 * recharts 的 ResponsiveContainer 依赖 ResizeObserver 实测容器尺寸——vitest
 * setup 中的 polyfill 为 noop，jsdom 下图表永远量不到尺寸、SVG 不会渲染。
 * 需要断言图表数据的测试用本工厂替换 recharts：把 props（stroke/fill/y 等）
 * 落成 data-* 属性、data/children 原样透传，断言在 DOM 边界进行。
 */
export async function rechartsStubFactory(): Promise<Record<string, unknown>> {
  const React = await import('react');
  type P = Record<string, unknown> & { children?: ReactNode };
  const node = (testid: string, props: P) =>
    React.createElement(
      'div',
      {
        'data-testid': testid,
        ...Object.fromEntries(
          Object.entries(props)
            .filter(([k, v]) => k !== 'children' && k !== 'data' && v !== undefined)
            .map(([k, v]) => [k.startsWith('data-') ? k : `data-${k.toLowerCase()}`, String(v)]),
        ),
      },
      props.children ?? null,
    );
  return {
    ResponsiveContainer: ({ children }: P) => React.createElement('div', null, children),
    LineChart: ({ data, children }: P) =>
      node('mock-line-chart', { 'data-chart-json': JSON.stringify(data), children }),
    BarChart: ({ data, children }: P) =>
      node('mock-bar-chart', { 'data-chart-json': JSON.stringify(data), children }),
    Line: ({ dataKey, stroke }: P) => node('mock-line', { dataKey, stroke }),
    Bar: ({ dataKey, children }: P) => node('mock-bar', { dataKey, children }),
    Cell: ({ fill, fillOpacity }: P) => node('mock-cell', { fill, fillOpacity }),
    XAxis: () => null,
    YAxis: () => null,
    ReferenceLine: ({ y, stroke }: P) => node('mock-refline', { y, stroke }),
  };
}
