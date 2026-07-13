/**
 * Skill discovery: scans for SKILL.md files in known directories.
 *
 * Skill directories (mirroring the omp engine's discovery):
 *   Project-level:  <root>/.omp/skills, <root>/.claude/skills, <root>/.agents/skills, <root>/.github/skills
 *   User-level:     ~/.omp/skills, ~/.claude/skills, ~/.agents/skills
 *
 * Each SKILL.md has YAML-like frontmatter:
 *   ---
 *   name: skill-name
 *   description: Skill description text
 *   ---
 *   # Body content...
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export interface DiscoveredSkill {
  name: string;
  description: string;
  filePath: string;
  source: 'project' | 'user';
  /** Directory containing the SKILL.md */
  baseDir: string;
}

/** Directories to scan for project-level skills */
const PROJECT_SKILL_DIRS = [
  '.omp/skills',
  '.claude/skills',
  '.agents/skills',
  '.github/skills',
];

/** Directories to scan for user-level skills */
const USER_SKILL_DIRS = [
  '.omp/skills',
  '.claude/skills',
  '.agents/skills',
];

/**
 * Parse YAML-like frontmatter from SKILL.md content.
 * Extracts `name` and `description` fields.
 */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
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
  source: 'project' | 'user',
): Promise<DiscoveredSkill[]> {
  if (!existsSync(dir)) return [];

  const skills: DiscoveredSkill[] = [];

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
  source: 'project' | 'user',
): Promise<DiscoveredSkill | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const fm = parseFrontmatter(content);
    // Use frontmatter name, or fall back to directory name
    const name = fm.name || basename(basename(filePath, 'SKILL.md'));
    if (!name) return null;

    return {
      name,
      description: fm.description || '',
      filePath,
      source,
      baseDir: filePath.replace(/[\\/]SKILL\.md$/, ''),
    };
  } catch {
    return null;
  }
}

/**
 * Discover all available skills for a given project root.
 * Scans both project-level and user-level skill directories.
 * Deduplicates by skill name (project-level takes priority).
 */
export async function discoverSkills(projectRoot: string): Promise<DiscoveredSkill[]> {
  const home = homedir();
  const allSkills: DiscoveredSkill[] = [];

  // Scan project-level skill directories
  for (const relDir of PROJECT_SKILL_DIRS) {
    const dir = join(projectRoot, relDir);
    const found = await scanSkillDir(dir, 'project');
    allSkills.push(...found);
  }

  // Scan user-level skill directories
  for (const relDir of USER_SKILL_DIRS) {
    const dir = join(home, relDir);
    const found = await scanSkillDir(dir, 'user');
    allSkills.push(...found);
  }

  // Deduplicate by name — project-level skills take priority
  const seen = new Set<string>();
  const deduped: DiscoveredSkill[] = [];
  // Sort so project skills come first
  allSkills.sort((a, b) => {
    if (a.source === 'project' && b.source === 'user') return -1;
    if (a.source === 'user' && b.source === 'project') return 1;
    return 0;
  });
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
