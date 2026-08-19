/**
 * inline-review.ts — CodeMirror 内联审阅扩展（Cursor / VSCode 风格）。
 *
 * 在普通编辑器视图上叠加 AI 改动的 diff 标注，无需独立的 diff 视图：
 * - 新增行：绿色行背景（Decoration.line）
 * - 删除行：以块级 widget 插入对应位置、红色背景（这些行不在当前文档中）
 * - 每个 hunk：顶部操作条 widget（接受 / 拒绝按钮）
 *
 * 装饰必须通过 StateField 而非 ViewPlugin 提供：CodeMirror 禁止 plugin
 * 提供 block 装饰（会抛 "Block decorations may not be specified via plugins"）。
 * spec 变化时由调用方重建 extension → @uiw/react-codemirror 触发
 * StateEffect.reconfigure 完整重配 → StateField.create() 以新 spec 重建装饰。
 *
 * 行号映射逻辑（planReviewMarkers）是纯函数，便于单独测试；
 * buildDecorations 负责把规划映射为 CodeMirror 装饰。
 */

import { EditorView, Decoration, type DecorationSet, WidgetType } from '@codemirror/view';
import { StateField, type Extension, type Text, type Range } from '@codemirror/state';
import type { FileDiffResult } from '@shared/types';

// ─── Types ──────────────────────────────────────────────────

export type InlineHunkState = 'pending' | 'accepted' | 'rejected';

/** 内联审阅扩展的配置：diff 数据 + hunk 状态 + 接受/拒绝回调 */
export interface InlineReviewSpec {
  diff: FileDiffResult;
  /** key = hunkId；缺省视为 pending */
  hunkStates: Record<number, InlineHunkState>;
  onAccept: (hunkId: number) => void;
  onReject: (hunkId: number) => void;
}

/** hunk 操作条规划 */
export interface HunkBarPlan {
  hunkId: number;
  /** 插入到该文档行（1-based）之前；'end' 表示文档末尾 */
  anchor: number | 'end';
  state: InlineHunkState;
  overwritten: boolean;
  addCount: number;
  delCount: number;
  toolName: string;
}

/** 删除行块规划（连续 del 行合并为一个块级 widget） */
export interface DelBlockPlan {
  lines: string[];
  anchor: number | 'end';
}

/** 新增行规划 */
export interface AddLinePlan {
  /** 文档行号（1-based） */
  line: number;
  /** 已拒绝：淡红 + 删除线（等待内容重载后消失） */
  rejected: boolean;
}

export interface ReviewMarkerPlan {
  hunkBars: HunkBarPlan[];
  delBlocks: DelBlockPlan[];
  addLines: AddLinePlan[];
}

// ─── 规划（纯函数） ─────────────────────────────────────────

function clampLine(n: number, max: number): number {
  return Math.max(1, Math.min(n, max));
}

/**
 * 将 diff 行规划为文档装饰标记。
 *
 * - ctx/add 行的 newLine 直接映射到文档行号；
 * - 连续 del 行合并为一个块，锚定到其后第一个存在于文档中的行（或文档末尾）；
 * - accepted hunk 完全折叠（不产生任何标记，视觉上等同普通代码）；
 * - rejected hunk 的 add 行标记为 rejected 样式，del 块不展示（改动即将回滚）。
 */
export function planReviewMarkers(
  diff: FileDiffResult,
  docLineCount: number,
  hunkStates: Record<number, InlineHunkState>,
): ReviewMarkerPlan {
  const maxLine = Math.max(docLineCount, 1);
  const hunkById = new Map(diff.hunks.map((h) => [h.id, h]));
  // overwritten hunk 的 before 内容已不可靠（被后续编辑覆盖），
  // 行级标记按 accepted 处理（不展示），仅保留操作条上的「已被覆盖」徽章。
  const lineState = (hunkId: number | null): InlineHunkState => {
    if (hunkId == null) return 'pending';
    if (hunkById.get(hunkId)?.overwritten) return 'accepted';
    return hunkStates[hunkId] ?? 'pending';
  };
  const addLines: AddLinePlan[] = [];
  const delBlocks: DelBlockPlan[] = [];
  let delRun: string[] = [];
  const flushDel = (anchor: number | 'end'): void => {
    if (delRun.length > 0) {
      delBlocks.push({ lines: delRun, anchor });
      delRun = [];
    }
  };

  for (const line of diff.lines) {
    const state = lineState(line.hunkId ?? null);
    if (line.type === 'del') {
      // accepted：删除已被采纳（旧行不再展示）；rejected：删除已回滚（不展示）
      if (state === 'pending') delRun.push(line.content);
      continue;
    }
    const docLine = clampLine(line.newLine ?? 1, maxLine);
    flushDel(docLine);
    if (line.type === 'add' && state !== 'accepted') {
      addLines.push({ line: docLine, rejected: state === 'rejected' });
    }
  }
  flushDel('end');

  const hunkBars: HunkBarPlan[] = [];
  for (const hunk of diff.hunks) {
    const state = hunkStates[hunk.id] ?? 'pending';
    if (state === 'accepted') continue; // 已接受：折叠为普通代码
    // 锚点：hunk 起始位置之后第一个存在于文档中的行（纯删除 hunk 锚定到其后的行）
    let anchor: number | 'end' = 'end';
    for (let i = hunk.startLineIndex; i < diff.lines.length; i++) {
      const l = diff.lines[i];
      if (l.newLine != null) {
        anchor = clampLine(l.newLine, maxLine);
        break;
      }
    }
    hunkBars.push({
      hunkId: hunk.id,
      anchor,
      state,
      overwritten: hunk.overwritten,
      addCount: hunk.addCount,
      delCount: hunk.delCount,
      toolName: hunk.toolName,
    });
  }

  return { hunkBars, delBlocks, addLines };
}

// ─── Widgets ────────────────────────────────────────────────

/** 删除行块：红色背景的只读旧行列表 */
class DeletedLinesWidget extends WidgetType {
  constructor(readonly lines: string[]) {
    super();
  }

  eq(other: DeletedLinesWidget): boolean {
    return this.lines.length === other.lines.length
      && this.lines.every((l, i) => l === other.lines[i]);
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-review-del-block';
    for (const line of this.lines) {
      const el = document.createElement('div');
      el.className = 'cm-review-del-line';
      const sign = document.createElement('span');
      sign.className = 'cm-review-del-sign';
      sign.textContent = '−';
      const content = document.createElement('span');
      content.className = 'cm-review-del-content';
      content.textContent = line.length > 0 ? line : '\u00A0';
      el.append(sign, content);
      wrap.appendChild(el);
    }
    return wrap;
  }

  ignore(): boolean {
    return true;
  }
}

/** hunk 操作条：统计 + 接受/拒绝按钮（或状态徽章） */
class HunkBarWidget extends WidgetType {
  constructor(readonly plan: HunkBarPlan, readonly spec: InlineReviewSpec) {
    super();
  }

  eq(other: HunkBarWidget): boolean {
    return this.plan.hunkId === other.plan.hunkId
      && this.plan.state === other.plan.state
      && this.plan.overwritten === other.plan.overwritten
      && this.plan.addCount === other.plan.addCount
      && this.plan.delCount === other.plan.delCount;
  }

  toDOM(): HTMLElement {
    const { plan } = this;
    const wrap = document.createElement('div');
    wrap.className = 'cm-review-bar';
    wrap.dataset.state = plan.state;

    const stats = document.createElement('span');
    stats.className = 'cm-review-bar-stats';
    stats.textContent = `+${plan.addCount} −${plan.delCount}`;
    wrap.appendChild(stats);

    const tool = document.createElement('span');
    tool.className = 'cm-review-bar-tool';
    tool.textContent = plan.toolName;
    wrap.appendChild(tool);

    const actions = document.createElement('div');
    actions.className = 'cm-review-bar-actions';
    if (plan.overwritten) {
      const badge = document.createElement('span');
      badge.className = 'cm-review-bar-badge';
      badge.textContent = '已被覆盖';
      actions.appendChild(badge);
    } else if (plan.state === 'rejected') {
      const badge = document.createElement('span');
      badge.className = 'cm-review-bar-badge cm-review-bar-badge-rejected';
      badge.textContent = '已拒绝';
      actions.appendChild(badge);
    } else {
      const acceptBtn = document.createElement('button');
      acceptBtn.type = 'button';
      acceptBtn.className = 'cm-review-btn cm-review-btn-accept';
      acceptBtn.textContent = '接受';
      acceptBtn.title = '保留此改动';
      acceptBtn.addEventListener('click', () => this.spec.onAccept(plan.hunkId));

      const rejectBtn = document.createElement('button');
      rejectBtn.type = 'button';
      rejectBtn.className = 'cm-review-btn cm-review-btn-reject';
      rejectBtn.textContent = '拒绝';
      rejectBtn.title = '回滚此改动';
      rejectBtn.addEventListener('click', () => this.spec.onReject(plan.hunkId));
      actions.append(acceptBtn, rejectBtn);
    }
    wrap.appendChild(actions);
    return wrap;
  }

  ignore(): boolean {
    return true; // 按钮点击由 DOM 原生处理
  }
}

// ─── Decoration 构建 ────────────────────────────────────────

function buildDecorations(doc: Text, spec: InlineReviewSpec): DecorationSet {
  const plan = planReviewMarkers(spec.diff, doc.lines, spec.hunkStates);
  const ranges: Array<Range<Decoration>> = [];
  const posOf = (anchor: number | 'end'): number =>
    anchor === 'end' ? doc.length : doc.line(anchor).from;

  for (const bar of plan.hunkBars) {
    ranges.push(
      // block widget：独立成行，锚点必须是行边界（行首或文档末尾）
      Decoration.widget({ widget: new HunkBarWidget(bar, spec), side: -20, block: true }).range(posOf(bar.anchor)),
    );
  }
  for (const block of plan.delBlocks) {
    ranges.push(
      Decoration.widget({ widget: new DeletedLinesWidget(block.lines), side: -10, block: true }).range(posOf(block.anchor)),
    );
  }
  for (const add of plan.addLines) {
    const pos = doc.line(add.line).from;
    ranges.push(
      Decoration.line({ class: add.rejected ? 'cm-review-add-rejected' : 'cm-review-add' }).range(pos),
    );
  }
  return Decoration.set(ranges, true);
}

// ─── Public API ─────────────────────────────────────────────

/**
 * 创建内联审阅 extension。
 *
 * 必须使用 StateField：block 装饰（hunk 操作条 / 删除行块）不允许
 * 由 ViewPlugin 提供，否则 CodeMirror 在 DocView 构建时抛出
 * "Block decorations may not be specified via plugins"（白屏）。
 *
 * spec 变化时由调用方重建 extension（@uiw/react-codemirror 通过
 * StateEffect.reconfigure 完整重配 → create() 以新 spec 重建装饰）；
 * 文档替换（内容重载）时在 update() 中基于新文档重建。
 */
export function createInlineReviewExtension(spec: InlineReviewSpec): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => buildDecorations(state.doc, spec),
    update: (decos, tr) => {
      // 内容重载等文档替换：基于新文档重建（planReviewMarkers 内部会钳制行号）
      if (tr.docChanged) {
        return buildDecorations(tr.state.doc, spec);
      }
      return decos.map(tr.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}
