/**
 * sysbase-gen sub-router — Issue 2 + Issue 3 + Issue 4 + Issue 5 + Issue 6 procedures.
 *
 * Issue 2: inferInstanceName · listRtlFiles · extractModuleName
 * Issue 3: getTemplatePath · getTemplatePreview
 * Issue 4: inferRalDirs · inferClkDirs
 * Issue 5: generateModIo (spawn perl getModIO_batch.p with streaming)
 * Issue 6: runGen · saveConfig · loadConfig · listSavedConfigs
 */

import { existsSync } from 'node:fs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { t, TRPCError } from '../../ipc/router-context';
import { BrowserWindow } from 'electron';
import { reqString, optStringUndef, cast } from './shared';
import {
  inferInstanceName as inferInstanceNameImpl,
  listRtlFiles as listRtlFilesImpl,
  extractModuleName as extractModuleNameImpl,
} from '../sysbase-gen/path-scanner';
import { buildSysbaseCommand } from '../sysbase-gen/command-builder';
import {
  resolveTemplatePath,
  getTemplatePreview as getTemplatePreviewImpl,
  isTemplateName,
  type TemplateName,
} from '../sysbase-gen/template-loader';
import {
  inferRalDirs as inferRalDirsImpl,
  inferClkDirs as inferClkDirsImpl,
} from '../sysbase-gen/dir-inferrer';
import {
  resolveVerdiHome,
  executeModIo,
  type ModIoEvent,
} from '../sysbase-gen/mod-io-runner';
import {
  saveSysgenConfig,
  loadSysgenConfig,
  loadScriptPath,
  listSavedConfigs,
} from '../sysbase-gen/config-persistence';
import {
  generateDutSpecTemplate,
  getDutSpecTemplatePreview,
} from '../sysbase-gen/dut-spec-template';
import {
  generateMiniExcelTemplate,
  getMiniExcelTemplatePreview,
} from '../sysbase-gen/mini-excel-template';
import type { SysbaseGenConfig } from '../../../shared/types/sysbase-gen';
import {
  executeGen,
  type RunGenEvent,
} from '../sysbase-gen/gen-runner';

export const sysbaseGenRouter = t.router({
  /** Build the formatted sysbase_gen.py command string (Issue 6). */
  previewCommand: t.procedure
    .input((raw): { config: SysbaseGenConfig; scriptPath: string } => {
      const r = raw as Record<string, unknown>;
      return {
        config: cast<SysbaseGenConfig>(r, 'config'),
        scriptPath: reqString(r, 'scriptPath'),
      };
    })
    .query(({ input }) => {
      return { command: buildSysbaseCommand(input.config, input.scriptPath) };
    }),

  /** Infer instance name from subsys name (e.g. apcpu_sys → u_sys_apcpu). */
  inferInstanceName: t.procedure
    .input((raw): { subsys: string } => {
      const r = raw as Record<string, unknown>;
      const subsys = reqString(r, 'subsys');
      if (!subsys.trim()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'subsys 不能为空' });
      }
      return { subsys };
    })
    .query(async ({ input }) => {
      const instanceName = inferInstanceNameImpl(input.subsys);
      return { instanceName };
    }),

  /** List all .v files in $PROJ_RTL/<subsys>/design/rtl/top/. */
  listRtlFiles: t.procedure
    .input((raw): { subsys: string; projectDir?: string } => {
      const r = raw as Record<string, unknown>;
      const subsys = reqString(r, 'subsys');
      if (!subsys.trim()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'subsys 不能为空' });
      }
      return {
        subsys,
        projectDir: typeof r.projectDir === 'string' ? r.projectDir : undefined,
      };
    })
    .query(async ({ input }) => {
      try {
        const files = listRtlFilesImpl(input.subsys, input.projectDir);
        return { files };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  /** Extract module name from a .v file using regex. */
  extractModuleName: t.procedure
    .input((raw): { filePath: string } => {
      const r = raw as Record<string, unknown>;
      const filePath = reqString(r, 'filePath');
      if (!filePath.trim()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath 不能为空' });
      }
      return { filePath };
    })
    .query(async ({ input }) => {
      try {
        const moduleName = extractModuleNameImpl(input.filePath);
        return { moduleName };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('不存在')) {
          throw new TRPCError({ code: 'NOT_FOUND', message });
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  /** Resolve absolute path to a template xlsx file (Issue 3). */
  getTemplatePath: t.procedure
    .input((raw): { template: TemplateName } => {
      const r = raw as Record<string, unknown>;
      const template = reqString(r, 'template');
      if (!isTemplateName(template)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `template must be 'dut_spec' or 'mini'`,
        });
      }
      return { template };
    })
    .query(({ input }) => {
      const path = resolveTemplatePath(input.template);
      return { path };
    }),

  /** Read template xlsx and return sheet names + header row preview (Issue 3). */
  getTemplatePreview: t.procedure
    .input((raw): { template: TemplateName } => {
      const r = raw as Record<string, unknown>;
      const template = reqString(r, 'template');
      if (!isTemplateName(template)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `template must be 'dut_spec' or 'mini'`,
        });
      }
      return { template };
    })
    .query(async ({ input }) => {
      try {
        const preview = await getTemplatePreviewImpl(input.template);
        return preview;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  /** Infer RAL directories by scanning spec/ and rtl/ for for_de + for_dv (Issue 4). */
  inferRalDirs: t.procedure
    .input((raw): { subsys: string; projectDir?: string } => {
      const r = raw as Record<string, unknown>;
      const subsys = reqString(r, 'subsys');
      if (!subsys.trim()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'subsys 不能为空' });
      }
      return {
        subsys,
        projectDir: typeof r.projectDir === 'string' ? r.projectDir : undefined,
      };
    })
    .query(async ({ input }) => {
      try {
        const dirs = inferRalDirsImpl(input.subsys, input.projectDir);
        return { dirs };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  /** Infer CLK directories by scanning rtl/ for clk_max_cfg files (Issue 4). */
  inferClkDirs: t.procedure
    .input((raw): { subsys: string; projectDir?: string } => {
      const r = raw as Record<string, unknown>;
      const subsys = reqString(r, 'subsys');
      if (!subsys.trim()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'subsys 不能为空' });
      }
      return {
        subsys,
        projectDir: typeof r.projectDir === 'string' ? r.projectDir : undefined,
      };
    })
    .query(async ({ input }) => {
      try {
        const dirs = inferClkDirsImpl(input.subsys, input.projectDir);
        return { dirs };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  /** Generate Module IO file via Verdi's getModIO_batch.p perl script (Issue 5). */
  generateModIo: t.procedure
    .input((raw): {
      filelist: string;
      moduleName: string;
      projectDir?: string;
      outputFile?: string;
      cwd?: string;
      moduleList?: string;
      targetScope?: string;
    } => {
      const r = raw as Record<string, unknown>;
      const filelist = reqString(r, 'filelist');
      const moduleName = reqString(r, 'moduleName');
      if (!filelist.trim()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filelist 不能为空' });
      }
      if (!moduleName.trim()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'moduleName 不能为空' });
      }
      return {
        filelist,
        moduleName,
        projectDir: optStringUndef(r, 'projectDir'),
        outputFile: optStringUndef(r, 'outputFile'),
        cwd: optStringUndef(r, 'cwd'),
        moduleList: optStringUndef(r, 'moduleList'),
        targetScope: optStringUndef(r, 'targetScope'),
      };
    })
    .mutation(async ({ input }) => {
      // Resolve VERDI_HOME from env or .socverify/env.json
      const verdiHome = resolveVerdiHome(input.projectDir);
      if (!verdiHome) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'VERDI_HOME 环境变量未设置，请在环境变量管理中配置 VERDI_HOME',
        });
      }

      // Check filelist file exists
      if (!existsSync(input.filelist)) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `filelist 文件不存在: ${input.filelist}`,
        });
      }

      const outputFile = input.outputFile || 'getModIO.log';
      const cwd = input.cwd || process.cwd();

      // Broadcast real-time log events to all windows
      const onEvent = (event: ModIoEvent) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('sysbase-gen:mod-io-log', event);
          }
        }
      };

      const result = await executeModIo(
        verdiHome,
        input.filelist,
        input.moduleName,
        outputFile,
        cwd,
        onEvent,
        input.moduleList,
        input.targetScope,
      );

      return {
        success: result.success,
        logs: result.logs,
        outputFilePath: result.outputFilePath,
        errorMessage: result.success ? undefined : 'Module IO 生成失败',
      };
    }),

  /** Execute sysbase_gen.py command with streaming output (Issue 6). */
  runGen: t.procedure
    .input((raw): { command: string; cwd?: string } => {
      const r = raw as Record<string, unknown>;
      const command = reqString(r, 'command');
      if (!command.trim()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'command 不能为空' });
      }
      return {
        command,
        cwd: optStringUndef(r, 'cwd'),
      };
    })
    .mutation(async ({ input }) => {
      const cwd = input.cwd || process.cwd();

      // Broadcast real-time log events to all windows
      const onEvent = (event: RunGenEvent) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('sysbase-gen:run-log', event);
          }
        }
      };

      const result = await executeGen(input.command, cwd, onEvent);

      return {
        success: result.success,
        logs: result.logs,
        errorMessage: result.success ? undefined : 'sysbase_gen.py 执行失败',
      };
    }),

  /** Save wizard config to .socverify/sysbase-gen/<subsys>.json (Issue 6). */
  saveConfig: t.procedure
    .input((raw): { config: SysbaseGenConfig; scriptPath: string; projectDir?: string } => {
      const r = raw as Record<string, unknown>;
      const config = cast<SysbaseGenConfig>(r, 'config');
      const scriptPath = reqString(r, 'scriptPath');
      if (!config.subsys.trim()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'subsys 不能为空' });
      }
      return { config, scriptPath, projectDir: optStringUndef(r, 'projectDir') };
    })
    .mutation(async ({ input }) => {
      const projectDir = input.projectDir || process.cwd();
      await saveSysgenConfig(input.config, input.scriptPath, projectDir);
      return { success: true };
    }),

  /** Load a saved config for a given subsys (Issue 6). */
  loadConfig: t.procedure
    .input((raw): { subsys: string; projectDir?: string } => {
      const r = raw as Record<string, unknown>;
      const subsys = reqString(r, 'subsys');
      if (!subsys.trim()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'subsys 不能为空' });
      }
      return { subsys, projectDir: optStringUndef(r, 'projectDir') };
    })
    .query(async ({ input }) => {
      const projectDir = input.projectDir || process.cwd();
      const config = await loadSysgenConfig(input.subsys, projectDir);
      const scriptPath = await loadScriptPath(projectDir);
      return { config, scriptPath };
    }),

  /** Generate a dut_spec template xlsx from the markdown-defined structure (replaces static template file). */
  generateDutSpecTemplate: t.procedure
    .input((raw): { outputPath?: string; subsysName?: string } => {
      const r = raw as Record<string, unknown>;
      return {
        outputPath: typeof r.outputPath === 'string' ? r.outputPath : undefined,
        subsysName: typeof r.subsysName === 'string' ? r.subsysName : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const outputPath = input.outputPath || join(tmpdir(), `soc-verify-dut-spec-${Date.now()}.xlsx`);
      try {
        await generateDutSpecTemplate(outputPath, input.subsysName);
        return { path: outputPath };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  /** Get a preview of the dut_spec template structure (sheet names + section headers). */
  getDutSpecGeneratedPreview: t.procedure
    .query(() => {
      return getDutSpecTemplatePreview();
    }),

  /** Generate a mini excel template xlsx from the code-defined structure (replaces static template file). */
  generateMiniExcelTemplate: t.procedure
    .input((raw): { outputPath?: string; subsysName?: string } => {
      const r = raw as Record<string, unknown>;
      return {
        outputPath: typeof r.outputPath === 'string' ? r.outputPath : undefined,
        subsysName: typeof r.subsysName === 'string' ? r.subsysName : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const outputPath = input.outputPath || join(tmpdir(), `soc-verify-mini-excel-${Date.now()}.xlsx`);
      try {
        await generateMiniExcelTemplate(outputPath, input.subsysName);
        return { path: outputPath };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  /** Get a preview of the mini excel template structure (sheet names + headers). */
  getMiniExcelGeneratedPreview: t.procedure
    .query(() => {
      return getMiniExcelTemplatePreview();
    }),

  /** Read a CSV file and return its content (for preview in StepCsv). */
  readCsvFile: t.procedure
    .input((raw): { path: string } => {
      const r = raw as Record<string, unknown>;
      const path = reqString(r, 'path');
      if (!path.trim()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'path 不能为空' });
      }
      return { path };
    })
    .query(({ input }) => {
      if (!existsSync(input.path)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `文件不存在: ${input.path}` });
      }
      try {
        const content = readFileSync(input.path, 'utf-8');
        return { content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  /** Create a temp CSV template file and return its path (for editing). */
  createCsvTemplate: t.procedure
    .input((raw): { content: string; filename?: string } => {
      const r = raw as Record<string, unknown>;
      const content = reqString(r, 'content');
      return {
        content,
        filename: typeof r.filename === 'string' ? r.filename : undefined,
      };
    })
    .mutation(({ input }) => {
      const fileName = input.filename ?? `soc-verify-top-csv-${Date.now()}.csv`;
      const tmpPath = join(tmpdir(), fileName);
      try {
        writeFileSync(tmpPath, input.content, 'utf-8');
        return { path: tmpPath };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  /** Write CSV content to a specified path (for export). */
  writeCsvFile: t.procedure
    .input((raw): { path: string; content: string } => {
      const r = raw as Record<string, unknown>;
      const path = reqString(r, 'path');
      const content = reqString(r, 'content');
      if (!path.trim()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'path 不能为空' });
      }
      return { path, content };
    })
    .mutation(({ input }) => {
      try {
        const dir = dirname(input.path);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(input.path, input.content, 'utf-8');
        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),

  /** List all saved configs grouped by subsys name (Issue 6). */
  listSavedConfigs: t.procedure
    .input((raw): { projectDir?: string } => {
      const r = raw as Record<string, unknown>;
      return { projectDir: optStringUndef(r, 'projectDir') };
    })
    .query(async ({ input }) => {
      const projectDir = input.projectDir || process.cwd();
      const configs = await listSavedConfigs(projectDir);
      return { configs };
    }),
});
