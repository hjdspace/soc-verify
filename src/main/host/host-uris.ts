import type { RpcHostUriRequest, RpcHostUriResult, RpcHostUriSchemeDefinition } from './types';
import type { CoverageManager } from '../coverage/coverage-manager';
import { COVERAGE_METRICS } from '@shared/types';
import type { CoverageMetric, UncoveredItem } from '@shared/types';

type UriHandler = (request: RpcHostUriRequest) => Promise<RpcHostUriResult>;

interface UriSchemeEntry {
  definition: RpcHostUriSchemeDefinition;
  handler: UriHandler;
}

function ok(content: string, contentType: RpcHostUriResult['contentType'] = 'text/plain'): RpcHostUriResult {
  return { type: 'host_uri_result', id: '', content, contentType, isError: false };
}

function fail(error: string): RpcHostUriResult {
  return { type: 'host_uri_result', id: '', isError: true, error };
}

export class HostUriRouter {
  private schemes = new Map<string, UriSchemeEntry>();
  private coverageManager: CoverageManager | null = null;

  constructor() {
    this.registerDefaults();
  }

  /**
   * 注入 CoverageManager（ADR 0009 摘要优先策略）。
   * 设置后 cov:// URI 返回分层覆盖率数据。
   */
  setCoverageManager(mgr: CoverageManager | null): void {
    this.coverageManager = mgr;
  }

  private registerDefaults(): void {
    this.register('case', 'Verification case data (read-only)', false, true, async (req) => {
      if (req.operation === 'write') return fail('case:// is read-only');
      return ok(JSON.stringify({ case: req.url, data: null }), 'application/json');
    });

    this.register('log', 'Simulation log data (read-only)', false, true, async (req) => {
      if (req.operation === 'write') return fail('log:// is read-only');
      return ok('', 'text/plain');
    });

    this.register('cov', 'Coverage data (read-only)', false, true, async (req) => {
      if (req.operation === 'write') return fail('cov:// is read-only');
      // 向后兼容：CoverageManager 未注入时返回空 JSON
      if (!this.coverageManager) return ok('{}', 'application/json');

      // 解析 URI: cov://<sessionId>[/<module>[/uncovered]]
      const rest = req.url.slice('cov://'.length);
      const parts = rest.split('/').filter(Boolean);

      if (parts.length === 0) {
        return fail('cov:// requires a sessionId');
      }

      const sessionId = parts[0];

      try {
        // 仅 sessionId → 摘要
        if (parts.length === 1) {
          const result = await this.coverageManager.getCoverageSummary(sessionId);
          return ok(JSON.stringify(result), 'application/json');
        }

        // 判断是否为 uncovered 请求
        const isUncovered = parts[parts.length - 1] === 'uncovered';
        const moduleParts = isUncovered ? parts.slice(1, -1) : parts.slice(1);
        const modulePath = moduleParts.join('/');

        if (isUncovered) {
          // 未覆盖项：从 CoverageData.uncovered 中提取指定模块的未覆盖项
          const data = await this.coverageManager.getTree(sessionId);
          const uncoveredMap = data.uncovered ?? {};
          const moduleName = moduleParts[moduleParts.length - 1] ?? modulePath;
          const items: Array<{ metric: CoverageMetric } & UncoveredItem> = [];
          for (const metric of COVERAGE_METRICS) {
            const metricItems = uncoveredMap[metric] ?? [];
            for (const item of metricItems) {
              // 匹配模块路径或模块名
              if (item.module === modulePath || item.module === moduleName) {
                items.push({ metric, ...item });
              }
            }
          }
          return ok(
            JSON.stringify({ sessionId, module: modulePath, uncovered: items }),
            'application/json',
          );
        }

        // 模块详情
        const result = await this.coverageManager.getCoverageDetail(modulePath, sessionId);
        return ok(JSON.stringify(result), 'application/json');
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    });
  }

  register(
    scheme: string,
    description: string,
    writable: boolean,
    immutable: boolean,
    handler: UriHandler,
  ): void {
    this.schemes.set(scheme, {
      definition: { scheme, description, writable, immutable },
      handler,
    });
  }

  unregister(scheme: string): boolean {
    return this.schemes.delete(scheme);
  }

  getSchemeDefinitions(): RpcHostUriSchemeDefinition[] {
    return Array.from(this.schemes.values()).map((e) => e.definition);
  }

  getSchemeNames(): string[] {
    return Array.from(this.schemes.keys());
  }

  hasScheme(scheme: string): boolean {
    return this.schemes.has(scheme);
  }

  async handleUriRequest(request: RpcHostUriRequest): Promise<RpcHostUriResult> {
    const scheme = request.url.split(':')[0];
    const entry = this.schemes.get(scheme);

    if (!entry) {
      return { ...fail(`No handler registered for URI scheme "${scheme}"`), id: request.id };
    }

    try {
      const result = await entry.handler(request);
      return { ...result, id: request.id };
    } catch (error) {
      return {
        ...fail(error instanceof Error ? error.message : String(error)),
        id: request.id,
      };
    }
  }
}
