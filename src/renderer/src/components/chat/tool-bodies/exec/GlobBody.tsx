import { type ReactNode } from 'react';
import { argStr } from '@renderer/components/chat/tool-helpers';
import { GenericBody } from '../shared/GenericBody';

function highlightMatches(text: string, regex: RegExp): ReactNode {
  const parts = text.split(regex);
  const matches = text.match(regex);
  if (!matches) return text;
  const result: ReactNode[] = [];
  parts.forEach((part, i) => {
    result.push(part);
    if (i < matches.length) {
      result.push(<span key={i} className="rounded bg-chart-1/20 px-0.5 text-chart-1">{matches[i]}</span>);
    }
  });
  return result;
}

export function GrepBody({ args, resultText }: { args: unknown; resultText: string }) {
  const pattern = argStr(args, 'pattern', 'query') ?? '';
  const lines = resultText.split('\n').filter(Boolean);
  const files: Array<{ file: string; matches: Array<{ ln: string; text: string }> }> = [];
  let currentFile: string | null = null;

  for (const line of lines) {
    const match = line.match(/^([^:]+):(\d+):(.*)$/);
    if (match) {
      const [, file, ln, text] = match;
      if (file !== currentFile) { currentFile = file; files.push({ file, matches: [] }); }
      files[files.length - 1].matches.push({ ln, text });
    } else {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const file = line.slice(0, colonIdx);
        if (file !== currentFile) { currentFile = file; files.push({ file, matches: [] }); }
        files[files.length - 1].matches.push({ ln: '', text: line.slice(colonIdx + 1) });
      }
    }
  }

  if (files.length === 0) return <GenericBody args={args} resultText={resultText} />;

  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = pattern ? new RegExp(`(${escapeRegex(pattern)})`, 'gi') : null;

  return (
    <div className="max-h-80 overflow-auto rounded-lg py-1 font-mono text-[11px] leading-relaxed">
      {files.map((f, fi) => (
        <div key={fi}>
          <div className="flex items-center gap-1.5 px-2.5 py-0.5">
            <span className="truncate font-semibold text-foreground" title={f.file}>{f.file}</span>
            <span className="shrink-0 rounded-full bg-[var(--dsw-layer-3)] px-1.5 text-[9px] leading-[14px] text-muted-foreground">
              ×{f.matches.length}
            </span>
          </div>
          {f.matches.map((m, mi) => (
            <div key={mi} className="flex gap-2 px-2.5 py-0.5">
              <span className="ap-gln w-7 shrink-0 text-right">{m.ln}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-muted-foreground">
                {regex ? highlightMatches(m.text, regex) : m.text}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
