import {
  argStr,
  argVal,
  detectLanguage,
} from '@renderer/components/chat/tool-helpers';
import { ClickablePathHeader } from '../shared/ClickablePathHeader';
import { CodeHighlight } from '../shared/CodeHighlight';

export function ReadBody({ args, resultText }: { args: unknown; resultText: string }) {
  const offset = typeof argVal(args, 'offset') === 'number' ? (argVal(args, 'offset') as number) : 1;
  const filePath = argStr(args, 'path', 'file_path') ?? '';
  const language = detectLanguage(filePath);
  const lines = resultText.split('\n');
  // 当读取目标是目录时（EISDIR 错误），路径不可点击
  const isDirError = /EISDIR/i.test(resultText);

  return (
    <div className="text-[11px] leading-relaxed">
      {filePath && <ClickablePathHeader filePath={filePath} clickable={!isDirError} />}
      <div className="flex max-h-80 overflow-auto">
        <div className="select-none border-r border-border/40 bg-background/50 px-2 py-1.5 text-right text-muted-foreground/60">
          {lines.map((_, i) => <div key={i}>{offset + i}</div>)}
        </div>
        <div className="flex-1 overflow-x-auto px-2.5 py-1.5">
          <CodeHighlight code={resultText} language={language} className="text-foreground/90" />
        </div>
      </div>
    </div>
  );
}
