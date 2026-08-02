import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [, , targetArg, idArg] = process.argv;
if (!targetArg || !idArg) {
  console.error('Usage: node scripts/create-plugin.mjs <target-directory> <plugin-id>');
  process.exit(1);
}

const target = resolve(targetArg);
const name = idArg.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

await mkdir(target, { recursive: true });
await writeFile(resolve(target, 'package.json'), `${JSON.stringify({
  name: idArg,
  version: '0.1.0',
  main: 'index.cjs',
  socverify: { apiVersion: '1.0', id: idArg, kind: 'ui' },
}, null, 2)}\n`, 'utf-8');
await writeFile(resolve(target, 'index.cjs'), `'use strict';

module.exports = {
  manifest: {
    apiVersion: '1.0',
    id: '${idArg}',
    name: '${name}',
    version: '0.1.0',
    kind: 'ui',
    activationEvents: ['onView:overview'],
    contributes: {
      views: [{ id: 'overview', name: 'Overview', location: 'center', entry: 'view.html' }],
      commands: [{ command: '${idArg}.refresh', title: 'Refresh' }],
    },
  },

  activate(context) {
    context.registerCommand('${idArg}.refresh', () => ({ ok: true }));
  },
};
`, 'utf-8');
await writeFile(resolve(target, 'view.html'), '<!doctype html>\n<html lang="en">\n  <body>\n    <button id="refresh">Refresh</button>\n    <script>\n      document.querySelector("#refresh").addEventListener("click", async () => {\n        await window.socVerify.invoke("' + idArg + '.refresh");\n      });\n    </script>\n  </body>\n</html>\n', 'utf-8');

console.log(`Created SoC Verify plugin at ${target}`);
