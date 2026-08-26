/**
 * Visual enhancement wrapper — unified re-export of the three animation
 * libraries (thinking-orbs, border-beam, liquid-gooey) used across the
 * AI Agent interaction surface.
 *
 * Import from `@renderer/components/visual` rather than the raw packages
 * so that test stubs can mock a single module path.
 */

export { ThinkingOrb } from 'thinking-orbs';
export type { ThinkingOrbProps, OrbState, OrbSize, OrbTheme } from 'thinking-orbs';

export { BorderBeam } from 'border-beam';
export type {
  BorderBeamProps,
  BorderBeamSize,
  BorderBeamTheme,
  BorderBeamColorVariant,
} from 'border-beam';

export { Liquid } from 'liquid-gooey';
export type { LiquidProps, LiquidItemProps, LiquidEffect, MoveTuning, MorphTuning } from 'liquid-gooey';
