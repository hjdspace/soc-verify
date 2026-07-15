import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionManager } from '../../src/main/agent/session-manager';
import { resolveAgentRuntime } from '../../src/main/agent/paths';

const runtime = resolveAgentRuntime();
const itWithRuntime = runtime ? it : it.skip;

describe('OpenAI-compatible Agent session', () => {
  let server: Server | undefined;
  let sessionId: string | undefined;
  let homeDir: string | undefined;

  afterEach(async () => {
    if (sessionId) await sessionManager.destroySession(sessionId);
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (homeDir) await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    sessionId = undefined;
    server = undefined;
    homeDir = undefined;
  });

  itWithRuntime('uses chat/completions instead of the Responses API', async () => {
    const requestPaths: string[] = [];
    const requestBodies: Array<Record<string, unknown>> = [];

    server = createServer((request, response) => {
      const path = request.url ?? '';
      requestPaths.push(path);

      if (request.method === 'GET' && path === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'chat-model' }] }));
        return;
      }

      if (request.method === 'POST' && path === '/v1/responses') {
        response.writeHead(403, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { type: 'forbidden', message: 'Request not allowed' } }));
        return;
      }

      if (request.method === 'POST' && path === '/v1/chat/completions') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          requestBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>);
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.end([
            `data: ${JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'chat-model',
              choices: [{ index: 0, delta: { role: 'assistant', content: 'I am chat-model.' }, finish_reason: null }],
            })}`,
            `data: ${JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'chat-model',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}`,
            'data: [DONE]',
            '',
          ].join('\n\n'));
        });
        return;
      }

      response.writeHead(404);
      response.end();
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');

    homeDir = await mkdtemp(join(tmpdir(), 'socverify-agent-home-'));
    sessionId = await sessionManager.createSession({
      projectId: 'project_test',
      cwd: process.cwd(),
      provider: 'agnes',
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      enableMCP: false,
      env: { HOME: homeDir, USERPROFILE: homeDir },
    });

    const client = sessionManager.getClient(sessionId);
    if (!client) throw new Error('Agent client was not created');

    // prompt() is fire-and-forget — it returns immediately while the agent
    // processes the message asynchronously.  Poll until the agent makes the
    // expected HTTP request.
    await client.prompt('What model are you?');
    const deadline = Date.now() + 20_000;
    while (!requestPaths.includes('/v1/chat/completions') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(requestPaths).toContain('/v1/chat/completions');
    expect(requestPaths).not.toContain('/v1/responses');
    expect(requestBodies[0]).toMatchObject({ model: 'chat-model', stream: true });
  }, 30_000);
});
