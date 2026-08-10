import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const buildScript = readFileSync(join(process.cwd(), 'scripts', 'build-linux-sqlite.mjs'), 'utf-8');

describe('Linux better-sqlite3 packaging', () => {
  it('always builds against the CentOS 8 glibc baseline', () => {
    expect(buildScript).toContain("'rockylinux:8'");
    expect(buildScript).toContain('GLIBC_2.28');
    expect(buildScript).toContain('GLIBCXX_3.4.25');
    expect(buildScript).toContain('gcc-toolset-10');
    expect(buildScript).toContain('-static-libstdc++ -static-libgcc');
    expect(buildScript).not.toContain('function buildOnLinux');
    expect(buildScript).not.toContain('if (IS_LINUX)');
    expect(buildScript).not.toContain('shell: IS_WIN');
  });

  it('rejects incompatible binaries before they enter the AppImage', () => {
    expect(buildScript).toContain('readelf --version-info');
    expect(buildScript).toContain('readelf -d');
    expect(buildScript).toContain('libstdc\\\\+\\\\+\\\\.so|libgcc_s\\\\.so');
    expect(buildScript).toContain('! ldd ${binary}');
  });

  it('runs a database create, insert, and select smoke test in Rocky Linux 8', () => {
    expect(buildScript).toContain('SQLite create/insert/select smoke test');
    expect(buildScript).toContain('new Database(":memory:")');
    expect(buildScript).toContain('__SQLITE_OK__');
  });

  it('removes fallback build output after installing the verified prebuild', () => {
    expect(buildScript).toContain('rmSync(BUILD_DIR, { recursive: true, force: true })');
  });
});
