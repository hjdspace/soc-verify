/**
 * App router — merges all per-subdomain routers into a single tRPC router.
 *
 * Each sub-router lives in `./routers/<domain>-router.ts` and is independently
 * testable. Shared helpers (`requireProject`, `requireSession`, etc.) and the
 * tRPC builder `t` are exported from `./router-context.ts`.
 */

import { t } from './router-context';
import { pingProcedure, versionProcedure, systemRouter } from './routers/system-router';
import { scmRouter } from './routers/scm-router';
import { projectRouter } from './routers/project-router';
import { sessionRouter } from './routers/session-router';
import { simulationRouter } from './routers/simulation-router';
import { terminalRouter } from './routers/terminal-router';
import { envRouter } from './routers/env-router';
import { coverageRouter } from './routers/coverage-router';
import { regressionRouter } from './routers/regression-router';
import { dashboardRouter } from './routers/dashboard-router';
import { toRouter } from './routers/to-router';
import { settingsRouter } from './routers/settings-router';
import { errorAnalysisRouter } from './routers/error-analysis-router';
import { searchRouter } from './routers/search-router';
import { violationRouter } from './routers/violation-router';
import { confirmationRouter } from './routers/confirmation-router';
import { patternRouter } from './routers/pattern-router';
import { scanRouter } from './routers/scan-router';
import { documentRouter } from './routers/document-router';
import { toolsRouter } from './routers/tools-router';
import { browserRouter } from './routers/browser-router';

export const router = t.router({
  ping: pingProcedure,
  version: versionProcedure,

  system: systemRouter,
  scm: scmRouter,
  project: projectRouter,
  session: sessionRouter,
  simulation: simulationRouter,
  terminal: terminalRouter,
  env: envRouter,
  coverage: coverageRouter,
  regression: regressionRouter,
  dashboard: dashboardRouter,
  to: toRouter,
  settings: settingsRouter,
  errorAnalysis: errorAnalysisRouter,
  search: searchRouter,
  violation: violationRouter,
  confirmation: confirmationRouter,
  pattern: patternRouter,
  scan: scanRouter,
  document: documentRouter,
  tools: toolsRouter,
  browser: browserRouter,
});

export type AppRouter = typeof router;
