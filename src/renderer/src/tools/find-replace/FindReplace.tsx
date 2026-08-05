/**
 * FindReplace — file text search and batch replace tool.
 *
 * Ported from the Python `find_and_replace` plugin.
 * Features: directory selection, plain text / regex search, batch replace
 * with undo support, file extension filtering.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { FolderOpen, Search, Replace, Undo2, Trash2 } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';

type SearchMatch = {
  filePath: string;
  line: number;
  context: string[];
  matchedLine: number;
};

export function FindReplace({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [directory, setDirectory] = useState(projectRoot ?? '');
  const [searchText, setSearchText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [fileExts, setFileExts] = useState('.v;.sv;.svh;.svi');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Update directory when projectRoot changes
  useEffect(() => {
    if (projectRoot && !directory) {
      setDirectory(projectRoot);
    }
  }, [projectRoot]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log]);

  // Check undo state
  useEffect(() => {
    trpc.tools.findReplace.canUndo.query().then((res) => setCanUndo(res.canUndo)).catch(() => {});
  }, []);

  const addLog = useCallback((msg: string) => {
    setLog((prev) => [...prev, msg]);
  }, []);

  const handleBrowse = useCallback(async () => {
    const res = await trpc.tools.selectDirectory.mutate({
      title: '选择目录',
      defaultPath: directory || undefined,
    });
    if (res.path) {
      setDirectory(res.path);
      onProjectRootChange(res.path);
    }
  }, [directory, onProjectRootChange]);

  const handleSearch = useCallback(async () => {
    if (!directory || !searchText) {
      addLog('请先选择目录并输入查找内容');
      return;
    }
    setSearching(true);
    setMatches([]);
    addLog(`开始在目录 ${directory} 中查找: ${searchText}`);

    const extensions = fileExts.split(';').map((e) => e.trim()).filter(Boolean);
    try {
      const res = await trpc.tools.findReplace.search.mutate({
        directory,
        searchText,
        useRegex,
        extensions,
      });
      setMatches(res.matches);
      addLog(`查找完成，找到 ${res.matches.length} 处匹配`);
    } catch (err) {
      addLog(`查找出错: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSearching(false);
    }
  }, [directory, searchText, useRegex, fileExts, addLog]);

  const handleReplace = useCallback(async () => {
    if (!directory || !searchText) {
      addLog('请先选择目录并输入查找和替换内容');
      return;
    }
    setReplacing(true);
    addLog(`开始替换: ${searchText} → ${replaceText || '(空)'}`);

    const extensions = fileExts.split(';').map((e) => e.trim()).filter(Boolean);
    try {
      const res = await trpc.tools.findReplace.replace.mutate({
        directory,
        searchText,
        replaceText,
        useRegex,
        extensions,
      });
      addLog(`成功替换了 ${res.count} 个文件`);
      setCanUndo(true);
    } catch (err) {
      addLog(`替换出错: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReplacing(false);
    }
  }, [directory, searchText, replaceText, useRegex, fileExts, addLog]);

  const handleUndo = useCallback(async () => {
    try {
      const res = await trpc.tools.findReplace.undo.mutate();
      addLog(`已撤销 ${res.count} 个文件的替换操作`);
      setCanUndo(res.canUndoMore);
    } catch (err) {
      addLog(`撤销出错: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [addLog]);

  const handleClearLog = useCallback(() => {
    setLog([]);
  }, []);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* ── Directory + search/replace inputs ── */}
      <div className="space-y-2 rounded border border-border p-3">
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-xs text-muted-foreground">目录:</span>
          <input
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
            placeholder="选择或输入目录路径..."
          />
          <button
            onClick={handleBrowse}
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
          >
            <FolderOpen className="h-3 w-3" /> 浏览
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-xs text-muted-foreground">查找:</span>
          <input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
            placeholder="输入查找内容..."
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-xs text-muted-foreground">替换:</span>
          <input
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
            placeholder="输入替换内容..."
          />
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={useRegex}
              onChange={(e) => setUseRegex(e.target.checked)}
              className="h-3 w-3"
            />
            使用正则表达式
          </label>
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">文件后缀:</span>
            <input
              value={fileExts}
              onChange={(e) => setFileExts(e.target.value)}
              className="w-40 rounded border border-border bg-background px-2 py-0.5 text-xs"
              placeholder=".v;.sv"
            />
          </div>
        </div>
      </div>

      {/* ── Action buttons ── */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleSearch}
          disabled={searching || !directory || !searchText}
          className="flex items-center gap-1 rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
        >
          <Search className="h-3 w-3" /> {searching ? '查找中' : '查找'}
        </button>
        <button
          onClick={handleReplace}
          disabled={replacing || !directory || !searchText}
          className="flex items-center gap-1 rounded bg-green-600 px-3 py-1 text-xs text-white disabled:opacity-50"
        >
          <Replace className="h-3 w-3" /> {replacing ? '替换中' : '替换'}
        </button>
        <button
          onClick={handleUndo}
          disabled={!canUndo}
          className="flex items-center gap-1 rounded bg-yellow-600 px-3 py-1 text-xs text-white disabled:opacity-50"
        >
          <Undo2 className="h-3 w-3" /> 撤销
        </button>
      </div>

      {/* ── Results: matches + log ── */}
      <div className="flex min-h-0 flex-1 gap-3">
        {/* Match results */}
        <div className="min-w-0 flex-1 overflow-auto rounded border border-border">
          {matches.length > 0 ? (
            <div className="divide-y divide-border">
              {matches.map((match, i) => (
                <div key={i} className="px-3 py-2 hover:bg-accent">
                  <div className="text-xs font-medium">
                    {match.filePath}:{match.line}
                  </div>
                  <pre className="mt-1 overflow-x-auto text-[11px] font-mono text-muted-foreground">
                    {match.context.map((line, j) => (
                      <div
                        key={j}
                        className={cn(
                          j === match.matchedLine && 'bg-yellow-500/20 font-bold text-foreground',
                        )}
                      >
                        {j === match.matchedLine ? '> ' : '  '}
                        {line}
                      </div>
                    ))}
                  </pre>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {searching ? '查找中...' : '暂无匹配结果'}
            </div>
          )}
        </div>

        {/* Log */}
        <div className="flex w-72 flex-col">
          <div className="flex items-center justify-between pb-1">
            <span className="text-xs font-medium text-muted-foreground">日志</span>
            <button
              onClick={handleClearLog}
              className="flex items-center gap-1 rounded px-1 py-0.5 text-xs hover:bg-accent"
            >
              <Trash2 className="h-3 w-3" /> 清空
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto rounded border border-border bg-zinc-900 p-2 font-mono text-[11px] text-green-400">
            {log.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
