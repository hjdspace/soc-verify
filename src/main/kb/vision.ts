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
 *  - 复用判断：同 assetId + 同上下文指纹（模型 + 提示版本 + 邻近文本 hash）
 *    的成功解读不重复调用模型；失败记录不复用（重试重算）；失败不写成功缓存；
 *  - 精确参数不可无证据补齐：提示词强制「不清晰」原样报告，禁止换算。
 *
 * 批量缓存/去重/续跑属 issue 13；本模块只提供单图语义与逐张顺序执行
 * （默认并发 1），不做持久缓存优化。
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
import { wikiLayout } from './wiki-layout';
import { readPdfAssetManifest, resolvePdfAssetFile } from './pdf-asset-store';
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

/** 上下文指纹：图片字节 hash（assetId）+ 模型 + 提示版本 + 邻近文本 hash */
export function visionContextHash(input: {
  assetId: string;
  model: string;
  promptVersion: string;
  nearbyTextHash: string;
}): string {
  return createHash('sha256')
    .update([input.assetId, input.model, input.promptVersion, input.nearbyTextHash].join('|'), 'utf-8')
    .digest('hex');
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
  asset: Pick<PdfAssetRecord, 'assetId' | 'ext' | 'method' | 'page'>;
  llm: VisionLlm;
  signal?: AbortSignal;
  /** 邻近文本 hash（issue 12 邻近文字未接入时为空串；指纹字段保留） */
  nearbyTextHash?: string;
  /** 注入时钟（测试用） */
  now?: string;
};

/**
 * 解读单张受管资产图片。
 *
 * 不抛异常：模型失败 / 字节被破坏 / 资产缺失都返回 status=failed 的记录
 * （失败不复用、不写成功缓存）。同上下文指纹的成功解读直接复用。
 */
export async function interpretImage(input: InterpretImageInput): Promise<WikiVisionInterpretation> {
  const { kbPath, sourceId, sourceRevision, asset, llm, signal } = input;
  const base = {
    assetId: asset.assetId,
    sourceId,
    sourceRevision,
    page: asset.page ?? null,
    method: asset.method,
    model: llm.model,
    promptVersion: VISION_PROMPT_VERSION,
  };
  const fail = (errorCode: string, errorMessage: string, at: string): WikiVisionInterpretation => ({
    ...base,
    contextHash: visionContextHash({ assetId: asset.assetId, model: llm.model, promptVersion: VISION_PROMPT_VERSION, nearbyTextHash: input.nearbyTextHash ?? '' }),
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

  // 已取消：不再发起模型调用（runVisionPhase 循环层也会拦截）
  if (signal?.aborted) return persist(fail('aborted', '图像解读已取消', now));

  // 复用：同上下文指纹的成功解读不重复调用模型（issue 13 做批量缓存优化）
  const contextHash = visionContextHash({
    assetId: asset.assetId,
    model: llm.model,
    promptVersion: VISION_PROMPT_VERSION,
    nearbyTextHash: input.nearbyTextHash ?? '',
  });
  const existing = await readVisionRecord(kbPath, sourceId, sourceRevision, asset.assetId);
  if (existing && existing.status === 'ok' && existing.contextHash === contextHash) {
    return existing;
  }

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

  const prompt = buildVisionPrompt({
    sourceName: await sourceNameFor(kbPath, sourceId),
    page: asset.page ?? null,
    method: asset.method,
  });

  try {
    const r = await llm.invoke({
      system: prompt.system,
      user: prompt.user,
      images: [{ mediaType: mediaTypeForExt(asset.ext), base64: bytes.toString('base64') }],
      maxTokens: VISION_MAX_TOKENS,
      signal,
    });
    // 响应已完整返回：即使期间收到取消信号也保留结果（已完成的解读不丢弃）
    const text = typeof r === 'string' ? r : r.text;
    const sections = parseVisionSections(text);
    const rec: WikiVisionInterpretation = {
      ...base,
      contextHash,
      status: 'ok',
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

  async function persist(rec: WikiVisionInterpretation): Promise<WikiVisionInterpretation> {
    const path = visionRecordPath(kbPath, sourceId, sourceRevision, asset.assetId);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFileAtomic(path, JSON.stringify(rec, null, 2));
    return rec;
  }
}

/** 来源显示名（manifest 的 sourcePath；manifest 不可读时回退 sourceId） */
async function sourceNameFor(kbPath: string, sourceId: string): Promise<string> {
  const { readWikiManifest } = await import('./wiki-layout');
  const read = await readWikiManifest(kbPath);
  return read.ok ? (read.manifest.sources?.[sourceId]?.sourcePath ?? sourceId) : sourceId;
}

/** 单图解读输出预算（解读是短事实输出；与参考 R13 的 4096 对齐并留思考余量） */
export const VISION_MAX_TOKENS = 4_096;

// ── 阶段执行 ────────────────────────────────────────────────────

export type VisionPhaseStats = {
  /** 唯一资产数（同图多次出现只解读一次） */
  total: number;
  /** 本次实际调用模型成功的数量 */
  interpreted: number;
  /** 直接复用既有成功解读的数量 */
  reused: number;
  failed: number;
};

export type VisionPhaseResult = {
  /** 来源是否含需要解读的资产（false = 视觉阶段 no-op） */
  needed: boolean;
  cancelled: boolean;
  /** 成功解读（含复用） */
  interpretations: WikiVisionInterpretation[];
  /** 失败记录（含 visionNotConfigured / aborted 之外的失败） */
  failures: WikiVisionInterpretation[];
  stats: VisionPhaseStats;
};

/**
 * 执行一个来源的视觉解读阶段：按资产清单逐张解读（顺序执行，默认并发 1）。
 *
 * 不抛异常：单图失败保留失败记录继续后续图（重试只重做失败项）；
 * 外部 signal 取消时已完成解读保留（已持久化），返回 cancelled=true。
 */
export async function runVisionPhase(input: {
  kbPath: string;
  sourceId: string;
  sourceRevision: string;
  llm: VisionLlm | null;
  signal?: AbortSignal;
  now?: string;
  /** 逐张进度回调（done/total；队列据此展示 vision 阶段进度） */
  onProgress?: (progress: { done: number; total: number }) => void;
}): Promise<VisionPhaseResult> {
  const manifest = await readPdfAssetManifest(input.kbPath, input.sourceId, input.sourceRevision);
  const assets = manifest?.assets ?? [];
  if (assets.length === 0) {
    return { needed: false, cancelled: false, interpretations: [], failures: [], stats: { total: 0, interpreted: 0, reused: 0, failed: 0 } };
  }

  // 唯一资产（同图多次出现只解读一次；位置记录保留在资产清单）
  const unique = new Map<string, (typeof assets)[number]>();
  for (const a of assets) {
    if (!unique.has(a.assetId)) unique.set(a.assetId, a);
  }
  const stats: VisionPhaseStats = { total: unique.size, interpreted: 0, reused: 0, failed: 0 };
  const interpretations: WikiVisionInterpretation[] = [];
  const failures: WikiVisionInterpretation[] = [];
  let done = 0;

  for (const asset of unique.values()) {
    if (input.signal?.aborted) {
      return { needed: true, cancelled: true, interpretations, failures, stats };
    }
    if (!input.llm) {
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
      input.onProgress?.({ done, total: unique.size });
      continue;
    }
    const before = await readVisionRecord(input.kbPath, input.sourceId, input.sourceRevision, asset.assetId);
    const rec = await interpretImage({
      kbPath: input.kbPath,
      sourceId: input.sourceId,
      sourceRevision: input.sourceRevision,
      asset,
      llm: input.llm,
      signal: input.signal,
      now: input.now,
    });
    if (rec.status === 'ok') {
      interpretations.push(rec);
      if (before && before.status === 'ok' && before.contextHash === rec.contextHash) stats.reused += 1;
      else stats.interpreted += 1;
    } else if (rec.errorCode === 'aborted') {
      return { needed: true, cancelled: true, interpretations, failures, stats };
    } else {
      failures.push(rec);
      stats.failed += 1;
    }
    done += 1;
    input.onProgress?.({ done, total: unique.size });
  }

  return { needed: true, cancelled: false, interpretations, failures, stats };
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
