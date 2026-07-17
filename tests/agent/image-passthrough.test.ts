import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ─── Mock paths module ──────────────────────────────────────────────
// In vitest, source files are imported directly (not bundled), so __dirname
// inside paths.ts resolves to src/main/agent/ (3 levels deep) instead of
// out/main/ (2 levels deep). This makes devBinariesDir() resolve to
// src/resources/binaries (wrong) instead of <root>/resources/binaries.
// We mock the resolver functions to look in the right place.
//
// vi.hoisted ensures the path computation runs before the mock factory,
// which itself is hoisted above all imports by vitest.
const mockPaths = vi.hoisted(() => {
  const { existsSync } = require('node:fs') as typeof import('node:fs');
  const { join, resolve } = require('node:path') as typeof import('node:path');
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  // __dirname in the test file = <root>/tests/agent
  const projectRoot = resolve(__dirname, '..', '..');
  const binaryPath = join(projectRoot, 'resources', 'binaries', 'socverify-runner.exe');
  const builtInExtDir = join(projectRoot, 'resources', 'built-in-extension');
  const runnerScript = join(projectRoot, 'runner', 'index.ts');
  const engineSdk = join(projectRoot, 'engine', 'oh-my-pi', 'packages', 'coding-agent', 'src', 'sdk.ts');

  // Find Bun in PATH
  let bunPath: string | null = null;
  try {
    const out = execFileSync('where', ['bun'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    bunPath = out.trim().split(/\r?\n/)[0] || null;
  } catch {
    bunPath = null;
  }

  const useScriptMode = existsSync(runnerScript) && existsSync(engineSdk) && bunPath !== null;

  return {
    binaryPath,
    builtInExtDir,
    binaryExists: existsSync(binaryPath),
    extExists: existsSync(join(builtInExtDir, 'skills')),
    useScriptMode,
    runnerScript,
    bunPath,
  };
});

vi.mock('../../src/main/agent/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/paths')>();
  return {
    ...actual,
    resolveAgentRuntime: () => {
      // Use binary mode (script mode requires engine submodule deps)
      if (mockPaths.binaryExists) {
        return { mode: 'binary' as const, runnerPath: mockPaths.binaryPath };
      }
      return null;
    },
    resolveRunnerBinary: () => (mockPaths.binaryExists ? mockPaths.binaryPath : null),
    resolveBuiltInExtensionDir: () =>
      mockPaths.extExists ? mockPaths.builtInExtDir : null,
  };
});

// Import AFTER mock so session-manager picks up the mocked paths.
const { sessionManager } = await import('../../src/main/agent/session-manager');

// A small (4x4) valid PNG, base64-encoded.  Using a real image (not a 1x1)
// avoids edge cases in the resize pipeline's `minDimension: 200` upscaling.
// The important thing is that the data URL survives the runner → SDK →
// provider chain and lands in the HTTP request body as an image_url block.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVQIW2P8//8/AwggBgYGRhgDADrlBgEqdrE2AAAAAElFTkSuQmCC';
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

/**
 * Extract the user-message content blocks from a chat/completions request body.
 * Returns the content array (or string) of the first user message found.
 */
function extractUserContent(body: Record<string, unknown>): unknown {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue;
    const m = msg as Record<string, unknown>;
    if (m.role === 'user') return m.content;
  }
  return undefined;
}

describe('Image passthrough to LLM (OpenAI-compatible)', () => {
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

  it(
    'forwards attached images to the LLM as image_url content blocks',
    async () => {
      const requestBodies: Array<Record<string, unknown>> = [];

      server = createServer((request, response) => {
        const path = request.url ?? '';

        if (request.method === 'GET' && path === '/v1/models') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ data: [{ id: 'vision-model' }] }));
          return;
        }

        if (request.method === 'POST' && path === '/v1/chat/completions') {
          const chunks: Buffer[] = [];
          request.on('data', (chunk: Buffer) => chunks.push(chunk));
          request.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
            requestBodies.push(body);
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.end([
              `data: ${JSON.stringify({
                id: 'chatcmpl-img',
                object: 'chat.completion.chunk',
                created: 0,
                model: 'vision-model',
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant', content: 'I see the image.' },
                    finish_reason: null,
                  },
                ],
              })}`,
              `data: ${JSON.stringify({
                id: 'chatcmpl-img',
                object: 'chat.completion.chunk',
                created: 0,
                model: 'vision-model',
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

      homeDir = await mkdtemp(join(tmpdir(), 'socverify-agent-img-'));
      sessionId = await sessionManager.createSession({
        projectId: 'project_img_test',
        cwd: process.cwd(),
        provider: 'agnes',
        apiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        enableMCP: false,
        env: { HOME: homeDir, USERPROFILE: homeDir },
      });

      const client = sessionManager.getClient(sessionId);
      if (!client) throw new Error('Agent client was not created');

      // Send a prompt with an image attached.  This is the exact code path the
      // UI uses (trpc.session.send → client.prompt(message, images)).
      await client.prompt('What is in this image?', [TINY_PNG_DATA_URL]);

      // Poll until the mock server receives the chat/completions request.
      const deadline = Date.now() + 30_000;
      while (requestBodies.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(requestBodies.length, 'mock server should receive at least one chat/completions request').toBeGreaterThan(0);

      const userContent = extractUserContent(requestBodies[0]!);
      expect(userContent, 'user message content must be present').toBeDefined();

      // The user content must contain an image block.  For OpenAI chat/completions,
      // that is { type: "image_url", image_url: { url: "data:image/png;base64,..." } }.
      // If the image was dropped by vision-guard, content would be a plain string or
      // a single text block — this assertion would fail.
      const blocks = Array.isArray(userContent) ? userContent : [];
      const imageBlock = blocks.find(
        (b) => typeof b === 'object' && b !== null && (b as Record<string, unknown>).type === 'image_url',
      );

      expect(imageBlock, 'user content must contain an image_url block — image was dropped by vision-guard').toBeDefined();

      // The image_url.url should contain base64 image data (not a placeholder text).
      const imageUrl = (imageBlock as Record<string, unknown>).image_url as Record<string, unknown> | undefined;
      expect(imageUrl?.url, 'image_url.url must be present').toBeDefined();
      expect(typeof imageUrl?.url, 'image_url.url must be a string').toBe('string');
      expect(
        (imageUrl!.url as string).startsWith('data:image/'),
        'image_url.url must be a data URL — got placeholder instead',
      ).toBe(true);
    },
    60_000,
  );

  it(
    'does NOT replace images with the "[image omitted]" placeholder text',
    async () => {
      const requestBodies: Array<Record<string, unknown>> = [];

      server = createServer((request, response) => {
        const path = request.url ?? '';

        if (request.method === 'GET' && path === '/v1/models') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ data: [{ id: 'vision-model' }] }));
          return;
        }

        if (request.method === 'POST' && path === '/v1/chat/completions') {
          const chunks: Buffer[] = [];
          request.on('data', (chunk: Buffer) => chunks.push(chunk));
          request.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
            requestBodies.push(body);
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.end([
              `data: ${JSON.stringify({
                id: 'chatcmpl-img2',
                object: 'chat.completion.chunk',
                created: 0,
                model: 'vision-model',
                choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
              })}`,
              `data: ${JSON.stringify({
                id: 'chatcmpl-img2',
                object: 'chat.completion.chunk',
                created: 0,
                model: 'vision-model',
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

      homeDir = await mkdtemp(join(tmpdir(), 'socverify-agent-img2-'));
      sessionId = await sessionManager.createSession({
        projectId: 'project_img_test2',
        cwd: process.cwd(),
        provider: 'agnes',
        apiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        enableMCP: false,
        env: { HOME: homeDir, USERPROFILE: homeDir },
      });

      const client = sessionManager.getClient(sessionId);
      if (!client) throw new Error('Agent client was not created');

      await client.prompt('Describe this', [TINY_PNG_DATA_URL]);

      const deadline = Date.now() + 30_000;
      while (requestBodies.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(requestBodies.length).toBeGreaterThan(0);

      // Stringify the entire request body and check that the placeholder text
      // does NOT appear anywhere.  This catches the case where vision-guard
      // replaced the image with "[image omitted: model does not support vision]".
      const bodyJson = JSON.stringify(requestBodies[0]!);
      expect(
        bodyJson,
        'request body must not contain the vision-guard placeholder',
      ).not.toContain('[image omitted');
      expect(
        bodyJson,
        'request body must not contain the no-vision-model note',
      ).not.toContain('No vision-capable model');
    },
    60_000,
  );
});
