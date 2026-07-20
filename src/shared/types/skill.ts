/**
 * Skill management shared types.
 *
 * Used by the settings router and renderer to display, create, and delete
 * omp-discoverable skills (SKILL.md files).
 */

/** Where a skill was discovered from. */
export type SkillSource = 'project' | 'user' | 'builtin';

/** A discovered skill (mirrors DiscoveredSkill from skill-discovery.ts). */
export interface SkillInfo {
  name: string;
  description: string;
  /** Absolute path to the SKILL.md file. */
  filePath: string;
  /** Where the skill was discovered. */
  source: SkillSource;
  /** Directory containing the SKILL.md (the skill's base directory). */
  baseDir: string;
}

/** Information about a scanned skill directory. */
export interface SkillDirectoryInfo {
  /** Absolute path to the directory. */
  path: string;
  /** Source label for skills discovered in this directory. */
  source: SkillSource;
  /** Human-readable label, e.g. "OMP 用户级", "Claude 用户级". */
  label: string;
  /** Whether the directory currently exists on disk. */
  exists: boolean;
  /** Whether skills in this directory can be managed (created/deleted) by the app. */
  manageable: boolean;
}

/** Input for creating a new user-level skill. */
export interface CreateSkillInput {
  /** Kebab-case skill name (lowercase letters, digits, hyphens). */
  name: string;
  /** One-line description shown in skill discovery. */
  description: string;
  /** Markdown body for SKILL.md (without frontmatter). */
  body: string;
}

/** Result of skill directory info query. */
export interface SkillInstallInfo {
  /** All scanned skill directories. */
  directories: SkillDirectoryInfo[];
  /** Guidance text explaining how to install skills manually. */
  guidance: string;
}
