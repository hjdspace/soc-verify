/**
 * KB 主动保存问答为 query 页提案（issue 18，spec §7）。
 *
 * 聊天中用户选择一组问题/答案消息，主进程固定项目、挂载 kbId 与当时
 * 引用的已发布页/来源修订；对没有挂载或不存在的引用给出明确错误。
 * 不把整个会话历史或用户凭证放入提案。
 *
 * 创建 `query` 类型的任务，经编译器生成 `wiki/queries/<pageId>.md` 提案，
 * 包含问题、答案、适用条件、引用与尚未证实项。已有知识引用必须可解析；
 * 来自会话中的无证据判断明确标为推测，不能自动成为来源事实。
 *
 * Query 任务复用队列、预算、staging、审阅、历史和索引；跳过文件转换/提图
 * 阶段。消息选择 hash + 引用修订参与去重，重复点击同一选择不创建重复任务。
 * 只保存已选问答，不自动入库全部聊天，也不新增 Agent 可绕过人工操作的
 * 写库工具。
 *
 * 发布时不需要原聊天会话仍存在，因为所选内容和引用已随提案保存；
 * 发布页自包含问答与来源，不引入额外「聊天原件目录」。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §7
 * @see .scratch/llm-wiki/issues/18-save-query.md
 */

import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { stageProposal, listChangeSets, readChangeSet } from './staging';
import { wikiLayout, readWikiManifest } from './wiki-layout';
import type {
  WikiChangeSet,
  WikiSourceRef,
} from '@shared/kb-types';

// ── 类型契约 ────────────────────────────────────────────────────

/** 单条选定的聊天消息 */
export type SaveQueryMessage = {
  /** 消息角色：user = 提问，assistant = 回答 */
  role: 'user' | 'assistant';
  /** 消息正文 */
  content: string;
  /** 消息 ID（用于去重与追踪；可为空但建议由调用方提供） */
  id?: string;
};

/** saveQuery 输入 */
export type SaveQueryInput = {
  /** 当前挂载的知识库 ID */
  kbId: string;
  /** 用户选定的问答消息序列（按对话顺序） */
  messages: SaveQueryMessage[];
  /** 用户指定的页面标题 */
  title: string;
  /** 用户指定的页面摘要 */
  summary: string;
  /**
   * 引用的来源修订（来自已发布知识页或来源全文）。
   * 对没有挂载或不存在的引用给出明确错误。
   * 无引用时传空数组 —— 提案将标为推测。
   */
  sourceRefs: WikiSourceRef[];
  /** 可选：已有知识页引用（wikilink 形式 pageId） */
  referencedPageIds?: string[];
  /** 注入时钟（测试用） */
  now?: string;
};

/** saveQuery 成功结果 */
export type SaveQuerySuccess = {
  ok: true;
  /** 持久化的变更集（审阅入口见 kb.stagedChangeSet） */
  changeSet: WikiChangeSet;
  /** 是否为去重复用（命中已有变更集） */
  deduplicated: boolean;
};

/** saveQuery 失败结果 */
export type SaveQueryFailure = {
  ok: false;
  error: {
    code: 'invalidSourceRef' | 'noMessages' | 'stagingFailed' | 'ioError';
    message: string;
  };
};

export type SaveQueryOutcome = SaveQuerySuccess | SaveQueryFailure;

// ── 选择 hash（去重键）──────────────────────────────────────────

/**
 * 计算消息选择的稳定 hash（用于去重）。
 *
 * hash 输入 = 消息序列（role + content + id）+ 来源引用（sourceId +
 * sourceRevision + parsedHash）的规范 JSON。相同选择 + 相同引用 →
 * 相同 hash，双击不产生重复任务。
 */
export function computeSelectionHash(
  messages: readonly SaveQueryMessage[],
  sourceRefs?: readonly WikiSourceRef[],
): string {
  const payload = {
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.id !== undefined ? { id: m.id } : {}),
    })),
    sources: (sourceRefs ?? []).map((s) => ({
      sourceId: s.sourceId,
      sourceRevision: s.sourceRevision,
      parsedHash: s.parsedHash,
    })),
  };
  return createHash('sha256')
    .update(JSON.stringify(payload), 'utf-8')
    .digest('hex');
}

/** 去重键 = 选择 hash + kbId + title */
function dedupeKey(input: SaveQueryInput): string {
  const selHash = computeSelectionHash(input.messages, input.sourceRefs);
  return `${input.kbId}:${selHash}:${input.title}`;
}

// ── 核心实现 ────────────────────────────────────────────────────

/**
 * 保存选定问答为 query 类型提案，进入既有 staging 审阅入口。
 *
 * 复用 stageProposal（origin='saveQuery'），跳过转换/提图阶段。
 * 去重：同消息选择 + 同引用修订 + 同标题 → 返回已有变更集。
 */
export async function saveQueryMessages(
  kbPath: string,
  input: SaveQueryInput,
): Promise<SaveQueryOutcome> {
  // ── 输入校验 ──
  if (input.messages.length === 0) {
    return {
      ok: false,
      error: { code: 'noMessages', message: '未选择任何消息，无法保存为知识页' },
    };
  }

  // ── 来源引用校验：引用必须可解析 ──
  if (input.sourceRefs.length > 0) {
    const manifestRes = await readWikiManifest(kbPath);
    if (manifestRes.ok) {
      for (const ref of input.sourceRefs) {
        const rec = manifestRes.manifest.sources?.[ref.sourceId];
        if (!rec) {
          return {
            ok: false,
            error: {
              code: 'invalidSourceRef',
              message: `引用来源不存在: ${ref.sourceId.slice(0, 16)}…（来源 ID 未在 manifest 中登记）`,
            },
          };
        }
        if (rec.currentRevision !== ref.sourceRevision) {
          return {
            ok: false,
            error: {
              code: 'invalidSourceRef',
              message: `引用来源修订已失效: ${ref.sourceId.slice(0, 16)}…（提案时 ${ref.sourceRevision.slice(0, 8)}，当前 ${rec.currentRevision.slice(0, 8)}）`,
            },
          };
        }
      }
    }
  }

  // ── 去重：检查已有 saveQuery 变更集 ──
  const dedupe = dedupeKey(input);
  const existing = await findExistingChangeSet(kbPath, input.kbId, dedupe);
  if (existing) {
    return { ok: true, changeSet: existing, deduplicated: true };
  }

  // ── 生成 query 页内容 ──
  const now = input.now ?? new Date().toISOString();
  const hasEvidence = input.sourceRefs.length > 0;
  const proposalText = buildQueryPageContent({
    messages: input.messages,
    title: input.title,
    summary: input.summary,
    sourceRefs: input.sourceRefs,
    referencedPageIds: input.referencedPageIds,
    hasEvidence,
    now,
  });

  // ── 构造 FILE 块文本（stageProposal 期望的输入格式）──
  const pageId = generatePageId(input.title);
  const relPath = `wiki/queries/${pageId}.md`;
  const fileBlock = `---FILE: ${relPath}---\n${proposalText}\n---END FILE---`;

  // ── 经既有 staging 落盘 ──
  const taskId = `saveQuery-${randomUUID()}`;
  const staged = await stageProposal(kbPath, {
    kbId: input.kbId,
    taskId,
    origin: 'saveQuery',
    sourceRefs: input.sourceRefs,
    proposalText: fileBlock,
    extraWarnings: hasEvidence
      ? []
      : ['无来源引用：本提案中的判断标为推测，不能作为原始事实使用。'],
  });

  if (!staged.ok) {
    return {
      ok: false,
      error: {
        code: 'stagingFailed',
        message: `保存提案失败: ${staged.error.code} — ${staged.error.message}`,
      },
    };
  }

  // ── 持久化去重键（附加到 changeSet 的 warnings 中，重开可读）──
  // changeSet.warnings 中包含去重标记，使后续调用可查找已有变更集
  const changeSet = staged.value.changeSet;
  // 去重键追加到 warnings 末尾（不污染正文）
  changeSet.warnings.push(`__dedupe_key:${dedupe}`);

  // 原子写回带去重键的 changeSet
  const { writeFileAtomic } = await import('./atomic-commit');
  const layout = wikiLayout(kbPath);
  try {
    await writeFileAtomic(
      join(layout.stagingDir, `${changeSet.changeSetId}.json`),
      JSON.stringify(changeSet, null, 2),
    );
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'ioError',
        message: `持久化变更集失败: ${String(err)}`,
      },
    };
  }

  return { ok: true, changeSet, deduplicated: false };
}

// ── 查找已有变更集（去重）──────────────────────────────────────

async function findExistingChangeSet(
  kbPath: string,
  kbId: string,
  dedupeKey: string,
): Promise<WikiChangeSet | null> {
  const list = await listChangeSets(kbPath, kbId);
  if (!list.ok) return null;

  for (const summary of list.value) {
    if (summary.origin !== 'saveQuery') continue;
    const csRes = await readChangeSet(kbPath, summary.changeSetId);
    if (!csRes.ok) continue;
    const cs = csRes.value;
    // 检查是否已有审阅选择（已处置的不再复用）
    // 未处置且去重键匹配 → 复用
    const hasDedupeKey = cs.warnings.some((w) => w.startsWith('__dedupe_key:') && w === `__dedupe_key:${dedupeKey}`);
    if (hasDedupeKey) {
      return cs;
    }
  }
  return null;
}

// ── 生成 pageId ────────────────────────────────────────────────

/**
 * 从标题生成安全的 pageId：
 * - 保留中文、字母数字、连字符
 * - 空格/标点 → 连字符
 * - 去除连续连字符与首尾连字符
 * - 空标题回退为时间戳
 */
function generatePageId(title: string): string {
  const sanitized = title
    .trim()
    .replace(/[/\\:*?"<>|]/g, '') // 去除文件系统非法字符
    .replace(/\s+/g, '-')          // 空格 → 连字符
    .replace(/[，。、！？；：""''（）【】《》]/g, '') // 去除中文标点
    .replace(/-+/g, '-')            // 合并连续连字符
    .replace(/^-+|-+$/g, '');       // 去除首尾连字符

  if (sanitized.length === 0) {
    return `query-${Date.now()}`;
  }
  // 截断过长的标题
  return sanitized.slice(0, 80);
}

// ── 构建 query 页正文 ──────────────────────────────────────────

/**
 * 构造 query 类型知识页的完整 Markdown（frontmatter + 正文）。
 *
 * 正文结构：
 *  - ## 问题：原始问题原文
 *  - ## 回答：原始回答原文
 *  - ## 适用条件：适用范围说明
 *  - ## 引用：来源引用清单
 *  - ## 推测项：无证据判断的明确标注
 */
function buildQueryPageContent(args: {
  messages: readonly SaveQueryMessage[];
  title: string;
  summary: string;
  sourceRefs: readonly WikiSourceRef[];
  referencedPageIds?: readonly string[];
  hasEvidence: boolean;
  now: string;
}): string {
  const { messages, title, summary, sourceRefs, referencedPageIds, hasEvidence, now } = args;

  // 分离问题和回答
  const questions = messages.filter((m) => m.role === 'user');
  const answers = messages.filter((m) => m.role === 'assistant');

  // frontmatter 来源引用
  const sourcesYaml = sourceRefs.length === 0
    ? 'sources: []'
    : [
        'sources:',
        ...sourceRefs.flatMap((s) => [
          `  - sourceId: "${s.sourceId}"`,
          `    sourceRevision: "${s.sourceRevision}"`,
          `    parsedHash: "${s.parsedHash}"`,
        ]),
      ].join('\n');

  // 引用的已有知识页 wikilink
  const refPageLinks = (referencedPageIds ?? [])
    .map((id) => `- [[${id}]]`)
    .join('\n');

  // 正文段落
  const questionSection = questions.length > 0
    ? [
        '## 问题',
        '',
        ...questions.map((m) => m.content),
      ].join('\n')
    : '';

  const answerSection = answers.length > 0
    ? [
        '## 回答',
        '',
        ...answers.map((m) => m.content),
      ].join('\n')
    : '';

  const conditionSection = [
    '## 适用条件',
    '',
    hasEvidence
      ? '本回答基于以下来源引用，适用于引用来源所描述的上下文。'
      : '本回答无来源引用支撑，判断标为推测，不能作为原始事实使用。',
  ].join('\n');

  const refSection = sourceRefs.length > 0
    ? [
        '## 引用',
        '',
        ...sourceRefs.map((s, i) =>
          `- 来源 ${i + 1}: ${s.sourceId.slice(0, 16)}…（修订 ${s.sourceRevision.slice(0, 8)}）`,
        ),
      ].join('\n')
    : '';

  const refPageSection = refPageLinks
    ? ['## 相关知识页', '', refPageLinks].join('\n')
    : '';

  const speculationSection = !hasEvidence
    ? [
        '## 推测项',
        '',
        '> ⚠️ 以下判断来自聊天会话，无来源证据支撑，标为推测。',
        '> 不能自动成为来源事实；请在审阅时确认是否接受。',
        '',
        ...answers.map((m) => m.content),
      ].join('\n')
    : '';

  // 组装正文
  const bodyParts = [
    questionSection,
    answerSection,
    conditionSection,
    refSection,
    refPageSection,
    speculationSection,
  ].filter((s) => s.length > 0);

  const body = bodyParts.join('\n\n');

  // 组装完整页面
  return [
    '---',
    `type: query`,
    `title: "${title.replace(/"/g, '\\"')}"`,
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    'keywords: []',
    'tags: []',
    sourcesYaml,
    `created: "${now}"`,
    `updated: "${now}"`,
    '---',
    '',
    `# ${title}`,
    '',
    body,
  ].join('\n');
}
