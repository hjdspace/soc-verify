/**
 * Dev launcher that unsets ELECTRON_RUN_AS_NODE before starting electron-vite.
 *
 * On some systems ELECTRON_RUN_AS_NODE=1 is set globally (e.g. for Cursor/VSCode
 * internal Electron usage), which prevents our Electron app from accessing
 * Electron APIs. This script ensures the variable is deleted before launch.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// Delete the env var so Electron runs in full mode (not Node.js compat mode)
delete process.env.ELECTRON_RUN_AS_NODE;

// Resolve the electron-vite JS entry directly to avoid spawning .cmd/.sh
// wrapper scripts.  This lets us pass args safely without shell:true,
// avoiding the Node.js DEP0190 deprecation warning.
const electronViteEntry = resolve('node_modules/electron-vite/bin/electron-vite.js');

const child = spawn(process.execPath, [electronViteEntry, 'dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
