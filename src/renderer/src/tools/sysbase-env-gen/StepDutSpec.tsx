/**
 * StepDutSpec — Step 3: DUT Spec Excel file import + template editing.
 *
 * Provides:
 *   - File path input with "导入" button (file dialog via toolsRouter.selectFiles)
 *   - "打开模板编辑" button (opens template xlsx in XlsxEditor via workbench store)
 *   - Template preview thumbnail (Architecture / MemoryMap sheet headers)
 *   - Parameter explanation callout
 *
 * Template loaded from `docs/dut_spec_template.xlsx`.
 * XlsxEditor handles requestFlush + notifyFileChanged internally.
 */

import { useState, useEffect, useCallback } from 'react';
import { FileSpreadsheet, FolderOpen, FileEdit, Info, Loader2 } from 'lucide-react';
import { useSysbaseGenStore } from '@renderer/stores/sysbase-gen';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

type TemplatePreview = {
  sheets: { name: string; headers: string[] }[];
};

export function StepDutSpec() {
  const config = useSysbaseGenStore((s) => s.config);
  const updateConfig = useSysbaseGenStore((s) => s.updateConfig);
  const openDestination = useWorkbenchStore((s) => s.open);

  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [openingTemplate, setOpeningTemplate] = useState(false);

  // Load template preview on mount
  const loadPreview = useCallback(async () => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const result = await trpc.tools.sysbaseGen.getTemplatePreview.query({ template: 'dut_spec' });
      setPreview(result);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  // Import button: open file dialog
  const handleImport = async () => {
    try {
      const result = await trpc.tools.selectFiles.mutate({
        title: '选择 DUT Spec Excel 文件',
        filters: [
          { name: 'Excel 文件', extensions: ['xlsx', 'xls'] },
        ],
      });
      if (result.paths.length > 0) {
        updateConfig({ dutSpecPath: result.paths[0] });
      }
    } catch {
      // best-effort
    }
  };

  // Open template in XlsxEditor
  const handleOpenTemplate = async () => {
    setOpeningTemplate(true);
    try {
      const result = await trpc.tools.sysbaseGen.getTemplatePath.query({ template: 'dut_spec' });
      openDestination({
        type: 'office-document',
        filePath: result.path,
        mode: 'edit',
      });
    } catch {
      // best-effort
    } finally {
      setOpeningTemplate(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Callout */}
      <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/5 p-3 text-xs text-info-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          dut_spec 包含 Architecture 和 MemoryMap 两个 sheet，描述 Subsys 的接口和内存映射信息。
          用于生成 systba VIP / sysbase BFM 组件环境。
        </span>
      </div>

      {/* File path + import + open template */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">DUT Spec 文件路径</span>
          <span className="text-destructive">*</span>
          <span className="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-x</span>
        </div>
        <div className="flex gap-1">
          <input
            type="text"
            value={config.dutSpecPath}
            onChange={(e) => updateConfig({ dutSpecPath: e.target.value })}
            placeholder="选择或导入 Excel 文件..."
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
          <button
            onClick={handleImport}
            className="flex items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            导入
          </button>
          <button
            onClick={handleOpenTemplate}
            disabled={openingTemplate}
            className={cn(
              'flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 text-xs text-primary transition-colors hover:bg-primary/20',
              'disabled:opacity-50',
            )}
          >
            {openingTemplate ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileEdit className="h-3.5 w-3.5" />
            )}
            打开模板编辑
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          支持 .xlsx / .xls 格式。点击「打开模板编辑」可在应用内直接编辑空白模板
        </p>
      </div>

      {/* Template preview thumbnail */}
      <div className="overflow-hidden rounded-md border border-border">
        <div className="flex items-center justify-between border-b bg-secondary/30 px-3 py-1.5">
          <span className="text-[11px] font-semibold">模板预览 · dut_spec_template.xlsx</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {preview ? `${preview.sheets.length} sheets` : '...'}
          </span>
        </div>
        <div className="p-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
          {previewLoading && (
            <div className="flex items-center gap-2 py-2 text-xs">
              <Loader2 className="h-3 w-3 animate-spin" />
              加载模板预览...
            </div>
          )}
          {previewError && (
            <div className="py-2 text-xs text-destructive">
              模板预览加载失败: {previewError}
            </div>
          )}
          {preview && !previewLoading && !previewError && (
            <>
              {preview.sheets.map((sheet, i) => (
                <div key={sheet.name}>
                  <div className="mb-1 text-primary">
                    Sheet {i + 1}: {sheet.name}
                  </div>
                  <div className="mb-2 truncate">
                    {sheet.headers.length > 0
                      ? sheet.headers.join(' | ')
                      : '(空 sheet)'}
                    {sheet.headers.length > 0 && ' | ...'}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Selected file indicator */}
      {config.dutSpecPath && (
        <div className="flex items-center gap-2 rounded-md border border-status-pass/20 bg-status-pass/5 px-3 py-1.5 text-xs">
          <FileSpreadsheet className="h-3.5 w-3.5 text-status-pass-foreground" />
          <span className="truncate font-mono">{config.dutSpecPath}</span>
        </div>
      )}
    </div>
  );
}
