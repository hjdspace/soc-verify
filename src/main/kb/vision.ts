/**
 * KB 图像解读模块（issue 12，spec §3）。
 *
 * 职责边界（Smart zone M）：
 *  - 单图解读：受管资产字节（raw/assets，内容寻址）→ base64 内联送入
 *    vision 角色模型 → 结构化解读（图类型/可见元素与信号/关系或时序/
 *    可辨认数值/不确定项）→ 持久化 .kb/vision/<sourceId>/<revision>/<assetId>.json；
 *  - 只发送受管图像字节：字节从本库资产目录读取并校验 hash（= assetId），
 *    绝不把本机路径当模型可读图片，也绝不抓取远程图片；
 *  - 机械 parsed 不插入模型解释：本模块不写 raw/parsed（解读作为编译输入
 *    附录随提案审阅，见 compile.ts）；
 *  - 复用判断：同上下文指纹（图片字节 hash + 处理参数 + 模型 + 提示版本 +
 *    输出语言 + 邻近文本 hash）的成功解读不重复调用模型；失败记录不复用
 *    （重试重算）；失败不写成功缓存；
 *  - 并发去重（issue 13）：使用中的同图同上下文异步请求共享一次模型调用，
 *    不同上下文/模型不共享；失败不占去重槽位；
 *  - 发送尺寸上限（issue 13，spec §3）：单张发送最长边超过 2048px 时先在
 *    本地等比缩小（处理参数参与指纹）；无法安全处理时不发送未知字节；
 *  - 批次页数上限（issue 13，spec §3）：阶段执行每批最多 50 页，达到上限
 *    返回待处理页清单（不暗漏页），重试只处理剩余批次；
 *  - 真实 usage（issue 13）：成功解读记录 API 返回的 token 用量并阶段汇总；
 *  - 精确参数不可无证据补齐：提示词强制「不清晰」原样报告，禁止换算。
 *
 * 单图独立重试（issue 13）：retryVisionAsset 按资产清单定位单张重试。
 *
 * 模型调用边界：协议分派与请求构造复用 llm-call（含图片支持）；
 * 本模块不解析凭证 —— createDefaultVisionLlmFactory 由 llm-config 的
 * vision 角色解析函数支撑。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §3
 */

import { readFile, readdir, stat, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { sha256Hex } from './hash';
import { callLlm, LlmCallError, type LlmUsage } from './llm-call';
import { resolveKbVisionLlmConfig, type LlmConfig } from './llm-config';
import { wikiLayout, readWikiManifest } from './wiki-layout';
import { readPdfAssetManifest, resolvePdfAssetFile } from './pdf-asset-store';
import { DEFAULT_MAX_EDGE } from './pdf-assets';
import { loadPdfRuntime } from './pdf-runtime';
import { writeFileAtomic } from './atomic-commit';
import type { PdfAssetRecord } from './pdf-assets';
import type { WikiVisionInterpretation } from '@shared/kb-types';

// ── 模型入口 ────────────────────────────────────────────────────

/** 宽松调用结果（与 compile.ts 的 LlmCallResultLike 同形） */
export type VisionCallResultLike =
  | string
  | { text: string; finishReason?: string | null; usage?: LlmUsage | null };

/** 视觉模型入口。调用方显式构造（真实凭证 / 可控假响应）；null = 未配置。 */
export type VisionLlm = {
  /** 配置快照描述（模型名，写入解读记录供显示与复用判断） */
  readonly model: string;
  invoke: (req: {
    system: string;
    user: string;
    images: ReadonlyArray<{ mediaType: string; base64: string }>;
    maxTokens: number;
    signal?: AbortSignal;
  }) => Promise<VisionCallResultLike>;
};

/**
 * 默认视觉模型入口工厂（队列单例使用）。
 *
 * vision 角色必须显式配置（settings.vision.providerId + 模型）：
 * 文本 chat 成功不代表支持图片输入，不自动跟随 compile 角色降级
 * （spec §3「不暗退回纯文字」）。未配置返回 null（任务 blocked）。
 */
export function createDefaultVisionLlmFactory(): (signal: AbortSignal) => Promise<VisionLlm | null> {
  return async (_signal) => {
    const config = await resolveKbVisionLlmConfig();
    if (!config) return null;
    return {
      model: config.model,
      invoke: (req) =>
        callLlm(config, {
          system: req.system,
          user: req.user,
          images: [...req.images],
          maxTokens: req.maxTokens,
        }),
    };
  };
}

// ── 提示词 ──────────────────────────────────────────────────────

/** 提示词版本（提示变更后旧解读指纹失配，自然重算） */
export const VISION_PROMPT_VERSION = 'kb-vision-1';

const VISION_SYSTEM = '你是严谨的 SoC 资料绘图解读员。只输出事实性解读，不输出思考过程。';

/** 解读输出的固定小节标题（解析与提示词共用同一组名称） */
export const VISION_SECTIONS = ['图类型', '可见元素与信号', '关系或时序', '可辨认数值', '不确定项'] as const;

export function buildVisionPrompt(input: {
  sourceName: string;
  page: number | null;
  method: PdfAssetRecord['method'];
}): { system: string; user: string } {
  const methodLabel = input.method === 'page-render' ? '整页渲染图' : '提取的嵌入图像';
  const where = input.page !== null ? `第 ${input.page} 页` : '（来源未提供页码定位）';
  const user = [
    `请解读以下嵌入在 SoC 文档《${input.sourceName}》${where}中的图像（${methodLabel}）。`,
    '',
    '要求：',
    '1. 只描述图像中可见的内容；无法辨认的内容写「不清晰」，不得推测，不得补齐或换算未经证据支持的数值、单位、位宽或时序；',
    '2. 可辨认的数值保留原文写法，不做换算；',
    '3. 固定输出以下五个小节（markdown 二级标题，全部给出；某节无内容写「无」）：',
    '',
    '## 图类型',
    '（如：时序图 / 框图 / 位段图 / 状态机图 / 表格截图 / 照片）',
    '',
    '## 可见元素与信号',
    '（信号名、方框、标签等可见文字，原样记录）',
    '',
    '## 关系或时序',
    '（箭头方向、连接关系、时序先后等；无则写「无」）',
    '',
    '## 可辨认数值',
    '（可辨认的原文数值，保留原值；看不清写「不清晰」，无数值写「无」）',
    '',
    '## 不确定项',
    '（无法确定或辨认的内容；没有则写「无」）',
  ].join('\n');
  return { system: VISION_SYSTEM, user };
}

/** 上下文指纹：图片字节 hash + 处理参数 + 模型 + 提示版本 + 输出语言 + 邻近文本 hash（spec §3） */
export function visionContextHash(input: {
  assetId: string;
  model: string;
  promptVersion: string;
  nearbyTextHash: string;
  /** 发送图像处理参数（'orig' / 'maxEdge=2048'）；形态变化必须重解读 */
  processParams: string;
  /** 输出语言 */
  language: string;
}): string {
  return createHash('sha256')
    .update(
      [input.assetId, input.model, input.promptVersion, input.nearbyTextHash, input.processParams, input.language]
        .join('|'),
      'utf-8',
    )
    .digest('hex');
}

// ── 发送尺寸上限（issue 13，spec §3）────────────────────────────

/** 单张发送图像最长边上限（spec §3：初始 2048px，以端点能力适配） */
export const VISION_MAX_EDGE = DEFAULT_MAX_EDGE;
/** 解读输出语言（提示词为中文；参与缓存指纹，issue 13） */
export const VISION_DEFAULT_LANGUAGE = 'zh';

/** 由资产记录尺寸推导发送形态参数（参与指纹；记录尺寸是唯一事实来源） */
function processParamsForDims(asset: Pick<PdfAssetRecord, 'width' | 'height'>): string {
  const w = asset.width ?? 0;
  const h = asset.height ?? 0;
  return Math.max(w, h) > VISION_MAX_EDGE ? `maxEdge=${VISION_MAX_EDGE}` : 'orig';
}

/**
 * 将超限图片等比缩小到最长边 maxEdge（PNG 输出）。
 *
 * 返回 null = 无法安全完成（本地图像运行时缺失或解码失败）：调用方必须
 * 给出可操作失败，不得把超限未知字节原样发给端点，也不得静默跳过。
 */
async function downscaleForSend(bytes: Buffer, maxEdge: number): Promise<Buffer | null> {
  try {
    const rt = await loadPdfRuntime();
    const loadImage = rt.canvas.loadImage;
    if (typeof loadImage !== 'function') return null;
    const img = await loadImage(bytes);
    const longest = Math.max(img.width, img.height);
    if (!(longest > maxEdge)) return null;
    const factor = maxEdge / longest;
    const w = Math.max(1, Math.round(img.width * factor));
    const h = Math.max(1, Math.round(img.height * factor));
    const canvas = rt.canvas.createCanvas(w, h);
    canvas.getContext('2d').drawImage?.(img, 0, 0, w, h);
    return Buffer.from(canvas.encodeSync('png'));
  } catch {
    return null;
  }
}

// ── 输出解析 ────────────────────────────────────────────────────

/** 按 `## 标题` 切分模型输出；已知小节名之外的内容并入原文 text，不静默丢弃 */
function parseVisionSections(text: string): {
  imageType: string | null;
  visibleElements: string | null;
  relations: string | null;
  visibleValues: string | null;
  uncertainties: string | null;
} {
  const lines = text.split(/\r?\n/);
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines) {
    const m = /^##\s*(.+?)\s*$/.exec(line);
    if (m) {
      current = m[1].trim();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current) sections.get(current)!.push(line);
  }
  const pick = (name: string): string | null => {
    const raw = (sections.get(name) ?? []).join('\n').trim();
    return raw.length > 0 ? raw : null;
  };
  return {
    imageType: pick('图类型'),
    visibleElements: pick('可见元素与信号'),
    relations: pick('关系或时序'),
    visibleValues: pick('可辨认数值'),
    uncertainties: pick('不确定项'),
  };
}

// ── 持久化路径 ──────────────────────────────────────────────────

function visionRecordPath(kbPath: string, sourceId: string, revision: string, assetId: string): string {
  return join(wikiLayout(kbPath).visionDir, sourceId, revision, `${assetId}.json`);
}

async function readVisionRecord(
  kbPath: string,
  sourceId: string,
  revision: string,
  assetId: string,
): Promise<WikiVisionInterpretation | null> {
  try {
    const raw = await readFile(visionRecordPath(kbPath, sourceId, revision, assetId), 'utf-8');
    const parsed = JSON.parse(raw) as WikiVisionInterpretation;
    return parsed?.assetId === assetId ? parsed : null;
  } catch {
    return null;
  }
}

// ── 单图解读 ────────────────────────────────────────────────────

const MEDIA_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function mediaTypeForExt(ext: string): string {
  return MEDIA_TYPE_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';
}

export type InterpretImageInput = {
  kbPath: string;
  sourceId: string;
  sourceRevision: string;
  asset: Pick<PdfAssetRecord, 'assetId' | 'ext' | 'method' | 'page' | 'width' | 'height'>;
  llm: VisionLlm;
  signal?: AbortSignal;
  /** 邻近文本 hash（issue 12 邻近文字未接入时为空串；指纹字段保留） */
  nearbyTextHash?: string;
  /** 解读输出语言（缺省中文；参与指纹，issue 13） */
  language?: string;
  /** 注入时钟（测试用） */
  now?: string;
};

/**
 * 使用中的异步请求去重（issue 13，spec §3）：同库 + 同来源修订 + 同上下文
 * 指纹的并发请求共享一次模型调用与落盘；不同上下文/模型不共享。
 * 槽位在请求结束后清理（失败也不占槽位，后续请求会真正重试）。
 */
const inflightInterpretations = new Map<string, Promise<WikiVisionInterpretation>>();

/**
 * 按指纹查找可复用的成功解读（null = 无可复用；失败记录一律不复用）。
 * runVisionPhase 批次预分类与 interpretImage 复用判断共用，保证指纹一致。
 */
async function reusableInterpretation(
  kbPath: string,
  sourceId: string,
  sourceRevision: string,
  asset: Pick<PdfAssetRecord, 'assetId' | 'width' | 'height'>,
  llm: Pick<VisionLlm, 'model'>,
  nearbyTextHash: string,
  language: string,
): Promise<WikiVisionInterpretation | null> {
  const existing = await readVisionRecord(kbPath, sourceId, sourceRevision, asset.assetId);
  if (!existing || existing.status !== 'ok') return null;
  const contextHash = visionContextHash({
    assetId: asset.assetId,
    model: llm.model,
    promptVersion: VISION_PROMPT_VERSION,
    nearbyTextHash,
    processParams: processParamsForDims(asset),
    language,
  });
  return existing.contextHash === contextHash ? existing : null;
}

/**
 * 解读单张受管资产图片。
 *
 * 不抛异常：模型失败 / 字节被破坏 / 资产缺失 / 超限无法安全缩小都返回
 * status=failed 的记录（失败不复用、不写成功缓存）。同上下文指纹的成功
 * 解读直接复用；并发同指纹请求共享一次调用（issue 13）。
 */
export async function interpretImage(input: InterpretImageInput): Promise<WikiVisionInterpretation> {
  const { kbPath, sourceId, sourceRevision, asset, llm, signal } = input;
  const language = input.language ?? VISION_DEFAULT_LANGUAGE;
  const nearbyTextHash = input.nearbyTextHash ?? '';
  const processParams = processParamsForDims(asset);
  const contextHash = visionContextHash({
    assetId: asset.assetId,
    model: llm.model,
    promptVersion: VISION_PROMPT_VERSION,
    nearbyTextHash,
    processParams,
    language,
  });
  const base = {
    assetId: asset.assetId,
    sourceId,
    sourceRevision,
    page: asset.page ?? null,
    method: asset.method,
    model: llm.model,
    promptVersion: VISION_PROMPT_VERSION,
    contextHash,
    processParams,
    language,
  };
  const fail = (errorCode: string, errorMessage: string, at: string): WikiVisionInterpretation => ({
    ...base,
    status: 'failed',
    imageType: null,
    visibleElements: null,
    relations: null,
    visibleValues: null,
    uncertainties: null,
    text: null,
    errorCode,
    errorMessage,
    interpretedAt: at,
  });

  const now = input.now ?? new Date().toISOString();

  const dedupKey = `${kbPath}|${sourceId}|${sourceRevision}|${contextHash}`;
  const joiner = inflightInterpretations.get(dedupKey);
  if (joiner) return joiner;

  const run = (async (): Promise<WikiVisionInterpretation> => {
    // 已取消：不再发起模型调用（runVisionPhase 循环层也会拦截）
    if (signal?.aborted) return persist(fail('aborted', '图像解读已取消', now));

    // 复用：同上下文指纹的成功解读不重复调用模型
    const reusable = await reusableInterpretation(
      kbPath, sourceId, sourceRevision, asset, llm, nearbyTextHash, language,
    );
    if (reusable) return reusable;

    // 受管字节：从资产目录解析（manifest 内登记的记录才可读），并校验内容 hash
    const file = await resolvePdfAssetFile(kbPath, sourceId, sourceRevision, asset.assetId);
    if (!file) {
      return persist(fail('assetNotFound', `资产文件不存在或未登记: ${asset.assetId.slice(0, 8)}`, now));
    }
    let bytes: Buffer;
    try {
      const s = await stat(file);
      if (!s.isFile()) throw new Error('not a file');
      bytes = await readFile(file);
    } catch (err) {
      return persist(fail('assetNotFound', `资产文件不可读: ${String(err)}`, now));
    }
    if (sha256Hex(bytes) !== asset.assetId) {
      // 内容寻址资产被外部改动 —— 不发送未知字节，也不调用模型
      return persist(fail('assetHashMismatch', '资产字节 hash 与 assetId 不符（文件被外部改动）', now));
    }

    // 发送尺寸上限（issue 13，spec §3）：超限图先本地等比缩小；
    // 无法安全处理时给可操作失败 —— 不发送超限未知字节，也不静默跳过。
    let prepared: { bytes: Buffer; mediaType: string } = { bytes, mediaType: mediaTypeForExt(asset.ext) };
    if (processParams !== 'orig') {
      const scaled = await downscaleForSend(bytes, VISION_MAX_EDGE);
      if (!scaled) {
        return persist(
          fail(
            'imageTooLarge',
            `图像 ${asset.width}x${asset.height} 超过发送上限 ${VISION_MAX_EDGE}px`
              + '且无法在本地安全缩小（解码失败或缺少本地图像运行时）',
            now,
          ),
        );
      }
      prepared = { bytes: scaled, mediaType: 'image/png' };
    }

    const prompt = buildVisionPrompt({
      sourceName: await sourceNameFor(kbPath, sourceId),
      page: asset.page ?? null,
      method: asset.method,
    });

    try {
      const r = await llm.invoke({
        system: prompt.system,
        user: prompt.user,
        images: [{ mediaType: prepared.mediaType, base64: prepared.bytes.toString('base64') }],
        maxTokens: VISION_MAX_TOKENS,
        signal,
      });
      // 响应已完整返回：即使期间收到取消信号也保留结果（已完成的解读不丢弃）
      const text = typeof r === 'string' ? r : r.text;
      const usage = typeof r === 'string' ? undefined : (r.usage ?? undefined);
      const sections = parseVisionSections(text);
      const rec: WikiVisionInterpretation = {
        ...base,
        status: 'ok',
        ...(usage ? { usage } : {}),
        ...sections,
        text,
        interpretedAt: now,
      };
      return persist(rec);
    } catch (err) {
      if (signal?.aborted) return persist(fail('aborted', '图像解读已取消', now));
      const message = err instanceof LlmCallError || err instanceof Error ? err.message : String(err);
      return persist(fail('llmFailed', message, now));
    }
  })();

  inflightInterpretations.set(dedupKey, run);
  try {
    return await run;
  } finally {
    if (inflightInterpretations.get(dedupKey) === run) inflightInterpretations.delete(dedupKey);
  }

  async function persist(rec: WikiVisionInterpretation): Promise<WikiVisionInterpretation> {
    const path = visionRecordPath(kbPath, sourceId, sourceRevision, asset.assetId);
    await mkdir(join(path, '..'), { recursive: true });
    await persistQueued(path, () => writeFileAtomic(path, JSON.stringify(rec, null, 2)));
    return rec;
  }
}

/**
 * 同一记录文件的并发写入串行化（issue 13）：同图不同上下文的解读共享
 * `<assetId>.json` 路径（issue 12 布局：每资产保留当前解读），并发原子
 * 替换在 Windows 上会 EPERM。按路径排队执行，前序写入完成（或失败）
 * 后再执行下一次；队列空转后清理槽位。
 */
const persistQueues = new Map<string, Promise<unknown>>();

function persistQueued(path: string, write: () => Promise<void>): Promise<void> {
  const prev = persistQueues.get(path) ?? Promise.resolve();
  const next = prev.then(write, write);
  persistQueues.set(path, next);
  void next
    .catch(() => undefined)
    .then(() => {
      if (persistQueues.get(path) === next) persistQueues.delete(path);
    });
  return next;
}

/** 来源显示名（manifest 的 sourcePath；manifest 不可读时回退 sourceId） */
async function sourceNameFor(kbPath: string, sourceId: string): Promise<string> {
  const read = await readWikiManifest(kbPath);
  return read.ok ? (read.manifest.sources?.[sourceId]?.sourcePath ?? sourceId) : sourceId;
}

/** 单图解读输出预算（解读是短事实输出；与参考 R13 的 4096 对齐并留思考余量） */
export const VISION_MAX_TOKENS = 4_096;

// ── 阶段执行 ────────────────────────────────────────────────────

/** 视觉阶段单批处理的页数上限（spec §3：每批最多 50 页；测试可注入更小值） */
export const VISION_MAX_BATCH_PAGES = 50;

export type VisionPhaseStats = {
  /** 唯一资产数（同图多次出现只解读一次） */
  total: number;
  /** 本次实际调用模型成功的数量 */
  interpreted: number;
  /** 直接复用既有成功解读的数量（不占批次页配额） */
  reused: number;
  failed: number;
  /** 页覆盖（issue 13，spec §3「不能默默只取前 N 张」）：含图页总数 / 本批处理页数 / 待处理页 */
  pages: { total: number; processed: number; pending: number[] };
};

export type VisionPhaseResult = {
  /** 来源是否含需要解读的资产（false = 视觉阶段 no-op） */
  needed: boolean;
  cancelled: boolean;
  /** 本次达到单批页数上限：待处理页见 stats.pages.pending（重试只处理剩余批次，不暗漏页） */
  batchLimitReached: boolean;
  /** 成功解读（含复用） */
  interpretations: WikiVisionInterpretation[];
  /** 失败记录（含 visionNotConfigured / aborted 之外的失败） */
  failures: WikiVisionInterpretation[];
  stats: VisionPhaseStats;
  /** 本次实际调用模型的真实 usage 合计（无 usage 时 null，不伪造 0；issue 13） */
  usage: LlmUsage | null;
};

/** usage 合计：只保留至少出现过一次的字段（缺失字段不伪造 0） */
function sumUsages(usages: LlmUsage[]): LlmUsage | null {
  if (usages.length === 0) return null;
  const sum = (key: 'inputTokens' | 'outputTokens' | 'totalTokens'): number | undefined => {
    if (!usages.some((u) => typeof u[key] === 'number')) return undefined;
    return usages.reduce<number>((acc, u) => acc + (typeof u[key] === 'number' ? u[key]! : 0), 0);
  };
  const out: LlmUsage = {};
  const inputTokens = sum('inputTokens');
  const outputTokens = sum('outputTokens');
  const totalTokens = sum('totalTokens');
  if (inputTokens !== undefined) out.inputTokens = inputTokens;
  if (outputTokens !== undefined) out.outputTokens = outputTokens;
  if (totalTokens !== undefined) out.totalTokens = totalTokens;
  return out;
}

/**
 * 执行一个来源的视觉解读阶段（issue 13 批量语义）：
 *
 *  - 先按指纹预分类：已有同指纹成功解读的资产直接复用（不调用模型、
 *    不占批次页配额）；其余资产按页分组（无页码资产归入首批、视作一个
 *    页组），按页码升序每批最多 VISION_MAX_BATCH_PAGES 页；
 *  - 达到单批上限时停止：返回 batchLimitReached=true 与待处理页清单
 *    （stats.pages.pending），不暗漏页 —— 重试任务只处理剩余批次；
 *  - 逐张顺序执行（默认并发 1，spec §3）；单张失败保留失败记录继续其余图
 *    （失败页计入已处理页，重试只重做失败项）；
 *  - 外部 signal 取消时已完成解读保留（已持久化），返回 cancelled=true。
 */
export async function runVisionPhase(input: {
  kbPath: string;
  sourceId: string;
  sourceRevision: string;
  llm: VisionLlm | null;
  signal?: AbortSignal;
  now?: string;
  /** 单批页数上限（默认 50，spec §3） */
  maxBatchPages?: number;
  /** 解读输出语言（缺省中文；参与指纹） */
  language?: string;
  /** 邻近文本 hash（与 interpretImage 一致；影响指纹与复用判断） */
  nearbyTextHash?: string;
  /** 逐张进度回调（done/total/reused；队列据此展示 vision 阶段进度与缓存命中） */
  onProgress?: (progress: { done: number; total: number; reused?: number }) => void;
}): Promise<VisionPhaseResult> {
  const manifest = await readPdfAssetManifest(input.kbPath, input.sourceId, input.sourceRevision);
  const assets = manifest?.assets ?? [];
  if (assets.length === 0) {
    return {
      needed: false,
      cancelled: false,
      batchLimitReached: false,
      interpretations: [],
      failures: [],
      stats: { total: 0, interpreted: 0, reused: 0, failed: 0, pages: { total: 0, processed: 0, pending: [] } },
      usage: null,
    };
  }

  const language = input.language ?? VISION_DEFAULT_LANGUAGE;
  const nearbyTextHash = input.nearbyTextHash ?? '';
  const maxBatchPages = Math.max(1, input.maxBatchPages ?? VISION_MAX_BATCH_PAGES);

  // 唯一资产（同图多次出现只解读一次；位置记录保留在资产清单）
  const unique = new Map<string, PdfAssetRecord>();
  for (const a of assets) {
    if (!unique.has(a.assetId)) unique.set(a.assetId, a);
  }
  const stats: VisionPhaseStats = {
    total: unique.size,
    interpreted: 0,
    reused: 0,
    failed: 0,
    pages: { total: 0, processed: 0, pending: [] },
  };
  const interpretations: WikiVisionInterpretation[] = [];
  const failures: WikiVisionInterpretation[] = [];
  const usages: LlmUsage[] = [];
  let done = 0;
  const progress = (): void => input.onProgress?.({ done, total: unique.size, reused: stats.reused });

  // 预分类：指纹匹配的成功解读直接复用（不占批次页配额、不调用模型）
  const needWork: PdfAssetRecord[] = [];
  for (const asset of unique.values()) {
    if (input.llm) {
      const reusable = await reusableInterpretation(
        input.kbPath, input.sourceId, input.sourceRevision, asset, input.llm, nearbyTextHash, language,
      );
      if (reusable) {
        interpretations.push(reusable);
        stats.reused += 1;
        done += 1;
        progress();
        continue;
      }
    }
    needWork.push(asset);
  }

  // 页覆盖：含图页总数（含复用页）；待处理资产按页分组（无页码资产归入首批）
  const allPages = new Set<number | null>();
  for (const a of unique.values()) allPages.add(a.page ?? null);
  stats.pages.total = allPages.size;

  const byPage = new Map<number | null, PdfAssetRecord[]>();
  for (const a of needWork) {
    const key = a.page ?? null;
    const bucket = byPage.get(key);
    if (bucket) bucket.push(a);
    else byPage.set(key, [a]);
  }
  const pageKeys = [...byPage.keys()].sort((x, y) => {
    if (x === null) return -1; // 无页码资产没有页范围语义，始终随首批处理
    if (y === null) return 1;
    return x - y;
  });

  // 未配置视觉模型（issue 12 行为保留）：全部待处理资产记为 visionNotConfigured
  // 失败（结果层；不写盘、不覆盖既有成功解读），由编译层转 blocked。
  if (!input.llm) {
    for (const asset of needWork) {
      failures.push({
        assetId: asset.assetId,
        sourceId: input.sourceId,
        sourceRevision: input.sourceRevision,
        page: asset.page ?? null,
        method: asset.method,
        model: '',
        promptVersion: VISION_PROMPT_VERSION,
        contextHash: '',
        status: 'failed',
        imageType: null,
        visibleElements: null,
        relations: null,
        visibleValues: null,
        uncertainties: null,
        text: null,
        errorCode: 'visionNotConfigured',
        errorMessage: '未配置视觉模型（设置 → 知识库 → 视觉模型）',
        interpretedAt: input.now ?? new Date().toISOString(),
      });
      stats.failed += 1;
      done += 1;
      progress();
    }
    stats.pages.processed = byPage.size;
    return { needed: true, cancelled: false, batchLimitReached: false, interpretations, failures, stats, usage: null };
  }

  // 单批页数上限（spec §3）：超出的页保持待处理，等待继续批次/缩小范围
  const batchPages = pageKeys.slice(0, maxBatchPages);
  const pendingPages = pageKeys.slice(maxBatchPages);
  const batchLimitReached = pendingPages.length > 0;
  stats.pages.pending = pendingPages.filter((p): p is number => p !== null);

  let cancelled = false;
  outer: for (const pageKey of batchPages) {
    for (const asset of byPage.get(pageKey)!) {
      if (input.signal?.aborted) {
        cancelled = true;
        break outer;
      }
      const rec = await interpretImage({
        kbPath: input.kbPath,
        sourceId: input.sourceId,
        sourceRevision: input.sourceRevision,
        asset,
        llm: input.llm,
        signal: input.signal,
        now: input.now,
        language,
        nearbyTextHash,
      });
      if (rec.status === 'ok') {
        interpretations.push(rec);
        stats.interpreted += 1;
        if (rec.usage) usages.push(rec.usage);
      } else if (rec.errorCode === 'aborted') {
        cancelled = true;
        break outer;
      } else {
        failures.push(rec);
        stats.failed += 1;
      }
      done += 1;
      progress();
    }
    stats.pages.processed += 1;
  }

  return { needed: true, cancelled, batchLimitReached, interpretations, failures, stats, usage: sumUsages(usages) };
}

/**
 * 单图独立重试（issue 13）：按资产清单定位单张解读，只重做该图 ——
 * 其余成功/失败记录保持不变。assetId 不在当前修订清单时返回 null
 * （不伪造记录）。已成功且同指纹的图直接复用（不重复调用模型）。
 */
export async function retryVisionAsset(input: {
  kbPath: string;
  sourceId: string;
  sourceRevision: string;
  assetId: string;
  llm: VisionLlm;
  signal?: AbortSignal;
  now?: string;
  language?: string;
  nearbyTextHash?: string;
}): Promise<WikiVisionInterpretation | null> {
  const manifest = await readPdfAssetManifest(input.kbPath, input.sourceId, input.sourceRevision);
  const asset = manifest?.assets.find((a) => a.assetId === input.assetId);
  if (!asset) return null;
  return interpretImage({
    kbPath: input.kbPath,
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    asset,
    llm: input.llm,
    signal: input.signal,
    now: input.now,
    language: input.language,
    nearbyTextHash: input.nearbyTextHash,
  });
}

/**
 * 构建编译输入的视觉附录（issue 12，spec §3「视觉解读作为编译输入附录」）。
 *
 * 只收编成功解读；附录明确标注「模型图像解读（非原文）」，携带 assetId
 * 供审阅时与原图并排核对。本函数不写 raw/parsed —— 附录只进编译提示词。
 */
export function buildVisionAppendix(records: ReadonlyArray<WikiVisionInterpretation>): string {
  const ok = records.filter((r) => r.status === 'ok');
  if (ok.length === 0) return '';
  const items = ok.map((r) => {
    const where = r.page !== null ? `第 ${r.page} 页` : '无页码';
    const section = (label: string, value: string | null): string =>
      `- ${label}：${value && value.trim().length > 0 ? value.trim() : '无'}`;
    return [
      `### assetId=${r.assetId.slice(0, 8)}（${where}；${r.method === 'page-render' ? '整页渲染图' : '提取的嵌入图像'}）`,
      section('图类型', r.imageType),
      section('可见元素与信号', r.visibleElements),
      section('关系或时序', r.relations),
      section('可辨认数值', r.visibleValues),
      section('不确定项', r.uncertainties),
    ].join('\n');
  });
  return [
    '## 附录：模型图像解读（非原文）',
    '',
    '以下小节由视觉模型对来源中的嵌入图像生成，仅作为理解图像的辅助输入；'
      + '所有内容以原文与原图为准，本附录不属于机械转换全文。'
      + '引用其中内容时必须在页面中注明「模型图像解读」。',
    '',
    items.join('\n\n'),
  ].join('\n');
}

// ── 读取（UI/编译消费） ─────────────────────────────────────────

/**
 * 读取来源的全部解读记录（任意状态）。
 *
 * 修订解析优先级：显式 revision → 资产清单当前修订 → 枚举 vision 目录下的
 * 修订子目录（清单不可用/已重建时仍可读回历史解读）。
 * 无任何记录返回 null（与「解读过但全失败」区分）。
 */
export async function readVisionInterpretations(
  kbPath: string,
  sourceId: string,
  revision?: string,
): Promise<WikiVisionInterpretation[] | null> {
  const visionRoot = join(wikiLayout(kbPath).visionDir, sourceId);
  let revs: string[];
  if (revision) {
    revs = [revision];
  } else {
    const manifest = await readPdfAssetManifest(kbPath, sourceId);
    if (manifest?.revision) {
      revs = [manifest.revision];
    } else {
      try {
        const entries = await readdir(visionRoot, { withFileTypes: true });
        revs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
      } catch {
        return null;
      }
    }
  }
  const out: WikiVisionInterpretation[] = [];
  for (const rev of revs) {
    const dir = join(visionRoot, rev);
    let names: string[];
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) continue;
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(await readFile(join(dir, name), 'utf-8')) as WikiVisionInterpretation;
        if (rec?.assetId) out.push(rec);
      } catch {
        // 坏记录跳过（不静默丢解读 —— UI 显示数量以能解析的为准）
      }
    }
  }
  return out.length > 0 ? out : null;
}

// ── 图片能力独立验证（spec §3：文本 chat 成功不代表支持图片） ────

/** 1x1 透明 PNG（验证用最小图片） */
const VERIFY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export type VisionVerifyOutcome =
  | { ok: true; model: string; sample: string }
  | { ok: false; error: { kind: VisionVerifyErrorKind; message: string } };

export type VisionVerifyErrorKind =
  | 'notConfigured'
  | 'authError'
  | 'modelNotFound'
  | 'imageRejected'
  | 'rateLimited'
  | 'networkError'
  | 'apiError';

/**
 * 以真实请求验证当前 vision 角色配置的图片输入能力。
 *
 * 发送一张 1x1 PNG + 极短指令；任何成功响应都证明端点接受了图片字节。
 * 错误按可操作类别区分（未配置/认证/模型不存在/图片被拒/限流/网络/API 异常），
 * 供设置页给出对应修复入口。这是用户主动触发的真实网络调用。
 */
export async function verifyVisionModel(config: LlmConfig): Promise<VisionVerifyOutcome> {
  try {
    const r = await callLlm(config, {
      system: '图片输入能力验证。只回复 OK。',
      user: '请回复 OK',
      images: [{ mediaType: 'image/png', base64: VERIFY_PNG_BASE64 }],
      maxTokens: 512,
      timeoutMs: 30_000,
    });
    return { ok: true, model: config.model, sample: r.text.slice(0, 100) };
  } catch (err) {
    const e = err instanceof LlmCallError ? err : new LlmCallError(String(err), false);
    const kind: VisionVerifyErrorKind = classifyVerifyError(e);
    return { ok: false, error: { kind, message: e.message } };
  }
}

function classifyVerifyError(e: LlmCallError): VisionVerifyErrorKind {
  if (e.status === 401 || e.status === 403) return 'authError';
  if (e.status === 404) return 'modelNotFound';
  // 携带合法最小图片仍 400/422：端点拒绝图片输入（文本对话可成功不代表支持图片）
  if (e.status === 400 || e.status === 422) return 'imageRejected';
  if (e.status === 429) return 'rateLimited';
  // 无 HTTP 状态的可重试失败：网络/超时/取消；网关 200 + 非 JSON 属 API 异常
  if (e.retryable && e.status === undefined) {
    return e.message.includes('不是有效 JSON') ? 'apiError' : 'networkError';
  }
  return 'apiError';
}
