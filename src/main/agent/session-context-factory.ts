/**
 * SessionContextFactory — encapsulates plugin adapter creation, credential
 * resolution, and sessionManager.createSession() into a single call.
 *
 * Extracted from session-router.ts where the same ~30-line pattern was
 * duplicated across create, setModel, and restore procedures. Also adopted
 * by ErrorAnalysisSessionFactory and TvAiAdvisor to eliminate further
 * duplication of adapter creation + credential resolution.
 *
 * Depth: small interface (one function, one options type, one result type)
 * hiding 5 steps (plugin loading, adapter creation, coverage/case-stats
 * wiring, credential resolution, session creation).
 */

import { ensurePluginsLoaded } from '../services/project-service';
import { pluginLoader } from '../plugins/loader';
import { PluginBackedDiscovery, PluginBackedSimulation, PluginBackedCoverage } from '../plugin-adapters';
import { coverageRegistry } from '../coverage/coverage-registry';
import { caseStatsRegistry } from '../case/case-stats-registry';
import { simulationRegistry } from '../simulation/simulation-registry';
import { credentialManager } from '../credentials/credential-manager';
import { sessionManager } from './session-manager';
import type { CaseStatsService } from '../case/case-stats-service';

/** Subset of persisted session model info used for credential/provider fallback. */
export type PersistedModelRef = {
  provider?: string;
  providerId?: string;
  id?: string;
  name?: string;
};

export type SessionContextOptions = {
  projectId: string;
  cwd: string;
  /** Explicit provider ID — overrides persistedModel/default. */
  providerId?: string;
  /** Explicit provider name — overrides persistedModel/credential-derived. */
  provider?: string;
  /** Model ID. When omitted, createSession auto-fetches from API. */
  model?: string;
  /** Resume an existing omp conversation by ompSessionId. */
  resumeSessionId?: string;
  /** Link the runtime session to a persisted session ID. */
  persistedSessionId?: string;
  /** Inject CaseStatsService (only the main session needs this). Default: false. */
  includeCaseStats?: boolean;
  /** Create and inject CoverageManager. Default: true. */
  includeCoverageManager?: boolean;
  /** Call ensurePluginsLoaded before creating adapters. Default: true. */
  ensurePlugins?: boolean;
  /** Custom system prompt for the agent. */
  systemPrompt?: string;
  /** Persisted model info — used for credential/provider/model fallback. */
  persistedModel?: PersistedModelRef;
};

export type SessionContext = {
  /** The newly created runtime session ID. */
  sessionId: string;
  /** The provider used (may differ from input when derived from credential). */
  provider: string | undefined;
  /** The model ID that the runtime session was actually initialized with. */
  model: string | undefined;
  /** The providerId of the credential used (for model info persistence). */
  providerId: string | undefined;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  /** Environment variables for the agent process. */
  credEnv: Record<string, string>;
};

/**
 * Create a session context: loads plugins, creates adapters, resolves
 * credentials, and calls sessionManager.createSession().
 *
 * This is the single entry point for session creation — all call sites
 * (session-router create/setModel/restore, ErrorAnalysisSessionFactory,
 * TvAiAdvisor) route through here.
 */
export async function createSessionContext(options: SessionContextOptions): Promise<SessionContext> {
  const { projectId, cwd } = options;

  // 1. Load plugins (if requested — error-analysis/TV paths skip this)
  if (options.ensurePlugins !== false) {
    await ensurePluginsLoaded(cwd);
  }
  const registry = pluginLoader.getRegistry(cwd);

  // 2. Create adapters
  const discovery = new PluginBackedDiscovery(cwd, registry);
  const simulation = new PluginBackedSimulation(registry);
  const coverage = new PluginBackedCoverage(cwd, registry);

  // 3. Optionally create CoverageManager (session router needs it;
  //    error-analysis/TV don't pass coverage tools to the agent)
  const coverageManager = options.includeCoverageManager !== false
    ? coverageRegistry.getOrCreate(cwd, coverage)
    : undefined;

  // 4. Optionally create CaseStatsService (only the main session needs this
  //    to enable get_case_stats / get_project_overview tools)
  let caseStatsService: CaseStatsService | undefined;
  if (options.includeCaseStats) {
    const simManager = simulationRegistry.get(cwd);
    caseStatsService = caseStatsRegistry.getOrCreate(cwd, registry, simManager);
  }

  // 5. Resolve credentials — providerId from explicit input, then persisted
  //    model, then default credential. Provider from explicit input, then
  //    persisted model, then mapped from credential.
  const credEnv = await credentialManager.buildEnvForAgent();
  const resolvedProviderId = options.providerId ?? options.persistedModel?.providerId;
  const cred = resolvedProviderId
    ? await credentialManager.get(resolvedProviderId)
    : await credentialManager.getDefaultCredential();
  const provider = options.provider
    ?? options.persistedModel?.provider
    ?? (cred ? credentialManager.mapProviderForAgent(cred.providerId) : undefined);
  const apiKey = cred?.apiKey;
  const baseUrl = cred?.baseUrl;

  // 6. Create the runtime session
  const sessionId = await sessionManager.createSession({
    projectId,
    cwd,
    provider,
    model: options.model,
    apiKey,
    baseUrl,
    discovery,
    simulationAdapter: simulation,
    coverageAdapter: coverage,
    coverageManager: coverageManager ?? null,
    caseStatsService: caseStatsService ?? null,
    resumeSessionId: options.resumeSessionId,
    persistedSessionId: options.persistedSessionId,
    env: credEnv,
    systemPrompt: options.systemPrompt,
  });

  // 7. Read back the resolved model (may differ from input when createSession
  //    auto-fetched the first model from the API)
  const resolvedModel = sessionManager.getModel(sessionId) ?? options.model;

  return {
    sessionId,
    provider,
    model: resolvedModel,
    providerId: resolvedProviderId ?? cred?.providerId,
    apiKey,
    baseUrl,
    credEnv,
  };
}
