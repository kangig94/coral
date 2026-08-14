import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCoordinatorServer } from '#src/coordinator/index.js';
import { ProviderOperationReconciler } from '#src/coordinator/services/provider-operation-reconciler.js';
import { ConsumerDriver } from '#src/projection-consumers/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import * as jobsStartup from '#src/jobs/startup.js';
import type { JobsStartupContext } from '#src/jobs/startup.js';
import { resultPathFor } from '#src/jobs/terminal/export.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('production JobStore composition', () => {
  it('composes workflow and canonical-cause result materializers', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-job-store-materializers-home-'));
    const pluginRoot = mkdtempSync(join(tmpdir(), 'coral-job-store-materializers-plugin-'));
    tempRoots.push(home, pluginRoot);
    mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: '0123456789abcdef', flavor: 'prod' }) + '\n',
      'utf-8',
    );
    vi.stubEnv('HOME', home);

    const runtime = createRealRuntime('prod');
    const workflowJobId = '22222222-2222-4222-8222-222222222222';
    const causeJobId = '11111111-1111-4111-8111-111111111111';
    let workflowMarkdown = '';
    let causeMarkdown = '';
    const runStartup = vi.fn(async (options: JobsStartupContext) => {
      const db = options.progressStore.getDb();
      const interruptedSessionId = 'composition-interrupted-session';
      const firstSeq =
        (db.prepare<[], { seq: number | null }>('SELECT MAX(seq) AS seq FROM events').get()?.seq ?? 0) + 1;
      const insertEvent = db.prepare(
        `INSERT INTO events (
          seq, ts, type, stream_kind, stream_id, namespace, project,
          correlation_id, causation_seq, refs, body
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`,
      );
      insertEvent.run(
        firstSeq,
        '2026-08-15T00:00:00.000Z',
        'session.interrupted',
        'session',
        interruptedSessionId,
        Buffer.from(JSON.stringify({ trigger: 'restart', continuity: 'pre_checkpoint_preserved' }), 'utf-8'),
      );
      insertEvent.run(
        firstSeq + 1,
        '2026-08-15T00:00:01.000Z',
        'job.terminal.recorded',
        'job',
        causeJobId,
        Buffer.from(
          JSON.stringify({
            terminal: {
              content: '',
              durationMs: 1,
              outcome: {
                kind: 'failed',
                causeRef: { stream: { kind: 'session', id: interruptedSessionId }, seq: firstSeq },
              },
            },
          }),
          'utf-8',
        ),
      );
      db.prepare(
        `INSERT INTO projection_jobs (
          job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
          project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
          workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
        ) VALUES (?, ?, 'completed', NULL, ?, NULL, NULL, ?, ?, NULL, 'workflow', NULL, NULL, NULL, NULL, ?, ?)`,
      ).run(
        workflowJobId,
        JSON.stringify({ kind: 'workflow', id: workflowJobId }),
        JSON.stringify({ progressFaults: [] }),
        home,
        'job-store-materializers',
        '2026-08-15T00:00:00.000Z',
        firstSeq + 3,
      );
      insertEvent.run(
        firstSeq + 2,
        '2026-08-15T00:00:02.000Z',
        'workflow.completed',
        'workflow',
        workflowJobId,
        Buffer.from(
          JSON.stringify({
            outcome: 'completed',
            stepDetails: [{ stepIndex: 0, atomIndex: 0, label: 'critic', output: 'durable composition report' }],
          }),
          'utf-8',
        ),
      );
      insertEvent.run(
        firstSeq + 3,
        '2026-08-15T00:00:03.000Z',
        'job.terminal.recorded',
        'job',
        workflowJobId,
        Buffer.from(
          JSON.stringify({ terminal: { content: 'generic output', durationMs: 1, outcome: { kind: 'completed' } } }),
          'utf-8',
        ),
      );

      causeMarkdown = runtime.storage.readFileSync(
        options.progressStore.materializeResultArtifact(causeJobId),
        'utf-8',
      );
      workflowMarkdown = runtime.storage.readFileSync(
        options.progressStore.materializeResultArtifact(workflowJobId),
        'utf-8',
      );
      db.prepare('DELETE FROM projection_jobs WHERE job_id = ?').run(workflowJobId);
      db.prepare('DELETE FROM events WHERE seq BETWEEN ? AND ?').run(firstSeq, firstSeq + 3);
      return options.progressStore;
    });
    vi.spyOn(jobsStartup, 'createJobsStartupRunner').mockReturnValue(runStartup);
    vi.spyOn(ProviderOperationReconciler.prototype, 'reconcileAtStartup').mockResolvedValue({
      setsVisited: 0,
      operationsVisited: 0,
      incidents: [],
    });
    vi.spyOn(ProviderOperationReconciler.prototype, 'start').mockImplementation(() => undefined);
    vi.spyOn(ConsumerDriver.prototype, 'waitFreshUntil').mockResolvedValue();
    const coordinator = createCoordinatorServer({
      runtime,
      pluginRoot,
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
      recoverPersistedDiscussFn: async () => [],
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
      closeServerFn: async () => {},
    });

    try {
      await coordinator.start();
      expect(causeMarkdown).toContain(
        'App-server restarted during the turn; existing conversation reference was preserved.',
      );
      expect(workflowMarkdown).toBe('# Step 0.0: critic\n\ndurable composition report\n');
      expect(runtime.storage.existsSync(resultPathFor(runtime.paths.coral.exports.jobsRoot, workflowJobId))).toBe(true);
    } finally {
      await coordinator.shutdown('test-cleanup');
      await coordinator.waitForShutdown();
    }
  });
});
