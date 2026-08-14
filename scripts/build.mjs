/**
 * Build launcher that unsets ELECTRON_RUN_AS_NODE before starting electron-vite build.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

delete process.env.ELECTRON_RUN_AS_NODE;

// Resolve the electron-vite JS entry directly to avoid spawning .cmd/.sh
// wrapper scripts.  This lets us pass args safely without shell:true,
// avoiding the Node.js DEP0190 deprecation warning.
const electronViteEntry = resolve('node_modules/electron-vite/bin/electron-vite.js');

const child = spawn(process.execPath, [electronViteEntry, 'build', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
