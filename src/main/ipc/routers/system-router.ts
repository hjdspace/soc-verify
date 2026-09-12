/**
 * System router — ping, version, agent runtime resolution, and system browser.
 */

import { shell } from 'electron';
import { join } from 'node:path';
import { t } from '../router-context';
import { resolvePiRunnerScript } from '../../agent/paths';
import { listNerdFontFaces, resolveNerdFontsDir } from '../../fonts/nerd-font-paths';
import { toLocalResourceUrl } from '../../local-resource-protocol';

export const pingProcedure = t.procedure.query(() => 'pong' as const);

export const versionProcedure = t.procedure.query(() => ({
  app: 'soc-verify',
  version: '0.2.0',
  stage: 'M2' as const,
}));

export const systemRouter = t.router({
  // issue 10：AI 引擎固定为 pi —— 状态只描述 pi runner 脚本可用性，
  // 不再有 binary/Bun 双模式与 omp 运行时解析。
  resolveAgent: t.procedure.query(() => {
    const runnerPath = resolvePiRunnerScript();
    return {
      available: runnerPath !== null,
      runnerPath,
    };
  }),
  // Nerd Font 可用字体列表（Issue #1）。
  // 返回磁盘上实际存在的 face 及其 local-resource:// URL，
  // 渲染进程据此生成 @font-face；字体未下载时 faces 为空（降级 fallback）。
  nerdFonts: t.procedure.query(() => {
    const fontsDir = resolveNerdFontsDir();
    const faces = listNerdFontFaces(fontsDir);
    return {
      available: faces.length > 0,
      faces: faces.map((face) => ({
        family: face.family,
        weight: face.weight,
        style: face.style,
        url: toLocalResourceUrl(join(fontsDir ?? '', face.fileName)),
      })),
    };
  }),
  openExternal: t.procedure
    .input((raw): string => {
      if (typeof raw !== 'string') throw new Error('URL must be a string');
      return raw;
    })
    .mutation(async ({ input: url }) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error('Invalid URL');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http/https URLs can be opened in the system browser');
      }
      await shell.openExternal(url);
      return { success: true };
    }),
});
