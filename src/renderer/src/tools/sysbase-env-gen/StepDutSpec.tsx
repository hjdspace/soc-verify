/**
 * StepDutSpec — Step 3: DUT Spec Excel file import + template generation.
 *
 * Provides:
 *   - File path input with "导入" button (file dialog via toolsRouter.selectFiles)
 *   - "生成模板" button — generates dut_spec xlsx from markdown-defined structure
 *     (replaces the old static template file approach)
 *   - Template preview thumbnail (Architecture / MemoryMap sheet headers)
 *   - Parameter explanation callout
 *
 * The template is generated on-the-fly from the code-defined structure in
 * `dut-spec-template.ts`, which mirrors the markdown format in the flow doc.
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
  const [generating, setGenerating] = useState(false);

  // Load template preview from generated structure
  const loadPreview = useCallback(async () => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const result = await trpc.tools.sysbaseGen.getDutSpecGeneratedPreview.query();
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

  // Generate template: create xlsx from markdown-defined structure
  const handleGenerateTemplate = async () => {
    setGenerating(true);
    try {
      const result = await trpc.tools.sysbaseGen.generateDutSpecTemplate.mutate({
        subsysName: config.subsys || undefined,
      });
      if (result.path) {
        updateConfig({ dutSpecPath: result.path });
        // Also open it in the XlsxEditor for immediate editing
        openDestination({
          type: 'office-document',
          filePath: result.path,
          mode: 'edit',
        });
      }
    } catch {
      // best-effort
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Callout */}
      <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/5 p-3 text-xs text-info-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          DUT Spec Excel 记录 IP 列表、协议、位宽、master/slave 关系等信息。
          包含两个 sheet：Architecture（AXI/AHB/APB/POWER/CLKRST）和 MemoryMap。
          点击「生成模板」可基于内置格式自动生成空白模板供填写。
        </span>
      </div>

      {/* File path + import + generate template */}
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
            placeholder="选择或生成 Excel 文件..."
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
          <button
            onClick={handleImport}
            title="导入已有 Excel 文件"
            className="flex items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            导入
          </button>
          <button
            onClick={() => void handleGenerateTemplate()}
            disabled={generating}
            title="生成空白模板（基于内置格式）"
            className={cn(
              'flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 text-xs text-primary transition-colors hover:bg-primary/20',
              'disabled:opacity-50',
            )}
          >
            {generating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileEdit className="h-3.5 w-3.5" />
            )}
            生成模板
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          点击「生成模板」自动生成空白 dut_spec 模板并打开编辑
        </p>
      </div>

      {/* Template preview */}
      <div className="overflow-hidden rounded-md border border-border">
        <div className="flex items-center justify-between border-b bg-secondary/30 px-3 py-1.5">
          <span className="text-[11px] font-semibold">模板结构预览</span>
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
