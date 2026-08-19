/**
 * TLS certificate self-heal for download scripts.
 *
 * On machines where a local proxy tool (e.g. Steamcommunity302, Charles,
 * Fiddler, enterprise MITM) intercepts HTTPS traffic, Node's built-in root
 * certificate store rejects the proxy's leaf certificate with
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.  The fix is `--use-system-ca` (or
 * `NODE_USE_SYSTEM_CA=1`), which makes Node use the OS certificate store
 * (where the proxy's root CA is typically trusted).  This module detects
 * that situation at startup and re-launches the current script with the
 * `--use-system-ca` flag if needed, so users never have to set it manually.
 *
 * Usage (at the top of any download script, before network calls):
 *
 *   import './tls-self-heal.mjs';
 *
 * The self-heal runs at most once per process tree — the re-launched child
 * sets `_SOCVERIFY_TLS_FIXED=1` to prevent infinite recursion.
 */

import { spawnSync } from 'node:child_process';

if (!process.env._SOCVERIFY_TLS_FIXED) {
  const probe = spawnSync(
    process.execPath,
    ['-e', 'fetch("https://github.com").then(()=>process.exit(0)).catch(()=>process.exit(1))'],
    { stdio: 'pipe', timeout: 15_000 },
  );

  if (probe.status !== 0) {
    const args = ['--use-system-ca', ...process.argv.slice(1)];
    const env = { ...process.env, _SOCVERIFY_TLS_FIXED: '1' };
    const result = spawnSync(process.execPath, args, { stdio: 'inherit', env });
    process.exit(result.status ?? 1);
  }
}
