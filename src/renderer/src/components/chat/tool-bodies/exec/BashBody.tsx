import { argStr } from '@renderer/components/chat/tool-helpers';
import { CopyButton } from '../shared/CopyButton';

export function BashBody({ args, resultText }: { args: unknown; resultText: string }) {
  const cmd = argStr(args, 'command') ?? '';
  return (
    <div className="overflow-hidden rounded-lg font-mono text-[11px] leading-relaxed">
      <div className="ap-banner">
        <span className="truncate text-[var(--dsw-label-secondary)]">
          <span className="text-[var(--dsw-label-caption)]">$ </span>{cmd}
        </span>
        <CopyButton text={cmd} />
      </div>
      <pre className="max-h-56 overflow-auto px-2.5 py-1.5 text-muted-foreground">{resultText || '\u00A0'}</pre>
    </div>
  );
}
