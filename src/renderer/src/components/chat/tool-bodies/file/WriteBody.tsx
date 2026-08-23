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
    <div className="text-[11px] leading-relaxed">
      {filePath && <ClickablePathHeader filePath={filePath} />}
      <div className="max-h-80 overflow-auto bg-diff-add/20">
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span className="w-5 shrink-0 select-none text-center text-status-pass-foreground">+</span>
            <span className="w-8 shrink-0 select-none border-r border-status-pass-foreground/20 pr-1 text-right text-status-pass-foreground/60">{i + 1}</span>
            <span className="flex-1 overflow-x-auto px-2 text-diff-add-foreground">
              <CodeHighlight code={line || '\u00A0'} language={language} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
