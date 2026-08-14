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
import { readFile, writeFile, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { convertDocument } from './converter';
import {
  indexDocument,
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

  // 3. LLM 分类
  notify({ name: docName, status: 'classifying' });

  // 读取现有分类体系
  let existingCategories: string[] = [];
  if (existsSync(indexMdPath)) {
    const indexContent = await readFile(indexMdPath, 'utf-8');
    existingCategories = listCategoriesFromIndex(indexContent);
  }

  const indexResult = await indexDocument(tempMdPath, docsDir, indexMdPath, existingCategories, llmConfig);
  const category = indexResult.entry.category;
  const classifiedAt = Date.now();

  // 4. 归位：移动 Markdown 到 docs/<分类>/<docName>.md
  const categoryDir = join(docsDir, category);
  await mkdir(categoryDir, { recursive: true });
  const finalMdPath = join(categoryDir, `${docName}.md`);

  // 如果 tempMdPath 和 finalMdPath 相同（分类正好是 docs/ 根），不需要移动
  if (tempMdPath !== finalMdPath) {
    // 读取临时 Markdown 内容，写入最终位置，删除临时文件
    const mdContent = await readFile(tempMdPath, 'utf-8');
    await writeFile(finalMdPath, mdContent, 'utf-8');
    await rm(tempMdPath, { force: true });
  }

  // 更新 index.md 中的路径（临时路径 → 最终路径）
  if (existsSync(indexMdPath)) {
    const indexContent = await readFile(indexMdPath, 'utf-8');
    const tempRelPath = tempMdPath.replace(docsDir + '/', '').replace(docsDir + '\\', '').replace(/\\/g, '/');
    const finalRelPath = finalMdPath.replace(docsDir + '/', '').replace(docsDir + '\\', '').replace(/\\/g, '/');

    // 同步替换 index.md 中的临时路径为最终路径
    if (tempRelPath !== finalRelPath) {
      const newIndexContent = indexContent.split(tempRelPath).join(finalRelPath);
      await writeFile(indexMdPath, newIndexContent, 'utf-8');
    }
  }

  notify({ name: docName, status: 'done', category });

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
    let errorCode: string | undefined;
    let errorMessage: string | undefined;
    let convertedAt: number | undefined;
    let classifiedAt: number | undefined;

    // 先在 docs/ 根查找
    const rootMdPath = join(docsDir, `${docName}.md`);
    if (existsSync(rootMdPath)) {
      markdownPath = rootMdPath;
      markdownSize = (await stat(rootMdPath)).size;
      status = 'done';
      convertedAt = (await stat(rootMdPath)).mtimeMs;
    } else {
      // 在 docs/ 子目录中查找
      try {
        const docEntries = await readdir(docsDir, { withFileTypes: true });
        for (const de of docEntries) {
          if (!de.isDirectory()) continue;
          const subMd = join(docsDir, de.name, `${docName}.md`);
          if (existsSync(subMd)) {
            markdownPath = subMd;
            category = de.name;
            markdownSize = (await stat(subMd)).size;
            status = 'done';
            convertedAt = (await stat(subMd)).mtimeMs;
            classifiedAt = convertedAt;
            break;
          }
        }
      } catch {
        // docs/ 不存在或读取失败
      }
    }

    // 检查 index.md 是否有对应条目
    if (status === 'done') {
      const mdRelPath = markdownPath.replace(docsDir + '/', '').replace(docsDir + '\\', '').replace(/\\/g, '/');
      const indexEntry = indexEntries.find((e) => e.path === mdRelPath);
      if (indexEntry) {
        category = indexEntry.category;
        classifiedAt = classifiedAt ?? convertedAt;
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
      errorCode,
      errorMessage,
      convertedAt,
      classifiedAt,
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

  // 先在 docs/ 根查找
  const rootMdPath = join(docsDir, `${docName}.md`);
  if (existsSync(rootMdPath)) {
    return readFile(rootMdPath, 'utf-8');
  }

  // 在 docs/ 子目录中查找
  if (existsSync(docsDir)) {
    try {
      const entries = await readdir(docsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'assets') continue;
        const subMd = join(docsDir, entry.name, `${docName}.md`);
        if (existsSync(subMd)) {
          return readFile(subMd, 'utf-8');
        }
      }
    } catch {
      // 忽略
    }
  }

  return null;
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
  let currentMdPath = '';
  let oldCategory = '';

  const rootMdPath = join(docsDir, `${docName}.md`);
  if (existsSync(rootMdPath)) {
    currentMdPath = rootMdPath;
    oldCategory = '';
  } else {
    try {
      const entries = await readdir(docsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'assets') continue;
        const subMd = join(docsDir, entry.name, `${docName}.md`);
        if (existsSync(subMd)) {
          currentMdPath = subMd;
          oldCategory = entry.name;
          break;
        }
      }
    } catch {
      // 忽略
    }
  }

  if (!currentMdPath) return null;

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

    // 计算旧相对路径和新相对路径
    const docsDirNormalized = docsDir.replace(/\\/g, '/');
    const oldRelPath = currentMdPath.replace(/\\/g, '/').replace(docsDirNormalized + '/', '');
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
