/**
 * Wiki Layout — LLM Wiki 新布局的单一拥有者（layout.ts 的替代实现）。
 *
 * ADR 0034 定下的库结构（spec §1）：
 *
 *   <kbRoot>/
 *     schema.md               写作规则 + Page Types 路由（受约束表）
 *     purpose.md              库目标描述
 *     raw/
 *       sources/<sourcePath>  最新原始字节（受保护）
 *       revisions/<sourceId>/<sourceRevision>/
 *       parsed/<sourcePath>.md
 *       assets/<sourceId>/<sourceRevision>/
 *     wiki/
 *       <类型目录>/<pageId>.md、index.md、overview.md、log.md
 *     .kb/
 *       manifest.json         库身份（kbId 持久于库内，与本机根路径分离）
 *       staging/ reviews/ page-history/ transactions/ vectors/ vision/
 *
 * 路径推导只由本模块拥有；派生索引目录（vectors 等）在应用内部状态
 * 目录的方案由后继票定，本模块先保留占位目录语义。
 *
 * @see ADR 0034 — 知识库重构为 LLM Wiki 双层架构
 */

import { join } from 'node:path';
import { mkdir, readdir, stat, writeFile, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { writeFileAtomic } from './atomic-commit';
import type { WikiSourceRecord } from '@shared/kb-types';

// ── 布局快照 ────────────────────────────────────────────────────

export type WikiLayoutPaths = {
  /** 库根目录（本机路径，只存在于注册表/调用方，不写入库内持久化） */
  readonly kbPath: string;
  readonly schemaMdPath: string;
  readonly purposeMdPath: string;
  readonly rawDir: string;
  readonly rawSourcesDir: string;
  readonly rawRevisionsDir: string;
  readonly rawParsedDir: string;
  readonly rawAssetsDir: string;
  readonly wikiDir: string;
  /** .kb/ 元数据目录 */
  readonly kbDir: string;
  readonly manifestPath: string;
  readonly stagingDir: string;
  readonly reviewsDir: string;
  readonly pageHistoryDir: string;
  readonly transactionsDir: string;
  readonly vectorsDir: string;
  readonly visionDir: string;
  /** 长来源分段编译 checkpoint（未发布模型中间产物；spec §1、§4；issue 10） */
  readonly compileCheckpointsDir: string;
};

export function wikiLayout(kbPath: string): WikiLayoutPaths {
  const rawDir = join(kbPath, 'raw');
  const wikiDir = join(kbPath, 'wiki');
  const kbDir = join(kbPath, '.kb');
  return {
    kbPath,
    schemaMdPath: join(kbPath, 'schema.md'),
    purposeMdPath: join(kbPath, 'purpose.md'),
    rawDir,
    rawSourcesDir: join(rawDir, 'sources'),
    rawRevisionsDir: join(rawDir, 'revisions'),
    rawParsedDir: join(rawDir, 'parsed'),
    rawAssetsDir: join(rawDir, 'assets'),
    wikiDir,
    kbDir,
    manifestPath: join(kbDir, 'manifest.json'),
    stagingDir: join(kbDir, 'staging'),
    reviewsDir: join(kbDir, 'reviews'),
    pageHistoryDir: join(kbDir, 'page-history'),
    transactionsDir: join(kbDir, 'transactions'),
    vectorsDir: join(kbDir, 'vectors'),
    visionDir: join(kbDir, 'vision'),
    compileCheckpointsDir: join(kbDir, 'compile-checkpoints'),
  };
}

// ── Manifest ────────────────────────────────────────────────────

/** 库身份清单（.kb/manifest.json）。来源修订/转换状态持久于此（spec §1）。 */
export type WikiKbManifest = {
  manifestVersion: 1;
  format: 'wiki';
  /** 稳定库 ID；注册表保存 kbId → 本机根路径映射 */
  kbId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 来源修订与转换状态（sourceId → 记录）；issue 02 引入，旧 manifest 无此字段 */
  sources?: Record<string, WikiSourceRecord>;
  /**
   * 发布进度（spec §1「发布 revision」；issue 06 引入）。
   * revision 单调递增，与 commitId 一并写入同一次提交。
   */
  publish?: {
    revision: number;
    commitId: string;
    at: string;
  };
};

export type ManifestReadResult =
  | { ok: true; manifest: WikiKbManifest }
  | { ok: false; reason: 'missing' | 'corrupt' };

/** 读取库身份清单。missing = 文件不存在；corrupt = 存在但不可解析/结构非法。 */
export async function readWikiManifest(kbPath: string): Promise<ManifestReadResult> {
  const layout = wikiLayout(kbPath);
  let content: string;
  try {
    content = await readFile(layout.manifestPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: 'missing' };
    }
    return { ok: false, reason: 'corrupt' };
  }
  try {
    const manifest = JSON.parse(content) as WikiKbManifest;
    if (
      manifest.manifestVersion !== 1
      || manifest.format !== 'wiki'
      || typeof manifest.kbId !== 'string'
      || manifest.kbId.length === 0
    ) {
      return { ok: false, reason: 'corrupt' };
    }
    return { ok: true, manifest };
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
}

/** 原子写入库身份清单（临时文件 + rename）。调用方负责更新 updatedAt。 */
export async function writeWikiManifest(kbPath: string, manifest: WikiKbManifest): Promise<void> {
  const layout = wikiLayout(kbPath);
  await writeManifestAt(layout.manifestPath, manifest);
}

// ── manifest 读改写串行化 ────────────────────────────────────────

const manifestLocks = new Map<string, Promise<unknown>>();

/**
 * 串行化同一库的「读 manifest → 变更 → 写 manifest」临界区。
 *
 * 多 worker 并发转换/导入与队列任务并发时，manifest.json 是单点共享文件：
 * 并发原子替换在 Windows 上会触发 rename EPERM，且以旧读为基的写回会
 * 丢更新。临界区内每次都应以 `readWikiManifest` 的新鲜读为基。
 */
export async function withManifestLock<T>(kbPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = manifestLocks.get(kbPath) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  manifestLocks.set(kbPath, run.catch(() => undefined));
  return run;
}

// ── 初始化 ──────────────────────────────────────────────────────

export const SCHEMA_MD_SKELETON = [
  '# Schema — 写作规则',
  '',
  '本文件约束知识页的类型路由与写作要求。`## Page Types` 是受约束表：',
  '类型完整且唯一、目录唯一且位于 wiki/ 内；无法解析或冲突时编译报错停止。',
  '',
  '## Page Types',
  '',
  '| type | 目录 | 说明 |',
  '| --- | --- | --- |',
  '| source | sources | 单一来源的结构化摘要 |',
  '| entity | entities | 实体页：IP、模块、信号组 |',
  '| concept | concepts | 概念与协议规则 |',
  '| comparison | comparisons | 跨来源对照 |',
  '| synthesis | synthesis | 综合结论页 |',
  '| query | queries | 保存的问答页 |',
  '| pitfall | pitfalls | 已知问题：现象 → 根因 → 规避 → 证据 |',
  '| interface | interfaces | 接口：信号表、位段、时序 |',
  '',
  '## Writing Rules',
  '',
  '- 页面之间用 `[[pageId|显示名]]` 双链引用。',
  '- 关键寄存器名、单位、位宽、复位值、时序条件必须保留原值。',
  '- 文档新旧或协议/DUT 差异并列标出处置范围，不按导入时间认定权威。',
  '',
].join('\n');

export const PURPOSE_MD_SKELETON = [
  '# Purpose — 知识库目标',
  '',
  '（描述这个知识库要沉淀什么知识、服务什么验证工作。',
  '编译与检索会用到这里的目标描述。）',
  '',
].join('\n');

/**
 * 在空目录初始化完整标准结构。假定调用方已完成空目录判定
 * （detectKbFormat === 'empty'）；已存在的文件不会被覆盖。
 */
export async function initWikiLayout(
  kbPath: string,
  identity: { kbId: string; name: string },
): Promise<WikiKbManifest> {
  const layout = wikiLayout(kbPath);
  await Promise.all([
    mkdir(layout.rawSourcesDir, { recursive: true }),
    mkdir(layout.rawRevisionsDir, { recursive: true }),
    mkdir(layout.rawParsedDir, { recursive: true }),
    mkdir(layout.rawAssetsDir, { recursive: true }),
    mkdir(layout.wikiDir, { recursive: true }),
    mkdir(layout.stagingDir, { recursive: true }),
    mkdir(layout.reviewsDir, { recursive: true }),
    mkdir(layout.pageHistoryDir, { recursive: true }),
    mkdir(layout.transactionsDir, { recursive: true }),
    mkdir(layout.vectorsDir, { recursive: true }),
    mkdir(layout.visionDir, { recursive: true }),
  ]);

  await writeIfMissing(layout.schemaMdPath, SCHEMA_MD_SKELETON);
  await writeIfMissing(layout.purposeMdPath, PURPOSE_MD_SKELETON);

  const now = new Date().toISOString();
  const manifest: WikiKbManifest = {
    manifestVersion: 1,
    format: 'wiki',
    kbId: identity.kbId,
    name: identity.name,
    createdAt: now,
    updatedAt: now,
  };
  await writeManifestAt(layout.manifestPath, manifest);
  return manifest;
}

/** 原子写入 manifest（按给定清单路径）。 */
async function writeManifestAt(manifestPath: string, manifest: WikiKbManifest): Promise<void> {
  await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * 更新库身份清单（名称变更、副本赋新 kbId 等）。
 * 要求 manifest 已存在且可读；updatedAt 由本函数统一刷新。
 */
export async function updateWikiManifest(
  kbPath: string,
  patch: Partial<Pick<WikiKbManifest, 'kbId' | 'name'>>,
): Promise<WikiKbManifest> {
  const layout = wikiLayout(kbPath);
  const read = await readWikiManifest(kbPath);
  if (!read.ok) {
    throw new Error(`无法更新 manifest: ${read.reason}`);
  }
  const updated: WikiKbManifest = {
    ...read.manifest,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeManifestAt(layout.manifestPath, updated);
  return updated;
}

// ── 格式探测 ────────────────────────────────────────────────────

/** 目录格式。unreadable = stat/readdir 失败（离线/权限/已删除），绝不能当旧格式处置。 */
export type KbDirFormat = 'wiki' | 'legacy' | 'empty' | 'foreign' | 'unreadable';

export type KbDirFormatResult = {
  kind: KbDirFormat;
  /** kind=unreadable 时的底层错误（调用方按 code 细分提示） */
  error?: NodeJS.ErrnoException;
};

/**
 * 探测目录格式（不读 manifest 内容，只判断标记）：
 *   - `.kb/manifest.json` 存在                    → wiki（内容有效性由 readWikiManifest 判定）
 *   - 同时存在 `sources/` 与 `docs/` 目录         → legacy（旧 ADR 0021 布局；
 *     与旧 register 的接受条件一致，避免把恰好含 docs/ 的普通目录误判为旧库）
 *   - 目录无任何条目                              → empty
 *   - 其余                                        → foreign
 */
export async function detectKbFormat(kbPath: string): Promise<KbDirFormatResult> {
  let entries: Dirent[];
  try {
    const s = await stat(kbPath);
    if (!s.isDirectory()) {
      return { kind: 'foreign' };
    }
    entries = await readdir(kbPath, { withFileTypes: true });
  } catch (err) {
    return { kind: 'unreadable', error: err as NodeJS.ErrnoException };
  }

  const has = (name: string, wantDir: boolean): boolean =>
    entries.some((e) => e.name === name && (wantDir ? e.isDirectory() : e.isFile()));

  if (has('.kb', true)) {
    try {
      const s = await stat(join(kbPath, '.kb', 'manifest.json'));
      if (s.isFile()) return { kind: 'wiki' };
    } catch {
      // .kb 存在但无 manifest → 落入后续判定
    }
  }
  if (has('sources', true) && has('docs', true)) {
    return { kind: 'legacy' };
  }
  if (entries.length === 0) {
    return { kind: 'empty' };
  }
  return { kind: 'foreign' };
}

// ── 健康检查 ────────────────────────────────────────────────────

/** wiki 布局健康检查（kb.status 使用）。 */
export async function checkWikiHealth(kbPath: string): Promise<{
  hasSchema: boolean;
  hasPurpose: boolean;
  hasManifest: boolean;
  hasRaw: boolean;
  hasWiki: boolean;
}> {
  const layout = wikiLayout(kbPath);
  const check = async (p: string): Promise<boolean> => {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  };
  const [hasSchema, hasPurpose, hasManifest, hasRaw, hasWiki] = await Promise.all([
    check(layout.schemaMdPath),
    check(layout.purposeMdPath),
    check(layout.manifestPath),
    check(layout.rawDir),
    check(layout.wikiDir),
  ]);
  return { hasSchema, hasPurpose, hasManifest, hasRaw, hasWiki };
}

// ── 内部工具 ────────────────────────────────────────────────────

async function writeIfMissing(filePath: string, content: string): Promise<void> {
  try {
    const existing = await readFile(filePath, 'utf-8');
    if (existing.length > 0) return;
  } catch {
    // 不存在 → 写入
  }
  await writeFile(filePath, content, 'utf-8');
}

// ── 原件解析 ────────────────────────────────────────────────────

export type ResolveOriginalQuery = {
  sourceId: string;
  /** 缺省 = 当前原件；指定历史修订时从 revisions 区解析 */
  revision?: string;
};

/**
 * 从身份解析原件绝对路径（预览/导出/资产提取用，不接受任意路径）。
 * 未知来源或盘上文件缺失返回 null。
 */
export async function resolveWikiOriginalPath(kbPath: string, query: ResolveOriginalQuery): Promise<string | null> {
  const layout = wikiLayout(kbPath);
  const read = await readWikiManifest(kbPath);
  if (!read.ok) return null;
  const rec = read.manifest.sources?.[query.sourceId];
  if (!rec) return null;

  if (!query.revision || query.revision === rec.currentRevision) {
    return fileOrNull(join(layout.rawSourcesDir, ...rec.sourcePath.split('/')));
  }
  const revDir = join(layout.rawRevisionsDir, rec.sourceId, query.revision);
  try {
    const entries = await readdir(revDir, { withFileTypes: true });
    const original = entries.find((e) => e.isFile() && e.name !== 'assets.json');
    return original ? join(revDir, original.name) : null;
  } catch {
    return null;
  }
}

async function fileOrNull(abs: string): Promise<string | null> {
  try {
    const s = await stat(abs);
    return s.isFile() ? abs : null;
  } catch {
    return null;
  }
}
