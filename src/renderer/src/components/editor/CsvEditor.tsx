/**
 * CsvEditor — CSV 文件表格预览/编辑组件。
 *
 * 以可编辑表格方式打开 CSV 文件：
 *   - 加载文件内容并解析为二维数组（支持引号包裹的字段，含逗号/换行/引号转义）
 *   - 第一行渲染为表头（可编辑）
 *   - 每个单元格为 <input>，实时编辑
 *   - 添加行/列、删除行
 *   - 保存时将二维数组序列化回 CSV 格式，调用 trpc.project.writeFile
 *
 * 解析/序列化逻辑提取为独立纯函数 parseCsv / serializeCsv，便于后续复用和测试。
 */

import { useState, useEffect, useCallback } from 'react';
import { Save, Loader2, AlertCircle, Plus, Trash2, Table as TableIcon } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { useThemeStore } from '@renderer/stores/theme';
import { cn } from '@renderer/lib/utils';
import { Breadcrumb } from './Breadcrumb';

// ── CSV 解析 / 序列化 ──────────────────────────────────────────

/**
 * Parse CSV content into a 2D array of strings.
 *
 * Handles:
 *   - Quoted fields with embedded commas
 *   - Quoted fields with embedded newlines
 *   - Escaped double quotes ("") inside quoted fields
 *   - Empty lines (skipped)
 *
 * Follows RFC 4180 semantics with a permissive state machine.
 */
export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  while (i < csv.length) {
    const char = csv[i];

    if (inQuotes) {
      if (char === '"') {
        // Check for escaped quote
        if (csv[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        }
        // End of quoted field
        inQuotes = false;
        i++;
        continue;
      }
      currentField += char;
      i++;
      continue;
    }

    // Not in quotes
    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (char === ',') {
      currentRow.push(currentField);
      currentField = '';
      i++;
      continue;
    }

    if (char === '\r') {
      // Handle CRLF
      if (csv[i + 1] === '\n') {
        i++;
      }
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = '';
      i++;
      continue;
    }

    if (char === '\n') {
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = '';
      i++;
      continue;
    }

    currentField += char;
    i++;
  }

  // Push last field and row if there's any remaining content
  if (currentField !== '' || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  // Filter out completely empty rows (from trailing newlines)
  return rows.filter((row) => row.length > 1 || (row.length === 1 && row[0] !== ''));
}

/**
 * Serialize a 2D array back into CSV content.
 *
 * - Fields containing commas, quotes, or newlines are quoted
 * - Double quotes inside fields are escaped as ""
 * - Always ends with a trailing newline
 */
export function serializeCsv(rows: string[][]): string {
  return (
    rows
      .map((row) =>
        row
          .map((cell) => {
            if (cell.includes(',') || cell.includes('"') || cell.includes('\n') || cell.includes('\r')) {
              return `"${cell.replace(/"/g, '""')}"`;
            }
            return cell;
          })
          .join(','),
      )
      .join('\n') + '\n'
  );
}

// ── Component ─────────────────────────────────────────────────

interface CsvEditorProps {
  projectId: string;
  filePath: string;
  fileName: string;
}

export function CsvEditor({ projectId, filePath, fileName }: CsvEditorProps) {
  const [data, setData] = useState<string[][]>([]);
  const [originalData, setOriginalData] = useState<string[][]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const currentTheme = useThemeStore((s) => s.currentTheme);
  const themes = useThemeStore((s) => s.themes);
  const themeMode = themes.find((t) => t.id === currentTheme)?.mode ?? 'dark';

  // ── Load file ───────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSaveError(null);
    trpc.project.readFile
      .query({ projectId, filePath })
      .then((content) => {
        if (cancelled) return;
        const parsed = parseCsv(content);
        setData(parsed);
        setOriginalData(parsed);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setSaveError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, filePath]);

  // ── Dirty check ─────────────────────────────────────────────

  const isDirty = data.length !== originalData.length ||
    data.some((row, r) =>
      row.length !== originalData[r]?.length ||
      row.some((cell, c) => cell !== originalData[r]?.[c]),
    );

  // ── Cell editing ────────────────────────────────────────────

  const updateCell = useCallback((rowIdx: number, colIdx: number, value: string) => {
    setData((prev) => {
      const next = prev.map((row) => [...row]);
      if (next[rowIdx]) {
        next[rowIdx][colIdx] = value;
      }
      return next;
    });
  }, []);

  // ── Add / delete rows ──────────────────────────────────────

  const addRow = useCallback(() => {
    setData((prev) => {
      const colCount = prev.length > 0 ? prev[0].length : 1;
      return [...prev, new Array(colCount).fill('')];
    });
  }, []);

  const deleteRow = useCallback((rowIdx: number) => {
    setData((prev) => prev.filter((_, idx) => idx !== rowIdx));
  }, []);

  // ── Add column ──────────────────────────────────────────────

  const addColumn = useCallback(() => {
    setData((prev) => {
      if (prev.length === 0) {
        return [['']];
      }
      return prev.map((row) => [...row, '']);
    });
  }, []);

  // ── Save ────────────────────────────────────────────────────

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!isDirty || saving) return false;
    setSaving(true);
    setSaveError(null);
    try {
      const content = serializeCsv(data);
      await trpc.project.writeFile.mutate({ projectId, filePath, content });
      setOriginalData(data.map((row) => [...row]));
      return true;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [projectId, filePath, data, isDirty, saving]);

  // ── Ctrl+S ──────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave]);

  // ── Render ──────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载中...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden" data-theme={themeMode}>
      {/* 工具栏 */}
      <div className="flex items-center justify-between border-b bg-secondary/20 px-3 py-1">
        <Breadcrumb filePath={filePath} />
        <div className="flex items-center gap-2">
          {isDirty && (
            <span className="text-[10px] text-status-aborted-foreground">● 已修改</span>
          )}
          {saveError && (
            <span className="flex items-center gap-0.5 text-[10px] text-status-fail-foreground" title={saveError}>
              <AlertCircle className="h-2.5 w-2.5" />
              保存失败
            </span>
          )}
          <button
            onClick={addRow}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="添加行"
          >
            <Plus className="h-3 w-3" />
            添加行
          </button>
          <button
            onClick={addColumn}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="添加列"
          >
            <Plus className="h-3 w-3 rotate-90" />
            添加列
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={!isDirty || saving}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-0.5 text-[10px] transition-colors',
              isDirty && !saving
                ? 'bg-primary/10 text-primary hover:bg-primary/20'
                : 'cursor-not-allowed text-muted-foreground opacity-50',
            )}
            title="保存 (Ctrl+S)"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            保存
          </button>
        </div>
      </div>

      {/* 表格区域 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {data.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            <TableIcon className="mr-2 h-4 w-4 opacity-40" />
            空表格 — 点击「添加行」开始编辑
          </div>
        ) : (
          <table className="border-collapse text-xs">
            <tbody>
              {data.map((row, rowIdx) => (
                <tr key={rowIdx} className="border-b border-border/50">
                  {/* 行号 / 删除按钮列 */}
                  <td className="sticky left-0 z-10 w-8 border-r border-border/50 bg-secondary/30 px-1 py-0.5 text-center text-[10px] text-muted-foreground">
                    {rowIdx === 0 ? (
                      <span className="font-semibold">#</span>
                    ) : (
                      <button
                        onClick={() => deleteRow(rowIdx)}
                        className="rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-status-fail-foreground"
                        title="删除行"
                      >
                        <Trash2 className="h-2.5 w-2.5" />
                      </button>
                    )}
                  </td>
                  {row.map((cell, colIdx) => (
                    <td key={colIdx} className="border-r border-border/50 p-0">
                      <input
                        type="text"
                        value={cell}
                        onChange={(e) => updateCell(rowIdx, colIdx, e.target.value)}
                        className={cn(
                          'w-32 min-w-[80px] bg-transparent px-2 py-1 text-xs outline-none',
                          rowIdx === 0
                            ? 'bg-secondary/20 font-semibold text-foreground'
                            : 'text-muted-foreground',
                          'focus:bg-primary/10 focus:text-foreground',
                        )}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 底部状态栏 */}
      <div className="flex shrink-0 items-center justify-between border-t bg-secondary/20 px-3 py-0.5 text-[10px] text-muted-foreground">
        <span>{fileName}</span>
        <span>
          {data.length} 行 × {data.length > 0 ? data[0].length : 0} 列
          {isDirty ? ' · 已修改' : ' · 已保存'}
        </span>
      </div>
    </div>
  );
}
