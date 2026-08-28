import { describe, expect, it } from 'vitest';
import {
  isThinkingLevelSetting,
  normalizeThinkingLevelSetting,
  thinkingLevelLabel,
} from '../src/shared/types/thinking-level';

describe('normalizeThinkingLevelSetting', () => {
  it('passes through every valid level', () => {
    for (const level of ['default', 'auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(normalizeThinkingLevelSetting(level)).toBe(level);
    }
  });

  it('falls back to default for undefined, null and unknown values', () => {
    expect(normalizeThinkingLevelSetting(undefined)).toBe('default');
    expect(normalizeThinkingLevelSetting(null)).toBe('default');
    expect(normalizeThinkingLevelSetting('bogus')).toBe('default');
    expect(normalizeThinkingLevelSetting(42)).toBe('default');
  });
});

describe('isThinkingLevelSetting', () => {
  it('accepts valid settings and rejects everything else', () => {
    expect(isThinkingLevelSetting('auto')).toBe(true);
    expect(isThinkingLevelSetting('default')).toBe(true);
    expect(isThinkingLevelSetting('inherit')).toBe(false);
    expect(isThinkingLevelSetting('')).toBe(false);
  });
});

describe('thinkingLevelLabel', () => {
  it('maps known values to their display labels', () => {
    expect(thinkingLevelLabel('default')).toBe('默认');
    expect(thinkingLevelLabel('auto')).toBe('自动');
    expect(thinkingLevelLabel('off')).toBe('关闭');
    expect(thinkingLevelLabel('max')).toBe('最大');
  });

  it('falls back to 默认 for undefined', () => {
    expect(thinkingLevelLabel(undefined)).toBe('默认');
  });
});
