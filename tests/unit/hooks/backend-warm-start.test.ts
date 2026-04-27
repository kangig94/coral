import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BACKEND_WARM_START_HOOK,
  cleanupFixtures,
  createFixture,
  runHookAsync,
  waitForFile,
} from '#tests/unit/hooks/_helpers.js';

afterEach(cleanupFixtures);

const WARM_START_TIMEOUT_MS = 15_000;

describe('backend-warm-start.mjs', () => {
  async function setupWarmStartFixture(expectedFlavor: 'prod' | 'dev', liveFlavor: 'prod' | 'dev') {
    const fixture = createFixture();
    const markerPath = join(fixture.pluginRoot, 'spawned.txt');
    const token = `${expectedFlavor}-${liveFlavor}-token`;

    mkdirSync(join(fixture.pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(fixture.pluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: 'test-hash', flavor: expectedFlavor }),
      'utf-8',
    );
    writeFileSync(
      join(fixture.pluginRoot, 'bridge', 'coral-backend.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'spawned')\n`,
      'utf-8',
    );

    const namespace = createHash('sha256').update(realpathSync(fixture.pluginRoot)).digest('hex').slice(0, 12);
    const installDir = join(fixture.root, '.claude', 'coral', 'installations', namespace);
    mkdirSync(installDir, { recursive: true });

    let shutdownCount = 0;
    const server = createServer((req, res) => {
      if (req.headers['x-coral-backend-token'] !== token) {
        res.statusCode = 401;
        res.end();
        return;
      }

      if (req.method === 'GET' && req.url === '/health') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            status: 'ok',
            version: '0.0.0',
            bundleHash: 'test-hash',
            flavor: liveFlavor,
            instanceId: `${liveFlavor}-instance`,
            namespace,
            uptimeMs: 1,
            active: 0,
            activeJobs: 0,
            inflightRequests: 0,
            queueDepth: 0,
          }),
        );
        return;
      }

      if (req.method === 'POST' && req.url === '/admin/shutdown') {
        shutdownCount += 1;
        res.statusCode = 200;
        res.end(JSON.stringify({ status: 'draining' }));
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address for backend-warm-start test');
    }

    writeFileSync(
      join(installDir, 'backend.json'),
      JSON.stringify({
        pid: process.pid,
        port: address.port,
        host: '127.0.0.1',
        token,
        version: '0.0.0',
        bundleHash: 'test-hash',
        flavor: liveFlavor,
        instanceId: `${liveFlavor}-instance`,
        namespace,
        startedAt: Date.now(),
      }),
      'utf-8',
    );

    return {
      fixture,
      markerPath,
      shutdownCount: () => shutdownCount,
      closeServer: async () =>
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    };
  }

  it('exits early without spawning when the live backend already matches the manifest flavor', async () => {
    const setup = await setupWarmStartFixture('prod', 'prod');
    try {
      const result = await runHookAsync(BACKEND_WARM_START_HOOK, {}, {
        HOME: setup.fixture.root,
        CLAUDE_PLUGIN_ROOT: setup.fixture.pluginRoot,
      });

      expect(result.status).toBe(0);
      expect(await waitForFile(setup.markerPath)).toBe(false);
      expect(setup.shutdownCount()).toBe(0);
    } finally {
      await setup.closeServer();
    }
  }, WARM_START_TIMEOUT_MS);

  it('requests shutdown and spawns a replacement when the live backend flavor differs from the manifest flavor', async () => {
    const setup = await setupWarmStartFixture('dev', 'prod');
    try {
      const result = await runHookAsync(BACKEND_WARM_START_HOOK, {}, {
        HOME: setup.fixture.root,
        CLAUDE_PLUGIN_ROOT: setup.fixture.pluginRoot,
      });

      expect(result.status).toBe(0);
      expect(await waitForFile(setup.markerPath)).toBe(true);
      expect(setup.shutdownCount()).toBe(1);
    } finally {
      await setup.closeServer();
    }
  }, WARM_START_TIMEOUT_MS);

  it('spawns a replacement when the backend pid is live but the health check fails', async () => {
    const setup = await setupWarmStartFixture('prod', 'prod');
    await setup.closeServer();

    const result = await runHookAsync(BACKEND_WARM_START_HOOK, {}, {
      HOME: setup.fixture.root,
      CLAUDE_PLUGIN_ROOT: setup.fixture.pluginRoot,
    });

    expect(result.status).toBe(0);
    expect(await waitForFile(setup.markerPath)).toBe(true);
    expect(setup.shutdownCount()).toBe(0);
  }, WARM_START_TIMEOUT_MS);
});
