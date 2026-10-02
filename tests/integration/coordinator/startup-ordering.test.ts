import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import * as jobsStartup from '#src/jobs/startup.js';
import type { JobsStartupContext } from '#src/jobs/startup.js';
import { createCoordinatorServer } from '#src/coordinator/index.js';
import { workflowRecover } from '#src/workflow/recover.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { sessionContinuationLeaseRecordedEvent } from '#src/sessions/continuation-lease-events.js';
import { providerSessionSchema } from '#src/sessions/entry.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();

  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('coordinator pending workflow replacement recovery', () => {
  it('passes a journal-written pending replacement lease to workflow recovery', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-startup-replacement-home-'));
    const pluginRoot = mkdtempSync(join(tmpdir(), 'coral-startup-replacement-plugin-'));
    tempRoots.push(home, pluginRoot);
    mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: '0123456789abcdef', flavor: 'prod' }) + '\n',
      'utf-8',
    );
    vi.stubEnv('HOME', home);

    const runtime = createRealRuntime('prod');
    const runStartup = vi.fn(async (options: JobsStartupContext) => {
      const opened = providerSessionSchema.parse({
        sessionId: 'pending-replacement-session',
        binding: TEST_CODEX_BINDING,
        name: 'pending-replacement-session',
        state: 'pending',
        retention: 'retain',
        artifactHandles: [],
        retentionDiscard: { attempts: [] },
        cwd: home,
        projectRoot: home,
        backendNamespace: 'startup-ordering',
        providerContinuity: null,
        createdAt: '2026-07-22T00:00:00.000Z',
        lastUsedAt: '2026-07-22T00:00:00.000Z',
        version: 1,
      });
      options.coordinatorCommit((c) => {
        c.append({
          type: 'session.opened',
          stream: { kind: 'session', id: opened.sessionId },
          refs: { sessionId: opened.sessionId },
          body: { entry: opened, controller: 'default', scope_key: 'startup-ordering' },
        });
        return undefined;
      });
      const lease = {
        status: 'pending' as const,
        staleJobId: 'workflow-pending:0:0',
        workflowId: 'workflow-pending',
        workflowSlotId: 'workflow-pending:0:0',
        replacementGeneration: 1,
        reason: 'stale_recovery' as const,
        expiresAt: new Date(runtime.time.now() + 60_000).toISOString(),
        recordedAt: new Date(runtime.time.now()).toISOString(),
      };
      const pending = providerSessionSchema.parse({
        ...opened,
        continuationLease: lease,
        lastUsedAt: lease.recordedAt,
        version: 2,
      });
      options.coordinatorCommit((c) => {
        c.append(sessionContinuationLeaseRecordedEvent(pending, lease));
        return undefined;
      });
      return { kind: 'complete', progressStore: options.progressStore } as const;
    });
    vi.spyOn(jobsStartup, 'createJobsStartupRunner').mockReturnValue(runStartup);
    const resumeAll = vi.spyOn(workflowRecover, 'resumeAll').mockImplementation(async (options) => {
      const row = options.db
        .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
        .get('pending-replacement-session');
      const entry = providerSessionSchema.parse(JSON.parse(row?.entry ?? 'null'));
      expect(entry.continuationLease).toMatchObject({
        status: 'pending',
        workflowId: 'workflow-pending',
        replacementGeneration: 1,
      });
      return [];
    });
    const kbDaemonSupervisor = createMockKbDaemonSupervisor();
    const coordinator = createCoordinatorServer({
      onFatalShutdownError: vi.fn(),
      runtime,
      pluginRoot,
      kbDaemonSupervisor,
      recoverPersistedDiscussFn: async () => [],
      writeBackendInfoFn: () => true,
      removeBackendInfoIfOwnerFn: () => {},
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
      closeServerFn: async () => {},
    });

    try {
      await coordinator.start();
      expect(resumeAll).toHaveBeenCalledOnce();
    } finally {
      resumeAll.mockRestore();
      await coordinator.shutdown('test-teardown');
      await coordinator.waitForShutdown();
    }
  });
});
