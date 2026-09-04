import {
  parseOmpEditResult,
} from '@renderer/components/chat/tool-helpers';
import { ClickablePathHeader } from '../shared/ClickablePathHeader';
import { CodeHighlight } from '../shared/CodeHighlight';

/** Render omp edit tool result: shows post-edit file content + warnings. */
export function OmpEditResultView({ resultText, language }: { resultText: string; language: string }) {
  const { filePath, contentLines, warnings } = parseOmpEditResult(resultText);
  return (
    <div className="text-[11px] leading-relaxed">
      {filePath && <ClickablePathHeader filePath={filePath} />}
      {contentLines.length > 0 && (
        <div className="max-h-80 overflow-auto">
          {contentLines.map((line, i) => (
            <div key={i} className="flex">
              <span className="w-10 shrink-0 select-none border-r border-border/30 pr-1 text-right text-[10px] text-muted-foreground/40">
                {line.lineNum || '\u00A0'}
              </span>
              <span className="flex-1 overflow-x-auto px-2 text-muted-foreground">
                <CodeHighlight code={line.content || '\u00A0'} language={language} />
              </span>
            </div>
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="border-t border-warning/30 bg-warning/5 px-2.5 py-1">
          <div className="text-[9px] font-semibold uppercase tracking-[0.06em] text-warning-foreground">Warnings</div>
          {warnings.map((w, i) => (
            <div key={i} className="text-[10px] text-warning-foreground/80">{w}</div>
          ))}
        </div>
      )}
      {contentLines.length === 0 && warnings.length === 0 && (
        <pre className="max-h-48 overflow-auto px-2.5 py-1 text-[10px] text-muted-foreground">{resultText}</pre>
      )}
    </div>
  );
}
