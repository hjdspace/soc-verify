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
    const LiquidItem = ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
      h('div', {
        'data-testid': 'liquid-item',
        'data-effect': props.effect ?? 'morph',
        ...(props.move ? { 'data-move': JSON.stringify(props.move) } : {}),
      }, children);
    const Liquid = ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
      h('div', {
        'data-testid': 'liquid-group',
        'data-blur': String(props.blur ?? 6),
        'data-contrast': String(props.contrast ?? 18),
        ...(props.fill ? { 'data-fill': props.fill } : {}),
        ...(props.shadow ? { 'data-shadow': props.shadow } : {}),
        ...(props.className ? { 'data-classname': props.className } : {}),
      }, children);
    // Match the real API: `Liquid` exposes `.Item` as a sub-component.
    (Liquid as unknown as { Item: typeof LiquidItem }).Item = LiquidItem;
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
      Liquid,
      LiquidItem,
    };
  });
}

// vi is available as a global in vitest tests
declare const vi: {
  mock: (path: string, factory: () => unknown) => void;
};
