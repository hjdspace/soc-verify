/**
 * MCP config — ensureBuiltinMcpServers stale config detection and BOM handling tests.
 *
 * Tests that built-in MCP server configs (like TraceWeave) are automatically
 * updated when the existing entry is "stale" — e.g., the command points to a
 * Windows Store app execution alias stub or a non-existent file.
 *
 * Also tests that config files with a UTF-8 BOM (as written by Windows
 * PowerShell's Set-Content -Encoding UTF8) are correctly parsed without
 * losing existing user-configured servers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock node:fs
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { ensureBuiltinMcpServers } from '../../src/main/mcp/mcp-config';
import type { McpServerConfig } from '@shared/types';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);

function makeConfig(command: string): McpServerConfig {
  return {
    type: 'stdio',
    command,
    args: ['server.py'],
    cwd: '/fake/traceweave',
    env: { PATH: '/usr/bin' },
    enabled: true,
  };
}

describe('mcp-config - ensureBuiltinMcpServers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: config file doesn't exist (empty config)
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds new built-in server when not in config', async () => {
    const result = await ensureBuiltinMcpServers([
      { name: 'TraceWeave', config: makeConfig('/usr/bin/python3') },
    ]);

    expect(result).toBe(true);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.mcpServers.TraceWeave).toBeDefined();
    expect(written.mcpServers.TraceWeave.command).toBe('/usr/bin/python3');
  });

  it('preserves existing valid config without overriding', async () => {
    const existingConfig = {
      $schema: 'https://example.com/schema.json',
      mcpServers: {
        TraceWeave: makeConfig('/custom/python'),
      },
    };
    mockReadFile.mockResolvedValue(JSON.stringify(existingConfig));

    const result = await ensureBuiltinMcpServers([
      { name: 'TraceWeave', config: makeConfig('/usr/bin/python3') },
    ]);

    expect(result).toBe(false);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('updates stale config when command points to Windows Store stub', async () => {
    const isWindows = process.platform === 'win32';
    if (!isWindows) return; // Windows-specific test

    const existingConfig = {
      $schema: 'https://example.com/schema.json',
      mcpServers: {
        TraceWeave: makeConfig(
          'C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe',
        ),
      },
    };
    mockReadFile.mockResolvedValue(JSON.stringify(existingConfig));

    const result = await ensureBuiltinMcpServers([
      { name: 'TraceWeave', config: makeConfig('D:\\Program\\Python\\Python313\\python.exe') },
    ]);

    expect(result).toBe(true);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.mcpServers.TraceWeave.command).toBe(
      'D:\\Program\\Python\\Python313\\python.exe',
    );
  });

  it('updates stale config when command file does not exist', async () => {
    const existingConfig = {
      $schema: 'https://example.com/schema.json',
      mcpServers: {
        TraceWeave: makeConfig('/nonexistent/python3'),
      },
    };
    mockReadFile.mockResolvedValue(JSON.stringify(existingConfig));
    // existsSync returns false for the stale command
    mockExistsSync.mockReturnValue(false);

    const result = await ensureBuiltinMcpServers([
      { name: 'TraceWeave', config: makeConfig('/usr/bin/python3') },
    ]);

    expect(result).toBe(true);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.mcpServers.TraceWeave.command).toBe('/usr/bin/python3');
  });

  it('does not update when existing config is valid', async () => {
    const existingConfig = {
      $schema: 'https://example.com/schema.json',
      mcpServers: {
        TraceWeave: makeConfig('/usr/bin/python3'),
      },
    };
    mockReadFile.mockResolvedValue(JSON.stringify(existingConfig));
    // existsSync returns true for the valid command
    mockExistsSync.mockReturnValue(true);

    const result = await ensureBuiltinMcpServers([
      { name: 'TraceWeave', config: makeConfig('/different/python3') },
    ]);

    expect(result).toBe(false);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('returns false for empty builtin servers list', async () => {
    const result = await ensureBuiltinMcpServers([]);
    expect(result).toBe(false);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

describe('mcp-config - BOM handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses config with UTF-8 BOM without losing existing servers', async () => {
    // Simulate a config file written by Windows PowerShell's
    // Set-Content -Encoding UTF8, which prepends a BOM (\uFEFF).
    const configObj = {
      $schema: 'https://example.com/schema.json',
      mcpServers: {
        codegraph: {
          command: 'codegraph',
          args: ['serve', '--mcp'],
          env: {},
          enabled: true,
          type: 'stdio',
        },
        TraceWeave: makeConfig('/usr/bin/python3'),
      },
    };
    const bomContent = '\uFEFF' + JSON.stringify(configObj);
    mockReadFile.mockResolvedValue(bomContent);

    const result = await ensureBuiltinMcpServers([
      { name: 'TraceWeave', config: makeConfig('/usr/bin/python3') },
    ]);

    // TraceWeave config is valid (not stale) → no modification needed
    expect(result).toBe(false);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('preserves codegraph when updating stale TraceWeave in BOM config', async () => {
    // Simulate a BOM-prefixed config where TraceWeave has a stale command
    const configObj = {
      $schema: 'https://example.com/schema.json',
      mcpServers: {
        codegraph: {
          command: 'codegraph',
          args: ['serve', '--mcp'],
          env: {},
          enabled: true,
          type: 'stdio',
        },
        TraceWeave: makeConfig('/nonexistent/python3'),
      },
    };
    const bomContent = '\uFEFF' + JSON.stringify(configObj);
    mockReadFile.mockResolvedValue(bomContent);
    mockExistsSync.mockReturnValue(false); // stale command

    const result = await ensureBuiltinMcpServers([
      { name: 'TraceWeave', config: makeConfig('/usr/bin/python3') },
    ]);

    expect(result).toBe(true);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    // codegraph must be preserved
    expect(written.mcpServers.codegraph).toBeDefined();
    expect(written.mcpServers.codegraph.command).toBe('codegraph');
    // TraceWeave must be updated
    expect(written.mcpServers.TraceWeave.command).toBe('/usr/bin/python3');
  });
});
