import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createRealRuntime } from '../../runtime/real.js';
import { appendEvents } from '../../store/append.js';
import { openStoreDatabase } from '../../store/db.js';
import { createEmptyRegistry } from '../../store/envelope.js';
import { loadJobProjectionDetail } from '../../store/queries/jobs.js';
import { composeReducers } from '../../store/reducers.js';
import { storePaths } from '../../store/paths.js';
import { jobsRegistry } from '../../jobs/events.js';
import { createCoordinatorServer } from '../coordinator.js';

const tempRoots: string[] = [];
let previousHome: string | undefined;

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  previousHome = undefined;

  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('coordinator startup ordering', () => {
  it('replays preboot journal events into job projections before startup completes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-startup-ordering-home-'));
    const pluginRoot = mkdtempSync(join(tmpdir(), 'coral-startup-ordering-plugin-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'coral-startup-ordering-project-'));
    tempRoots.push(home, pluginRoot, projectRoot);

    mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: 'startup-ordering-bundle', flavor: 'prod' }) + '\n',
      'utf-8',
    );

    previousHome = process.env.HOME;
    process.env.HOME = home;

    const runtime = createRealRuntime();
    const namespace = runtime.paths.pluginRootNamespace(pluginRoot);
    const db = openStoreDatabase({
      path: storePaths('prod', { baseDir: join(home, '.coral') }).dbFile,
      storage: runtime.storage,
    });

    try {
      const jobId = 'startup-ordering-job';
      const sessionId = 'startup-ordering-session';
      appendEvents(
        db,
        [
          {
            type: 'job.launch.requested',
            stream: { kind: 'job', id: jobId },
            namespace,
            project: projectRoot,
            correlationId: 'startup-ordering-correlation',
            refs: { sessionId },
            bodyVersion: 1,
            body: {
              sessionId,
              provider: 'fake-provider',
              providerAction: 'exec',
              projectRoot,
              backendNamespace: namespace,
              bundleHash: 'startup-ordering-bundle',
              pool: 'default',
              enqueueSequence: 0,
              request: {
                prompt: 'hello',
                cwd: projectRoot,
                bypassPermissions: false,
                coralEnv: {},
              },
              createdAt: '2026-04-19T00:00:00.000Z',
            },
          },
        ],
        {
          now: () => new Date('2026-04-19T00:00:00.000Z'),
          reducers: composeReducers(jobsRegistry),
          upcasters: createEmptyRegistry(),
        },
      );

      db.prepare('DELETE FROM projection_jobs WHERE job_id = ?').run(jobId);

      const coordinator = createCoordinatorServer({
        runtime,
        pluginRoot,
        registerBuiltInProvidersFn: () => {},
      });

      try {
        await coordinator.start();
        const detail = loadJobProjectionDetail(db, jobId);
        expect(detail.launch).toMatchObject({
          jobId,
          sessionId,
          projectRoot,
          backendNamespace: namespace,
        });
        expect(detail.status).toMatchObject({
          jobId,
          sessionId,
          phase: 'error',
          result: { outcome: { kind: 'job_fault', fault: { kind: 'ghost_launch' } } },
        });
        expect(
          (db.prepare('SELECT cursor FROM equipment_cursors WHERE consumer_id = ?').get('jobs') as { cursor: number }).cursor,
        ).toBeGreaterThan(0);
      } finally {
        await coordinator.shutdown('test-cleanup');
        await coordinator.waitForShutdown();
      }
    } finally {
      db.close();
    }
  });
});
