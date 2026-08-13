/**
 * StepMini — Step 4: Mini Case Excel file import + template editing.
 *
 * Provides:
 *   - File path input with "导入" button (file dialog via toolsRouter.selectFiles)
 *   - "打开模板编辑" button (opens template xlsx in XlsxEditor via workbench store)
 *   - Parameter explanation callout
 *
 * Template loaded from `docs/sysbase_mini_case_template.xlsx`.
 * XlsxEditor handles requestFlush + notifyFileChanged internally.
 */

import { useState } from 'react';
import { FileSpreadsheet, FolderOpen, FileEdit, Info, Loader2, CheckCircle } from 'lucide-react';
import { useSysbaseGenStore } from '@renderer/stores/sysbase-gen';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

export function StepMini() {
  const config = useSysbaseGenStore((s) => s.config);
  const updateConfig = useSysbaseGenStore((s) => s.updateConfig);
  const openDestination = useWorkbenchStore((s) => s.open);

  const [openingTemplate, setOpeningTemplate] = useState(false);
  const [templatePath, setTemplatePath] = useState<string | null>(null);

  // Import button: open file dialog
  const handleImport = async () => {
    try {
      const result = await trpc.tools.selectFiles.mutate({
        title: '选择 Mini Case Excel 文件',
        filters: [
          { name: 'Excel 文件', extensions: ['xlsx', 'xls'] },
        ],
      });
      if (result.paths.length > 0) {
        updateConfig({ miniExcelPath: result.paths[0] });
      }
    } catch {
      // best-effort
    }
  };

  // Open template in XlsxEditor
  const handleOpenTemplate = async () => {
    setOpeningTemplate(true);
    try {
      const result = await trpc.tools.sysbaseGen.getTemplatePath.query({ template: 'mini' });
      setTemplatePath(result.path);
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

  // Use the template file as the Mini Excel input
  const handleUseTemplate = async () => {
    try {
      const path = templatePath ?? (await trpc.tools.sysbaseGen.getTemplatePath.query({ template: 'mini' })).path;
      updateConfig({ miniExcelPath: path });
    } catch {
      // best-effort
    }
  };

  return (
    <div className="space-y-4">
      {/* Callout */}
      <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/5 p-3 text-xs text-info-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          mini_excel 用于生成提供给 ipsocv 的相关环境。
          示例文件名：sysbase_mini_case_apcpu.xlsx
        </span>
      </div>

      {/* File path + import + open template */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">Mini Excel 文件路径</span>
          <span className="text-destructive">*</span>
          <span className="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-mini</span>
        </div>
        <div className="flex gap-1">
          <input
            type="text"
            value={config.miniExcelPath}
            onChange={(e) => updateConfig({ miniExcelPath: e.target.value })}
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
          支持 .xlsx / .xls 格式。点击「打开模板编辑」可在应用内直接编辑模板，
          编辑完成后点击「使用此模板」将其作为 Mini Excel 输入，或在编辑器中「另存为」后用「导入」选择
        </p>
      </div>

      {/* Use template button */}
      {templatePath && (
        <button
          onClick={() => void handleUseTemplate()}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-status-pass/30 bg-status-pass/5 px-3 py-1.5 text-xs text-status-pass-foreground transition-colors hover:bg-status-pass/10"
        >
          <CheckCircle className="h-3.5 w-3.5" />
          使用此模板作为 Mini Excel 输入
        </button>
      )}

      {/* Selected file indicator */}
      {config.miniExcelPath && (
        <div className="flex items-center gap-2 rounded-md border border-status-pass/20 bg-status-pass/5 px-3 py-1.5 text-xs">
          <FileSpreadsheet className="h-3.5 w-3.5 text-status-pass-foreground" />
          <span className="truncate font-mono">{config.miniExcelPath}</span>
        </div>
      )}
    </div>
  );
}
