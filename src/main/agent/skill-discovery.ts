/**
 * Skill discovery: scans for SKILL.md files in known directories.
 *
 * Skill directories (mirroring the omp engine's discovery):
 *   Built-in:       <app>/resources/built-in-extension/skills  (随应用打包)
 *   Project-level:  <root>/.omp/skills, <root>/.claude/skills, <root>/.agents/skills, <root>/.github/skills
 *   User-level:     ~/.omp/agent/skills, ~/.omp/agent/managed-skills, ~/.claude/skills, ~/.agents/skills, ~/.codex/skills
 *
 * Each SKILL.md has YAML-like frontmatter:
 *   ---
 *   name: skill-name
 *   description: Skill description text
 *   ---
 *   # Body content...
 */

import { readdir, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { resolveBuiltInExtensionDir } from './paths';
import type { SkillInfo, SkillSource, SkillDirectoryInfo, CreateSkillInput, SkillInstallInfo } from '@shared/types';

export type { SkillInfo, SkillSource, SkillDirectoryInfo, CreateSkillInput, SkillInstallInfo };

/** Directories to scan for project-level skills */
const PROJECT_SKILL_DIRS = [
  '.omp/skills',
  '.claude/skills',
  '.agents/skills',
  '.github/skills',
];

/**
 * User-level skill directory descriptors.
 * Mirrors omp engine's discovery: native omp uses ~/.omp/agent/skills (not ~/.omp/skills).
 */
interface UserSkillDirEntry {
  /** Path relative to home directory */
  relPath: string;
  /** Human-readable label */
  label: string;
  /** Whether skills here can be created/deleted by the app */
  manageable: boolean;
}

const USER_SKILL_DIRS: UserSkillDirEntry[] = [
  { relPath: '.omp/agent/skills', label: 'OMP 用户级', manageable: true },
  { relPath: '.omp/agent/managed-skills', label: 'OMP 自动学习', manageable: true },
  { relPath: '.claude/skills', label: 'Claude 用户级', manageable: true },
  { relPath: '.agents/skills', label: 'Agents 用户级', manageable: true },
  { relPath: '.codex/skills', label: 'Codex 用户级', manageable: true },
];

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
 * Discover all available skills for a given project root.
 * Scans built-in, project-level, and user-level skill directories.
 * Deduplicates by skill name with priority: project > builtin > user.
 */
export async function discoverSkills(projectRoot: string): Promise<SkillInfo[]> {
  const home = homedir();
  const allSkills: SkillInfo[] = [];

  // Scan built-in extension skills (shipped with the app)
  const builtInExtDir = resolveBuiltInExtensionDir();
  if (builtInExtDir) {
    const builtInSkillsDir = join(builtInExtDir, 'skills');
    const found = await scanSkillDir(builtInSkillsDir, 'builtin');
    allSkills.push(...found);
  }

  // Scan project-level skill directories
  for (const relDir of PROJECT_SKILL_DIRS) {
    const dir = join(projectRoot, relDir);
    const found = await scanSkillDir(dir, 'project');
    allSkills.push(...found);
  }

  // Scan user-level skill directories
  for (const entry of USER_SKILL_DIRS) {
    const dir = join(home, entry.relPath);
    const found = await scanSkillDir(dir, 'user');
    allSkills.push(...found);
  }

  // Deduplicate by name — priority: project > builtin > user
  const sourcePriority: Record<SkillSource, number> = { project: 0, builtin: 1, user: 2 };
  const seen = new Set<string>();
  const deduped: SkillInfo[] = [];
  allSkills.sort((a, b) => sourcePriority[a.source] - sourcePriority[b.source]);
  for (const skill of allSkills) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    deduped.push(skill);
  }

  return deduped;
}

/**
 * Discover all available skills WITHOUT a project root.
 * Used by the settings page — scans built-in and user-level directories only.
 * Deduplicates by skill name with priority: builtin > user.
 */
export async function discoverAllSkills(): Promise<SkillInfo[]> {
  const home = homedir();
  const allSkills: SkillInfo[] = [];

  // Scan built-in extension skills (shipped with the app)
  const builtInExtDir = resolveBuiltInExtensionDir();
  if (builtInExtDir) {
    const builtInSkillsDir = join(builtInExtDir, 'skills');
    const found = await scanSkillDir(builtInSkillsDir, 'builtin');
    allSkills.push(...found);
  }

  // Scan user-level skill directories
  for (const entry of USER_SKILL_DIRS) {
    const dir = join(home, entry.relPath);
    const found = await scanSkillDir(dir, 'user');
    allSkills.push(...found);
  }

  // Deduplicate by name — priority: builtin > user
  const sourcePriority: Record<SkillSource, number> = { project: 0, builtin: 1, user: 2 };
  const seen = new Set<string>();
  const deduped: SkillInfo[] = [];
  allSkills.sort((a, b) => sourcePriority[a.source] - sourcePriority[b.source]);
  for (const skill of allSkills) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    deduped.push(skill);
  }

  return deduped;
}

/**
 * Read the full content of a SKILL.md file.
 * Used when sending a skill as context to the agent.
 */
export async function readSkillContent(filePath: string): Promise<string> {
  return readFile(filePath, 'utf-8');
}

/**
 * Get information about all scanned skill directories.
 * Used by the settings page to show users where skills are discovered from.
 */
export async function getSkillDirectoryInfo(): Promise<SkillDirectoryInfo[]> {
  const home = homedir();
  const dirs: SkillDirectoryInfo[] = [];

  // Built-in directory
  const builtInExtDir = resolveBuiltInExtensionDir();
  if (builtInExtDir) {
    const builtInSkillsDir = join(builtInExtDir, 'skills');
    dirs.push({
      path: builtInSkillsDir,
      source: 'builtin',
      label: '内置技能（随应用打包）',
      exists: existsSync(builtInSkillsDir),
      manageable: false,
    });
  }

  // User-level directories
  for (const entry of USER_SKILL_DIRS) {
    const dir = join(home, entry.relPath);
    dirs.push({
      path: dir,
      source: 'user',
      label: entry.label,
      exists: existsSync(dir),
      manageable: entry.manageable,
    });
  }

  return dirs;
}

/**
 * Get skill install info including directories and guidance text.
 */
export async function getSkillInstallInfo(): Promise<SkillInstallInfo> {
  const directories = await getSkillDirectoryInfo();
  const guidance = [
    '技能以 SKILL.md 文件的形式存在，omp 会自动发现以下目录中的技能：',
    '',
    '1. 内置技能：随应用打包，不可修改。',
    '2. 用户级技能：放在用户主目录下，可在此页面创建和管理。',
    '3. 项目级技能：放在项目根目录的 .omp/skills/ 等目录下，随项目分发。',
    '',
    'SKILL.md 格式：',
    '  ---',
    '  name: my-skill          # 技能名称（kebab-case）',
    '  description: 技能描述     # 一行描述，用于技能发现',
    '  ---',
    '  # 技能内容',
    '  Markdown 格式的技能正文...',
    '',
    '技能目录结构：<skills-dir>/<skill-name>/SKILL.md',
  ].join('\n');

  return { directories, guidance };
}

/** Validate a kebab-case skill name (matches omp's managed-skill pattern). */
function validateSkillName(name: string): void {
  const pattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
  if (!pattern.test(name)) {
    throw new Error(
      `无效的技能名称 "${name}"。请使用小写字母、数字和连字符（1-64 字符，以字母或数字开头）。`,
    );
  }
}

/**
 * Create a new user-level skill.
 * Writes SKILL.md to ~/.omp/agent/skills/<name>/SKILL.md.
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

  const home = homedir();
  // Create in the primary user-level omp skills directory
  const skillDir = join(home, '.omp/agent/skills', name);
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
 * Only allows deleting skills from user-level directories (not built-in or project-level).
 */
export async function deleteUserSkill(name: string): Promise<void> {
  const safeName = name.trim().toLowerCase();
  validateSkillName(safeName);

  const home = homedir();
  const skillDir = join(home, '.omp/agent/skills', safeName);

  if (!existsSync(skillDir)) {
    throw new Error(`技能 "${safeName}" 不存在于用户级目录中`);
  }

  // Safety: only delete if it looks like a skill directory (contains SKILL.md)
  const skillFilePath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillFilePath)) {
    throw new Error(`目录 "${skillDir}" 不包含 SKILL.md，不是有效的技能目录`);
  }

  await rm(skillDir, { recursive: true, force: true });
}
