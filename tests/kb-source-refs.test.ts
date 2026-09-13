/**
 * kb source refs 行为测试（issue 02 — 修订引用根）。
 *
 * spec §1：导入更新路径时「保存仍被引用的旧修订」；引用根来自
 * 已发布知识页 frontmatter sources、页面历史与 staging 提案。
 * issue 02 用小型 manifest/页面 fixture 验证引用根扫描，
 * 不等待后续编译器（issue 05/06 才定义完整格式）。
 *
 * 方向安全性：引用扫描允许假阳性（多保存一份证据），不允许假阴性
 * （丢失被引用证据）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectReferencedRevisions,
  extractSourceRefsFromMarkdown,
  extractSourceRefsFromJsonValue,
} from '../src/main/kb/source-refs';

const SID = 'sid-1234567890abcdef';
const REV1 = 'rev-aaaa';
const REV2 = 'rev-bbbb';

let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `sv-kb-refs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('extractSourceRefsFromMarkdown — 已发布页 frontmatter 引用', () => {
  it('解析 frontmatter sources 中的 sourceId/sourceRevision 对', () => {
    const page = [
      '---',
      'type: concept',
      'title: AXI outstanding 限制',
      'sources:',
      `  - sourceId: "${SID}"`,
      `    sourceRevision: "${REV1}"`,
      '    parsedHash: "p1"',
      '---',
      '',
      '正文',
    ].join('\n');
    const refs = extractSourceRefsFromMarkdown(page);
    expect(refs).toContainEqual({ sourceId: SID, sourceRevision: REV1 });
  });

  it('无 frontmatter 或无 sources 的页面返回空（log/聚合页安全）', () => {
    expect(extractSourceRefsFromMarkdown('# 纯正文，无 frontmatter')).toEqual([]);
    expect(extractSourceRefsFromMarkdown('---\ntype: concept\ntitle: 无来源\n---\n正文')).toEqual([]);
  });

  it('多来源多修订全部收集', () => {
    const page = [
      '---',
      'sources:',
      `  - sourceId: "${SID}"`,
      `    sourceRevision: "${REV1}"`,
      `  - sourceId: "${SID}"`,
      `    sourceRevision: "${REV2}"`,
      '  - sourceId: "other"',
      `    sourceRevision: "${REV1}"`,
      '---',
    ].join('\n');
    const refs = extractSourceRefsFromMarkdown(page);
    expect(refs).toHaveLength(3);
    expect(refs.filter((r) => r.sourceId === SID)).toHaveLength(2);
  });

  it('围栏代码块中的伪 frontmatter 不产生引用（忽略围栏）', () => {
    const page = [
      '# 正文页',
      '',
      '```markdown',
      '---',
      'sources:',
      `  - sourceId: "fake-id"`,
      `    sourceRevision: "fake-rev"`,
      '---',
      '```',
    ].join('\n');
    expect(extractSourceRefsFromMarkdown(page)).toEqual([]);
  });

  it('缺 sourceRevision 的条目跳过（不完整引用不参与保留判定）', () => {
    const page = ['---', 'sources:', `  - sourceId: "${SID}"`, '---'].join('\n');
    expect(extractSourceRefsFromMarkdown(page)).toEqual([]);
  });
});

describe('extractSourceRefsFromJsonValue — .kb/ JSON 引用（page-history / staging fixture）', () => {
  it('从嵌套 JSON 中收集 sourceId+sourceRevision 对', () => {
    const fixture = {
      entries: [
        { op: 'create', before: null, sources: [{ sourceId: SID, sourceRevision: REV1 }] },
        { op: 'update', sourceRefs: [{ sourceId: SID, sourceRevision: REV2, parsedHash: 'p' }] },
      ],
    };
    const refs = extractSourceRefsFromJsonValue(fixture);
    expect(refs).toContainEqual({ sourceId: SID, sourceRevision: REV1 });
    expect(refs).toContainEqual({ sourceId: SID, sourceRevision: REV2 });
  });

  it('只有 sourceId 没有修订的对象跳过', () => {
    expect(extractSourceRefsFromJsonValue({ sourceId: SID, note: 'x' })).toEqual([]);
  });

  it('深度超限/循环引用安全终止', () => {
    const cyclic: Record<string, unknown> = { sourceId: SID, sourceRevision: REV1 };
    cyclic['self'] = cyclic;
    expect(() => extractSourceRefsFromJsonValue(cyclic)).not.toThrow();
    expect(extractSourceRefsFromJsonValue(cyclic)).toContainEqual({ sourceId: SID, sourceRevision: REV1 });
  });
});

describe('collectReferencedRevisions — 库内引用根汇总', () => {
  it('汇总已发布页 + page-history + staging 的引用；空库返回空', async () => {
    // wiki 页 fixture
    mkdirSync(join(tmp, 'wiki', 'concepts'), { recursive: true });
    writeFileSync(
      join(tmp, 'wiki', 'concepts', 'axi.md'),
      ['---', 'sources:', `  - sourceId: "${SID}"`, `    sourceRevision: "${REV1}"`, '---'].join('\n'),
    );
    writeFileSync(join(tmp, 'wiki', 'log.md'), `## [2026-09-13] import | ${SID} ${REV2}\n`);

    // page-history fixture
    mkdirSync(join(tmp, '.kb', 'page-history'), { recursive: true });
    writeFileSync(
      join(tmp, '.kb', 'page-history', 'h1.json'),
      JSON.stringify({ sourceRefs: [{ sourceId: SID, sourceRevision: REV2 }] }),
    );

    // staging fixture
    mkdirSync(join(tmp, '.kb', 'staging', 'p1'), { recursive: true });
    writeFileSync(
      join(tmp, '.kb', 'staging', 'p1', 'proposal.json'),
      JSON.stringify({ sources: [{ sourceId: 'other-source', sourceRevision: REV1 }] }),
    );

    const index = await collectReferencedRevisions(tmp);
    expect(index.get(SID)).toEqual(new Set([REV1, REV2]));
    expect(index.get('other-source')).toEqual(new Set([REV1]));
  });

  it('库目录不存在/无 wiki 时返回空 Map 而非抛错', async () => {
    const index = await collectReferencedRevisions(join(tmp, 'nonexistent'));
    expect(index.size).toBe(0);
  });

  it('损坏的 JSON fixture 不阻断其他引用根', async () => {
    mkdirSync(join(tmp, '.kb', 'page-history'), { recursive: true });
    writeFileSync(join(tmp, '.kb', 'page-history', 'bad.json'), '{ not json');
    mkdirSync(join(tmp, 'wiki'), { recursive: true });
    writeFileSync(
      join(tmp, 'wiki', 'ok.md'),
      ['---', 'sources:', `  - sourceId: "${SID}"`, `    sourceRevision: "${REV1}"`, '---'].join('\n'),
    );
    const index = await collectReferencedRevisions(tmp);
    expect(index.get(SID)).toEqual(new Set([REV1]));
  });

  it('证据不落盘：扫描后 fixture 原样保留', async () => {
    mkdirSync(join(tmp, 'wiki'), { recursive: true });
    const pagePath = join(tmp, 'wiki', 'a.md');
    writeFileSync(pagePath, ['---', 'sources:', `  - sourceId: "x"`, `    sourceRevision: "y"`, '---'].join('\n'));
    collectReferencedRevisions(tmp);
    expect(existsSync(pagePath)).toBe(true);
  });
});
