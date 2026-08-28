#!/usr/bin/env node
/**
 * Build the TraceWeave FSDB wrapper (libfsdb_wrapper.so) on the packaging machine.
 *
 * Prereqs: Linux + VERDI_HOME (Verdi FsdbReader headers/libs) + g++ — satisfied
 * by EDA build machines per ADR 0020 (user machines ship Verdi and set
 * VERDI_HOME). Best-effort: on any failure this script exits 0 and the build
 * continues; the packaged app then runs TraceWeave VCD-only and the MCP
 * diagnostics surface the missing wrapper as an FSDB blocker.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(import.meta.url), '../..');
const traceweaveDir = join(projectRoot, 'engine', 'traceweave');
const wrapperSo = join(traceweaveDir, 'libfsdb_wrapper.so');

const log = (msg) => console.log(`[traceweave-wrapper] ${msg}`);

if (process.platform !== 'linux') {
  log(`skip: FSDB wrapper is Linux-only (platform=${process.platform})`);
  process.exit(0);
}

const verdiHome = process.env.VERDI_HOME;
if (!verdiHome) {
  log('skip: VERDI_HOME is not set — cannot compile libfsdb_wrapper.so (packaged app runs VCD-only)');
  process.exit(0);
}

const fsdbReaderDir = join(verdiHome, 'share', 'FsdbReader');
if (!existsSync(fsdbReaderDir)) {
  log(`skip: FsdbReader not found at ${fsdbReaderDir} (packaged app runs VCD-only)`);
  process.exit(0);
}

const gxxCheck = spawnSync('g++', ['--version'], { stdio: 'ignore' });
if (gxxCheck.error || gxxCheck.status !== 0) {
  log('skip: g++ not available (packaged app runs VCD-only)');
  process.exit(0);
}

if (!existsSync(join(traceweaveDir, 'build_wrapper.sh'))) {
  log('skip: engine/traceweave/build_wrapper.sh not found');
  process.exit(0);
}

log(`building libfsdb_wrapper.so with VERDI_HOME=${verdiHome}`);
const result = spawnSync('bash', ['build_wrapper.sh'], { cwd: traceweaveDir, stdio: 'inherit' });

if (result.status !== 0 || !existsSync(wrapperSo)) {
  log('warn: build failed — packaged app runs VCD-only (non-blocking, see output above)');
  process.exit(0);
}

log(`built ${wrapperSo}`);
