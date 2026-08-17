/**
 * StepCsv — Step 3 for top-level: CSV file for subsys domain + core name info (-c).
 *
 * The CSV file contains the list of subsys names and their core master info.
 * Format:
 *   "Subsys_Name","Core_Name_1","Core_Name_2","Core_Name_3","Core_Name_4","Core_Name_5"
 *   "aon_sys","SP_CMSTAR_C(AHB)","AON_SP(AHB)",,,
 *   ...
 *
 * Provides:
 *   - Import: file dialog to select an existing CSV file
 *   - Edit Template: creates a fixed-name CSV template and opens it for editing
 *   - Export: save the current CSV template to a user-chosen path
 *   - Editable CSV preview table (cells are editable inputs, changes saved back)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { FileText, FolderOpen, FileEdit, Download, Info, CheckCircle2, Save } from 'lucide-react';
import { useSysbaseGenStore } from '@renderer/stores/sysbase-gen';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

/** Default CSV template content (from the flow doc). */
const DEFAULT_CSV_TEMPLATE = `"Subsys_Name","Core_Name_1","Core_Name_2","Core_Name_3","Core_Name_4","Core_Name_5"
"aon_sys","SP_CMSTAR_C(AHB)","AON_SP(AHB)",,,
"ap_sys","DMA(AXI)","UFS(AXI)","CE(APB)",,
"apcpu_sys","APCPU(AXI)","APCPU_1(AXI)",,,
"camera_sys","CMCU_AXI(AXI)",,,,,
"dpu_sys","DPU0_CORE0(AXI)","DPU0_CORE1(AXI)","DPU_LITE0(AXI)","DPU_LITE1(AXI)",
"vpu_sys","VPU_CODECO(AXI)","VPU_CODEC1(AXI)",,,,
"gpu_sys","KRAKE(AXI)",,,,,
"lpach_sys","HIFI4(AXI)","HIFI4_I(AXI)","CM55(AXI)",,
"dbg_sys","DAP(AXI)",,,,,
"ai_sys","POWERVR(AXI)","VDSP_MST(AXI)",,,,
"pub_sys",,,,,,
"pcie_sys","PCIE0(AXI)","PCIE1(AXI)",,,
`;

/** Fixed temp file name for CSV template (no timestamp to avoid changing on each click). */
const CSV_TEMPLATE_FILENAME = 'soc-verify-top-csv-template.csv';

/** Parse CSV content into rows for preview. */
function parseCsvPreview(csv: string): string[][] {
  return csv
    .trim()
    .split('\n')
    .map((line) => {
      // Simple CSV parse: split by comma, strip surrounding quotes
      return line
        .split(',')
        .map((cell) => cell.trim().replace(/^"|"$/g, ''));
    });
}

/** Serialize rows back into CSV content with quoting. */
function serializeCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          // Quote cells that contain commas or special chars
          if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
            return `"${cell.replace(/"/g, '""')}"`;
          }
          // Keep empty cells as empty (no quotes) to match original format
          return cell;
        })
        .join(',')
    )
    .join('\n') + '\n';
}

export function StepCsv() {
  const config = useSysbaseGenStore((s) => s.config);
  const updateConfig = useSysbaseGenStore((s) => s.updateConfig);

  const [csvData, setCsvData] = useState<string[][]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load CSV data when csvPath changes
  const loadCsvPreview = useCallback(async (path: string) => {
    if (!path) {
      setCsvData([]);
      return;
    }
    try {
      const result = await trpc.tools.sysbaseGen.readCsvFile.query({ path });
      setCsvData(parseCsvPreview(result.content));
      setDirty(false);
    } catch {
      setCsvData([]);
    }
  }, []);

  useEffect(() => {
    void loadCsvPreview(config.csvPath);
  }, [config.csvPath, loadCsvPreview]);

  // Cleanup any pending save timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  // Import: open file dialog
  const handleImport = async () => {
    try {
      const result = await trpc.tools.selectFiles.mutate({
        title: '选择 Top CSV 文件',
        filters: [
          { name: 'CSV 文件', extensions: ['csv'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.paths.length > 0) {
        updateConfig({ csvPath: result.paths[0] });
      }
    } catch {
      // best-effort
    }
  };

  // Edit Template: create a fixed-name CSV template and open it
  const handleEditTemplate = async () => {
    try {
      const result = await trpc.tools.sysbaseGen.createCsvTemplate.mutate({
        content: DEFAULT_CSV_TEMPLATE,
        filename: CSV_TEMPLATE_FILENAME,
      });
      if (result.path) {
        updateConfig({ csvPath: result.path });
      }
    } catch {
      // best-effort
    }
  };

  // Export: save the template to a user-chosen path
  const handleExport = async () => {
    try {
      const result = await trpc.tools.saveFileDialog.mutate({
        title: '导出 Top CSV 模板',
        defaultPath: 'top.csv',
        filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
      });
      if (result.path) {
        const content = csvData.length > 0 ? serializeCsv(csvData) : DEFAULT_CSV_TEMPLATE;
        await trpc.tools.sysbaseGen.writeCsvFile.mutate({
          path: result.path,
          content,
        });
        updateConfig({ csvPath: result.path });
      }
    } catch {
      // best-effort
    }
  };

  // Save CSV content back to file (debounced auto-save)
  const saveCsv = useCallback(async (data: string[][]) => {
    if (!config.csvPath) return;
    setSaving(true);
    try {
      const content = serializeCsv(data);
      await trpc.tools.sysbaseGen.writeCsvFile.mutate({
        path: config.csvPath,
        content,
      });
      setDirty(false);
    } catch {
      // best-effort
    } finally {
      setSaving(false);
    }
  }, [config.csvPath]);

  // Handle cell edit
  const handleCellEdit = (rowIdx: number, colIdx: number, value: string) => {
    const newData = csvData.map((row, ri) =>
      ri === rowIdx
        ? row.map((cell, ci) => (ci === colIdx ? value : cell))
        : row
    );
    setCsvData(newData);
    setDirty(true);

    // Debounced auto-save
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      void saveCsv(newData);
    }, 1000);
  };

  // Add a new row
  const handleAddRow = () => {
    const colCount = csvData[0]?.length ?? 6;
    const newRow = new Array(colCount).fill('');
    const newData = [...csvData, newRow];
    setCsvData(newData);
    setDirty(true);
    // Save immediately for structural changes
    void saveCsv(newData);
  };

  return (
    <div className="space-y-4">
      {/* Callout */}
      <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/5 p-3 text-xs text-info-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          CSV 文件包含 chip 下所有 subsys domain 的名字和 core name 信息，
          用于生成 subsys2top 的相关环境。首列为 subsys name，后续列为
          core name（格式：<code className="font-mono">core_name(amba_protocol)</code>）。
          下方预览表格可直接编辑，修改后自动保存。
        </span>
      </div>

      {/* File path + import + edit template + export */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">Top CSV 文件路径</span>
          <span className="text-destructive">*</span>
          <span className="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-c</span>
        </div>
        <div className="flex gap-1">
          <input
            type="text"
            value={config.csvPath}
            onChange={(e) => updateConfig({ csvPath: e.target.value })}
            placeholder="选择或导入 CSV 文件..."
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
          <button
            onClick={handleImport}
            title="导入已有 CSV 文件"
            className="flex items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            导入
          </button>
          <button
            onClick={handleEditTemplate}
            title="生成模板 CSV 并打开编辑"
            className={cn(
              'flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 text-xs text-primary transition-colors hover:bg-primary/20',
            )}
          >
            <FileEdit className="h-3.5 w-3.5" />
            编辑模板
          </button>
          <button
            onClick={handleExport}
            title="导出模板 CSV 到指定路径"
            className="flex items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" />
            导出
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          点击「编辑模板」生成默认 CSV 模板并使用，或点击「导入」选择已有 CSV 文件
        </p>
      </div>

      {/* Editable CSV preview */}
      {csvData.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border">
          <div className="flex items-center justify-between border-b bg-secondary/30 px-3 py-1.5">
            <div className="flex items-center gap-1.5">
              <FileText className="h-3 w-3 text-muted-foreground" />
              <span className="text-[11px] font-semibold">CSV 预览（可编辑）</span>
              {dirty && (
                <span className="text-[10px] text-warning-foreground">未保存</span>
              )}
              {saving && (
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Save className="h-2.5 w-2.5 animate-pulse" />
                  保存中...
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void saveCsv(csvData)}
                disabled={saving || !dirty}
                className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
              >
                <Save className="h-2.5 w-2.5" />
                保存
              </button>
              <button
                onClick={handleAddRow}
                className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                + 添加行
              </button>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {csvData.length} 行
              </span>
            </div>
          </div>
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-left text-[10px]">
              <thead className="sticky top-0 bg-secondary/20">
                <tr>
                  {csvData[0]?.map((header, i) => (
                    <th
                      key={i}
                      className="border-b border-border px-2 py-1 font-medium text-muted-foreground"
                    >
                      {header || `Col ${i}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {csvData.slice(1).map((row, ri) => (
                  <tr key={ri} className="border-b border-border/30">
                    {row.map((cell, ci) => (
                      <td key={ci} className="px-1 py-0.5">
                        <input
                          type="text"
                          value={cell}
                          onChange={(e) => handleCellEdit(ri + 1, ci, e.target.value)}
                          placeholder="—"
                          className={cn(
                            'w-full bg-transparent px-1 py-0.5 font-mono text-[10px]',
                            'focus:outline-none focus:rounded focus:bg-accent/30 focus:ring-1 focus:ring-primary',
                            cell === '' && 'text-muted-foreground/30',
                          )}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Selected file indicator */}
      {config.csvPath && (
        <div className="flex items-center gap-2 rounded-md border border-status-pass/20 bg-status-pass/5 px-3 py-1.5 text-xs">
          <CheckCircle2 className="h-3.5 w-3.5 text-status-pass-foreground" />
          <span className="truncate font-mono">{config.csvPath}</span>
        </div>
      )}
    </div>
  );
}
