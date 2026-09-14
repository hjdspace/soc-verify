/**
 * Knowledge Base Pipeline — 上传 → 转换 → 分类 → 索引。
 *
 * 核心职责：
 *  1. upload：文件复制到 sources/ → 转换 → LLM 分类 → 归位 docs/<分类>/ → 合并 index.md
 *  2. listDocuments：扫描 docs/ 返回文档列表（含状态/大小/分类）
 *  3. deleteDocument：清理源文件 + Markdown + assets + 索引条目
 *  4. retryDocument：重试失败转换
 *  5. listCategories：返回分类树 + 计数
 *
 * 状态与进度通过回调推送（router 层连接到 webContents.send）。
 *
 * 布局知识（路径推导、文档发现、清理操作）由 `layout.ts` 单一拥有，
 * 本模块只消费 `kbLayout(kbPath)` 的接口，不再手工拼接路径。
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

import { basename, extname, dirname } from 'node:path';
import { readFile, writeFile, mkdir, rm, readdir, stat, rename } from 'node:fs/promises';
import { convertDocument } from './converter';
import {
  classifyMarkdownFile,
  upsertIndexEntry,
  removeFromIndex,
  parseIndexMd,
  listCategoriesFromIndex,
  entryBelongsToDoc,
  type LlmConfig,
} from './indexer';
import { kbLayout, docNameFromFileName } from './layout';
import type {
  KbDocument,
  KbDocStatus,
  KbCategory,
  KbDocStatusEvent,
} from './types';

// ── 类型 ────────────────────────────────────────────────────────

/** 状态变化推送回调 */
export type StatusNotifier = (event: KbDocStatusEvent) => void;

/** 无操作通知器（默认） */
const noopNotifier: StatusNotifier = () => {};

// ── 上传流水线 ──────────────────────────────────────────────────

/**
 * 上传单个文档：复制到 sources/ → 转换 → LLM 分类 → 归位 docs/<分类>/ → 合并 index.md。
 *
 * 同名覆盖：以 sources/ 文件名为键，覆盖后自动重走完整流水线。
 *
 * @param sourcePath 源文件绝对路径
 * @param kbPath 知识库根目录
 * @param llmConfig LLM 配置（null 时降级占位）
 * @param notify 状态变化通知回调
 * @returns 处理结果
 */
export async function uploadDocument(
  sourcePath: string,
  kbPath: string,
  llmConfig: LlmConfig | null,
  notify: StatusNotifier = noopNotifier,
): Promise<{ ok: true; document: KbDocument } | { ok: false; error: { code: string; message: string } }> {
  const docName = docNameFromFileName(basename(sourcePath));
  const sourceExt = extname(basename(sourcePath));
  const layout = kbLayout(kbPath);

  // 确保 sources/ 存在
  await mkdir(layout.sourcesDir, { recursive: true });
  const destSourcePath = layout.sourcePath(`${docName}${sourceExt}`);

  // 1. 复制源文件到 sources/
  notify({ name: docName, status: 'queued' });

  try {
    const fileBytes = await readFile(sourcePath);
    await writeFile(destSourcePath, fileBytes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    notify({ name: docName, status: 'failed', errorCode: 'io', errorMessage: msg });
    return { ok: false, error: { code: 'io', message: `源文件复制失败: ${msg}` } };
  }

  const sourceSize = (await stat(destSourcePath)).size;

  // 2. 转换
  notify({ name: docName, status: 'converting' });

  // 先清理旧的 docs/ 产物（同名覆盖场景）
  await layout.cleanupDocArtifacts(docName);

  const convertResult = await convertDocument(destSourcePath, layout.docsDir);

  if (!convertResult.ok) {
    const errorCode = convertResult.error.code;
    const errorMessage = convertResult.error.message;
    notify({ name: docName, status: 'failed', errorCode, errorMessage });

    // 记录失败状态的文档
    const failedDoc: KbDocument = {
      name: docName,
      sourceExt,
      sourcePath: destSourcePath,
      markdownPath: '',
      category: '',
      sourceSize,
      markdownSize: 0,
      assetCount: 0,
      status: 'failed',
      errorCode,
      errorMessage,
    };
    return { ok: true, document: failedDoc };
  }

  // 转换成功，Markdown 在 docs/<docName>.md
  const tempMdPath = convertResult.markdownPath;
  const assetCount = convertResult.assetCount;
  const markdownSize = (await stat(tempMdPath)).size;
  const convertedAt = Date.now();

  // 3. AI 分类（读临时 Markdown 骨架，不写 index.md）
  notify({ name: docName, status: 'classifying' });

  const existingCategories = await readExistingCategories(layout.indexMdPath);
  const classifyResult = await classifyMarkdownFile(tempMdPath, existingCategories, llmConfig);
  const { classification, degraded, error } = classifyResult;
  if (degraded) {
    console.error(`[kb] 文档「${docName}」AI 分类/摘要降级: ${error ?? '未知错误'}`);
  }
  const category = classification.category;
  const classifiedAt = Date.now();

  // 4. 归位：移动 Markdown 到 docs/<分类>/<docName>.md
  const targetDir = layout.categoryDir(category);
  await mkdir(targetDir, { recursive: true });
  const finalMdPath = layout.categoryMdPath(category, docName);

  if (tempMdPath !== finalMdPath) {
    await rename(tempMdPath, finalMdPath);
  }

  // 5. 以最终路径写入 index.md（先清除该文档旧条目，防止重复/脏路径残留）
  const finalRelPath = layout.toRelPath(finalMdPath);
  await upsertIndexEntry(layout.indexMdPath, docName, {
    title: classification.title,
    path: finalRelPath,
    category,
    summary: classification.summary,
    keywords: classification.keywords,
  });

  notify({ name: docName, status: 'done', category, aiDegraded: degraded, aiError: error });

  const doc: KbDocument = {
    name: docName,
    sourceExt,
    sourcePath: destSourcePath,
    markdownPath: finalMdPath,
    category,
    sourceSize,
    markdownSize,
    assetCount,
    status: 'done',
    convertedAt,
    classifiedAt,
    aiDegraded: degraded,
    aiError: error,
  };

  return { ok: true, document: doc };
}

// ── 列出文档 ─────────────────────────────────────────────────────

/**
 * 扫描知识库，返回文档列表。
 *
 * 数据来源：
 *  - sources/ 中的文件列表（确定文档名和源文件信息）
 *  - docs/ 中对应的 Markdown 文件（确定分类和状态）
 *  - index.md 中的条目（确定摘要和关键词）
 *
 * 状态推断：
 *  - sources/ 有文件但 docs/ 无对应 .md → queued（已入库未转换，等待处理；
 *    挂载时 autoScanDocuments 会自动重走上传流水线，不判 failed——转换失败
 *    的 errorCode/errorMessage 未持久化，重启后无法与"未处理"区分）
 *  - docs/ 有 .md 但 index.md 无条目 → done（已转换但分类未持久化）
 *  - 完整路径 → done
 */
export async function listDocuments(kbPath: string): Promise<KbDocument[]> {
  const layout = kbLayout(kbPath);
  const documents: KbDocument[] = [];

  // 三路数据并行拉取：index.md 条目 / sources/ 源文件 / docs/ Markdown 全量清单
  // （listMarkdownFiles 一次 readdir 扫根目录 + 并行扫分类子目录，
  //  取代逐文档 findMarkdown 的 O(N×C) 目录扫描——kb.documents 处于
  //  IPC 查询热路径，每次 docStatus 事件都会触发）
  const [indexEntries, sourceFiles, markdownMap] = await Promise.all([
    (async () => {
      try {
        const content = await readFile(layout.indexMdPath, 'utf-8');
        return parseIndexMd(content).entries;
      } catch {
        return [] as Array<{ title: string; path: string; category: string; summary: string; keywords: string[] }>;
      }
    })(),
    layout.listSourceFiles(),
    layout.listMarkdownFiles(),
  ]);

  if (sourceFiles.length === 0) return [];

  // 文档级 stat 并行（源文件 + Markdown），避免串行 await
  const sourceStatMap = new Map<string, { size: number }>();
  await Promise.all(
    sourceFiles.map(async (fileName) => {
      try {
        const s = await stat(layout.sourcePath(fileName));
        sourceStatMap.set(fileName, { size: s.size });
      } catch {
        // 源文件读取失败（挂载中断等极端场景）→ 跳过该文档
      }
    }),
  );

  const mdStatMap = new Map<string, { size: number; mtimeMs: number }>();
  await Promise.all(
    Array.from(markdownMap.entries()).map(async ([docName, mdPath]) => {
      try {
        const s = await stat(mdPath);
        mdStatMap.set(docName, { size: s.size, mtimeMs: s.mtimeMs });
      } catch {
        // 已在扫描与 stat 之间被删除 → 视为未转换
      }
    }),
  );

  for (const fileName of sourceFiles) {
    const ext = extname(fileName);
    const docName = ext ? fileName.slice(0, -ext.length) : fileName;
    const srcPath = layout.sourcePath(fileName);
    const sourceStat = sourceStatMap.get(fileName);
    if (!sourceStat) continue;
    const sourceSize = sourceStat.size;

    // 查找 docs/ 中的对应 Markdown
    let markdownPath = '';
    let category = '';
    let markdownSize = 0;
    // 未找到 Markdown：文档已入库但尚未转换（等待 autoScan/上传流水线处理），
    // 不能判 failed —— 失败详情未持久化，重启后与"未处理"不可区分
    let status: KbDocStatus = 'queued';
    let convertedAt: number | undefined;
    let classifiedAt: number | undefined;
    let aiDegraded: boolean | undefined;

    const foundMd = markdownMap.get(docName);
    const mdStat = foundMd ? mdStatMap.get(docName) : undefined;
    if (foundMd && mdStat) {
      markdownPath = foundMd;
      markdownSize = mdStat.size;
      status = 'done';
      convertedAt = mdStat.mtimeMs;
      if (foundMd !== layout.rootMdPath(docName)) {
        category = basename(dirname(foundMd));
        classifiedAt = convertedAt;
      }
    }

    // 检查 index.md 是否有对应条目
    if (status === 'done') {
      const mdRelPath = layout.toRelPath(markdownPath);
      const indexEntry = indexEntries.find((e) => e.path === mdRelPath);
      if (indexEntry) {
        category = indexEntry.category;
        classifiedAt = classifiedAt ?? convertedAt;
        // AI 降级推断：无摘要且归入未分类（上传时 LLM 未配置或调用失败）
        if (!indexEntry.summary && indexEntry.category === '未分类') {
          aiDegraded = true;
        }
      }
    }

    documents.push({
      name: docName,
      sourceExt: ext,
      sourcePath: srcPath,
      markdownPath,
      category,
      sourceSize,
      markdownSize,
      assetCount: 0, // 不在此扫描 assets
      status,
      convertedAt,
      classifiedAt,
      aiDegraded,
    });
  }

  return documents;
}

// ── 删除文档 ─────────────────────────────────────────────────────

/**
 * 删除文档：源文件 + Markdown + assets + 索引条目。
 */
export async function deleteDocument(
  kbPath: string,
  docName: string,
): Promise<void> {
  const layout = kbLayout(kbPath);

  // 删除源文件（所有扩展名）
  const sourceFiles = await layout.listSourceFiles();
  for (const file of sourceFiles) {
    const name = extname(file) ? file.slice(0, -extname(file).length) : file;
    if (name === docName) {
      await rm(layout.sourcePath(file), { force: true });
    }
  }

  // 删除 Markdown（docs/ 根和所有子目录）+ assets
  await layout.cleanupDocArtifacts(docName);

  // 从 index.md 移除条目
  // 用路径末段精确匹配（entryBelongsToDoc），不能用子串匹配：
  // 子串匹配会把 `My_DDR5.md` 误判为 `DDR5.md` 的条目，导致误删无关文档的索引。
  try {
    const content = await readFile(layout.indexMdPath, 'utf-8');
    const { entries } = parseIndexMd(content);
    for (const entry of entries) {
      if (entryBelongsToDoc(entry, docName)) {
        await removeFromIndex(layout.indexMdPath, entry.path);
      }
    }
  } catch {
    // index.md 不存在 → 无条目可删
  }
}

// ── 重试文档 ─────────────────────────────────────────────────────

/**
 * 重试失败文档的转换。
 * 删除旧产物，重新走转换 → 分类 → 索引流水线。
 */
export async function retryDocument(
  kbPath: string,
  docName: string,
  llmConfig: LlmConfig | null,
  notify: StatusNotifier = noopNotifier,
): Promise<{ ok: true; document: KbDocument } | { ok: false; error: { code: string; message: string } }> {
  const layout = kbLayout(kbPath);

  // 查找源文件
  const sourcePath = await layout.findSource(docName);

  if (!sourcePath) {
    return { ok: false, error: { code: 'notFound', message: `源文件未找到: ${docName}` } };
  }

  // 清理旧产物
  await layout.cleanupDocArtifacts(docName);

  // 重新走流水线
  return uploadDocument(sourcePath, kbPath, llmConfig, notify);
}

// ── 分类树 ──────────────────────────────────────────────────────

/**
 * 返回分类树 + 每分类文档数。
 *
 * 数据来源：docs/ 子目录 + index.md 分类。
 */
export async function listCategories(kbPath: string): Promise<KbCategory[]> {
  const layout = kbLayout(kbPath);
  const categoryMap = new Map<string, number>();

  // 从 docs/ 子目录统计（子目录 readdir 并行 —— kb.categories 处于 IPC 热路径）
  try {
    const entries = await readdir(layout.docsDir, { withFileTypes: true });
    const dirEntries = entries.filter((e) => e.isDirectory() && e.name !== 'assets');
    const counts = await Promise.all(
      dirEntries.map(async (entry) => {
        try {
          const subEntries = await readdir(layout.categoryDir(entry.name), { withFileTypes: true });
          return [entry.name, subEntries.filter((se) => se.isFile() && se.name.endsWith('.md')).length] as const;
        } catch {
          return [entry.name, 0] as const;
        }
      }),
    );
    for (const [name, count] of counts) {
      categoryMap.set(name, count);
    }
  } catch {
    // docs/ 不存在或读取失败
  }

  // 从 index.md 补充分类
  try {
    const content = await readFile(layout.indexMdPath, 'utf-8');
    const categories = listCategoriesFromIndex(content);
    for (const cat of categories) {
      if (!categoryMap.has(cat)) {
        categoryMap.set(cat, 0);
      }
    }
  } catch {
    // index.md 不存在
  }

  return Array.from(categoryMap.entries()).map(([name, count]) => ({ name, count }));
}

// ── 读取 index.md ──────────────────────────────────────────────

/**
 * 读取知识库的 index.md 内容。
 * 不存在时返回空字符串。
 */
export async function readIndexMd(kbPath: string): Promise<string> {
  const layout = kbLayout(kbPath);
  try {
    return await readFile(layout.indexMdPath, 'utf-8');
  } catch {
    return '';
  }
}

// ── 写入 index.md ──────────────────────────────────────────────

/**
 * 写入知识库的 index.md 内容（编辑保存）。
 */
export async function writeIndexMd(kbPath: string, content: string): Promise<void> {
  const layout = kbLayout(kbPath);
  await mkdir(dirname(layout.indexMdPath), { recursive: true });
  await writeFile(layout.indexMdPath, content, 'utf-8');
}

// ── 读取 Markdown 文档 ─────────────────────────────────────────

/**
 * 读取知识库中某个文档的 Markdown 内容。
 * docName 对应文档名（不含扩展名），在 docs/ 的子目录或根目录中查找。
 *
 * @returns Markdown 内容；文档不存在时返回 null。
 */
export async function readMarkdownDoc(kbPath: string, docName: string): Promise<string | null> {
  const layout = kbLayout(kbPath);
  const foundMd = await layout.findMarkdown(docName);
  if (!foundMd) return null;
  return readFile(foundMd, 'utf-8');
}

// ── 辅助：读取 index.md 中的分类列表 ───────────────────────────

/** 读取 index.md 中的现有分类列表（文件不存在返回空） */
async function readExistingCategories(indexMdPath: string): Promise<string[]> {
  try {
    const indexContent = await readFile(indexMdPath, 'utf-8');
    return listCategoriesFromIndex(indexContent);
  } catch {
    return [];
  }
}
