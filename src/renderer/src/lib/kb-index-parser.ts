/**
 * KB index.md 解析器（渲染进程版本，纯函数，不依赖 node:fs）。
 *
 * 与 src/main/kb/indexer.ts 中的 parseIndexMd 逻辑一致，
 * 但仅包含解析逻辑，不涉及文件 I/O。
 *
 * 用于预览 Tab 中从 index.md 提取文档摘要和关键词。
 */

export type IndexEntry = {
  title: string;
  path: string;
  category: string;
  summary: string;
  keywords: string[];
};

const PATH_PREFIX = '- **路径**: `';
const SUMMARY_PREFIX = '- **摘要**: ';
const KEYWORDS_PREFIX = '- **关键词**: ';

/**
 * 解析 index.md 内容为条目列表 + 分类顺序。
 */
export function parseIndexMd(content: string): { entries: IndexEntry[]; categoryOrder: string[] } {
  const entries: IndexEntry[] = [];
  const categoryOrder: string[] = [];
  let currentCategory = '';
  let currentTitle = '';
  let currentPath = '';
  let currentSummary = '';
  let currentKeywords: string[] = [];

  function flushEntry(): void {
    if (currentTitle && currentPath) {
      entries.push({
        title: currentTitle,
        path: currentPath,
        category: currentCategory || '未分类',
        summary: currentSummary,
        keywords: currentKeywords,
      });
    }
    currentTitle = '';
    currentPath = '';
    currentSummary = '';
    currentKeywords = [];
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    const catMatch = trimmed.match(/^##\s+(.+)$/);
    if (catMatch) {
      flushEntry();
      currentCategory = catMatch[1].trim();
      if (!categoryOrder.includes(currentCategory)) {
        categoryOrder.push(currentCategory);
      }
      continue;
    }

    const titleMatch = trimmed.match(/^###\s+(.+)$/);
    if (titleMatch) {
      flushEntry();
      currentTitle = titleMatch[1].trim();
      continue;
    }

    if (trimmed.startsWith(PATH_PREFIX)) {
      currentPath = trimmed.slice(PATH_PREFIX.length, -1);
      continue;
    }

    if (trimmed.startsWith(SUMMARY_PREFIX)) {
      currentSummary = trimmed.slice(SUMMARY_PREFIX.length);
      continue;
    }

    if (trimmed.startsWith(KEYWORDS_PREFIX)) {
      const kwStr = trimmed.slice(KEYWORDS_PREFIX.length);
      currentKeywords = kwStr.split('·').map((k) => k.trim().replace(/`/g, '')).filter(Boolean);
      continue;
    }
  }
  flushEntry();

  return { entries, categoryOrder };
}
