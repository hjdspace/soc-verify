import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const buildScript = readFileSync(join(process.cwd(), 'scripts', 'build-linux-pty.mjs'), 'utf-8');
const patchScript = readFileSync(join(process.cwd(), 'scripts', 'patch-native-modules.mjs'), 'utf-8');

describe('Linux node-pty packaging', () => {
  it('builds against a glibc baseline compatible with CentOS 8', () => {
    expect(buildScript).toContain("'rockylinux:8'");
    expect(buildScript).not.toContain("'node:22-bookworm'");
    expect(buildScript).toContain('GLIBC_2.28');
    expect(buildScript).toContain('GLIBCXX_3.4.25');
    expect(buildScript).toContain('gcc-toolset-10');
    expect(buildScript).toContain('-static-libstdc++ -static-libgcc');
  });

  it('runs an interactive PTY smoke test in the EL8 build container', () => {
    expect(buildScript).toContain('PTY spawn/input/output/resize/exit smoke test');
    expect(buildScript).toContain('p.resize(100,30)');
    expect(buildScript).toContain('__PTY_OK__');
  });

  it('removes the higher-priority build output after copying the Linux prebuild', () => {
    expect(buildScript).toContain('rmSync(BUILD_DIR, { recursive: true, force: true })');
  });

  it('preserves the native loader error instead of the final missing-path error', () => {
    expect(patchScript).toContain('[socverify-patch-v2]');
    expect(patchScript).toContain('lastError = _unpackedError');
  });
});
