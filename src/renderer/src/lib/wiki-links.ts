/**
 * wikilink 展示层转换 — `[[target|alias]]` → `[label](wikilink://target)`。
 *
 * 只服务只读浏览的 markdown 渲染；跳过规则（围栏代码块、行内代码、
 * 转义 `\[\[`）与主进程统一解析器（src/main/kb/wikilink.ts）保持一致，
 * 解析语义（唯一命中/歧义/未命中）以主进程返回的 links 结论为准，
 * 本实现不做解析判断。
 *
 * 图片 embed `![[...]]` 不转换（资产浏览属后继票），保持原样显示。
 */

const WIKI_MARKUP_RE = /(!?)\[\[([^\]|\n]*)(?:\|([^\]\n]*))?\]\]/g;

export const WIKILINK_HREF_PREFIX = 'wikilink://';

/** 从 `wikilink://<target>` href 提取 target；非该前缀返回 null */
export function parseWikilinkHref(href: string): string | null {
  return href.startsWith(WIKILINK_HREF_PREFIX) ? decodeURIComponent(href.slice(WIKILINK_HREF_PREFIX.length)) : null;
}

/** 在代码围栏/行内代码/转义之外执行转换（与主进程 forOutsideCode 同构） */
function transformOutsideCode(content: string, transform: (text: string) => string): string {
  return content
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .split(/(`[^`\n]*`)/g)
            .map((seg, j) => (j % 2 === 1 ? seg : transform(seg)))
            .join(''),
    )
    .join('');
}

/**
 * 转换页面正文用于只读展示：
 * 页面引用 `[[target|alias]]` 变为内部链接（点击由组件拦截导航）；
 * embed、围栏、行内代码、转义原样保留。
 */
export function wikiLinksToDisplayMarkdown(content: string): string {
  if (!content.includes('[[')) return content;
  // \u0001 占位符不会出现在正常 markdown 中（no-control-regex 对占位符正则误报）
  /* eslint-disable no-control-regex */
  return transformOutsideCode(content, (text) => {
    // 转义的 \[\[ 用占位符保护
    const escaped = text
      .replace(/\\\[\\\[/g, '\u0001ESCL\u0001')
      .replace(/\\\]\\\]/g, '\u0001ESCR\u0001');
    const replaced = escaped.replace(WIKI_MARKUP_RE, (match, bang: string, rawTarget: string, rawAlias?: string) => {
      if (bang === '!') return match; // embed 原样
      const target = rawTarget.trim();
      const alias = rawAlias?.trim() ?? '';
      const label = (alias.length > 0 ? alias : target).replace(/\[/g, '\\[').replace(/\]/g, '\\]');
      return `[${label}](${WIKILINK_HREF_PREFIX}${encodeURIComponent(target)})`;
    });
    return replaced
      .replace(/\u0001ESCL\u0001/g, '\\[\\[')
      .replace(/\u0001ESCR\u0001/g, '\\]\\]');
  });
  /* eslint-enable no-control-regex */
}
