import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useKbWikiStore } from '@renderer/stores/kb-wiki';
import type { WikiCatalog, WikiCatalogAggregate, WikiCatalogPage } from '@shared/kb-types';

type Directory = {
  name: string;
  path: string;
  children: Map<string, Directory>;
  pages: Array<WikiCatalogPage | WikiCatalogAggregate>;
};

function buildTree(catalog: WikiCatalog): Directory {
  const root: Directory = { name: 'wiki', path: '', children: new Map(), pages: [] };
  const directory = (path: string): Directory => {
    let parent = root;
    for (const name of path.replace(/\\/g, '/').split('/').filter(Boolean)) {
      const key = name.toLowerCase();
      let child = parent.children.get(key);
      if (!child) {
        child = { name, path: [parent.path, name].filter(Boolean).join('/'), children: new Map(), pages: [] };
        parent.children.set(key, child);
      }
      parent = child;
    }
    return parent;
  };
  // 先创建 schema 目录，保持配置顺序和拼写，兼容 Windows 大小写差异。
  for (const dir of Object.values(catalog.typeDirs)) directory(dir);
  for (const page of [...catalog.pages, ...catalog.aggregates]) {
    const parts = page.relPath.replace(/\\/g, '/').split('/').slice(1, -1);
    directory(parts.join('/')).pages.push(page);
  }
  return root;
}

function DirectoryRow({ node, depth }: { node: Directory; depth: number }) {
  const [expanded, setExpanded] = useState(true);
  const activePageId = useKbWikiStore((s) => s.activePageId);
  const openPage = useKbWikiStore((s) => s.openPage);
  useEffect(() => {
    if (activePageId && (!node.path || activePageId.toLowerCase().startsWith(`${node.path.toLowerCase()}/`))) {
      setExpanded(true);
    }
  }, [activePageId, node.path]);
  return (
    <div data-testid={`wiki-group-${node.path}`}>
      <button
        aria-label={node.name}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        style={{ paddingLeft: 12 + depth * 16 }}
        className="flex w-full items-center gap-1.5 py-1.5 pr-3 text-left text-xs text-muted-foreground hover:bg-secondary focus-visible:outline-2 focus-visible:outline-primary"
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0', expanded && 'rotate-90')} />
        {expanded ? <FolderOpen className="h-3.5 w-3.5 shrink-0" /> : <Folder className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate">{node.name}</span>
      </button>
      {expanded && (
        <>
          {[...node.children.values()].map((child) => <DirectoryRow key={child.path} node={child} depth={depth + 1} />)}
          {node.pages.map((page) => {
            const invalid = page.kind === 'page' && !page.parse.ok;
            const label = page.kind === 'page' && page.parse.ok
              ? page.parse.frontmatter.title
              : page.relPath.replace(/\\/g, '/').split('/').at(-1);
            return (
              <button
                key={page.pageId}
                data-testid={`wiki-page-${page.pageId}`}
                aria-current={activePageId === page.pageId ? 'page' : undefined}
                onClick={() => void openPage(page.pageId)}
                title={page.kind === 'page' && !page.parse.ok ? `${page.relPath}\n${page.parse.issues.map((i) => i.message).join('\n')}` : page.relPath}
                style={{ paddingLeft: 28 + (depth + 1) * 16 }}
                className={cn(
                  'flex w-full items-center gap-1.5 py-1 pr-3 text-left text-xs hover:bg-secondary focus-visible:outline-2 focus-visible:outline-primary',
                  invalid ? 'text-destructive' : 'text-foreground',
                  activePageId === page.pageId && 'bg-secondary font-medium',
                )}
              >
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{label}</span>
                {page.kind === 'page' && page.routeMismatch && <span title="页面类型与目录不符">⚠</span>}
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}

export function KbPageTree({ catalog }: { catalog: WikiCatalog }) {
  const tree = useMemo(() => buildTree(catalog), [catalog]);
  return (
    <nav aria-label="知识页目录" className="w-60 shrink-0 overflow-y-auto border-r border-border py-2">
      <DirectoryRow node={tree} depth={0} />
      {catalog.orphans.length > 0 && (
        <div className="mt-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          <div>路由外（{catalog.orphans.length}）</div>
          {catalog.orphans.map((page) => <div key={page.relPath} className="truncate py-1" title={page.relPath}>{page.relPath}</div>)}
        </div>
      )}
    </nav>
  );
}
