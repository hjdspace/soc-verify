import {
  argStr,
  detectLanguage,
} from '@renderer/components/chat/tool-helpers';
import { ClickablePathHeader } from '../shared/ClickablePathHeader';
import { CodeHighlight } from '../shared/CodeHighlight';

export function WriteBody({ args, resultText }: { args: unknown; resultText: string }) {
  const content = argStr(args, 'content') ?? resultText;
  const filePath = argStr(args, 'path', 'file_path') ?? '';
  const language = detectLanguage(filePath);
  const lines = content.split('\n');

  return (
    <div className="overflow-hidden rounded-lg font-mono text-[11px] leading-relaxed">
      {filePath && <ClickablePathHeader filePath={filePath} />}
      <div className="max-h-80 overflow-auto py-1">
        {lines.map((line, i) => (
          <div key={i} className="ap-diff-add flex whitespace-pre">
            <span className="w-4 shrink-0 select-none">+ </span>
            <span className="min-w-0 flex-1 overflow-x-auto pr-2">
              <CodeHighlight code={line || '\u00A0'} language={language} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
