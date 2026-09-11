/**
 * Skill discovery — pi canonical 来源与旧 omp 只读兼容（issue 09）。
 *
 * 引擎迁移到 pi 后，skill 的发现、创建与解析对齐 pi canonical 布局：
 *
 *   项目级 canonical:  <root>/.pi/skills          （pi 默认项目来源）
 *   用户级 canonical:  ~/.pi/agent/skills          （pi 默认用户来源，可管理）
 *   内置:              <app>/resources/built-in-extension/skills（随应用打包）
 *
 * 旧 omp 布局只读兼容一个版本周期（只发现、不创建、不修改、不删除）：
 *
 *   项目级 legacy:     <root>/.omp/skills
 *   用户级 legacy:     ~/.omp/agent/skills
 *
 * managed-skills（omp 自动学习产物）不迁移：不再发现，应用任何代码路径
 * 都不写入该目录。omp 时代的镜像目录（.claude/.agents/.github/.codex）
 * 是旧引擎的发现规则，pi 不加载，随之停止扫描。
 *
 * 同名 skill 解析优先级（first-wins，只暴露一个确定结果）：
 *   project canonical > project legacy > builtin > user canonical > user legacy
 * （作用域优先 project > builtin > user；同作用域内 canonical 优先于 legacy）
 *
 * 每个技能是 <skills-dir>/<skill-name>/SKILL.md，frontmatter：
 *   ---
 *   name: skill-name
 *   description: Skill description text
 *   ---
 *   # Body content...
 */

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { resolveBuiltInExtensionDir } from './paths';
import type { SkillInfo, SkillSource, SkillDirectoryInfo, CreateSkillInput, SkillInstallInfo } from '@shared/types';

export type { SkillInfo, SkillSource, SkillDirectoryInfo, CreateSkillInput, SkillInstallInfo };

// ─── 来源定义（有序 = 解析优先级） ───────────────────────

/** 一个被扫描的技能根目录及其来源语义。 */
export type SkillRootDir = {
  /** 绝对路径 */
  path: string;
  /** UI 展示用的来源分类 */
  source: SkillSource;
  /** 是否为 pi canonical 来源（相对旧 omp legacy 而言） */
  canonical: boolean;
  /** 应用是否可在该目录创建/删除技能 */
  manageable: boolean;
};

/** 内置技能子目录名（位于 built-in-extension 包内）。 */
const BUILTIN_SKILLS_SUBDIR = 'skills';

/**
 * 组装项目级 + 用户级 + 内置的有序技能根目录列表。
 * 顺序即同名解析优先级：project canonical > project legacy > builtin >
 * user canonical > user legacy。
 */
export function getSkillRootDirs(projectRoot: string | null): SkillRootDir[] {
  const home = homedir();
  const dirs: SkillRootDir[] = [];

  if (projectRoot) {
    dirs.push(
      { path: join(projectRoot, '.pi', 'skills'), source: 'project', canonical: true, manageable: false },
      { path: join(projectRoot, '.omp', 'skills'), source: 'project', canonical: false, manageable: false },
    );
  }

  const builtInExtDir = resolveBuiltInExtensionDir();
  if (builtInExtDir) {
    dirs.push({
      path: join(builtInExtDir, BUILTIN_SKILLS_SUBDIR),
      source: 'builtin',
      canonical: true,
      manageable: false,
    });
  }

  dirs.push(
    { path: join(home, '.pi', 'agent', 'skills'), source: 'user', canonical: true, manageable: true },
    // 只读兼容一个版本周期（移除期限：v0.6.0，见 spec「Further Notes」——
    // 历史兼容读取点应有明确注释和移除期限）：仅发现，不创建/修改/删除
    { path: join(home, '.omp', 'agent', 'skills'), source: 'user', canonical: false, manageable: false },
  );

  return dirs;
}

/**
 * runner 装载用的有序 skill 目录列表（仅含磁盘上存在的目录）。
 *
 * host 与 runner 的单一事实来源：UI 发现（discoverSkills）与 pi 会话
 * 实际装载（DefaultResourceLoader additionalSkillPaths）使用同一份列表，
 * 保证"列表里看到的"就是"会被加载的"。旧 omp 目录在兼容期内仍会装载
 * （只读可用），canonical 目录优先。
 */
export async function resolveSkillLoadPaths(projectRoot: string): Promise<string[]> {
  return getSkillRootDirs(projectRoot)
    .map((d) => d.path)
    .filter((p) => existsSync(p));
}

/**
 * Parse YAML-like frontmatter from SKILL.md content.
 * Extracts `name` and `description` fields.
 *
 * 支持任意换行符（LF / CRLF）：先统一规范化为 LF 再解析，避免 CRLF 文件
 * 因行尾 `\r` 导致 `^name:...$` 正则匹配失败。
 */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  // 统一换行符：CRLF / CR → LF
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const fmMatch = normalized.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};

  const fm = fmMatch[1];
  const result: { name?: string; description?: string } = {};

  // Simple line-based parsing (not a full YAML parser, but sufficient for SKILL.md)
  const lines = fm.split('\n');
  for (const line of lines) {
    const nameMatch = line.match(/^name:\s*(.+)$/);
    if (nameMatch) {
      result.name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    const descMatch = line.match(/^description:\s*(.+)$/);
    if (descMatch) {
      result.description = descMatch[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
  }

  return result;
}

/**
 * Scan a single skills directory for SKILL.md files.
 * Expected layout: <dir>/<skill-name>/SKILL.md
 * Also supports a single SKILL.md directly in <dir>.
 */
async function scanSkillDir(
  dir: string,
  source: SkillSource,
): Promise<SkillInfo[]> {
  if (!existsSync(dir)) return [];

  const skills: SkillInfo[] = [];

  try {
    // Check for direct SKILL.md in the directory itself
    const directSkillPath = join(dir, 'SKILL.md');
    if (existsSync(directSkillPath)) {
      const skill = await tryParseSkill(directSkillPath, source);
      if (skill) skills.push(skill);
    }

    // Scan subdirectories
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(dir, entry.name, 'SKILL.md');
      if (existsSync(skillPath)) {
        const skill = await tryParseSkill(skillPath, source);
        if (skill) skills.push(skill);
      }
    }
  } catch {
    // Permission errors etc — return what we have
  }

  return skills;
}

/** Read and parse a SKILL.md file */
async function tryParseSkill(
  filePath: string,
  source: SkillSource,
): Promise<SkillInfo | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const fm = parseFrontmatter(content);
    // Use frontmatter name, or fall back to the skill's directory name.
    // Note: Node's basename(path, ext) only strips ext if it starts with '.',
    // so we cannot pass 'SKILL.md' as ext — use dirname + basename instead.
    const name = fm.name || basename(dirname(filePath));
    if (!name) return null;

    return {
      name,
      description: fm.description || '',
      filePath,
      source,
      baseDir: dirname(filePath),
    };
  } catch {
    return null;
  }
}

/**
 * 按有序目录列表扫描并去重（first-wins）。
 * 调用方保证 dirs 的顺序即解析优先级（见 getSkillRootDirs）。
 */
async function discoverFromDirs(dirs: SkillRootDir[]): Promise<SkillInfo[]> {
  const seen = new Set<string>();
  const deduped: SkillInfo[] = [];
  for (const dir of dirs) {
    const found = await scanSkillDir(dir.path, dir.source);
    for (const skill of found) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      deduped.push(skill);
    }
  }
  return deduped;
}

/**
 * Discover all available skills for a given project root.
 * Scans project-level, built-in, and user-level skill directories.
 * 同名 skill 按 project > builtin > user 解析（同作用域 canonical 优先），
 * 只暴露一个确定结果。
 */
export async function discoverSkills(projectRoot: string): Promise<SkillInfo[]> {
  return discoverFromDirs(getSkillRootDirs(projectRoot));
}

/**
 * Discover all available skills WITHOUT a project root.
 * Used by the settings page — scans built-in and user-level directories only.
 */
export async function discoverAllSkills(): Promise<SkillInfo[]> {
  return discoverFromDirs(getSkillRootDirs(null));
}

/**
 * Read the full content of a SKILL.md file.
 * Used when sending a skill as context to the agent.
 */
export async function readSkillContent(filePath: string): Promise<string> {
  return readFile(filePath, 'utf-8');
}

/**
 * Resolve a `skill://` internal URI to the real file path on disk.
 *
 * 会话内用 `skill://<name>[/<rel>]` 引用技能文件，UI 层（工具卡片路径点击
 * 等）拿到的是原始 URI 字符串——直接当文件路径打开必然失败。此函数将其
 * 解析为磁盘上的绝对路径：
 *   skill://<name>            → 该技能的 SKILL.md
 *   skill://<name>/<rel-path> → 技能 baseDir 下的相对文件（如 references/foo.md）
 *
 * 安全约束（与 pi 加载语义一致）：拒绝绝对路径与 `..` 穿越；目标必须
 * 存在。解析不到（技能不存在 / 文件不存在）返回 null。
 */
export async function resolveSkillUriPath(projectRoot: string, uri: string): Promise<string | null> {
  if (!uri.startsWith('skill://')) return null;

  const rest = uri.slice('skill://'.length);
  const slashIdx = rest.indexOf('/');
  const name = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  const rel = slashIdx === -1 ? '' : rest.slice(slashIdx + 1);
  if (!name) return null;

  const skills = await discoverSkills(projectRoot);
  const skill = skills.find((s) => s.name === name);
  if (!skill) return null;

  if (!rel) return skill.filePath;

  // 引擎侧会做 decodeURIComponent，这里保持一致；解码失败按原文处理
  let decoded = rel;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    // keep raw
  }
  // 拒绝绝对路径与 .. 穿越（Windows 盘符路径与 POSIX 绝对路径均拦截）
  if (isAbsolute(decoded) || decoded.split(/[\\/]/).includes('..')) return null;

  const target = join(skill.baseDir, decoded);
  return existsSync(target) ? target : null;
}

/**
 * Get information about all scanned skill directories.
 * Used by the settings page to show users where skills are discovered from.
 * 从 getSkillRootDirs(null) 派生 —— 目录清单与 manageable 语义只有这一份
 * 定义，UI 展示不会与实际扫描/写入点漂移。
 */
export async function getSkillDirectoryInfo(): Promise<SkillDirectoryInfo[]> {
  const dirLabel = (dir: SkillRootDir): string => {
    if (dir.source === 'builtin') return '内置技能（随应用打包）';
    return dir.canonical ? '用户级（pi canonical）' : '旧版 OMP 用户级（只读兼容）';
  };

  return getSkillRootDirs(null).map((dir) => ({
    path: dir.path,
    source: dir.source,
    label: dirLabel(dir),
    exists: existsSync(dir.path),
    manageable: dir.manageable,
  }));
}

/**
 * Get skill install info including directories and guidance text.
 */
export async function getSkillInstallInfo(): Promise<SkillInstallInfo> {
  const directories = await getSkillDirectoryInfo();
  const guidance = [
    '技能以 SKILL.md 文件的形式存在，pi 引擎会自动发现以下目录中的技能：',
    '',
    '1. 内置技能：随应用打包，不可修改。',
    '2. 用户级技能（pi canonical）：~/.pi/agent/skills/，可在此页面创建和管理。',
    '3. 项目级技能（pi canonical）：项目根目录 .pi/skills/，随项目分发。',
    '',
    '旧版兼容（只读，移除期限 v0.6.0）：',
    '  - 项目根目录 .omp/skills/ 与用户目录 ~/.omp/agent/skills/ 中的旧技能',
    '    在一个版本周期内仍会被发现和加载，但不再支持创建、修改和删除；',
    '    请将仍在使用的技能迁移到上方的 canonical 目录。',
  ].join('\n');

  return { directories, guidance };
}

/** Validate a kebab-case skill name. */
function validateSkillName(name: string): void {
  const pattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
  if (!pattern.test(name)) {
    throw new Error(
      `无效的技能名称 "${name}"。请使用小写字母、数字和连字符（1-64 字符，以字母或数字开头）。`,
    );
  }
}

/** pi canonical 用户级技能根目录（应用创建/删除技能的唯一写入点）。 */
function canonicalUserSkillsDir(): string {
  return join(homedir(), '.pi', 'agent', 'skills');
}

/**
 * Create a new user-level skill.
 * 写入 pi canonical 用户级目录 ~/.pi/agent/skills/<name>/SKILL.md。
 * 旧 omp 目录（含 managed-skills）在迁移后不被创建或修改。
 */
export async function createUserSkill(input: CreateSkillInput): Promise<SkillInfo> {
  const name = input.name.trim().toLowerCase();
  validateSkillName(name);

  if (!input.description.trim()) {
    throw new Error('技能描述不能为空');
  }
  if (!input.body.trim()) {
    throw new Error('技能内容不能为空');
  }

  const skillDir = join(canonicalUserSkillsDir(), name);
  const skillFilePath = join(skillDir, 'SKILL.md');

  // Check if skill already exists
  if (existsSync(skillFilePath)) {
    throw new Error(`技能 "${name}" 已存在`);
  }

  // Sanitize description: single line, strip control chars
  const description = input.description.trim().replace(/[\r\n]+/g, ' ');

  // Build SKILL.md content
  const content = `---\nname: ${name}\ndescription: "${description}"\n---\n\n${input.body.trim()}\n`;

  await mkdir(skillDir, { recursive: true });
  await writeFile(skillFilePath, content, 'utf-8');

  return {
    name,
    description,
    filePath: skillFilePath,
    source: 'user',
    baseDir: skillDir,
  };
}

/**
 * Delete a user-level skill by name.
 * 只允许删除 pi canonical 用户级目录中的技能；旧 omp 只读兼容目录中的
 * 技能拒绝删除（一个版本周期内只读可用，请先迁移到 canonical 目录）。
 *
 * Node.js v22 `fs.rm({ recursive: true, force: true })` 在 Windows 上存在 bug：
 * 报告成功但目录实际未被删除。因此删除后会验证目录确实不存在；
 * 如果 `fs.rm` 失效，回退到 Windows 原生 `rmdir` 命令。
 */
export async function deleteUserSkill(name: string): Promise<void> {
  const safeName = name.trim().toLowerCase();
  validateSkillName(safeName);

  const skillDir = join(canonicalUserSkillsDir(), safeName);

  if (!existsSync(skillDir)) {
    // 区分「存在于只读旧目录」与「不存在」，给出可操作的错误信息
    const legacyDir = join(homedir(), '.omp', 'agent', 'skills', safeName);
    if (existsSync(join(legacyDir, 'SKILL.md'))) {
      throw new Error(
        `技能 "${safeName}" 位于旧版 OMP 只读兼容目录，不支持删除。` +
          '请将该技能迁移到 ~/.pi/agent/skills 后再管理。',
      );
    }
    throw new Error(`技能 "${safeName}" 不存在于用户级目录中`);
  }

  // Safety: only delete if it looks like a skill directory (contains SKILL.md)
  const skillFilePath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillFilePath)) {
    throw new Error(`目录 "${skillDir}" 不包含 SKILL.md，不是有效的技能目录`);
  }

  // Step 1: try fs.rm (works on Linux/macOS and older Node.js on Windows)
  try {
    await rm(skillDir, { recursive: true, force: true });
  } catch {
    // Ignore — will fall back to native command below
  }

  // Step 2: verify deletion. fs.rm may silently fail on Windows (Node.js v22 bug).
  if (!existsSync(skillDir)) return;

  // Step 3: fallback to native OS command (reliable on Windows where fs.rm is broken)
  if (process.platform === 'win32') {
    try {
      execSync(`rmdir /s /q "${skillDir}"`, { shell: 'cmd.exe', stdio: 'ignore' });
    } catch {
      // Fall through to error below
    }
  } else {
    try {
      execSync(`rm -rf "${skillDir}"`, { stdio: 'ignore' });
    } catch {
      // Fall through to error below
    }
  }

  // Step 4: final verification
  if (existsSync(skillDir)) {
    throw new Error(
      `无法删除技能目录 "${skillDir}"（可能被其他进程锁定）。请关闭相关程序后重试。`,
    );
  }
}
