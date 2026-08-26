/**
 * Default vi.mock stubs for the three visual animation libraries.
 *
 * Import and call `installVisualMocks()` in test files that render components
 * using ThinkingOrb / BorderBeam / Liquid. The stubs render lightweight DOM
 * with data-testid attributes and forward key props as data attributes so
 * tests can assert on them without a canvas/SVG engine.
 *
 * @example
 * ```ts
 * import { installVisualMocks } from '../mocks/visual-stubs';
 * installVisualMocks();
 * ```
 */

/** Install vi.mock stubs for the visual wrapper module. */
export function installVisualMocks(): void {
  vi.mock('@renderer/components/visual', async () => {
    const { createElement: h } = await import('react');
    return {
      ThinkingOrb: (props: Record<string, unknown>) =>
        h('canvas', {
          'data-testid': 'thinking-orb',
          'data-state': props.state ?? 'working',
          'data-size': String(props.size ?? 64),
          'data-theme': props.theme ?? 'auto',
        }),
      BorderBeam: ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
        h('div', {
          'data-testid': 'border-beam',
          'data-active': String(props.active ?? true),
          'data-size': props.size ?? 'md',
          'data-colorvariant': props.colorVariant ?? 'colorful',
          'data-theme': props.theme ?? 'dark',
        }, children),
      Liquid: ({ children }: { children?: React.ReactNode }) =>
        h('div', { 'data-testid': 'liquid-group' }, children),
      LiquidItem: ({ children }: { children?: React.ReactNode }) =>
        h('div', { 'data-testid': 'liquid-item' }, children),
    };
  });
}

// vi is available as a global in vitest tests
declare const vi: {
  mock: (path: string, factory: () => unknown) => void;
};
