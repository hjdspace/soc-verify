import { useState } from 'react';
import {
  argStr,
  argVal,
  detectLanguage,
  isDirectoryToolResult,
} from '@renderer/components/chat/tool-helpers';
import { ClickablePathHeader } from '../shared/ClickablePathHeader';
import { CopyButton } from '../shared/CopyButton';
import { CodeHighlight } from '../shared/CodeHighlight';

/** 聊天内 read 行数帽（DSH §6.3：head 4 + tail 4） */
const READ_CAP = 8;

export function ReadBody({ args, resultText, toolResult }: { args: unknown; resultText: string; toolResult?: unknown }) {
  const offset = typeof argVal(args, 'offset') === 'number' ? (argVal(args, 'offset') as number) : 1;
  const filePath = argStr(args, 'path', 'file_path') ?? '';
  const language = detectLanguage(filePath);
  // 当读取目标是目录时（omp read 返回目录列表，或 EISDIR 错误），路径不可点击
  const isDirError = /EISDIR/i.test(resultText) || isDirectoryToolResult(toolResult);

  const [showAll, setShowAll] = useState(false);
  const lines = resultText.split('\n');
  const capped = !showAll && lines.length > READ_CAP;
  const headCount = capped ? Math.ceil(READ_CAP / 2) : 0;
  const tailCount = capped ? READ_CAP - headCount : 0;

  const rows: Array<{ text: string; lineNo: number }> = [];
  if (capped) {
    for (let i = 0; i < headCount; i++) rows.push({ text: lines[i], lineNo: offset + i });
    for (let i = lines.length - tailCount; i < lines.length; i++) rows.push({ text: lines[i], lineNo: offset + i });
  } else {
    for (let i = 0; i < lines.length; i++) rows.push({ text: lines[i], lineNo: offset + i });
  }

  return (
    <div className="overflow-hidden rounded-lg font-mono text-[11px] leading-relaxed">
      {filePath && <ClickablePathHeader filePath={filePath} clickable={!isDirError} />}
      {(capped || showAll) && (
        <div className="ap-banner-min flex items-center justify-between">
          <span>显示 {rows.length} / {lines.length} 行</span>
          <CopyButton text={resultText} />
        </div>
      )}
      <div className="max-h-80 overflow-auto py-1">
        {rows.map((row, i) => (
          <div key={i} className="flex whitespace-pre">
            <span className="ap-rn w-7">{row.lineNo}</span>
            <span className="min-w-0 flex-1 overflow-x-auto pr-2">
              <CodeHighlight code={row.text || '\u00A0'} language={language} />
            </span>
          </div>
        ))}
      </div>
      {capped && (
        <button
          onClick={(e) => { e.stopPropagation(); setShowAll(true); }}
          className="w-full border-t border-[var(--dsw-border-l1)] py-0.5 text-center text-[10px] text-primary hover:bg-[var(--dsw-hover-bg)]"
        >
          … 其余 {lines.length - READ_CAP} 行
        </button>
      )}
    </div>
  );
}
