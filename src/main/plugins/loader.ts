// M0 占位：插件动态加载器
// 用户确认：插件动态加载、仿真选项动态生成、MCP/skill 动态叠加
// M2 将实现从项目 .socverify/plugins + 全局 plugins 目录动态发现/注册
import type {
  PluginManifest,
  PluginRegistry
} from '@shared/plugin-types';

export const pluginRegistry: PluginRegistry = {
  caseParsers: [],
  subsysDiscoverers: [],
  coverageParsers: [],
  simulationRunners: [],
  simOptionSchemaProviders: []
};

export async function loadPlugins(_projectRoot: string): Promise<void> {
  // TODO(M2): 动态发现 + 加载项目级/全局插件
}

export function registerPlugin(_manifest: PluginManifest): void {
  // TODO(M2): 按 kind 注册到对应数组
}

export function clearPlugins(): void {
  pluginRegistry.caseParsers.length = 0;
  pluginRegistry.subsysDiscoverers.length = 0;
  pluginRegistry.coverageParsers.length = 0;
  pluginRegistry.simulationRunners.length = 0;
  pluginRegistry.simOptionSchemaProviders.length = 0;
}
