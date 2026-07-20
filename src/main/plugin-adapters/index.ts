/**
 * Barrel re-export of all plugin adapters.
 *
 * These adapters bridge the plugin system (@shared/plugin-types) to the
 * host interface layer (src/main/host/). Routers and services should
 * import from here rather than from host/plugin-discovery.
 */

export { PluginBackedDiscovery } from './discovery';
export { PluginBackedSimulation } from './simulation';
export { PluginBackedCoverage } from './coverage';
