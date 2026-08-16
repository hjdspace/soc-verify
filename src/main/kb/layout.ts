/**
 * Knowledge Base Layout — 库布局知识的单一拥有者。
 *
 * ADR 0021 定下的库结构（sources/、docs/<分类>/、docs/assets/<文档名>/、index.md）
 * 是一份领域知识，但此前它在代码里没有单一拥有者 —— 每个 pipeline 函数各自
 * `join(kbPath, 'sources')` 式手工拼接，converter、registry、router 的 autoScan
 * 再各拼一遍。文档发现（「在 docs/ 根或任一分类子目录找 <docName>.md」）被独立
 * 写了 4 遍；「在 sources/ 按文档名找源文件」也写了 2 遍。
 *
 * 本模块收拢所有布局知识：路径推导、文档发现、同名覆盖清理。
 * 布局规则变更（比如 assets 平铺、分类支持二级目录）从「改 5 个文件」变成
 * 「改 1 个」。
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

import { join, extname } from 'node:path';
import { readdir, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// ── 类型 ────────────────────────────────────────────────────────

/**
 * 知识库布局快照 —— 给定 kbPath 后推导出的所有路径。
 *
 * 调用方只需 `const layout = kbLayout(kbPath)` 然后消费字段，
 * 不再自己拼接任何路径。
 */
export type KbLayout = {
  /** 知识库根目录 */
  readonly kbPath: string;
  /** sources/ 目录绝对路径 */
  readonly sourcesDir: string;
  /** docs/ 目录绝对路径 */
  readonly docsDir: string;
  /** index.md 绝对路径 */
  readonly indexMdPath: string;
  /** docs/assets/ 目录绝对路径 */
  readonly assetsRootDir: string;

  // ── 路径推导 ──

  /** docs/<category>/ 目录绝对路径 */
  categoryDir: (category: string) => string;
  /** docs/<category>/<docName>.md 绝对路径 */
  categoryMdPath: (category: string, docName: string) => string;
  /** docs/<docName>.md 绝对路径（根目录下的 Markdown） */
  rootMdPath: (docName: string) => string;
  /** docs/assets/<docName>/ 目录绝对路径 */
  assetsDir: (docName: string) => string;
  /** sources/<fileName> 绝对路径 */
  sourcePath: (fileName: string) => string;

  // ── 文档发现 ──

  /**
   * 在 docs/ 根目录与子目录中查找文档的 Markdown 文件。
   * @returns 绝对路径；未找到返回 null。
   */
  findMarkdown: (docName: string) => Promise<string | null>;

  /**
   * 在 sources/ 中按文档名（不含扩展名）查找源文件。
   * 同名不同扩展名时返回第一个匹配。
   * @returns 绝对路径；未找到返回 null。
   */
  findSource: (docName: string) => Promise<string | null>;

  /**
   * 列出 sources/ 中的所有文件名（不含目录）。
   * sources/ 不存在时返回空数组。
   */
  listSourceFiles: () => Promise<string[]>;

  // ── 清理操作 ──

  /**
   * 清理文档在 docs/ 中的所有同名产物（.md + assets/）。
   * 用于同名覆盖场景——重转前清理旧产物。
   */
  cleanupDocArtifacts: (docName: string) => Promise<void>;

  // ── 辅助 ──

  /**
   * 将绝对路径转换为相对 docs/ 的路径（正斜杠分隔，如 `分类/文档.md`）。
   * 用于 index.md 条目中的 path 字段。
   */
  toRelPath: (absPath: string) => string;
};

// ── 辅助函数 ────────────────────────────────────────────────────

/** 从文件名提取文档名（不含扩展名） */
export function docNameFromFileName(fileName: string): string {
  const ext = extname(fileName);
  return ext ? fileName.slice(0, -ext.length) : fileName;
}

/** 绝对路径 → 相对 docs/ 的路径（正斜杠分隔，如 `分类/文档.md`） */
function toRelPathImpl(absPath: string, docsDir: string): string {
  return absPath
    .replace(docsDir + '/', '')
    .replace(docsDir + '\\', '')
    .replace(/\\/g, '/');
}

// ── 工厂函数 ────────────────────────────────────────────────────

/**
 * 为给定知识库根目录创建布局快照。
 *
 * 所有路径推导、文档发现、清理操作都封装在此。
 * 调方只需 `const layout = kbLayout(kbPath)`，然后消费字段和方法。
 */
export function kbLayout(kbPath: string): KbLayout {
  const sourcesDir = join(kbPath, 'sources');
  const docsDir = join(kbPath, 'docs');
  const indexMdPath = join(kbPath, 'index.md');
  const assetsRootDir = join(docsDir, 'assets');

  // ── 路径推导 ──

  const categoryDir = (category: string): string => join(docsDir, category);
  const categoryMdPath = (category: string, docName: string): string =>
    join(categoryDir(category), `${docName}.md`);
  const rootMdPath = (docName: string): string => join(docsDir, `${docName}.md`);
  const assetsDir = (docName: string): string => join(assetsRootDir, docName);
  const sourcePath = (fileName: string): string => join(sourcesDir, fileName);

  // ── 文档发现 ──

  /**
   * 在 docs/ 根目录与子目录中查找文档的 Markdown 文件。
   * 跳过 assets/ 目录。
   */
  async function findMarkdown(docName: string): Promise<string | null> {
    const rootMd = rootMdPath(docName);
    if (existsSync(rootMd)) return rootMd;

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

  /**
   * 在 sources/ 中按文档名（不含扩展名）查找源文件。
   */
  async function findSource(docName: string): Promise<string | null> {
    if (!existsSync(sourcesDir)) return null;
    try {
      const files = await readdir(sourcesDir);
      for (const file of files) {
        const name = extname(file) ? file.slice(0, -extname(file).length) : file;
        if (name === docName) return sourcePath(file);
      }
    } catch {
      // 忽略
    }
    return null;
  }

  /**
   * 列出 sources/ 中的所有文件名（不含目录）。
   */
  async function listSourceFiles(): Promise<string[]> {
    if (!existsSync(sourcesDir)) return [];
    try {
      const entries = await readdir(sourcesDir, { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  // ── 清理操作 ──

  /**
   * 清理文档在 docs/ 中的所有同名产物（.md + assets/）。
   * 用于同名覆盖场景——重转前清理旧产物。
   */
  async function cleanupDocArtifacts(docName: string): Promise<void> {
    if (!existsSync(docsDir)) return;

    // 清理 docs/ 根下的同名 .md
    await rm(rootMdPath(docName), { force: true });

    // 清理 assets/<docName>/
    await rm(assetsDir(docName), { recursive: true, force: true });

    // 扫描子目录中的同名 .md
    try {
      const entries = await readdir(docsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await rm(join(docsDir, entry.name, `${docName}.md`), { force: true });
        }
      }
    } catch {
      // 忽略
    }
  }

  // ── 辅助 ──

  const toRelPath = (absPath: string): string => toRelPathImpl(absPath, docsDir);

  return {
    kbPath,
    sourcesDir,
    docsDir,
    indexMdPath,
    assetsRootDir,
    categoryDir,
    categoryMdPath,
    rootMdPath,
    assetsDir,
    sourcePath,
    findMarkdown,
    findSource,
    listSourceFiles,
    cleanupDocArtifacts,
    toRelPath,
  };
}

// ── 初始化 ──────────────────────────────────────────────────────

/** index.md 骨架内容 */
const INDEX_MD_SKELETON =
  '# 知识库索引\n\n<!-- 此文件由 AI Agent 会话启动时注入为库地图 -->\n<!-- 手动编辑可调整分类体系与条目 -->\n\n';

/**
 * 初始化标准库结构（sources/ docs/ index.md 骨架）。
 * 已存在的目录/文件不会被覆盖。
 */
export async function initKbLayout(kbPath: string): Promise<void> {
  const layout = kbLayout(kbPath);
  await mkdir(layout.sourcesDir, { recursive: true });
  await mkdir(layout.docsDir, { recursive: true });
  if (!existsSync(layout.indexMdPath)) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(layout.indexMdPath, INDEX_MD_SKELETON, 'utf-8');
  }
}

/**
 * 检查目录结构是否兼容知识库（存在 sources/ 与 docs/ 即认可）。
 */
export function checkKbHealth(kbPath: string): {
  hasSources: boolean;
  hasDocs: boolean;
  hasIndex: boolean;
} {
  const layout = kbLayout(kbPath);
  return {
    hasSources: existsSync(layout.sourcesDir),
    hasDocs: existsSync(layout.docsDir),
    hasIndex: existsSync(layout.indexMdPath),
  };
}

// ── 统计 ────────────────────────────────────────────────────────

/**
 * 统计 docs/ 下的文档数（.md 文件）和分类数（一级子目录，不含 assets/）。
 */
export async function countKbDocs(kbPath: string): Promise<{
  documentCount: number;
  categoryCount: number;
}> {
  const layout = kbLayout(kbPath);
  let documentCount = 0;
  let categoryCount = 0;

  if (!existsSync(layout.docsDir)) return { documentCount: 0, categoryCount: 0 };

  try {
    const entries = await readdir(layout.docsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === 'assets') continue;
        categoryCount++;
        try {
          const subEntries = await readdir(join(layout.docsDir, entry.name), { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (subEntry.isFile() && subEntry.name.endsWith('.md')) {
              documentCount++;
            }
          }
        } catch {
          // 子目录读取失败，跳过
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        documentCount++;
      }
    }
  } catch {
    // docs/ 不存在或读取失败
  }

  return { documentCount, categoryCount };
}

// ── 重新导出以方便调用方 ────────────────────────────────────────

export { INDEX_MD_SKELETON };
