import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginKind, PluginOrigin } from '@shared/plugin-types';
import type { PluginConfigEntry } from '@shared/types';

const PLUGIN_KINDS = new Set<PluginKind>([
  'case-parser',
  'subsys-discoverer',
  'coverage-parser',
  'simulation-runner',
  'sim-option-schema',
  'ui',
]);

export type PluginPackageCandidate = {
  entry: PluginConfigEntry;
  origin: PluginOrigin;
  packageRoot: string;
  error?: string;
};

function fallbackCandidate(
  packageRoot: string,
  origin: PluginOrigin,
  error: string,
): PluginPackageCandidate {
  const id = packageRoot.split(/[\\/]/).at(-1) ?? 'unknown-plugin';
  return {
    entry: {
      id,
      name: id,
      version: '0.0.0',
      kind: 'ui',
      source: 'local',
      path: packageRoot,
      enabled: true,
    },
    origin,
    packageRoot,
    error,
  };
}

function readCandidate(packageRoot: string, origin: PluginOrigin): PluginPackageCandidate | null {
  const packagePath = join(packageRoot, 'package.json');
  if (!existsSync(packagePath)) {
    return fallbackCandidate(packageRoot, origin, `Missing package.json in plugin directory: ${packageRoot}`);
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(packagePath, 'utf-8')) as Record<string, unknown>;
  } catch (error) {
    return fallbackCandidate(
      packageRoot,
      origin,
      `Invalid package.json in ${packageRoot}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const metadata = pkg.socverify;
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const socverify = metadata as Record<string, unknown>;
  if (typeof socverify.id !== 'string' || !socverify.id.trim()) {
    return fallbackCandidate(packageRoot, origin, 'Plugin package socverify.id must be a non-empty string');
  }
  if (typeof socverify.kind !== 'string' || !PLUGIN_KINDS.has(socverify.kind as PluginKind)) {
    return fallbackCandidate(packageRoot, origin, `Unsupported plugin kind: ${String(socverify.kind)}`);
  }
  if (socverify.apiVersion !== undefined && socverify.apiVersion !== '1.0') {
    return fallbackCandidate(packageRoot, origin, `Unsupported plugin API version: ${String(socverify.apiVersion)}`);
  }

  const mainFile = typeof pkg.main === 'string' && pkg.main.trim() ? pkg.main : 'index.js';
  return {
    entry: {
      id: socverify.id,
      apiVersion: typeof socverify.apiVersion === 'string' ? socverify.apiVersion : undefined,
      name: typeof pkg.name === 'string' ? pkg.name : socverify.id,
      version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
      kind: socverify.kind as PluginKind,
      source: 'local',
      path: resolve(packageRoot, mainFile),
      enabled: true,
    },
    origin,
    packageRoot,
  };
}

export function discoverPluginPackages(
  pluginsDir: string | null,
  origin: Extract<PluginOrigin, 'builtin' | 'user'>,
): PluginPackageCandidate[] {
  if (!pluginsDir || !existsSync(pluginsDir)) return [];

  let directories: string[];
  try {
    directories = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((entry) => {
        if (entry.isDirectory()) return true;
        if (!entry.isSymbolicLink()) return false;
        try {
          return statSync(join(pluginsDir, entry.name)).isDirectory();
        } catch {
          return false;
        }
      })
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }

  return directories.flatMap((directory) => {
    const candidate = readCandidate(join(pluginsDir, directory), origin);
    return candidate ? [candidate] : [];
  });
}

export function getDefaultUserPluginsDir(): string {
  return join(homedir(), '.socverify', 'plugins');
}

export function getBuiltinPluginsDir(): string | null {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resourcesPath ? join(resourcesPath, 'plugins') : null,
    resolve(currentDir, '../../../plugins'),
    resolve(currentDir, '../../plugins'),
  ];

  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null;
}
