/**
 * Sysbase Environment Generator — main process module barrel.
 *
 * Re-exports the command builder for use by tRPC routers and tests.
 * Additional modules (path-scanner, mod-io-runner) will be added
 * in subsequent issues.
 */

export { buildSysbaseCommand } from './command-builder';
export { inferInstanceName, listRtlFiles, extractModuleName, resolveProjRtl } from './path-scanner';
export type { RtlFileEntry } from './path-scanner';
export { resolveTemplatePath, getTemplatePreview, isTemplateName } from './template-loader';
export type { TemplateName, TemplatePreview, TemplatePreviewSheet } from './template-loader';
export { inferRalDirs, inferClkDirs } from './dir-inferrer';
export { resolveVerdiHome, buildModIoCommand, executeModIo } from './mod-io-runner';
export type { ModIoEvent, ModIoEventCallback, ModIoResult } from './mod-io-runner';
export {
  saveSysgenConfig,
  loadSysgenConfig,
  loadScriptPath,
  listSavedConfigs,
  resolveSysgenDir,
} from './config-persistence';
export type { SavedConfigEntry } from './config-persistence';
export { executeGen } from './gen-runner';
export type { RunGenEvent, RunGenEventCallback, RunGenResult } from './gen-runner';
