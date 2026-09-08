import {
  argStr,
  argVal,
  detectLanguage,
  computeSimpleDiff,
  extractEditFilePath,
  extractOmpEditPathFromResult,
  extractSloppyEditInput,
  hasResultWarning,
  type DiffLineData,
} from '@renderer/components/chat/tool-helpers';
import { getEditDetailDiff } from '../shared/diff-stats';
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

/** edit 展开体通用 diff 块：路径头 + diff 行 + 警告 */
function DiffBlock({
  filePath,
  lines,
  language,
  resultText,
}: {
  filePath: string;
  lines: DiffLineData[];
  language: string;
  resultText: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg py-1 font-mono text-[11px] leading-relaxed">
      {filePath && <ClickablePathHeader filePath={filePath} />}
      <div className="max-h-80 overflow-auto">
        {lines.map((line, i) => <DiffLineView key={i} line={line} language={language} />)}
      </div>
      {hasResultWarning(resultText) && <EditWarningBlock resultText={resultText} />}
    </div>
  );
}

export function EditBody({ args, resultText, toolResult }: { args: unknown; resultText: string; toolResult?: unknown }) {
  const filePath = extractEditFilePath(args, resultText);
  const language = detectLanguage(filePath);

  // omp edit 删除文件：details.op === 'delete'，结果文本为 `Deleted <path>`
  const details = toolResult != null && typeof toolResult === 'object'
    ? (toolResult as { details?: Record<string, unknown> }).details
    : undefined;
  if (details?.op === 'delete') {
    const deletedPath = typeof details.path === 'string' ? details.path : filePath;
    return (
      <div className="rounded-lg py-1 font-mono text-[11px] text-muted-foreground">
        <span className="text-destructive">Deleted</span>{deletedPath ? ` ${deletedPath}` : ''}
      </div>
    );
  }

  // ① omp edit 成功时 details 始终携带结构化 diff（全模式通用，最可靠）
  const detailLines = getEditDetailDiff(toolResult);
  if (detailLines) {
    return <DiffBlock filePath={filePath} lines={detailLines} language={language} resultText={resultText} />;
  }

  // ② args 携带 oldText/newText（replace 模式入参 / edits 数组）
  const { oldText, newText } = extractEditTexts(args);
  if (oldText != null && newText != null) {
    return (
      <DiffBlock
        filePath={filePath}
        lines={computeSimpleDiff(oldText, newText)}
        language={language}
        resultText={resultText}
      />
    );
  }

  // ③ sloppy 模式输入：`<SM:EDIT path>` + `<SM:FIND>/<SM:PUT>` 对（无 +/- 行，需单独解析）
  const sloppy = extractSloppyEditInput(args);
  if (sloppy) {
    const sloppyPath = filePath || sloppy.path || '';
    const lines: DiffLineData[] = [];
    for (const pair of sloppy.pairs) {
      if (lines.length > 0) lines.push({ type: 'ctx', content: '⋯' });
      lines.push(...computeSimpleDiff(pair.find, pair.put));
    }
    return (
      <DiffBlock
        filePath={sloppyPath}
        lines={lines}
        language={detectLanguage(sloppyPath)}
        resultText={resultText}
      />
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
      <div className="overflow-hidden rounded-lg py-1 font-mono text-[11px] leading-relaxed">
        {filePath && <ClickablePathHeader filePath={filePath} />}
        <div className="max-h-80 overflow-auto">
          {lines.map((line, i) => {
            if (line.type === 'hunk') {
              // DSH：同文件多个 hunk 之间插灰色 ⋯ 行
              return <div key={i} className="ap-diff-hunk px-2.5 py-0.5 text-[10px] leading-[18px]">⋯</div>;
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
