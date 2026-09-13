/**
 * 共享 hunk 模型测试（issue 07）。
 *
 * 覆盖验收：
 *  - 新页与 frontmatter 整体接受/拒绝；已有正文支持逐 hunk；
 *  - 从用户选择重建最终候选正文（全接受 == proposed、全拒绝 == before）；
 *  - 部分接受可识别（供 published_partial）；
 *  - 差异重算后旧 hunk 决定可比对失效（指纹）。
 *
 * 模型约定：
 *  - `WIKI_PAGE_HUNK_ID (0)` = 整页/元数据块（新页整页、或显式整页处置）；
 *  - 已有页的真实 hunk 从 1 起编号；frontmatter 区的改动**合并为单块**（不可拆开 YAML）；
 *  - 无差异返回 null。
 */

import { describe, it, expect } from 'vitest';
import {
  WIKI_PAGE_HUNK_ID,
  buildWikiPageDiff,
  rebuildWikiPage,
  wikiPageDiffFingerprint,
  wikiRealHunkIds,
} from '@shared/wiki-hunks';

const page = (before: string | null, proposed: string) => ({
  relPath: 'wiki/concepts/axi.md',
  before,
  proposed,
});

const NEW_PAGE = ['---', 'type: concept', 'title: "APB"', '---', '', '# APB', '', '正文。'].join('\n');

const FM_BODY_BEFORE = [
  '---', 'type: concept', 'title: "A"', 'summary: 旧摘要。', '---', '', '# A', '', '旧正文。',
].join('\n');
const FM_BODY_AFTER = [
  '---', 'type: concept', 'title: "A2"', 'summary: 新摘要。', '---', '', '# A', '', '新正文。',
].join('\n');

const BODY_BEFORE = ['---', 'type: concept', 'title: "A"', '---', '', '# A', '', '旧正文。'].join('\n');
const BODY_AFTER = ['---', 'type: concept', 'title: "A"', '---', '', '# A', '', '新正文。', '', '补充。'].join('\n');

describe('buildWikiPageDiff — hunk 切分', () => {
  it('新页：整页一个 hunk（id 0，kind whole-page），全部为 add 行', () => {
    const diff = buildWikiPageDiff(page(null, NEW_PAGE));
    expect(diff).not.toBeNull();
    expect(diff!.isNewFile).toBe(true);
    expect(diff!.lines.every((l) => l.type === 'add')).toBe(true);
    expect(diff!.lines.every((l) => l.hunkId === WIKI_PAGE_HUNK_ID)).toBe(true);
    expect(diff!.hunks).toHaveLength(1);
    expect(diff!.hunks[0].id).toBe(WIKI_PAGE_HUNK_ID);
    expect(diff!.hunks[0].kind).toBe('whole-page');
    expect(wikiRealHunkIds(page(null, NEW_PAGE))).toEqual([WIKI_PAGE_HUNK_ID]);
  });

  it('已有页仅正文改动：真实 hunk 从 1 编号，frontmatter 不产生 hunk', () => {
    const diff = buildWikiPageDiff(page(BODY_BEFORE, BODY_AFTER));
    expect(diff).not.toBeNull();
    expect(diff!.isNewFile).toBe(false);
    expect(diff!.hunks.map((h) => h.id)).toEqual([1]);
    expect(diff!.hunks[0].kind).toBe('body');
    expect(diff!.lines.some((l) => l.type === 'del' && l.content === '旧正文。' && l.hunkId === 1)).toBe(true);
    expect(wikiRealHunkIds(page(BODY_BEFORE, BODY_AFTER))).toEqual([1]);
  });

  it('frontmatter 区多处改动合并为单块（不得拆开 YAML），正文另成一块', () => {
    const diff = buildWikiPageDiff(page(FM_BODY_BEFORE, FM_BODY_AFTER));
    expect(diff).not.toBeNull();
    expect(diff!.hunks.map((h) => h.id)).toEqual([1, 2]);
    expect(diff!.hunks[0].kind).toBe('frontmatter');
    expect(diff!.hunks[1].kind).toBe('body');
    // title 与 summary 两处改动同属 hunk 1
    const fmHunkIds = diff!.lines
      .filter((l) => l.content.startsWith('title:') || l.content.startsWith('summary:'))
      .map((l) => l.hunkId);
    expect(new Set(fmHunkIds)).toEqual(new Set([1]));
    // 正文改动属 hunk 2
    expect(diff!.lines.find((l) => l.content === '新正文。')?.hunkId).toBe(2);
  });

  it('内容一致返回 null；CRLF/LF 纯换行差异同样视为无差异', () => {
    expect(buildWikiPageDiff(page(BODY_AFTER, BODY_AFTER))).toBeNull();
    expect(buildWikiPageDiff(page(BODY_AFTER.replace(/\n/g, '\r\n'), BODY_AFTER))).toBeNull();
  });
});

describe('rebuildWikiPage — 从审阅选择重建最终候选', () => {
  it('新页整页接受 → proposed；整页拒绝 → rejected（不发布）', () => {
    const accepted = rebuildWikiPage(page(null, NEW_PAGE), 'accepted', {});
    expect(accepted).toMatchObject({ status: 'accepted', content: NEW_PAGE, partial: false });

    const rejected = rebuildWikiPage(page(null, NEW_PAGE), 'rejected', {});
    expect(rejected.status).toBe('rejected');

    // 旧决策口径：hunkId 0 即整页
    expect(rebuildWikiPage(page(null, NEW_PAGE), 'pending', { 0: 'accepted' }))
      .toMatchObject({ status: 'accepted', content: NEW_PAGE });
    expect(rebuildWikiPage(page(null, NEW_PAGE), 'pending', { 0: 'rejected' }).status).toBe('rejected');
  });

  it('已有页全部 hunk 接受 → 与 proposed 逐字节一致（partial=false）', () => {
    const res = rebuildWikiPage(page(FM_BODY_BEFORE, FM_BODY_AFTER), 'pending', { 1: 'accepted', 2: 'accepted' });
    expect(res).toMatchObject({ status: 'accepted', content: FM_BODY_AFTER, partial: false });
  });

  it('已有页全部拒绝 → rejected（正文保持 before）', () => {
    const res = rebuildWikiPage(page(FM_BODY_BEFORE, FM_BODY_AFTER), 'pending', { 1: 'rejected', 2: 'rejected' });
    expect(res.status).toBe('rejected');
  });

  it('部分接受 → 只应用被接受的 hunk，partial=true 且 YAML 仍完整', () => {
    const res = rebuildWikiPage(page(FM_BODY_BEFORE, FM_BODY_AFTER), 'pending', { 1: 'accepted', 2: 'rejected' });
    expect(res).toMatchObject({ status: 'accepted', partial: true });
    if (res.status !== 'accepted') return;
    expect(res.content).toContain('title: "A2"');
    expect(res.content).toContain('summary: 新摘要。');
    expect(res.content).toContain('旧正文。');
    expect(res.content).not.toContain('新正文。');
    // frontmatter 结构完整（首行与闭合 --- 都在）
    expect(res.content.startsWith('---\ntype: concept\n')).toBe(true);
    expect(res.content.match(/^---$/gm)).toHaveLength(2);
  });

  it('存在未处置的 hunk → pending（不发布）', () => {
    const res = rebuildWikiPage(page(FM_BODY_BEFORE, FM_BODY_AFTER), 'pending', { 1: 'accepted' });
    expect(res.status).toBe('pending');
    if (res.status !== 'pending') return;
    expect(res.pendingHunks).toEqual([2]);
  });

  it('无差异的页 → unchanged（不产生发布目标）', () => {
    expect(rebuildWikiPage(page(BODY_AFTER, BODY_AFTER), 'pending', {}).status).toBe('unchanged');
    expect(rebuildWikiPage(page(BODY_AFTER, BODY_AFTER), 'accepted', {}).status).toBe('unchanged');
  });

  it('部分接受后内容与 before 相同（纯格式差异）仍视为 unchanged', () => {
    const crlf = BODY_AFTER.replace(/\n/g, '\r\n');
    expect(rebuildWikiPage(page(crlf, BODY_AFTER), 'pending', {}).status).toBe('unchanged');
  });
});

describe('wikiPageDiffFingerprint — 差异重算即失效旧决定', () => {
  it('before/proposed 任一变化都改变指纹', () => {
    const base = wikiPageDiffFingerprint(page(BODY_BEFORE, BODY_AFTER));
    expect(wikiPageDiffFingerprint(page(BODY_BEFORE, BODY_AFTER))).toBe(base);
    expect(wikiPageDiffFingerprint(page(BODY_BEFORE, `${BODY_AFTER}\n追加。`))).not.toBe(base);
    expect(wikiPageDiffFingerprint(page(BODY_AFTER, BODY_AFTER))).not.toBe(base);
    expect(wikiPageDiffFingerprint(page(null, BODY_AFTER))).not.toBe(base);
  });
});
