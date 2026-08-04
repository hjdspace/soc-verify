import { describe, it, expect } from 'vitest';
import { normalizeCheckInfo } from '../../src/main/timing-violation/confirm/pattern-normalizer';

describe('Pattern Normalizer', () => {
  describe('normalizeCheckInfo', () => {
    it('normalizes standard check with time info in parentheses', () => {
      const input = 'setup( posedge clk: 1523423 FS, negedge data: 100 PS, margin: -50 PS)';
      const result = normalizeCheckInfo(input);
      expect(result).toBe('setup( posedge clk, negedge data)');
    });

    it('normalizes hold check', () => {
      const input = 'hold( posedge clk: 2000000 FS, negedge data: 200 PS, margin: -30 PS)';
      const result = normalizeCheckInfo(input);
      expect(result).toBe('hold( posedge clk, negedge data)');
    });

    it('preserves prefix before parentheses (must match exactly)', () => {
      const input1 = 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)';
      const input2 = 'hold( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)';
      expect(normalizeCheckInfo(input1)).not.toBe(normalizeCheckInfo(input2));
      expect(normalizeCheckInfo(input1)).toBe('setup( posedge clk, negedge data)');
      expect(normalizeCheckInfo(input2)).toBe('hold( posedge clk, negedge data)');
    });

    it('ignores third part completely (margin)', () => {
      const input1 = 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)';
      const input2 = 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -999 PS)';
      expect(normalizeCheckInfo(input1)).toBe(normalizeCheckInfo(input2));
    });

    it('different time values normalize to same result (fuzzy match)', () => {
      const input1 = 'setup( posedge clk: 1000 FS, negedge data: 50 PS, margin: -50 PS)';
      const input2 = 'setup( posedge clk: 9999 FS, negedge data: 200 PS, margin: -80 PS)';
      expect(normalizeCheckInfo(input1)).toBe(normalizeCheckInfo(input2));
      expect(normalizeCheckInfo(input1)).toBe('setup( posedge clk, negedge data)');
    });

    it('returns original when no parentheses found', () => {
      const input = 'setup_no_paren';
      expect(normalizeCheckInfo(input)).toBe(input);
    });

    it('returns original when parentheses have less than 3 comma-separated parts', () => {
      const input = 'setup( posedge clk: 100 FS, negedge data: 200 PS)';
      expect(normalizeCheckInfo(input)).toBe(input);
    });

    it('returns original for empty string', () => {
      expect(normalizeCheckInfo('')).toBe('');
    });

    it('handles check with only parentheses content', () => {
      const input = 'check( a: 1, b: 2, c: 3)';
      const result = normalizeCheckInfo(input);
      expect(result).toBe('check( a, b)');
    });

    it('handles parts without colon (no time info)', () => {
      const input = 'setup( posedge clk, negedge data, margin)';
      const result = normalizeCheckInfo(input);
      expect(result).toBe('setup( posedge clk, negedge data)');
    });

    it('handles mixed colon/no-colon parts', () => {
      const input = 'setup( posedge clk: 100 FS, negedge data, margin: -50 PS)';
      const result = normalizeCheckInfo(input);
      expect(result).toBe('setup( posedge clk, negedge data)');
    });

    it('handles more than 3 parts (extra commas ignored)', () => {
      const input = 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS, extra: data)';
      const result = normalizeCheckInfo(input);
      expect(result).toBe('setup( posedge clk, negedge data)');
    });

    it('handles nested parentheses (uses first open and last close)', () => {
      const input = 'setup( posedge clk(x): 100 FS, negedge data: 200 PS, margin: -50 PS)';
      const result = normalizeCheckInfo(input);
      // Should still normalize the first two parts by colon
      expect(result).toContain('posedge clk');
      expect(result).toContain('negedge data');
    });

    it('matches Python reference example exactly', () => {
      // From handoff doc §2.4.3
      const original = 'setup( posedge clk: 1523423 FS, negedge data: 100 PS, margin: -50 PS)';
      const expected = 'setup( posedge clk, negedge data)';
      expect(normalizeCheckInfo(original)).toBe(expected);
    });
  });
});
