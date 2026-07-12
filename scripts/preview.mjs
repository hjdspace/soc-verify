/**
 * Preview launcher that unsets ELECTRON_RUN_AS_NODE before starting electron-vite preview.
 */
import { spawn } from 'node:child_process';

delete process.env.ELECTRON_RUN_AS_NODE;

const child = spawn('electron-vite', ['preview', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  shell: true,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
