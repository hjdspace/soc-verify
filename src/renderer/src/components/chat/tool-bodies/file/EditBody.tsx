import {
  argStr,
  argVal,
  detectLanguage,
  computeSimpleDiff,
  extractEditFilePath,
  extractOmpEditPathFromResult,
  hasResultWarning,
} from '@renderer/components/chat/tool-helpers';
import { ClickablePathHeader } from '../shared/ClickablePathHeader';
import { GenericBody } from '../shared/GenericBody';
import { DiffLineView } from './DiffLineView';
import { EditWarningBlock } from './EditWarningBlock';
import { OmpEditResultView } from './OmpEditResultView';

/** Extract old/new text from omp edit tool args, handling the `edits` array format. */
function extractEditTexts(args: unknown): { oldText: string | undefined; newText: string | undefined } {
  const flatOld = argStr(args, 'oldText', 'old_string', 'old_text', 'find');
  const flatNew = argStr(args, 'newText', 'new_string', 'new_text', 'replace');
  if (flatOld != null || flatNew != null) {
    return { oldText: flatOld, newText: flatNew };
  }

  const editsVal = argVal(args, 'edits');
  if (Array.isArray(editsVal) && editsVal.length > 0) {
    const firstEdit = editsVal[0];
    if (firstEdit && typeof firstEdit === 'object') {
      const editObj = firstEdit as Record<string, unknown>;
      const oldText = typeof editObj.old_text === 'string' ? editObj.old_text
        : typeof editObj.oldText === 'string' ? editObj.oldText
        : typeof editObj.old_string === 'string' ? editObj.old_string
        : undefined;
      const newText = typeof editObj.new_text === 'string' ? editObj.new_text
        : typeof editObj.newText === 'string' ? editObj.newText
        : typeof editObj.new_string === 'string' ? editObj.new_string
        : undefined;
      if (oldText != null || newText != null) {
        return { oldText, newText };
      }
    }
  }
  return { oldText: undefined, newText: undefined };
}

export function EditBody({ args, resultText }: { args: unknown; resultText: string }) {
  const filePath = extractEditFilePath(args, resultText);
  const language = detectLanguage(filePath);
  const { oldText, newText } = extractEditTexts(args);

  if (oldText != null && newText != null) {
    const diff = computeSimpleDiff(oldText, newText);
    return (
      <div className="text-[11px] leading-relaxed">
        {filePath && <ClickablePathHeader filePath={filePath} />}
        <div className="max-h-80 overflow-auto">
          {diff.map((line, i) => <DiffLineView key={i} line={line} language={language} />)}
        </div>
        {hasResultWarning(resultText) && <EditWarningBlock resultText={resultText} />}
      </div>
    );
  }

  // Fallback: apply_patch and some edit adapters carry the unified patch in args.
  const patchText = argStr(args, 'input', 'patch', 'diff') ?? '';
  if (patchText.includes('@@') || /^[+-]/m.test(patchText)) {
    const lines = patchText.split('\n').map((content) => {
      if (content.startsWith('*** ') || content.startsWith('+++') || content.startsWith('---') || content.startsWith('@@')) return { type: 'hunk' as const, content };
      if (content.startsWith('+')) return { type: 'add' as const, content: content.slice(1) };
      if (content.startsWith('-')) return { type: 'del' as const, content: content.slice(1) };
      return { type: 'ctx' as const, content: content.startsWith(' ') ? content.slice(1) : content };
    });
    return (
      <div className="text-[11px] leading-relaxed">
        {filePath && <ClickablePathHeader filePath={filePath} />}
        <div className="max-h-80 overflow-auto">
          {lines.map((line, i) => {
            if (line.type === 'hunk') {
              return <div key={i} className="bg-secondary/40 px-2.5 py-0.5 text-[10px] text-muted-foreground/70">{line.content}</div>;
            }
            return <DiffLineView key={i} line={line} language={language} />;
          })}
        </div>
        {hasResultWarning(resultText) && <EditWarningBlock resultText={resultText} />}
      </div>
    );
  }

  // omp edit format: input is `[file#tag]\nDEL 42-49\n`, result has `[path#tag]\n42:content...\nWarnings:...`
  const ompPath = extractOmpEditPathFromResult(resultText);
  if (ompPath || (argStr(args, 'input') && resultText.match(/^\[[^\]]+#[A-Za-z0-9_]+\]/))) {
    return <OmpEditResultView resultText={resultText} language={detectLanguage(ompPath || filePath)} />;
  }

  return <GenericBody args={args} resultText={resultText} />;
}
