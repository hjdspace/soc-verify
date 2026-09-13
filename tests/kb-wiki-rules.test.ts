/**
 * wiki-rules 单元测试（issue 04 — 写作规则读取与保存校验）。
 *
 * spec §2：用户可修改写作规则、模板与 purpose；已有页面的类型路由
 * 重映射需要专门迁移，本期保存时拒绝这种变更并解释受影响页面；
 * 仅写作要求变更使编译缓存失效，不自动触发全库付费重编。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readWikiRules, saveWikiRules } from '../src/main/kb/wiki-rules';
import { initWikiLayout, SCHEMA_MD_SKELETON, PURPOSE_MD_SKELETON } from '../src/main/kb/wiki-layout';

let kbPath: string;

beforeEach(() => {
  kbPath = join(__dirname, `tmp-kb-rules-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(kbPath, { recursive: true });
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

function writePage(rel: string, content: string): void {
  const abs = join(kbPath, 'wiki', rel);
  mkdirSync(abs.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

const PAGE_FM = (type: string, title: string): string => [
  '---',
  `type: ${type}`,
  `title: "${title}"`,
  'summary: S', 'keywords: []', 'tags: []', 'sources: []',
  'created: "2026-09-13T00:00:00Z"', 'updated: "2026-09-13T00:00:00Z"',
  '---', '', `# ${title}`,
].join('\n');

/** 把骨架里 concept 行的目录换成给定目录 */
function schemaWithConceptDir(dir: string): string {
  return SCHEMA_MD_SKELETON.replace('| concept | concepts | 概念与协议规则 |', `| concept | ${dir} | 概念与协议规则 |`);
}

describe('readWikiRules', () => {
  it('返回 schema/purpose 原文与 schema 解析结果', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-r1', name: 'KB' });
    const res = await readWikiRules(kbPath);
    expect(res.schemaRaw).toBe(SCHEMA_MD_SKELETON);
    expect(res.purposeRaw).toBe(PURPOSE_MD_SKELETON);
    expect(res.schemaParse.ok).toBe(true);
  });

  it('schema 缺失/损坏时 schemaParse 失败但 raw 仍返回（null/raw）', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-r2', name: 'KB' });
    writeFileSync(join(kbPath, 'schema.md'), '# 坏的\n', 'utf-8');
    const res = await readWikiRules(kbPath);
    expect(res.schemaRaw).toBe('# 坏的\n');
    expect(res.schemaParse.ok).toBe(false);
  });
});

describe('saveWikiRules — purpose', () => {
  it('purpose 可任意修改', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-r3', name: 'KB' });
    const res = await saveWikiRules(kbPath, { purposeRaw: '# 新目标\n\n沉淀 AXI 验证知识。\n' });
    expect(res.ok).toBe(true);
    expect(readFileSync(join(kbPath, 'purpose.md'), 'utf-8')).toContain('AXI 验证知识');
  });
});

describe('saveWikiRules — schema', () => {
  it('合法 schema（仅写作要求变更）保存成功', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-r4', name: 'KB' });
    const updated = SCHEMA_MD_SKELETON.replace(
      '- 关键寄存器名、单位、位宽、复位值、时序条件必须保留原值。',
      '- 关键寄存器名、单位、位宽、复位值、时序条件必须保留原值。\n- 新增写作要求：必须给出复位值来源。',
    );
    const res = await saveWikiRules(kbPath, { schemaRaw: updated });
    expect(res.ok).toBe(true);
    expect(readFileSync(join(kbPath, 'schema.md'), 'utf-8')).toContain('复位值来源');
  });

  it('不完整/重复/未知路由的 schema 拒绝保存', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-r5', name: 'KB' });
    const bad = SCHEMA_MD_SKELETON.replace('| pitfall | pitfalls | 已知问题：现象 → 根因 → 规避 → 证据 |\n', '')
      .replace('| concept | concepts | 概念与协议规则 |', '| concept | concepts | 概念与协议规则 |\n| concept | more | 重复 |');
    const res = await saveWikiRules(kbPath, { schemaRaw: bad });
    expect(res.ok).toBe(false);
    if (!res.ok && res.error.code === 'schemaInvalid') {
      const messages = res.error.issues.map((i) => i.message).join('\n');
      expect(messages).toContain('pitfall');
      expect(messages).toContain('concept');
    }
    // 拒绝时不落盘
    expect(readFileSync(join(kbPath, 'schema.md'), 'utf-8')).toBe(SCHEMA_MD_SKELETON);
  });

  it('已有页面的类型目录重映射被拒绝，并解释受影响页面', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-r6', name: 'KB' });
    writePage('concepts/axi-outstanding.md', PAGE_FM('concept', 'AXI'));
    writePage('concepts/axi-protocol.md', PAGE_FM('concept', '协议'));

    const res = await saveWikiRules(kbPath, { schemaRaw: schemaWithConceptDir('concept-notes') });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('pageDirRemap');
      expect(res.error.message).toContain('concepts');
      expect(res.error.message).toContain('concept-notes');
      expect(res.error.message).toContain('axi-outstanding');
      expect(res.error.message).toContain('axi-protocol');
    }
    // 拒绝时不落盘
    expect(readFileSync(join(kbPath, 'schema.md'), 'utf-8')).toBe(SCHEMA_MD_SKELETON);
  });

  it('目录重映射到已有其他页面占用的目录同样拒绝（冲突页列出）', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-r7', name: 'KB' });
    writePage('concept-notes/x.md', PAGE_FM('concept', 'X'));

    const res = await saveWikiRules(kbPath, { schemaRaw: schemaWithConceptDir('concept-notes') });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('pageDirRemap');
  });

  it('空目录（无页面）时允许调整路由目录', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-r8', name: 'KB' });
    const res = await saveWikiRules(kbPath, { schemaRaw: schemaWithConceptDir('concept-notes') });
    expect(res.ok).toBe(true);
    expect(readFileSync(join(kbPath, 'schema.md'), 'utf-8')).toContain('concept-notes');
  });

  it('schema.md 缺失时允许保存修复（当前路由视为空，无重映射）', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-r9', name: 'KB' });
    rmSync(join(kbPath, 'schema.md'));
    const res = await saveWikiRules(kbPath, { schemaRaw: SCHEMA_MD_SKELETON });
    expect(res.ok).toBe(true);
    expect(existsSync(join(kbPath, 'schema.md'))).toBe(true);
  });

  it('同一次调用可同时保存 schema 与 purpose', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-r10', name: 'KB' });
    const res = await saveWikiRules(kbPath, {
      schemaRaw: schemaWithConceptDir('concept-notes'), // 无页面，允许
      purposeRaw: '# 新目标\n',
    });
    expect(res.ok).toBe(true);
    expect(readFileSync(join(kbPath, 'schema.md'), 'utf-8')).toContain('concept-notes');
    expect(readFileSync(join(kbPath, 'purpose.md'), 'utf-8')).toContain('新目标');
  });
});
