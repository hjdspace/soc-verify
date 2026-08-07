/**
 * c-sv-converter sub-router — C ↔ SystemVerilog code conversion.
 *
 * Procedures: preview · previewSvToC · convert · getDefaultTypeMappings · export · scanDirectory
 */

import { t, TRPCError } from '../../ipc/router-context';
import {
  previewCToSv,
  previewSvToC,
  convertCToSv,
  convertSvToC,
  getDefaultTypeMappings,
  getDefaultFunctionMappings,
  type ConversionConfig,
} from '../c-sv-converter';
import { optArray, optBoolean, optString, cast } from './shared';
import { writeFile } from 'node:fs/promises';

type PreviewConfig = {
  preserveComments?: boolean;
  addAutomatic?: boolean;
  coreNameDefault?: string;
  typeMappings?: Record<string, string>;
};

export const cSvConverterRouter = t.router({
  preview: t.procedure
    .input((raw): { filePaths: string[]; config: PreviewConfig } => {
      const r = raw as Record<string, unknown>;
      return {
        filePaths: optArray<string>(r, 'filePaths', []),
        config: cast<PreviewConfig>(r, 'config'),
      };
    })
    .mutation(async ({ input }) => {
      return await previewCToSv(input.filePaths, input.config ?? {});
    }),

  previewSvToC: t.procedure
    .input((raw): { filePaths: string[]; config: PreviewConfig } => {
      const r = raw as Record<string, unknown>;
      return {
        filePaths: optArray<string>(r, 'filePaths', []),
        config: cast<PreviewConfig>(r, 'config'),
      };
    })
    .mutation(async ({ input }) => {
      return await previewSvToC(input.filePaths, input.config ?? {});
    }),

  convert: t.procedure
    .input((raw): {
      inputFiles: string[];
      outputPath: string;
      direction: 'c-to-sv' | 'sv-to-c';
      preserveComments: boolean;
      addAutomatic: boolean;
      coreNameDefault: string;
      typeMappings: Record<string, string>;
    } => {
      const r = raw as Record<string, unknown>;
      return {
        inputFiles: optArray<string>(r, 'inputFiles', []),
        outputPath: optString(r, 'outputPath', ''),
        direction: r.direction === 'sv-to-c' ? 'sv-to-c' : 'c-to-sv',
        preserveComments: optBoolean(r, 'preserveComments', true),
        addAutomatic: optBoolean(r, 'addAutomatic', true),
        coreNameDefault: optString(r, 'coreNameDefault', 'AON'),
        typeMappings: (r.typeMappings && typeof r.typeMappings === 'object') ? r.typeMappings as Record<string, string> : {},
      };
    })
    .mutation(async ({ input }) => {
      const config: ConversionConfig = {
        inputFiles: input.inputFiles,
        outputPath: input.outputPath,
        direction: input.direction,
        preserveComments: input.preserveComments,
        addAutomatic: input.addAutomatic,
        coreNameDefault: input.coreNameDefault,
        typeMappings: input.typeMappings,
        functionMappings: {},
      };
      if (input.direction === 'sv-to-c') {
        return await convertSvToC(config);
      }
      return await convertCToSv(config);
    }),

  getDefaultTypeMappings: t.procedure
    .query(() => ({
      typeMappings: getDefaultTypeMappings(),
      functionMappings: getDefaultFunctionMappings(),
    })),

  export: t.procedure
    .input((raw): { content: string; savePath: string } => {
      const r = raw as Record<string, unknown>;
      return {
        content: optString(r, 'content', ''),
        savePath: optString(r, 'savePath', ''),
      };
    })
    .mutation(async ({ input }) => {
      await writeFile(input.savePath, input.content, 'utf-8');
      return { success: true };
    }),

  /** Walk a directory and return files matching the given extensions. */
  scanDirectory: t.procedure
    .input((raw): { directory: string; extensions: string[] } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.directory !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'directory is required' });
      }
      return {
        directory: r.directory,
        extensions: optArray<string>(r, 'extensions', []),
      };
    })
    .mutation(async ({ input }) => {
      const { readdirSync, statSync } = await import('node:fs');
      const { join } = await import('node:path');
      const results: string[] = [];

      function walk(dir: string): void {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const fullPath = join(dir, entry);
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath);
          } else if (input.extensions.length === 0 || input.extensions.some((ext) => entry.endsWith(ext))) {
            results.push(fullPath);
          }
        }
      }

      walk(input.directory);
      return { files: results };
    }),
});
