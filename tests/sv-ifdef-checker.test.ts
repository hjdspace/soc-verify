import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '../src/main/tools/sv-ifdef-checker';

describe('SV Ifdef Checker', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = require('node:os').tmpdir() + `/sv-ifdef-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper: write content to a .sv file and check it. */
  async function checkContent(content: string) {
    const filePath = join(tmpDir, 'test.sv');
    writeFileSync(filePath, content, 'utf-8');
    return checkFile(filePath);
  }

  // ── Case 1: Single-line inline ifdef...endif ──────────────────────
  describe('single-line inline ifdef...endif', () => {
    it('should match `ifdef MACRO do_task(); `endif on one line', async () => {
      const result = await checkContent('`ifdef MACRO_1   do_task(); `endif\n');
      expect(result.isBalanced).toBe(true);
      expect(result.totalIfdef).toBe(1);
      expect(result.totalEndif).toBe(1);
      expect(result.inlineMatches).toBe(1);
      expect(result.unmatchedIfdef).toHaveLength(0);
      expect(result.unmatchedEndif).toHaveLength(0);
    });

    it('should match `ifndef MACRO do_task(); `endif on one line', async () => {
      const result = await checkContent('`ifndef MACRO_1   do_task(); `endif\n');
      expect(result.isBalanced).toBe(true);
      expect(result.totalIfndef).toBe(1);
      expect(result.totalEndif).toBe(1);
      expect(result.inlineMatches).toBe(1);
    });
  });

  // ── Case 2: Nested ifdef on same line with endifs on same line ───
  describe('nested ifdef on same line', () => {
    it('should match `ifdef A `ifdef B do_task(); `endif `endif', async () => {
      const result = await checkContent('`ifdef MACRO_1 `ifdef MACRO_2 do_task(); `endif `endif\n');
      expect(result.isBalanced).toBe(true);
      expect(result.totalIfdef).toBe(2);
      expect(result.totalEndif).toBe(2);
      expect(result.inlineMatches).toBe(2);
      expect(result.unmatchedIfdef).toHaveLength(0);
      expect(result.unmatchedEndif).toHaveLength(0);
    });

    it('should match triple-nested on same line', async () => {
      const result = await checkContent('`ifdef A `ifdef B `ifdef C do_task(); `endif `endif `endif\n');
      expect(result.isBalanced).toBe(true);
      expect(result.totalIfdef).toBe(3);
      expect(result.totalEndif).toBe(3);
      expect(result.inlineMatches).toBe(3);
    });
  });

  // ── Case 3: Nested ifdef on same line, endifs on separate lines ──
  describe('nested ifdef with endifs on separate lines', () => {
    it('should match multi-line nested ifdef/endif', async () => {
      const content = '`ifdef MACRO_1 `ifdef MACRO_2 do_task();\n`endif\n`endif\n';
      const result = await checkContent(content);
      expect(result.isBalanced).toBe(true);
      expect(result.totalIfdef).toBe(2);
      expect(result.totalEndif).toBe(2);
      expect(result.unmatchedIfdef).toHaveLength(0);
      expect(result.unmatchedEndif).toHaveLength(0);
    });

    it('should match 3-level nested across lines', async () => {
      const content = '`ifdef A `ifdef B `ifdef C do_task();\n`endif\n`endif\n`endif\n';
      const result = await checkContent(content);
      expect(result.isBalanced).toBe(true);
      expect(result.totalIfdef).toBe(3);
      expect(result.totalEndif).toBe(3);
    });
  });

  // ── Basic multi-line blocks ──────────────────────────────────────
  describe('basic multi-line blocks', () => {
    it('should match simple multi-line ifdef...endif', async () => {
      const content = '`ifdef MACRO_1\n  do_task();\n`endif\n';
      const result = await checkContent(content);
      expect(result.isBalanced).toBe(true);
      expect(result.totalIfdef).toBe(1);
      expect(result.totalEndif).toBe(1);
      expect(result.inlineMatches).toBe(0);
    });

    it('should match simple multi-line ifndef...endif', async () => {
      const content = '`ifndef DEBUG\n  do_task();\n`endif\n';
      const result = await checkContent(content);
      expect(result.isBalanced).toBe(true);
      expect(result.totalIfndef).toBe(1);
      expect(result.totalEndif).toBe(1);
    });

    it('should match multiple separate blocks', async () => {
      const content = [
        '`ifdef A',
        '  do_a();',
        '`endif',
        '`ifdef B',
        '  do_b();',
        '`endif',
        '',
      ].join('\n');
      const result = await checkContent(content);
      expect(result.isBalanced).toBe(true);
      expect(result.totalIfdef).toBe(2);
      expect(result.totalEndif).toBe(2);
    });
  });

  // ── Unbalanced cases ─────────────────────────────────────────────
  describe('unbalanced cases', () => {
    it('should report unmatched ifdef (missing endif)', async () => {
      const content = '`ifdef MACRO_1\n  do_task();\n';
      const result = await checkContent(content);
      expect(result.isBalanced).toBe(false);
      expect(result.unmatchedIfdef).toHaveLength(1);
      expect(result.unmatchedIfdef[0].condition).toBe('MACRO_1');
      expect(result.unmatchedEndif).toHaveLength(0);
    });

    it('should report unmatched endif (extra endif)', async () => {
      const content = '`ifdef MACRO_1\n  do_task();\n`endif\n`endif\n';
      const result = await checkContent(content);
      expect(result.isBalanced).toBe(false);
      expect(result.unmatchedIfdef).toHaveLength(0);
      expect(result.unmatchedEndif).toHaveLength(1);
    });

    it('should report unmatched ifndef', async () => {
      const content = '`ifndef DEBUG\n  do_task();\n';
      const result = await checkContent(content);
      expect(result.isBalanced).toBe(false);
      expect(result.unmatchedIfdef).toHaveLength(1);
      expect(result.unmatchedIfdef[0].type).toBe('ifndef');
    });
  });

  // ── Mixed inline and multi-line ──────────────────────────────────
  describe('mixed inline and multi-line', () => {
    it('should handle inline inside multi-line block', async () => {
      const content = [
        '`ifdef OUTER',
        '  `ifdef INNER do_task(); `endif',
        '`endif',
        '',
      ].join('\n');
      const result = await checkContent(content);
      expect(result.isBalanced).toBe(true);
      expect(result.totalIfdef).toBe(2);
      expect(result.totalEndif).toBe(2);
      expect(result.inlineMatches).toBe(1);
    });

    it('should handle multiple inline on same line inside multi-line', async () => {
      const content = [
        '`ifdef OUTER',
        '  `ifdef A do_a(); `endif `ifdef B do_b(); `endif',
        '`endif',
        '',
      ].join('\n');
      const result = await checkContent(content);
      expect(result.isBalanced).toBe(true);
      expect(result.totalIfdef).toBe(3);
      expect(result.totalEndif).toBe(3);
      expect(result.inlineMatches).toBe(2);
    });
  });

  // ── Comments handling ────────────────────────────────────────────
  describe('comments', () => {
    it('should skip line comments', async () => {
      const content = [
        '// `ifdef COMMENTED_OUT',
        '`ifdef REAL',
        '  do_task();',
        '`endif',
        '',
      ].join('\n');
      const result = await checkContent(content);
      expect(result.isBalanced).toBe(true);
      expect(result.totalIfdef).toBe(1);
      expect(result.totalEndif).toBe(1);
    });

    it('should skip block comments', async () => {
      const content = [
        '/*',
        ' `ifdef COMMENTED_OUT',
        ' `endif',
        '*/',
        '`ifdef REAL',
        '  do_task();',
        '`endif',
        '',
      ].join('\n');
      const result = await checkContent(content);
      expect(result.isBalanced).toBe(true);
      expect(result.totalIfdef).toBe(1);
      expect(result.totalEndif).toBe(1);
    });

    it('should handle same-line block comment', async () => {
      const content = '`ifdef REAL /* comment */ do_task(); `endif\n';
      const result = await checkContent(content);
      expect(result.isBalanced).toBe(true);
      expect(result.totalIfdef).toBe(1);
      expect(result.totalEndif).toBe(1);
    });

    it('should handle trailing line comment after directive', async () => {
      const content = '`ifdef REAL // some comment\n  do_task();\n`endif\n';
      const result = await checkContent(content);
      expect(result.isBalanced).toBe(true);
      expect(result.totalIfdef).toBe(1);
      expect(result.totalEndif).toBe(1);
    });
  });

  // ── Empty and edge cases ─────────────────────────────────────────
  describe('edge cases', () => {
    it('should handle empty file', async () => {
      const result = await checkContent('');
      expect(result.isBalanced).toBe(true);
      expect(result.totalIfdef).toBe(0);
      expect(result.totalEndif).toBe(0);
    });

    it('should handle file with no directives', async () => {
      const result = await checkContent('module test;\nendmodule\n');
      expect(result.isBalanced).toBe(true);
      expect(result.totalIfdef).toBe(0);
      expect(result.totalEndif).toBe(0);
    });

    it('should handle multiple directives with code on same line', async () => {
      // Complex real-world style
      const content = [
        'module test;',
        '`ifdef SIM',
        '  `ifdef FAST `define DELAY 0 `endif',
        '  initial begin',
        '    `ifdef DBG $display("debug"); `endif',
        '  end',
        '`endif',
        'endmodule',
        '',
      ].join('\n');
      const result = await checkContent(content);
      expect(result.isBalanced).toBe(true);
    });
  });

  // ── Ifdef with code between directives on same line ──────────────
  describe('directives with code between them', () => {
    it('should handle `ifdef A code `ifdef B code `endif code `endif', async () => {
      const content = '`ifdef A assign x = 1; `ifdef B assign y = 2; `endif assign z = 3; `endif\n';
      const result = await checkContent(content);
      expect(result.isBalanced).toBe(true);
      expect(result.totalIfdef).toBe(2);
      expect(result.totalEndif).toBe(2);
      expect(result.inlineMatches).toBe(2);
    });
  });
});
