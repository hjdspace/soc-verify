/**
 * Knowledge Base Layout 测试。
 *
 * layout.ts 是库布局知识的单一拥有者 —— 路径推导、文档发现、清理操作。
 * 测试直接对着 layout 接口断言（临时目录），不再借道整条上传流水线。
 *
 * 覆盖场景：
 *  - 路径推导：sourcesDir / docsDir / indexMdPath / assetsRootDir
 *    categoryDir / categoryMdPath / rootMdPath / assetsDir / sourcePath
 *  - 文档发现：findMarkdown（根目录、子目录、未找到）
 *  - 源文件发现：findSource / listSourceFiles
 *  - 清理操作：cleanupDocArtifacts（同名 .md + assets + 跨子目录）
 *  - 辅助：toRelPath / docNameFromFileName
 *  - 初始化：initKbLayout / checkKbHealth / countKbDocs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import {
  kbLayout,
  docNameFromFileName,
  initKbLayout,
  checkKbHealth,
  countKbDocs,
  INDEX_MD_SKELETON,
} from '../src/main/kb/layout';

// ── 测试工具 ──────────────────────────────────────────────────────

/** 创建临时目录作为知识库根目录 */
async function makeTempKb(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kb-layout-test-'));
}

/** 在临时 KB 中创建一个完整结构 */
async function makeFullKb(): Promise<string> {
  const kbPath = await makeTempKb();
  await initKbLayout(kbPath);
  return kbPath;
}

// ── docNameFromFileName ────────────────────────────────────────────

describe('docNameFromFileName', () => {
  it('去除扩展名', () => {
    expect(docNameFromFileName('验证计划.docx')).toBe('验证计划');
    expect(docNameFromFileName('report.pdf')).toBe('report');
    expect(docNameFromFileName('multi.dot.xlsx')).toBe('multi.dot');
  });

  it('无扩展名时返回原文件名', () => {
    expect(docNameFromFileName('README')).toBe('README');
  });
});

// ── 路径推导 ──────────────────────────────────────────────────────

describe('kbLayout 路径推导', () => {
  it('sourcesDir / docsDir / indexMdPath / assetsRootDir 正确', () => {
    const kbPath = '/tmp/fake-kb';
    const layout = kbLayout(kbPath);

    expect(layout.kbPath).toBe(kbPath);
    expect(layout.sourcesDir).toBe(join(kbPath, 'sources'));
    expect(layout.docsDir).toBe(join(kbPath, 'docs'));
    expect(layout.indexMdPath).toBe(join(kbPath, 'index.md'));
    expect(layout.assetsRootDir).toBe(join(kbPath, 'docs', 'assets'));
  });

  it('categoryDir / categoryMdPath 正确', () => {
    const layout = kbLayout('/tmp/kb');

    expect(layout.categoryDir('协议手册')).toBe(join('/tmp/kb', 'docs', '协议手册'));
    expect(layout.categoryMdPath('协议手册', 'DDR5')).toBe(join('/tmp/kb', 'docs', '协议手册', 'DDR5.md'));
  });

  it('rootMdPath 正确', () => {
    const layout = kbLayout('/tmp/kb');
    expect(layout.rootMdPath('DDR5')).toBe(join('/tmp/kb', 'docs', 'DDR5.md'));
  });

  it('assetsDir 正确', () => {
    const layout = kbLayout('/tmp/kb');
    expect(layout.assetsDir('文档A')).toBe(join('/tmp/kb', 'docs', 'assets', '文档A'));
  });

  it('sourcePath 正确', () => {
    const layout = kbLayout('/tmp/kb');
    expect(layout.sourcePath('文档A.docx')).toBe(join('/tmp/kb', 'sources', '文档A.docx'));
  });
});

// ── toRelPath ──────────────────────────────────────────────────────

describe('kbLayout.toRelPath', () => {
  it('绝对路径转换为相对 docs/ 的正斜杠路径', () => {
    const layout = kbLayout('/tmp/kb');
    // 用 layout 的方法构建路径再转回来
    const absPath = layout.categoryMdPath('协议手册', 'DDR5');
    expect(layout.toRelPath(absPath)).toBe('协议手册/DDR5.md');
  });

  it('根目录下的 .md 路径转换正确', () => {
    const layout = kbLayout('/tmp/kb');
    const absPath = layout.rootMdPath('文档');
    expect(layout.toRelPath(absPath)).toBe('文档.md');
  });
});

// ── findMarkdown ───────────────────────────────────────────────────

describe('kbLayout.findMarkdown', () => {
  let kbPath: string;

  beforeEach(async () => {
    kbPath = await makeFullKb();
  });

  afterEach(async () => {
    await rm(kbPath, { recursive: true, force: true });
  });

  it('找到 docs/ 根目录下的 .md', async () => {
    const layout = kbLayout(kbPath);
    await writeFile(layout.rootMdPath('文档A'), '# 文档A');

    const found = await layout.findMarkdown('文档A');
    expect(found).toBe(layout.rootMdPath('文档A'));
  });

  it('找到 docs/ 子目录下的 .md', async () => {
    const layout = kbLayout(kbPath);
    await mkdir(layout.categoryDir('协议手册'), { recursive: true });
    await writeFile(layout.categoryMdPath('协议手册', 'DDR5'), '# DDR5');

    const found = await layout.findMarkdown('DDR5');
    expect(found).toBe(layout.categoryMdPath('协议手册', 'DDR5'));
  });

  it('跳过 assets 目录', async () => {
    const layout = kbLayout(kbPath);
    await mkdir(layout.assetsDir('文档A'), { recursive: true });
    await writeFile(join(layout.assetsDir('文档A'), '文档A.md'), '# not here');

    const found = await layout.findMarkdown('文档A');
    expect(found).toBeNull();
  });

  it('文档不存在时返回 null', async () => {
    const layout = kbLayout(kbPath);
    const found = await layout.findMarkdown('不存在');
    expect(found).toBeNull();
  });
});

// ── listMarkdownFiles ─────────────────────────────────────────────

describe('kbLayout.listMarkdownFiles', () => {
  let kbPath: string;

  beforeEach(async () => {
    kbPath = await makeFullKb();
  });

  afterEach(async () => {
    await rm(kbPath, { recursive: true, force: true });
  });

  it('一次扫描返回根目录 + 各分类子目录的 .md（键为文档名）', async () => {
    const layout = kbLayout(kbPath);
    await writeFile(layout.rootMdPath('文档A'), '# 文档A');
    await mkdir(layout.categoryDir('协议手册'), { recursive: true });
    await writeFile(layout.categoryMdPath('协议手册', 'DDR5'), '# DDR5');
    await mkdir(layout.categoryDir('验证计划'), { recursive: true });
    await writeFile(layout.categoryMdPath('验证计划', 'plan'), '# plan');

    const files = await layout.listMarkdownFiles();
    expect(files.size).toBe(3);
    expect(files.get('文档A')).toBe(layout.rootMdPath('文档A'));
    expect(files.get('DDR5')).toBe(layout.categoryMdPath('协议手册', 'DDR5'));
    expect(files.get('plan')).toBe(layout.categoryMdPath('验证计划', 'plan'));
  });

  it('跳过 assets 目录且不含非 .md 文件', async () => {
    const layout = kbLayout(kbPath);
    await writeFile(layout.rootMdPath('文档A'), '# 文档A');
    await mkdir(layout.assetsDir('文档A'), { recursive: true });
    await writeFile(join(layout.assetsDir('文档A'), '图片.md'), '# not here');
    await writeFile(join(layout.docsDir, 'notes.txt'), 'not md');

    const files = await layout.listMarkdownFiles();
    expect(files.size).toBe(1);
    expect(files.has('图片')).toBe(false);
    expect(files.has('文档A')).toBe(true);
  });

  it('docs/ 不存在时返回空 Map', async () => {
    const layout = kbLayout(join(kbPath, 'not-exist'));
    const files = await layout.listMarkdownFiles();
    expect(files.size).toBe(0);
  });
});

// ── findSource / listSourceFiles ─────────────────────────────────

describe('kbLayout.findSource / listSourceFiles', () => {
  let kbPath: string;

  beforeEach(async () => {
    kbPath = await makeFullKb();
  });

  afterEach(async () => {
    await rm(kbPath, { recursive: true, force: true });
  });

  it('findSource 按文档名（不含扩展名）找到源文件', async () => {
    const layout = kbLayout(kbPath);
    await writeFile(layout.sourcePath('文档A.docx'), Buffer.from([0x50, 0x4b]));

    const found = await layout.findSource('文档A');
    expect(found).toBe(layout.sourcePath('文档A.docx'));
  });

  it('findSource 同名不同扩展名时返回第一个匹配', async () => {
    const layout = kbLayout(kbPath);
    await writeFile(layout.sourcePath('文档B.pdf'), Buffer.from([0x25, 0x50]));

    const found = await layout.findSource('文档B');
    expect(found).toBe(layout.sourcePath('文档B.pdf'));
  });

  it('findSource 未找到时返回 null', async () => {
    const layout = kbLayout(kbPath);
    const found = await layout.findSource('不存在');
    expect(found).toBeNull();
  });

  it('listSourceFiles 返回 sources/ 中所有文件名', async () => {
    const layout = kbLayout(kbPath);
    await writeFile(layout.sourcePath('a.docx'), 'a');
    await writeFile(layout.sourcePath('b.pdf'), 'b');
    await mkdir(layout.sourcePath('subdir'), { recursive: true }); // 目录不算

    const files = await layout.listSourceFiles();
    expect(files).toContain('a.docx');
    expect(files).toContain('b.pdf');
    expect(files).not.toContain('subdir');
    expect(files).toHaveLength(2);
  });

  it('listSourceFiles sources/ 不存在时返回空数组', async () => {
    const layout = kbLayout('/tmp/nonexistent-kb');
    const files = await layout.listSourceFiles();
    expect(files).toEqual([]);
  });
});

// ── cleanupDocArtifacts ───────────────────────────────────────────

describe('kbLayout.cleanupDocArtifacts', () => {
  let kbPath: string;

  beforeEach(async () => {
    kbPath = await makeFullKb();
  });

  afterEach(async () => {
    await rm(kbPath, { recursive: true, force: true });
  });

  it('清理 docs/ 根下的同名 .md', async () => {
    const layout = kbLayout(kbPath);
    await writeFile(layout.rootMdPath('文档A'), '# 文档A');

    await layout.cleanupDocArtifacts('文档A');

    expect(existsSync(layout.rootMdPath('文档A'))).toBe(false);
  });

  it('清理 assets/<docName>/ 目录', async () => {
    const layout = kbLayout(kbPath);
    await mkdir(layout.assetsDir('文档A'), { recursive: true });
    await writeFile(join(layout.assetsDir('文档A'), 'image-001.png'), 'img');

    await layout.cleanupDocArtifacts('文档A');

    expect(existsSync(layout.assetsDir('文档A'))).toBe(false);
  });

  it('清理子目录中的同名 .md', async () => {
    const layout = kbLayout(kbPath);
    await mkdir(layout.categoryDir('分类1'), { recursive: true });
    await mkdir(layout.categoryDir('分类2'), { recursive: true });
    await writeFile(layout.categoryMdPath('分类1', '文档A'), '# in cat1');
    await writeFile(layout.categoryMdPath('分类2', '文档A'), '# in cat2');

    await layout.cleanupDocArtifacts('文档A');

    expect(existsSync(layout.categoryMdPath('分类1', '文档A'))).toBe(false);
    expect(existsSync(layout.categoryMdPath('分类2', '文档A'))).toBe(false);
  });

  it('docs/ 不存在时静默跳过', async () => {
    const layout = kbLayout('/tmp/nonexistent-kb');
    // 不应抛出异常
    await expect(layout.cleanupDocArtifacts('任何文档')).resolves.toBeUndefined();
  });
});

// ── initKbLayout ──────────────────────────────────────────────────

describe('initKbLayout', () => {
  let kbPath: string;

  beforeEach(async () => {
    kbPath = await makeTempKb();
  });

  afterEach(async () => {
    await rm(kbPath, { recursive: true, force: true });
  });

  it('初始化标准结构 sources/ docs/ index.md', async () => {
    await initKbLayout(kbPath);

    const layout = kbLayout(kbPath);
    expect(existsSync(layout.sourcesDir)).toBe(true);
    expect(existsSync(layout.docsDir)).toBe(true);
    expect(existsSync(layout.indexMdPath)).toBe(true);

    const content = await readFile(layout.indexMdPath, 'utf-8');
    expect(content).toContain('# 知识库索引');
  });

  it('已存在的目录/文件不被覆盖', async () => {
    const layout = kbLayout(kbPath);
    // 先创建 index.md 带自定义内容
    await mkdir(layout.docsDir, { recursive: true });
    await writeFile(layout.indexMdPath, '# 自定义索引', 'utf-8');

    // 再初始化
    await initKbLayout(kbPath);

    // 内容应保留
    const content = await readFile(layout.indexMdPath, 'utf-8');
    expect(content).toBe('# 自定义索引');
  });

  it('INDEX_MD_SKELETON 包含正确注释', () => {
    expect(INDEX_MD_SKELETON).toContain('# 知识库索引');
    expect(INDEX_MD_SKELETON).toContain('AI Agent 会话启动时注入为库地图');
  });
});

// ── checkKbHealth ─────────────────────────────────────────────────

describe('checkKbHealth', () => {
  let kbPath: string;

  beforeEach(async () => {
    kbPath = await makeTempKb();
  });

  afterEach(async () => {
    await rm(kbPath, { recursive: true, force: true });
  });

  it('空目录全部 false', async () => {
    const health = await checkKbHealth(kbPath);
    expect(health.hasSources).toBe(false);
    expect(health.hasDocs).toBe(false);
    expect(health.hasIndex).toBe(false);
  });

  it('初始化后全部 true', async () => {
    await initKbLayout(kbPath);
    const health = await checkKbHealth(kbPath);
    expect(health.hasSources).toBe(true);
    expect(health.hasDocs).toBe(true);
    expect(health.hasIndex).toBe(true);
  });

  it('部分结构存在时反映正确状态', async () => {
    const layout = kbLayout(kbPath);
    await mkdir(layout.sourcesDir, { recursive: true });
    // docs/ 不存在，index.md 不存在

    const health = await checkKbHealth(kbPath);
    expect(health.hasSources).toBe(true);
    expect(health.hasDocs).toBe(false);
    expect(health.hasIndex).toBe(false);
  });
});

// ── countKbDocs ───────────────────────────────────────────────────

describe('countKbDocs', () => {
  let kbPath: string;

  beforeEach(async () => {
    kbPath = await makeFullKb();
  });

  afterEach(async () => {
    await rm(kbPath, { recursive: true, force: true });
  });

  it('空 docs/ 返回 0', async () => {
    const { documentCount, categoryCount } = await countKbDocs(kbPath);
    expect(documentCount).toBe(0);
    expect(categoryCount).toBe(0);
  });

  it('统计根目录下的 .md 文件', async () => {
    const layout = kbLayout(kbPath);
    await writeFile(layout.rootMdPath('文档1'), '# 1');
    await writeFile(layout.rootMdPath('文档2'), '# 2');

    const { documentCount, categoryCount } = await countKbDocs(kbPath);
    expect(documentCount).toBe(2);
    expect(categoryCount).toBe(0);
  });

  it('统计子目录下的 .md 文件和分类数', async () => {
    const layout = kbLayout(kbPath);
    await mkdir(layout.categoryDir('分类A'), { recursive: true });
    await mkdir(layout.categoryDir('分类B'), { recursive: true });
    await writeFile(layout.categoryMdPath('分类A', '文档1'), '# 1');
    await writeFile(layout.categoryMdPath('分类A', '文档2'), '# 2');
    await writeFile(layout.categoryMdPath('分类B', '文档3'), '# 3');

    const { documentCount, categoryCount } = await countKbDocs(kbPath);
    expect(documentCount).toBe(3);
    expect(categoryCount).toBe(2);
  });

  it('跳过 assets 目录', async () => {
    const layout = kbLayout(kbPath);
    await mkdir(layout.assetsDir('文档1'), { recursive: true });
    await writeFile(join(layout.assetsDir('文档1'), 'image.png'), 'img');
    await writeFile(layout.rootMdPath('文档1'), '# 1');

    const { documentCount, categoryCount } = await countKbDocs(kbPath);
    expect(documentCount).toBe(1);
    expect(categoryCount).toBe(0);
  });

  it('docs/ 不存在时返回 0', async () => {
    const { documentCount, categoryCount } = await countKbDocs('/tmp/nonexistent-kb');
    expect(documentCount).toBe(0);
    expect(categoryCount).toBe(0);
  });
});
