/**
 * Regression Discovery — scans $PROJ_ENV directory tree for regression list/group files.
 *
 * See ADR 0020 for design rationale.
 *
 * Scanning sources:
 *   1. $PROJ_ENV/<subsys>/regression/           — direct subsystem lists
 *   2. $PROJ_ENV/udtb/<subsys>/<block>/regression/  — ip2soc lists (merged into subsys)
 *   3. $PROJ_ENV/udtb/usvp/regression/<short>/   — usvp lists (mapped via usvp-subsys-map.json)
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import type {
  RegressionEntry,
  RegressionList,
  RegressionGroup,
  RegressionItem,
  RegressionDiscoveryResult,
} from '@shared/types/regression';

// ── Constants ──────────────────────────────────────────

const SOCVERIFY_DIR = '.socverify';
const USVP_MAP_FILE = 'usvp-subsys-map.json';
const MAX_GRP_DEPTH = 10;

// ── File type detection ───────────────────────────────

/**
 * Detect whether a file is a regression list, group, or neither.
 *
 * - List: has at least one line matching `^\s*(ON|OFF)\s*,` (ignoring comments/blank lines)
 * - Group: has at least one line that looks like a file path (not ON/OFF, not comment)
 * - Neither: ignored
 */
export type FileType = 'list' | 'group' | 'unknown';

export function detectFileType(content: string): FileType {
  const lines = content.split(/\r?\n/);
  let hasOnOff = false;
  let hasPathLike = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;

    if (/^(ON|OFF)\s*[,]/i.test(line)) {
      hasOnOff = true;
    } else if (isPathLike(line)) {
      hasPathLike = true;
    }
  }

  // If file has ON/OFF lines, treat as list (paths might appear in plusargs)
  if (hasOnOff) return 'list';
  if (hasPathLike) return 'group';
  return 'unknown';
}

/**
 * Check if a line looks like a file path reference.
 * Paths typically contain / or \ or start with $ (env var).
 */
function isPathLike(line: string): boolean {
  // Must not be a comment or ON/OFF line (already filtered by caller)
  // Check for path-like characteristics
  if (line.startsWith('$')) return true;       // $PROJ_DIR/...
  if (/[\\/]/.test(line)) return true;        // contains slash or backslash
  return false;
}

// ── List parsing ──────────────────────────────────────

/**
 * Parse a regression list file (`.lst`) into entries.
 *
 * Format (CSV-like, first line may be a comment header):
 *   // on/off, block, case, seed, iterative, tag, priority, config, CFG_DEF, env/base, plusargs
 *   ON,  ap_sys,  apsys_bus_mini_test,  rand,  10,  [RTL0.1, mini, cq],  H,  default,  default,  default,  MYARG=[10:20]
 */
export function parseRegressionList(content: string): {
  entries: RegressionEntry[];
  tagSet: string[];
  onCount: number;
  offCount: number;
} {
  const lines = content.split(/\r?\n/);
  const entries: RegressionEntry[] = [];
  const tagSet = new Set<string>();
  let onCount = 0;
  let offCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;

    // Must start with ON or OFF (case-insensitive)
    const match = /^(ON|OFF)\s*,/i.exec(line);
    if (!match) continue;

    const enabled = match[1].toUpperCase() === 'ON';
    if (enabled) onCount++;
    else offCount++;

    // Parse the rest of the CSV line
    const fields = parseCsvLine(line);
    // fields[0] = on/off, fields[1] = block, fields[2] = case, ...
    const entry: RegressionEntry = {
      enabled,
      block: fields[1]?.trim() ?? '',
      caseName: fields[2]?.trim() ?? '',
      seed: fields[3]?.trim() ?? '',
      iterative: fields[4]?.trim() ?? '',
      tags: parseTags(fields[5]),
      priority: parsePriority(fields[6]),
      config: fields[7]?.trim() ?? '',
      cfgDef: fields[8]?.trim() ?? '',
      envBase: fields[9]?.trim() ?? '',
      plusargs: fields.slice(10).join(',').trim(),
    };

    for (const tag of entry.tags) tagSet.add(tag);
    entries.push(entry);
  }

  return {
    entries,
    tagSet: Array.from(tagSet).sort(),
    onCount,
    offCount,
  };
}

/**
 * Parse a CSV line that may contain bracketed values with commas inside.
 *
 * Example: `ON, ap_sys, apsys_test, [1,2,3], 10, [RTL0.1, mini, cq], H, default, default, default, MYARG=[10:20]`
 *
 * The bracketed sections `[...]` are treated as single fields.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inBracket = 0;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '[' || char === '(') {
      inBracket++;
      current += char;
    } else if (char === ']' || char === ')') {
      inBracket = Math.max(0, inBracket - 1);
      current += char;
    } else if (char === ',' && inBracket === 0) {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) fields.push(current.trim());
  return fields;
}

/** Parse tag field like `[RTL0.1, mini, cq]` → `['RTL0.1', 'mini', 'cq']` */
function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  // Remove surrounding brackets
  const inner = trimmed.replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  return inner.split(',').map((t) => t.trim()).filter(Boolean);
}

/** Parse priority field — expect H, M, or L */
function parsePriority(raw: string | undefined): 'H' | 'M' | 'L' | '' {
  const trimmed = (raw ?? '').trim().toUpperCase();
  if (trimmed === 'H' || trimmed === 'M' || trimmed === 'L') return trimmed;
  return '';
}

// ── Group parsing ─────────────────────────────────────

/**
 * Parse a regression group file (`.grp`) into referenced file paths.
 *
 * Format:
 *   // ap_sys.grp
 *   $PROJ_DIR/dv/ap_sys/regression/regr1.lst
 *   $PROJ_DIR/dv/ap_sys/regression/regr2.lst
 */
export function parseRegressionGroup(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const refs: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    // Skip ON/OFF lines (shouldn't be in a group file, but just in case)
    if (/^(ON|OFF)\s*[,]/i.test(line)) continue;
    if (isPathLike(line)) {
      refs.push(line);
    }
  }

  return refs;
}

/** Resolved group reference: type is 'unreadable' when the file exists in the
 *  .grp but could not be opened — surfaced as such instead of being guessed
 *  as a list (a guessed list used to trigger bogus parseList errors downstream). */
export type ResolvedGroupRef = { path: string; type: 'list' | 'group' | 'unreadable' };

/**
 * Expand `$VAR` / `${VAR}` prefixes in a group reference and anchor relative
 * paths against the group file's directory.
 *
 * Group files conventionally reference lists via env-var-prefixed paths
 * (`$PROJ_DIR/dv/...`); `readFile` cannot open those literally. Resolution
 * priority per known project env var ($PROJ_DIR/$PROJ_ENV/$PROJ_RTL/$PROJ_WORK):
 * process env → login shell env → .socverify/env.json (via resolveProjectEnvVar).
 * Unresolvable vars and bare relative paths fall back to anchoring against
 * the group file's own directory.
 */
export function normalizeGroupRef(
  ref: string,
  groupDir: string,
  resolveVar: (name: string) => Promise<string | null>,
): Promise<string> {
  return (async () => {
    const expanded = await expandEnvVars(ref, resolveVar);
    if (isAbsoluteLike(expanded)) return normalize(expanded);
    return normalize(join(groupDir, expanded));
  })();
}

/** Path starts with `/`, `\`, drive letter, or an unexpanded `$VAR` root */
function isAbsoluteLike(p: string): boolean {
  return /^([/\\]|[A-Za-z]:[\\/])/.test(p) || /^\$\{?[A-Za-z_]/.test(p);
}

/** Replace every `$VAR` / `${VAR}` occurrence with the resolved value (unknown vars kept literal) */
async function expandEnvVars(
  raw: string,
  resolveVar: (name: string) => Promise<string | null>,
): Promise<string> {
  const varPattern = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
  const names = new Set<string>();
  for (const m of raw.matchAll(varPattern)) names.add(m[1]);

  let result = raw;
  for (const name of names) {
    const value = await resolveVar(name);
    if (!value) continue; // unresolvable: keep literal, caller falls back to groupDir anchor
    const pattern = new RegExp(`\\$\\{?${name}\\}?`, 'g');
    result = result.replace(pattern, value);
  }
  return result;
}

// ── Recursive group resolution ────────────────────────

/**
 * Recursively resolve a group file's references, detecting cycles.
 *
 * References are normalized before reading: `$VAR` prefixes expanded via
 * `resolveVar` (project env), relative paths anchored to the group file's
 * directory. Unreadable references are returned as `{ type: 'unreadable' }`
 * so the UI can show them instead of guessing a type that would mislead
 * downstream parsing.
 *
 * @param filePath     Absolute path to the group file
 * @param fileReader   Function to read file content (injectable for testing)
 * @param resolveVar   Optional env-var resolver for `$VAR` expansion
 * @param depth        Current recursion depth (max MAX_GRP_DEPTH)
 * @param visited      Set of already-visited file paths (cycle detection)
 * @returns            Array of { path, type } for all resolved references
 */
export async function resolveGroupRefs(
  filePath: string,
  fileReader: (path: string) => Promise<string>,
  resolveVar: (name: string) => Promise<string | null> = async () => null,
  depth = 0,
  visited = new Set<string>(),
): Promise<ResolvedGroupRef[]> {
  if (depth >= MAX_GRP_DEPTH) return [];
  if (visited.has(filePath)) return []; // cycle detected
  visited.add(filePath);

  const content = await fileReader(filePath);
  const refs = parseRegressionGroup(content);
  const groupDir = dirname(filePath);
  const result: ResolvedGroupRef[] = [];

  for (const ref of refs) {
    // Skip already-visited files (cycle detection)
    if (visited.has(ref)) continue;

    const resolvedPath = await normalizeGroupRef(ref, groupDir, resolveVar);
    if (visited.has(resolvedPath)) continue;

    // Try to read the referenced file to determine its type
    try {
      const refContent = await fileReader(resolvedPath);
      const type = detectFileType(refContent);
      if (type === 'list') {
        result.push({ path: resolvedPath, type: 'list' });
      } else if (type === 'group') {
        result.push({ path: resolvedPath, type: 'group' });
        const nested = await resolveGroupRefs(resolvedPath, fileReader, resolveVar, depth + 1, visited);
        result.push(...nested);
      } else {
        // Readable but neither list nor group — surface as unreadable
        result.push({ path: resolvedPath, type: 'unreadable' });
      }
    } catch {
      // File not readable — surface honestly instead of guessing 'list'
      result.push({ path: resolvedPath, type: 'unreadable' });
    }
  }

  return result;
}

// ── usvp mapping ──────────────────────────────────────

/**
 * Load usvp short-name → subsystem-name mapping from `.socverify/usvp-subsys-map.json`.
 * Returns empty map if file doesn't exist (short names used as-is).
 */
export async function loadUsvpMap(projectRoot: string): Promise<Record<string, string>> {
  const mapPath = join(projectRoot, SOCVERIFY_DIR, USVP_MAP_FILE);
  try {
    const data = await readFile(mapPath, 'utf-8');
    return JSON.parse(data) as Record<string, string>;
  } catch {
    return {};
  }
}

// ── Directory scanning ────────────────────────────────

/**
 * Scan a directory for all files (non-recursively), returning their paths and content.
 * Subdirectories are returned as entries to be scanned separately.
 */
async function scanDirectory(dirPath: string): Promise<Array<{ name: string; isDir: boolean }>> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }
}

/**
 * Read and classify all files in a regression directory.
 * Returns items (lists and groups) found in that directory.
 */
async function scanRegressionDir(
  dirPath: string,
  subsys: string,
  block: string,
): Promise<RegressionItem[]> {
  const entries = await scanDirectory(dirPath);
  const items: RegressionItem[] = [];

  for (const entry of entries) {
    if (entry.isDir) continue;

    const filePath = join(dirPath, entry.name);
    try {
      const content = await readFile(filePath, 'utf-8');
      const type = detectFileType(content);

      if (type === 'list') {
        const parsed = parseRegressionList(content);
        items.push({
          type: 'list',
          filePath,
          subsys,
          block,
          ...parsed,
        } satisfies RegressionList);
      } else if (type === 'group') {
        const refPaths = parseRegressionGroup(content);
        items.push({
          type: 'group',
          filePath,
          subsys,
          block,
          refPaths,
        } satisfies RegressionGroup);
      }
    } catch {
      // Skip unreadable files
    }
  }

  return items;
}

// ── Main discovery ────────────────────────────────────

/**
 * Discover all regression items from $PROJ_ENV directory tree.
 *
 * @param projectRoot   Project root path (for reading .socverify config)
 * @param projEnv       Value of $PROJ_ENV environment variable
 * @returns             Items grouped by subsystem
 */
export async function discoverRegressions(
  projectRoot: string,
  projEnv: string,
): Promise<RegressionDiscoveryResult> {
  const subsysMap = new Map<string, RegressionItem[]>();
  const seenPaths = new Set<string>(); // dedup by absolute path

  // Load usvp mapping
  const usvpMap = await loadUsvpMap(projectRoot);

  // ── Source 1: $PROJ_ENV/<subsys>/regression/ ──
  await scanSubsysDirect(projEnv, subsysMap, seenPaths);

  // ── Source 2: $PROJ_ENV/udtb/<subsys>/<block>/regression/ ──
  await scanIp2Soc(projEnv, subsysMap, seenPaths);

  // ── Source 3: $PROJ_ENV/udtb/usvp/regression/<short>/ ──
  await scanUsvp(projEnv, usvpMap, subsysMap, seenPaths);

  // Convert map to sorted array
  return Array.from(subsysMap.entries())
    .map(([subsys, items]) => ({ subsys, items }))
    .sort((a, b) => a.subsys.localeCompare(b.subsys));
}

/** Directories under $PROJ_ENV that are NOT subsystems. */
const NON_SUBSYS_DIRS = new Set(['udtb']);

/** Scan $PROJ_ENV/<subsys>/regression/ directories */
async function scanSubsysDirect(
  projEnv: string,
  subsysMap: Map<string, RegressionItem[]>,
  seenPaths: Set<string>,
): Promise<void> {
  const entries = await scanDirectory(projEnv);
  for (const entry of entries) {
    if (!entry.isDir) continue;
    if (NON_SUBSYS_DIRS.has(entry.name)) continue;
    const subsys = entry.name;
    const regressionDir = join(projEnv, subsys, 'regression');
    const items = await scanRegressionDir(regressionDir, subsys, '');
    addItems(subsysMap, seenPaths, subsys, items);
  }
}

/** Scan $PROJ_ENV/udtb/<subsys>/<block>/regression/ directories */
async function scanIp2Soc(
  projEnv: string,
  subsysMap: Map<string, RegressionItem[]>,
  seenPaths: Set<string>,
): Promise<void> {
  const udtbDir = join(projEnv, 'udtb');
  const subsysEntries = await scanDirectory(udtbDir);
  for (const subsysEntry of subsysEntries) {
    if (!subsysEntry.isDir) continue;
    if (subsysEntry.name === 'usvp') continue; // handled separately
    const subsys = subsysEntry.name;
    const blockDir = join(udtbDir, subsys);
    const blockEntries = await scanDirectory(blockDir);
    for (const blockEntry of blockEntries) {
      if (!blockEntry.isDir) continue;
      const block = blockEntry.name;
      const regressionDir = join(blockDir, block, 'regression');
      const items = await scanRegressionDir(regressionDir, subsys, block);
      addItems(subsysMap, seenPaths, subsys, items);
    }
  }
}

/** Scan $PROJ_ENV/udtb/usvp/regression/<short>/ directories */
async function scanUsvp(
  projEnv: string,
  usvpMap: Record<string, string>,
  subsysMap: Map<string, RegressionItem[]>,
  seenPaths: Set<string>,
): Promise<void> {
  const usvpRegressionDir = join(projEnv, 'udtb', 'usvp', 'regression');
  const shortEntries = await scanDirectory(usvpRegressionDir);
  for (const shortEntry of shortEntries) {
    if (!shortEntry.isDir) continue;
    const shortName = shortEntry.name;
    const subsys = usvpMap[shortName] ?? shortName; // fallback: use short name as-is
    const dirPath = join(usvpRegressionDir, shortName);
    const items = await scanRegressionDir(dirPath, subsys, 'usvp');
    addItems(subsysMap, seenPaths, subsys, items);
  }
}

/** Add items to subsys map, deduplicating by absolute file path.
 *  Skips subsystems with zero items (avoids empty entries in the tree). */
function addItems(
  subsysMap: Map<string, RegressionItem[]>,
  seenPaths: Set<string>,
  subsys: string,
  items: RegressionItem[],
): void {
  if (items.length === 0) return;
  if (!subsysMap.has(subsys)) subsysMap.set(subsys, []);
  const existing = subsysMap.get(subsys)!;
  for (const item of items) {
    if (!seenPaths.has(item.filePath)) {
      seenPaths.add(item.filePath);
      existing.push(item);
    }
  }
}
