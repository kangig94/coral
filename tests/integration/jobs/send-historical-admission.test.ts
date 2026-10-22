import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';

import { makeClient } from '#src/cli/dispatch.js';
import { formatJobSendResult } from '#src/cli/format/jobs.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { seedHistoricalEpoch } from '#src/jobs/historical-reader.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { IpcRpcError } from '#src/transport/ipc/client.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';

const client = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('#src/transport/ipc/ensure.js', () => ({
  issueWithSuccessorAfterLifecycleRefusal: async (
    _method: string,
    _root: unknown,
    issue: (reached: unknown) => Promise<unknown>,
  ) => issue(client),
}));

const roots: string[] = [];
const epochKey = '00000000-0000-4000-8000-000000000007:7';
const fingerprint = 'sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52';
const jobId = 'historical-job';
const ts = '2026-10-01T00:00:00.000Z';

function writeFrozenJournal(path: string, workDir: string, outcome: 'missing' | 'unreadable'): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE projection_jobs (
      job_id TEXT, execution_owner TEXT, phase TEXT, diagnostics TEXT, session_id TEXT,
      provider TEXT, project_root TEXT, backend_namespace TEXT, bundle_hash TEXT,
      job_kind TEXT, parent_workflow_job_id TEXT, workflow_slot TEXT,
      workflow_slot_generation INTEGER, replaces_workflow_job_id TEXT, created_at TEXT, last_seq INTEGER
    ); CREATE TABLE events (seq INTEGER, ts TEXT, type TEXT, stream_kind TEXT, stream_id TEXT, body BLOB);`);
    db.prepare('INSERT INTO projection_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      jobId,
      JSON.stringify({ kind: 'provider-session', id: 'old-session' }),
      outcome === 'missing' ? 'running' : 'completed',
      JSON.stringify({ progressFaults: [] }),
      'old-session',
      'claude',
      workDir,
      'old-namespace',
      null,
      'provider',
      null,
      null,
      null,
      null,
      ts,
      outcome === 'missing' ? 1 : 2,
    );
    const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)');
    insert.run(
      1,
      ts,
      'job.launch.requested',
      'job',
      jobId,
      Buffer.from(
        JSON.stringify({
          projectRoot: workDir,
          jobKind: 'provider',
          request: { cwd: workDir },
        }),
      ),
    );
    if (outcome === 'unreadable')
      insert.run(
        2,
        ts,
        'job.terminal.recorded',
        'job',
        jobId,
        Buffer.from(
          JSON.stringify({
            terminal: { content: 'unreadable result', outcome: { kind: 'future-outcome' }, durationMs: 1 },
          }),
        ),
      );
  } finally {
    db.close();
  }
}

function frozenHistoricalJob(outcome: 'missing' | 'unreadable') {
  const root = mkdtempSync(join(tmpdir(), 'coral-send-historical-'));
  roots.push(root);
  const projectRoot = canonicalizeWorkDir(root, root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const epochDir = join(root, 'db', 'epoch-7');
  mkdirSync(epochDir, { recursive: true });
  const lock = new DatabaseSync(join(epochDir, '.lock'));
  lock.exec('CREATE TABLE lock_marker (id INTEGER PRIMARY KEY)');
  lock.close();
  writeFileSync(
    join(epochDir, '.coral-lineage.v1.json'),
    JSON.stringify({
      version: 'v1',
      lineageId: epochKey.split(':')[0],
    }),
  );
  writeFrozenJournal(join(epochDir, 'store.db'), projectRoot, outcome);
  const index = new JobLocationIndex(runtime, root, undefined, currentCoralStoreFormat().fingerprint);
  const seeded = seedHistoricalEpoch(
    runtime,
    index,
    {
      storeRoot: join(root, 'db'),
      epoch: '7',
      path: join(epochDir, 'store.db'),
    },
    epochKey,
    fingerprint,
    join(root, 'results'),
    runtime.storage,
    [],
    true,
  );
  expect(seeded).toMatchObject({ kind: 'unrecoverable-retained', knownJobIds: [jobId] });
  const addressing = new JobAddressing(
    index.readOnlyView(),
    {
      epochKey: () => 'new:8',
      detail: () => null,
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'decided',
    undefined,
    () => ({ kind: 'pending' }),
  );
  return { addressing, projectRoot };
}

afterEach(() => {
  client.request.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(['missing', 'unreadable'] as const)(
  'refuses send from frozen location metadata when the historical outcome is %s',
  async (outcome) => {
    const { addressing, projectRoot } = frozenHistoricalJob(outcome);
    const kind = outcome === 'missing' ? 'outcome-unrecoverable' : 'outcome-unreadable';
    expect(addressing.detail(jobId)).toMatchObject({ kind });
    const method = rpcCatalog.find((entry) => entry.name === 'jobs.detail');
    if (method === undefined) throw new Error('Missing jobs.detail RPC');
    const ports = {
      identity: { pluginRoot: '/plugin' },
      coralEnvSnapshot: {},
      admin: { isLaunchFenceActive: () => false },
      jobs: {
        scopeCheck: (ids: string[]) => addressing.scopeCheck(ids, projectRoot, 'contains'),
        detail: (id: string) => addressing.detail(id),
      },
    } as unknown as HttpHandlerPorts;
    client.request.mockImplementation(async (name: string, params: unknown) => {
      expect(name).toBe('jobs.detail');
      const response = await executeCatalogRequest(
        method,
        method.requestSchema.parse(params),
        ports,
        testProjectPrincipal(projectRoot),
      );
      if (response.kind !== 'unary') throw new Error('Expected unary detail response');
      expect(response).toMatchObject({
        statusCode: 409,
        body: { code: outcome === 'missing' ? 'job_outcome_unrecoverable' : 'job_outcome_unreadable' },
      });
      const body = response.body as { message: string };
      throw new IpcRpcError({ code: -32000, message: body.message, data: body });
    });
    const command = new Command('coral-cli').command('jobs').command('send');
    const result = await makeClient(projectRoot, command).sendJob(jobId, 'continue');
    expect(result).toMatchObject({ state: 'refused', code: 'pre_generation_job' });
    expect(client.request).toHaveBeenCalledOnce();
    const output = formatJobSendResult(jobId, result, { inputTokens: ['continue'] });
    expect(output.exitCode).toBe(1);
    expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual([
      'command=coral-cli codex -i continue',
      'command=coral-cli claude -i continue',
    ]);
    expect(output.text).not.toContain('jobs wait');
  },
);
