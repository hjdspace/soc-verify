/**
 * wikilink 单元测试（issue 04 — 统一链接解析）。
 *
 * spec §2：链接采用 `[[concepts/axi-outstanding|显示名]]`，允许
 * `#heading`。统一解析实现供图谱、Lint、检索与 UI 消费：忽略围栏/
 * 行内代码、转义和图片 embed；裸名仅在唯一命中时解析，歧义显式报告，
 * 禁止取第一个（spec 对 R11 的修正点）。
 */

import { describe, it, expect } from 'vitest';
import {
  extractWikiLinks,
  resolveWikiTarget,
  type WikiCatalogLookup,
  type WikiLinkOccurrence,
} from '../src/main/kb/wikilink';

// ── 抽取 ────────────────────────────────────────────────────────

describe('extractWikiLinks — 抽取', () => {
  it('基本链接与别名', () => {
    const links = extractWikiLinks('见 [[concepts/axi-outstanding|AXI 限制]] 说明。');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      kind: 'link',
      target: 'concepts/axi-outstanding',
      alias: 'AXI 限制',
    });
    expect(links[0].heading).toBeUndefined();
  });

  it('target 与别名缺省时的 label 回退由消费方处理；无别名 alias 为 undefined', () => {
    const links = extractWikiLinks('见 [[concepts/axi-outstanding]]。');
    expect(links[0]).toMatchObject({ kind: 'link', target: 'concepts/axi-outstanding' });
    expect(links[0].alias).toBeUndefined();
  });

  it('#heading 分离到 heading 字段', () => {
    const links = extractWikiLinks('[[concepts/axi-outstanding# outstanding | 限值]]');
    expect(links[0]).toMatchObject({
      target: 'concepts/axi-outstanding',
      alias: '限值',
    });
    expect(links[0].heading).toBe(' outstanding'); // 整体 trim 去尾空格，内部空格保留
  });

  it('heading-only 链接（target 为空）也返回，target = ""', () => {
    const links = extractWikiLinks('[[#现象]]');
    expect(links[0]).toMatchObject({ kind: 'link', target: '', heading: '现象' });
  });

  it('图片 embed 单独标记，不混入页面引用边', () => {
    const links = extractWikiLinks('![[assets/diagram.png|框图]] 与 [[concepts/axi]]');
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ kind: 'embed', target: 'assets/diagram.png', alias: '框图' });
    expect(links[1]).toMatchObject({ kind: 'link', target: 'concepts/axi' });
  });

  it('围栏代码块内的链接被忽略', () => {
    const md = [
      '正文 [[concepts/real]] 引用。',
      '```',
      '[[concepts/in-code]]',
      '```',
      '~~~md',
      '示例 [[concepts/in-tilde]]',
      '~~~',
    ].join('\n');
    const links = extractWikiLinks(md);
    expect(links.map((l) => l.target)).toEqual(['concepts/real']);
  });

  it('行内代码内的链接被忽略', () => {
    const links = extractWikiLinks('写法 `[[concepts/not-a-link]]` 与 [[concepts/real]]。');
    expect(links.map((l) => l.target)).toEqual(['concepts/real']);
  });

  it('转义 \\[\\[ 不算链接', () => {
    const links = extractWikiLinks('转义 \\[\\[concepts/escaped\\]\\] 与 [[concepts/real]]');
    expect(links.map((l) => l.target)).toEqual(['concepts/real']);
  });

  it('多处链接按出现顺序返回', () => {
    const md = '[[a/first]] 中 [[b/second|二]] 后 [[a/first]]';
    const links: WikiLinkOccurrence[] = extractWikiLinks(md);
    expect(links.map((l) => l.target)).toEqual(['a/first', 'b/second', 'a/first']);
  });

  it('无链接返回空数组', () => {
    expect(extractWikiLinks('普通 markdown [x](y) 文本')).toEqual([]);
  });
});

// ── 解析 ────────────────────────────────────────────────────────

const lookup: WikiCatalogLookup = {
  byId: new Map([
    ['concepts/axi-outstanding', { pageId: 'concepts/axi-outstanding', title: 'AXI outstanding 限制' }],
    ['concepts/axi-protocol', { pageId: 'concepts/axi-protocol', title: 'AXI 协议' }],
    ['pitfalls/deadlock', { pageId: 'pitfalls/deadlock', title: '死锁案例' }],
  ]),
  byBasename: new Map([
    ['axi-outstanding', ['concepts/axi-outstanding']],
    ['axi-protocol', ['concepts/axi-protocol']],
    ['deadlock', ['pitfalls/deadlock']],
  ]),
  byTitle: new Map([
    ['AXI outstanding 限制', ['concepts/axi-outstanding']],
    ['AXI 协议', ['concepts/axi-protocol']],
    ['死锁案例', ['pitfalls/deadlock']],
  ]),
};

describe('resolveWikiTarget — 解析', () => {
  it('完整 pageId 精确命中', () => {
    expect(resolveWikiTarget('concepts/axi-outstanding', lookup)).toEqual({
      status: 'resolved',
      pageId: 'concepts/axi-outstanding',
    });
  });

  it('带 .md 后缀剥掉后命中', () => {
    expect(resolveWikiTarget('concepts/axi-outstanding.md', lookup)).toMatchObject({ status: 'resolved' });
  });

  it('裸名唯一 basename 命中', () => {
    expect(resolveWikiTarget('deadlock', lookup)).toEqual({
      status: 'resolved',
      pageId: 'pitfalls/deadlock',
    });
  });

  it('裸名唯一标题命中', () => {
    expect(resolveWikiTarget('AXI 协议', lookup)).toEqual({ status: 'resolved', pageId: 'concepts/axi-protocol' });
  });

  it('裸名歧义显式报告全部候选，不取第一个', () => {
    const ambiguous: WikiCatalogLookup = {
      byId: new Map([
        ['concepts/dup', { pageId: 'concepts/dup', title: '同名页' }],
        ['sources/dup', { pageId: 'sources/dup', title: '来源侧同名' }],
      ]),
      byBasename: new Map([['dup', ['concepts/dup', 'sources/dup']]]),
      byTitle: new Map(),
    };
    const res = resolveWikiTarget('dup', ambiguous);
    expect(res.status).toBe('ambiguous');
    if (res.status === 'ambiguous') {
      expect(new Set(res.candidates)).toEqual(new Set(['concepts/dup', 'sources/dup']));
    }
  });

  it('标题歧义同样报告', () => {
    const ambiguous: WikiCatalogLookup = {
      byId: new Map([
        ['concepts/x', { pageId: 'concepts/x', title: '同名标题' }],
        ['concepts/y', { pageId: 'concepts/y', title: '同名标题' }],
      ]),
      byBasename: new Map([['x', ['concepts/x']], ['y', ['concepts/y']]]),
      byTitle: new Map([['同名标题', ['concepts/x', 'concepts/y']]]),
    };
    const res = resolveWikiTarget('同名标题', ambiguous);
    expect(res.status).toBe('ambiguous');
    if (res.status === 'ambiguous') {
      expect(res.candidates).toHaveLength(2);
    }
  });

  it('未命中返回 unresolved', () => {
    expect(resolveWikiTarget('concepts/missing', lookup)).toEqual({ status: 'unresolved' });
  });

  it('空 target（纯 heading 链接）按 unresolved 处理', () => {
    expect(resolveWikiTarget('', lookup)).toEqual({ status: 'unresolved' });
  });

  it('pageId 优先于裸名/标题（同名字下精确路径赢）', () => {
    const tricky: WikiCatalogLookup = {
      byId: new Map([['concepts/z', { pageId: 'concepts/z', title: 'dup' }]]),
      byBasename: new Map([['concepts/z', ['concepts/z']], ['dup', ['concepts/z']]]),
      byTitle: new Map([['dup', ['concepts/z']]]),
    };
    expect(resolveWikiTarget('concepts/z', tricky)).toEqual({ status: 'resolved', pageId: 'concepts/z' });
  });
});
