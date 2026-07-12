/**
 * Dev launcher that unsets ELECTRON_RUN_AS_NODE before starting electron-vite.
 *
 * On some systems ELECTRON_RUN_AS_NODE=1 is set globally (e.g. for Cursor/VSCode
 * internal Electron usage), which prevents our Electron app from accessing
 * Electron APIs. This script ensures the variable is deleted before launch.
 */
import { spawn } from 'node:child_process';

// Delete the env var so Electron runs in full mode (not Node.js compat mode)
delete process.env.ELECTRON_RUN_AS_NODE;

const child = spawn('electron-vite', ['dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  shell: true,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
