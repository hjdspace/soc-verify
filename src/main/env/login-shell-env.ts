/**
 * Login shell environment capture for Linux/macOS.
 *
 * When an Electron app is launched from the desktop (e.g. AppImage),
 * the main process inherits a minimal environment from the systemd user
 * session — not the login shell environment that sources `.bashrc`,
 * `.profile`, `module init`, etc.  This means EDA tool paths
 * (`/tools/synopsys/.../bin`), `VCS_HOME`, `LM_LICENSE_FILE` and similar
 * variables set in shell configuration are invisible to the app.
 *
 * This module spawns a login shell, captures its full `env` output, and
 * merges it with `process.env` so that EDA tool detection and env var
 * auto-detection can see the same environment the user gets in a terminal.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** PATH separator for the current platform. */
const PATH_SEP = process.platform === 'win32' ? ';' : ':';

/**
 * Resolve the user's login shell binary path.
 *
 * Priority:
 * 1. `userInfo().shell` — the account's configured login shell
 *    (authoritative when `$SHELL` is missing, e.g. AppImage desktop launch).
 * 2. `process.env.SHELL` — inherited from the launching environment.
 * 3. `/bin/bash` — safe default on virtually all Linux/macOS systems.
 *
 * @param preferred - Optional preferred shells to check first
 *                    (e.g. `['/bin/csh', '/usr/bin/csh']` for EDA environments).
 */
export function resolveLoginShell(preferred?: string[]): string {
  if (process.platform === 'win32') return 'powershell.exe';

  // Check preferred shells first (e.g. csh for EDA/simulation environments)
  if (preferred && preferred.length > 0) {
    for (const c of preferred) {
      if (existsSync(c)) return c;
    }
  }

  // Account login shell (authoritative for desktop-launched apps)
  try {
    const accountShell = userInfo().shell;
    if (accountShell && existsSync(accountShell)) return accountShell;
  } catch {
    // userInfo() can fail in rare containerized environments
  }

  // Inherited $SHELL
  const inheritedShell = process.env.SHELL;
  if (inheritedShell && existsSync(inheritedShell)) return inheritedShell;

  // Safe fallbacks
  const candidates = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/bin/sh'];
  return candidates.find((p) => existsSync(p)) ?? 'bash';
}

/** Shell preferences for EDA environments (csh/tcsh preferred). */
const EDA_SHELL_PREFERENCES: string[] =
  process.platform === 'win32'
    ? []
    : ['/bin/tcsh', '/usr/bin/tcsh', '/bin/csh', '/usr/bin/csh'];

/**
 * Determine if a shell path is a C-shell variant (csh/tcsh).
 */
function isCshShell(shell: string): boolean {
  const base = shell.split('/').pop() ?? shell;
  return base === 'csh' || base === 'tcsh';
}

/**
 * Parse the output of `env` command into a key→value record.
 *
 * Each line is `KEY=VALUE`.  Values may contain `=`; only the first `=` splits.
 */
function parseEnvOutput(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (key) env[key] = value;
  }
  return env;
}

/**
 * Merge two environment variable maps.
 *
 * - All keys from both maps are preserved.
 * - For `PATH` (and `LD_LIBRARY_PATH`), the two values are combined with the
 *   login shell's value taking priority (prepended), and duplicates removed.
 * - For other keys, the login shell value wins if it exists; otherwise the
 *   process.env value is kept.
 */
function mergeEnvs(
  processEnv: Record<string, string>,
  loginShellEnv: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...processEnv };

  for (const [key, value] of Object.entries(loginShellEnv)) {
    if (key === 'PATH' || key === 'LD_LIBRARY_PATH') {
      const existing = merged[key] ?? '';
      if (existing) {
        // Merge with dedup, login shell paths first
        const parts = [...value.split(PATH_SEP), ...existing.split(PATH_SEP)];
        const seen = new Set<string>();
        const deduped: string[] = [];
        for (const p of parts) {
          if (p && !seen.has(p)) {
            seen.add(p);
            deduped.push(p);
          }
        }
        merged[key] = deduped.join(PATH_SEP);
      } else {
        merged[key] = value;
      }
    } else {
      // Login shell value takes priority
      merged[key] = value;
    }
  }

  return merged;
}

/** Cached login shell environments, keyed by the shell binary path. */
const cachedLoginShellEnvs = new Map<string, Record<string, string>>();

/**
 * Capture the login shell's full environment by spawning `<shell> -l -c 'env'`.
 *
 * On Windows, this is a no-op — returns `process.env` directly.
 * On Linux/macOS, it spawns the user's login shell to capture the environment
 * that `.bashrc` / `.profile` / `module init` would set up.
 *
 * Results are cached for the process lifetime.  Call {@link refreshLoginShellEnv}
 * to force a re-capture.
 *
 * @returns The merged environment (login shell env ∪ process.env).
 *          If shell capture fails, falls back to `process.env`.
 */
export async function getLoginShellEnv(shellOverride?: string): Promise<Record<string, string>> {
  // Windows: no login shell concept, just use process.env
  if (process.platform === 'win32') {
    return { ...process.env } as Record<string, string>;
  }

  const shell = shellOverride && existsSync(shellOverride)
    ? shellOverride
    : resolveLoginShell(EDA_SHELL_PREFERENCES);

  const cached = cachedLoginShellEnvs.get(shell);
  if (cached) return cached;

  try {
    // Build the command to capture the login shell environment.
    // - For bash/zsh: `bash -l -c 'env'` (login + command)
    // - For csh/tcsh: `csh -l -c 'env'` (login shell sources .cshrc + .login)
    //
    // We use execFile (not exec) to avoid an extra shell layer that could
    // interfere with quoting.
    const isCsh = isCshShell(shell);
    const args = isCsh ? ['-l', '-c', 'env'] : ['-l', '-c', 'env'];

    const { stdout } = await execFileAsync(shell, args, {
      timeout: 10000,
      encoding: 'utf-8',
      // Don't pass our own env — we want the shell's env.
      // However, some shells need HOME and USER to function, so we pass
      // a minimal set.
      env: {
        HOME: process.env.HOME ?? '',
        USER: process.env.USER ?? '',
        TERM: 'dumb',
      },
    });

    const loginEnv = parseEnvOutput(stdout);
    const merged = mergeEnvs(
      process.env as Record<string, string>,
      loginEnv,
    );

    cachedLoginShellEnvs.set(shell, merged);
    console.log(
      `[login-shell-env] captured ${Object.keys(loginEnv).length} vars from ${shell}` +
      ` (PATH entries: ${(merged.PATH ?? '').split(PATH_SEP).length})`,
    );
    return merged;
  } catch (err) {
    // If the preferred shell fails, try bash as a fallback (unless we
    // were already using bash).
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[login-shell-env] failed to capture env from ${shell}: ${errMsg}`);

    if (!isCshShell(shell) && shell !== 'bash') {
      // Already tried a non-bash shell; try bash as last resort
      try {
        const { stdout } = await execFileAsync('bash', ['-l', '-c', 'env'], {
          timeout: 10000,
          encoding: 'utf-8',
          env: {
            HOME: process.env.HOME ?? '',
            USER: process.env.USER ?? '',
            TERM: 'dumb',
          },
        });
        const loginEnv = parseEnvOutput(stdout);
        const merged = mergeEnvs(
          process.env as Record<string, string>,
          loginEnv,
        );
        cachedLoginShellEnvs.set('bash', merged);
        console.log(
          `[login-shell-env] captured ${Object.keys(loginEnv).length} vars from bash fallback`,
        );
        return merged;
      } catch (fallbackErr) {
        const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        console.warn(`[login-shell-env] bash fallback also failed: ${fbMsg}`);
      }
    }

    // Last resort: just use process.env
    const fallbackEnv = { ...process.env } as Record<string, string>;
    cachedLoginShellEnvs.set(shell, fallbackEnv);
    return fallbackEnv;
  }
}

/**
 * Force a re-capture of the login shell environment on the next call to
 * {@link getLoginShellEnv}.
 *
 * Called when the user clicks the "detect" button to ensure fresh results.
 */
export function refreshLoginShellEnv(): void {
  cachedLoginShellEnvs.clear();
}

/**
 * Find an executable in PATH using the platform-appropriate command
 * (`where` on Windows, `which` on Linux/macOS).
 *
 * This is the async version of {@link findAllInPath} from `paths.ts`,
 * with the added ability to pass a custom environment (so the login
 * shell's PATH is used for the lookup).
 */
export async function findInPathAsync(
  executable: string,
  env?: Record<string, string>,
): Promise<string[]> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(cmd, [executable], {
      timeout: 5000,
      encoding: 'utf-8',
      env: env ?? (process.env as Record<string, string>),
    });
    return stdout.trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}
