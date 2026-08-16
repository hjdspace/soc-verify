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
 * @see ADR 0021 — anydoc 文档知识库
 */

import { join, basename, extname, dirname } from 'node:path';
import { readFile, writeFile, mkdir, rm, readdir, stat, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { convertDocument } from './converter';
import {
  classifyMarkdownFile,
  upsertIndexEntry,
  removeFromIndex,
  parseIndexMd,
  listCategoriesFromIndex,
  type LlmConfig,
} from './indexer';
import type {
  KbDocument,
  KbDocStatus,
  KbCategory,
  KbDocStatusEvent,
  IndexEntry,
} from './types';

// ── 类型 ────────────────────────────────────────────────────────

/** 状态变化推送回调 */
export type StatusNotifier = (event: KbDocStatusEvent) => void;

/** 无操作通知器（默认） */
const noopNotifier: StatusNotifier = () => {};

/** 从文件名提取文档名（不含扩展名） */
function docNameFromPath(filePath: string): string {
  const base = basename(filePath);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/** 绝对路径 → 相对 docs/ 的路径（正斜杠分隔，如 `分类/文档.md`） */
function toRelPath(absPath: string, docsDir: string): string {
  return absPath
    .replace(docsDir + '/', '')
    .replace(docsDir + '\\', '')
    .replace(/\\/g, '/');
}

/**
 * 在 docs/ 根目录与子目录中查找文档的 Markdown 文件。
 * @returns 绝对路径；未找到返回 null。
 */
async function findMarkdownPath(docsDir: string, docName: string): Promise<string | null> {
  const rootMdPath = join(docsDir, `${docName}.md`);
  if (existsSync(rootMdPath)) return rootMdPath;

  if (existsSync(docsDir)) {
    try {
      const entries = await readdir(docsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'assets') continue;
        const subMd = join(docsDir, entry.name, `${docName}.md`);
        if (existsSync(subMd)) return subMd;
      }
    } catch {
      // 忽略
    }
  }
  return null;
}

/** 读取 index.md 中的现有分类列表（文件不存在返回空） */
async function readExistingCategories(indexMdPath: string): Promise<string[]> {
  if (!existsSync(indexMdPath)) return [];
  const indexContent = await readFile(indexMdPath, 'utf-8');
  return listCategoriesFromIndex(indexContent);
}

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
  const docName = docNameFromPath(sourcePath);
  const sourceExt = extname(basename(sourcePath));
  const sourcesDir = join(kbPath, 'sources');
  const docsDir = join(kbPath, 'docs');
  const assetsDir = join(docsDir, 'assets');
  const indexMdPath = join(kbPath, 'index.md');

  // 确保 sources/ 存在
  await mkdir(sourcesDir, { recursive: true });
  const destSourcePath = join(sourcesDir, `${docName}${sourceExt}`);

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
  // 扫描 docs/ 下所有子目录中可能存在的同名 .md 文件
  await cleanupOldDocsArtifacts(docsDir, docName, assetsDir);

  const convertResult = await convertDocument(destSourcePath, docsDir);

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

  const existingCategories = await readExistingCategories(indexMdPath);
  const classifyResult = await classifyMarkdownFile(tempMdPath, existingCategories, llmConfig);
  const { classification, degraded, error } = classifyResult;
  if (degraded) {
    console.error(`[kb] 文档「${docName}」AI 分类/摘要降级: ${error ?? '未知错误'}`);
  }
  const category = classification.category;
  const classifiedAt = Date.now();

  // 4. 归位：移动 Markdown 到 docs/<分类>/<docName>.md
  const categoryDir = join(docsDir, category);
  await mkdir(categoryDir, { recursive: true });
  const finalMdPath = join(categoryDir, `${docName}.md`);

  if (tempMdPath !== finalMdPath) {
    await rename(tempMdPath, finalMdPath);
  }

  // 5. 以最终路径写入 index.md（先清除该文档旧条目，防止重复/脏路径残留）
  const finalRelPath = toRelPath(finalMdPath, docsDir);
  await upsertIndexEntry(indexMdPath, docName, {
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

// ── 清理旧 docs 产物 ─────────────────────────────────────────────

/**
 * 扫描 docs/ 下所有子目录，清理可能存在的同名 .md 文件和 assets 目录。
 * 用于同名覆盖场景——重转前清理旧产物。
 */
async function cleanupOldDocsArtifacts(docsDir: string, docName: string, assetsDir: string): Promise<void> {
  if (!existsSync(docsDir)) return;

  // 清理 docs/ 根下的同名 .md
  const rootMdPath = join(docsDir, `${docName}.md`);
  await rm(rootMdPath, { force: true });

  // 清理 assets/<docName>/
  const docAssetsDir = join(assetsDir, docName);
  await rm(docAssetsDir, { recursive: true, force: true });

  // 扫描子目录中的同名 .md
  try {
    const entries = await readdir(docsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subMd = join(docsDir, entry.name, `${docName}.md`);
        await rm(subMd, { force: true });
      }
    }
  } catch {
    // 忽略
  }
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
 *  - sources/ 有文件但 docs/ 无对应 .md → failed（转换失败）
 *  - docs/ 有 .md 但 index.md 无条目 → done（已转换但分类未持久化）
 *  - 完整路径 → done
 */
export async function listDocuments(kbPath: string): Promise<KbDocument[]> {
  const sourcesDir = join(kbPath, 'sources');
  const docsDir = join(kbPath, 'docs');
  const indexMdPath = join(kbPath, 'index.md');
  const documents: KbDocument[] = [];

  // 读取 index.md 条目
  let indexEntries: Array<{ title: string; path: string; category: string; summary: string; keywords: string[] }> = [];
  if (existsSync(indexMdPath)) {
    const content = await readFile(indexMdPath, 'utf-8');
    const parsed = parseIndexMd(content);
    indexEntries = parsed.entries;
  }

  // 扫描 sources/
  if (!existsSync(sourcesDir)) return [];

  const sourceFiles = await readdir(sourcesDir, { withFileTypes: true });
  for (const sf of sourceFiles) {
    if (!sf.isFile()) continue;

    const fileName = sf.name;
    const ext = extname(fileName);
    const docName = ext ? fileName.slice(0, -ext.length) : fileName;
    const sourcePath = join(sourcesDir, fileName);
    const sourceSize = (await stat(sourcePath)).size;

    // 查找 docs/ 中的对应 Markdown
    let markdownPath = '';
    let category = '';
    let markdownSize = 0;
    let status: KbDocStatus = 'failed';
    let convertedAt: number | undefined;
    let classifiedAt: number | undefined;
    let aiDegraded: boolean | undefined;

    const foundMd = await findMarkdownPath(docsDir, docName);
    if (foundMd) {
      markdownPath = foundMd;
      markdownSize = (await stat(foundMd)).size;
      status = 'done';
      convertedAt = (await stat(foundMd)).mtimeMs;
      if (foundMd !== join(docsDir, `${docName}.md`)) {
        category = basename(dirname(foundMd));
        classifiedAt = convertedAt;
      }
    }

    // 检查 index.md 是否有对应条目
    if (status === 'done') {
      const mdRelPath = toRelPath(markdownPath, docsDir);
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
      sourcePath,
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
  const sourcesDir = join(kbPath, 'sources');
  const docsDir = join(kbPath, 'docs');
  const assetsDir = join(docsDir, 'assets');
  const indexMdPath = join(kbPath, 'index.md');

  // 删除源文件（所有扩展名）
  try {
    const sourceFiles = await readdir(sourcesDir);
    for (const file of sourceFiles) {
      const name = extname(file) ? file.slice(0, -extname(file).length) : file;
      if (name === docName) {
        await rm(join(sourcesDir, file), { force: true });
      }
    }
  } catch {
    // 忽略
  }

  // 删除 Markdown（docs/ 根和所有子目录）
  await rm(join(docsDir, `${docName}.md`), { force: true });
  try {
    const docEntries = await readdir(docsDir, { withFileTypes: true });
    for (const de of docEntries) {
      if (de.isDirectory()) {
        await rm(join(docsDir, de.name, `${docName}.md`), { force: true });
      }
    }
  } catch {
    // 忽略
  }

  // 删除 assets 目录
  await rm(join(assetsDir, docName), { recursive: true, force: true });

  // 从 index.md 移除条目
  if (existsSync(indexMdPath)) {
    const content = await readFile(indexMdPath, 'utf-8');
    // 查找所有可能匹配的路径
    const { entries } = parseIndexMd(content);
    for (const entry of entries) {
      if (entry.path.includes(`${docName}.md`)) {
        await removeFromIndex(indexMdPath, entry.path);
      }
    }
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
  const sourcesDir = join(kbPath, 'sources');
  const docsDir = join(kbPath, 'docs');
  const assetsDir = join(docsDir, 'assets');

  // 查找源文件
  let sourcePath = '';
  try {
    const files = await readdir(sourcesDir);
    for (const file of files) {
      const name = extname(file) ? file.slice(0, -extname(file).length) : file;
      if (name === docName) {
        sourcePath = join(sourcesDir, file);
        break;
      }
    }
  } catch {
    // 忽略
  }

  if (!sourcePath) {
    return { ok: false, error: { code: 'notFound', message: `源文件未找到: ${docName}` } };
  }

  // 清理旧产物
  await cleanupOldDocsArtifacts(docsDir, docName, assetsDir);

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
  const docsDir = join(kbPath, 'docs');
  const indexMdPath = join(kbPath, 'index.md');
  const categoryMap = new Map<string, number>();

  // 从 docs/ 子目录统计
  if (existsSync(docsDir)) {
    try {
      const entries = await readdir(docsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'assets') continue;
        const subPath = join(docsDir, entry.name);
        try {
          const subEntries = await readdir(subPath, { withFileTypes: true });
          let count = 0;
          for (const se of subEntries) {
            if (se.isFile() && se.name.endsWith('.md')) count++;
          }
          categoryMap.set(entry.name, count);
        } catch {
          categoryMap.set(entry.name, 0);
        }
      }
    } catch {
      // 忽略
    }
  }

  // 从 index.md 补充分类
  if (existsSync(indexMdPath)) {
    const content = await readFile(indexMdPath, 'utf-8');
    const categories = listCategoriesFromIndex(content);
    for (const cat of categories) {
      if (!categoryMap.has(cat)) {
        categoryMap.set(cat, 0);
      }
    }
  }

  return Array.from(categoryMap.entries()).map(([name, count]) => ({ name, count }));
}

// ── 读取 index.md ──────────────────────────────────────────────

/**
 * 读取知识库的 index.md 内容。
 * 不存在时返回空字符串。
 */
export async function readIndexMd(kbPath: string): Promise<string> {
  const indexMdPath = join(kbPath, 'index.md');
  if (!existsSync(indexMdPath)) return '';
  return readFile(indexMdPath, 'utf-8');
}

// ── 写入 index.md ──────────────────────────────────────────────

/**
 * 写入知识库的 index.md 内容（编辑保存）。
 */
export async function writeIndexMd(kbPath: string, content: string): Promise<void> {
  const indexMdPath = join(kbPath, 'index.md');
  await mkdir(dirname(indexMdPath), { recursive: true });
  await writeFile(indexMdPath, content, 'utf-8');
}

// ── 读取 Markdown 文档 ─────────────────────────────────────────

/**
 * 读取知识库中某个文档的 Markdown 内容。
 * docName 对应文档名（不含扩展名），在 docs/ 的子目录或根目录中查找。
 *
 * @returns Markdown 内容；文档不存在时返回 null。
 */
export async function readMarkdownDoc(kbPath: string, docName: string): Promise<string | null> {
  const docsDir = join(kbPath, 'docs');
  const foundMd = await findMarkdownPath(docsDir, docName);
  if (!foundMd) return null;
  return readFile(foundMd, 'utf-8');
}

// ── 移动文档到新分类 ─────────────────────────────────────────────

/**
 * 将文档移动到新分类目录，并更新 index.md 中该文档条目的分类。
 *
 * 步骤：
 *  1. 查找文档当前 Markdown 路径
 *  2. 创建目标分类目录（如不存在）
 *  3. 移动 Markdown 文件
 *  4. 更新 index.md 中该条目的分类和路径
 *
 * @returns 移动后的新 Markdown 路径；文档不存在时返回 null。
 */
export async function moveDocumentCategory(
  kbPath: string,
  docName: string,
  newCategory: string,
): Promise<string | null> {
  const docsDir = join(kbPath, 'docs');
  const indexMdPath = join(kbPath, 'index.md');

  // 查找当前 Markdown 路径
  const currentMdPath = await findMarkdownPath(docsDir, docName);
  if (!currentMdPath) return null;

  const oldCategory = currentMdPath === join(docsDir, `${docName}.md`)
    ? ''
    : basename(dirname(currentMdPath));

  // 如果新旧分类相同，不需要移动
  if (oldCategory === newCategory) return currentMdPath;

  // 创建目标分类目录
  const targetDir = join(docsDir, newCategory);
  await mkdir(targetDir, { recursive: true });
  const targetMdPath = join(targetDir, `${docName}.md`);

  // 读取内容并写入新位置，删除旧文件
  const content = await readFile(currentMdPath, 'utf-8');
  await writeFile(targetMdPath, content, 'utf-8');
  await rm(currentMdPath, { force: true });

  // 更新 index.md 中该条目的分类和路径
  if (existsSync(indexMdPath)) {
    const indexContent = await readFile(indexMdPath, 'utf-8');
    const { entries, categoryOrder } = parseIndexMd(indexContent);

    const oldRelPath = toRelPath(currentMdPath, docsDir);
    const newRelPath = `${newCategory}/${docName}.md`;

    // 查找并更新条目
    const idx = entries.findIndex((e) => e.path === oldRelPath || e.path.endsWith(`/${docName}.md`) || e.path === `${docName}.md`);
    if (idx >= 0) {
      entries[idx] = {
        ...entries[idx],
        category: newCategory,
        path: newRelPath,
      };
    }

    // 确保新分类在顺序中
    if (!categoryOrder.includes(newCategory)) {
      categoryOrder.push(newCategory);
    }

    // 重新序列化并写入
    const updatedContent = serializeIndexMdForMove(entries, categoryOrder);
    await writeFile(indexMdPath, updatedContent, 'utf-8');
  }

  return targetMdPath;
}

// ── 序列化 index.md（用于移动分类时） ──────────────────────────

/**
 * 将条目列表 + 分类顺序序列化为 index.md 文本。
 * 与 indexer.ts 的 serializeIndexMd 逻辑一致，此处独立实现以避免导出内部函数。
 */
function serializeIndexMdForMove(entries: IndexEntry[], categoryOrder: string[]): string {
  const byCategory = new Map<string, IndexEntry[]>();
  for (const entry of entries) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }

  const allCategories = [...categoryOrder];
  for (const cat of byCategory.keys()) {
    if (!allCategories.includes(cat)) {
      allCategories.push(cat);
    }
  }

  const parts: string[] = [
    '# 知识库索引',
    '',
    '<!-- 此文件由 AI Agent 会话启动时注入为库地图 -->',
    '<!-- 手动编辑可调整分类体系与条目 -->',
    '',
  ];

  for (const cat of allCategories) {
    const list = byCategory.get(cat);
    if (!list || list.length === 0) continue;

    parts.push(`## ${cat}`, '');
    for (const entry of list) {
      const keywords = entry.keywords.length > 0
        ? entry.keywords.map((k) => `\`${k}\``).join(' · ')
        : '';
      const lines = [
        `### ${entry.title}`,
        `- **路径**: \`${entry.path}\``,
        `- **摘要**: ${entry.summary || '（暂无摘要）'}`,
      ];
      if (keywords) {
        lines.push(`- **关键词**: ${keywords}`);
      }
      parts.push(lines.join('\n'), '');
    }
  }

  return parts.join('\n');
}

// ── 重命名分类 ─────────────────────────────────────────────────

/**
 * 重命名分类目录，并更新 index.md 中所有相关条目的分类名和路径。
 *
 * 步骤：
 *  1. 将 docs/<oldCategory>/ 重命名为 docs/<newCategory>/
 *  2. 更新 index.md 中所有 category === oldCategory 的条目
 *
 * @returns 成功返回 true；分类目录不存在返回 false。
 */
export async function renameCategory(
  kbPath: string,
  oldCategory: string,
  newCategory: string,
): Promise<boolean> {
  const docsDir = join(kbPath, 'docs');
  const oldDir = join(docsDir, oldCategory);
  const newDir = join(docsDir, newCategory);

  if (!existsSync(oldDir)) return false;

  // 如果新旧名称相同，无需操作
  if (oldCategory === newCategory) return true;

  // 重命名目录
  // 如果目标目录已存在，合并：将旧目录中的文件移动到新目录
  if (existsSync(newDir)) {
    // 合并：移动旧目录下的所有文件到新目录
    const entries = await readdir(oldDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(oldDir, entry.name);
      const destPath = join(newDir, entry.name);
      await rename(srcPath, destPath);
    }
    await rm(oldDir, { recursive: true, force: true });
  } else {
    await rename(oldDir, newDir);
  }

  // 更新 index.md
  const indexMdPath = join(kbPath, 'index.md');
  if (existsSync(indexMdPath)) {
    const indexContent = await readFile(indexMdPath, 'utf-8');
    const { entries, categoryOrder } = parseIndexMd(indexContent);

    // 更新所有匹配分类的条目。
    // 匹配条件：条目分类名 === 旧分类，或路径首段 === 旧分类
    // （后者兜底手动编辑 index.md 导致的 category 字段与路径不一致）。
    for (const entry of entries) {
      const firstSeg = entry.path.split('/')[0];
      if (entry.category === oldCategory || firstSeg === oldCategory) {
        entry.category = newCategory;
        if (firstSeg === oldCategory) {
          // 替换首段，并清理连续重复的旧分类前缀
          // （历史 bug 产生的「未分类/未分类/x.md」脏数据）
          let rest = entry.path.slice(oldCategory.length);
          while (rest.startsWith(`/${oldCategory}/`)) {
            rest = rest.slice(oldCategory.length + 1);
          }
          entry.path = newCategory + rest;
        }
      }
    }

    // 更新 categoryOrder
    const idx = categoryOrder.indexOf(oldCategory);
    if (idx >= 0) {
      // 如果新分类已在 order 中，移除旧的；否则替换
      if (categoryOrder.includes(newCategory)) {
        categoryOrder.splice(idx, 1);
      } else {
        categoryOrder[idx] = newCategory;
      }
    } else if (!categoryOrder.includes(newCategory)) {
      categoryOrder.push(newCategory);
    }

    const updatedContent = serializeIndexMdForMove(entries, categoryOrder);
    await writeFile(indexMdPath, updatedContent, 'utf-8');
  }

  return true;
}

// ── AI 重新分类/摘要 ────────────────────────────────────────────

/** reclassifyDocument 结果 */
export type ReclassifyResult =
  | { ok: true; entry: IndexEntry; moved: boolean }
  | { ok: false; error: { code: string; message: string } };

/**
 * AI 重新分类单个文档并重新生成标题/摘要/关键词。
 *
 * 流程：
 *  1. 查找文档 Markdown
 *  2. LLM 分类（复用上传流水线的 classifyMarkdownFile）
 *  3. 分类变化时移动文件到新分类目录
 *  4. 以最终路径更新 index.md 条目（清除旧条目）
 *
 * 与上传不同：LLM 失败时不降级，直接返回错误（用户显式触发，失败必须可见）。
 */
export async function reclassifyDocument(
  kbPath: string,
  docName: string,
  llmConfig: LlmConfig | null,
): Promise<ReclassifyResult> {
  const docsDir = join(kbPath, 'docs');
  const indexMdPath = join(kbPath, 'index.md');

  // 1. 查找文档
  const currentMdPath = await findMarkdownPath(docsDir, docName);
  if (!currentMdPath) {
    return { ok: false, error: { code: 'notFound', message: `文档未找到: ${docName}` } };
  }

  if (!llmConfig) {
    return {
      ok: false,
      error: { code: 'noLlmConfig', message: '未配置 LLM 凭证，请先在设置中配置（与 AI Agent 面板共用同一凭证）' },
    };
  }

  // 2. AI 分类
  const existingCategories = await readExistingCategories(indexMdPath);
  const { classification, degraded, error } = await classifyMarkdownFile(currentMdPath, existingCategories, llmConfig);
  if (degraded) {
    return { ok: false, error: { code: 'llmFailed', message: `AI 分类失败: ${error ?? '未知错误'}` } };
  }

  // 3. 分类变化时移动文件
  let finalMdPath = currentMdPath;
  let moved = false;
  const currentCategory = currentMdPath === join(docsDir, `${docName}.md`)
    ? ''
    : basename(dirname(currentMdPath));

  if (classification.category && classification.category !== currentCategory) {
    const targetDir = join(docsDir, classification.category);
    await mkdir(targetDir, { recursive: true });
    const targetMdPath = join(targetDir, `${docName}.md`);
    if (currentMdPath !== targetMdPath) {
      const content = await readFile(currentMdPath, 'utf-8');
      await writeFile(targetMdPath, content, 'utf-8');
      await rm(currentMdPath, { force: true });
      finalMdPath = targetMdPath;
      moved = true;
    }
  }

  // 4. 更新 index.md 条目
  const entry: IndexEntry = {
    title: classification.title,
    path: toRelPath(finalMdPath, docsDir),
    category: classification.category || currentCategory || '未分类',
    summary: classification.summary,
    keywords: classification.keywords,
  };
  await upsertIndexEntry(indexMdPath, docName, entry);

  return { ok: true, entry, moved };
}
