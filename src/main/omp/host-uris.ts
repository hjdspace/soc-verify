import type { RpcHostUriRequest, RpcHostUriResult, RpcHostUriSchemeDefinition } from './types';

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

  constructor() {
    this.registerDefaults();
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
      return ok('{}', 'application/json');
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
