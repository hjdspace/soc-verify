/**
 * Backward-compatible re-exports of plugin adapters.
 *
 * The actual adapter implementations have been moved to
 * src/main/plugin-adapters/. This file re-exports them so that existing
 * imports from 'host/plugin-discovery' continue to work during migration.
 *
 * New code should import from src/main/plugin-adapters/ instead:
 *   import { PluginBackedDiscovery } from '@main/plugin-adapters';
 */

export { PluginBackedDiscovery } from '../plugin-adapters/discovery';
export { PluginBackedSimulation } from '../plugin-adapters/simulation';
export { PluginBackedCoverage } from '../plugin-adapters/coverage';
