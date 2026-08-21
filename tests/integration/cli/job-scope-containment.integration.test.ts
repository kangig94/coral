import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { createCoordinatorControl } from '#src/coordinator/composition/job-control.js';
import type { CoordinatorWorld } from '#src/coordinator/composition/world.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { JobStore } from '#src/jobs/store.js';
import { canonicalizeWorkDir, type CanonicalWorkDir } from '#src/runtime/canonical-work-dir.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { executeCatalogRequest, type CatalogRequestExecution } from '#src/transport/dispatch.js';
import { rpcCatalog, type RpcMethodSpec } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { seedTestJobSession } from '#tests/helpers/session.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

type JobCommand = 'jobs.abort' | 'jobs.detail' | 'jobs.wait';

const tempRoots: string[] = [];

function commandSpec(name: JobCommand): RpcMethodSpec<unknown, unknown> {
  const spec = rpcCatalog.find((candidate) => candidate.name === name);
  if (spec === undefined) throw new Error(`Missing RPC method ${name}.`);
  return spec;
}

function commandRequest(name: JobCommand, jobId: string, callerRoot: string): unknown {
  switch (name) {
    case 'jobs.abort':
      return { jobs: [jobId], projectRoot: callerRoot };
    case 'jobs.detail':
      return { jobId, projectRoot: callerRoot };
    case 'jobs.wait':
      return { jobIds: [jobId], projectRoot: callerRoot, timeoutSeconds: 1 };
  }
}

function launchProviderJob(
  store: JobStore,
  jobId: string,
  projectRoot: CanonicalWorkDir,
  workDir: CanonicalWorkDir,
): void {
  const sessionId = `${jobId}-session`;
  seedTestJobSession(store, {
    jobId,
    sessionId,
    provider: 'codex',
    projectRoot,
    backendNamespace: 'scope-integration',
  });
  store.appendLaunchRequested(jobId, {
    jobId,
    owner: { kind: 'provider-session', id: sessionId },
    sessionId,
    provider: 'codex',
    providerAction: 'exec',
    projectRoot,
    backendNamespace: 'scope-integration',
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: 1,
    request: {
      prompt: 'launched with --work-dir',
      cwd: workDir,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: '2026-08-21T00:00:00.000Z',
  });
}

function launchKbJob(store: JobStore, jobId: string, projectRoot: CanonicalWorkDir): void {
  store.appendLaunchRequested(jobId, {
    jobId,
    owner: { kind: 'system-task', id: `kb.reindex:${jobId}` },
    sessionId: null,
    provider: null,
    projectRoot,
    backendNamespace: 'scope-integration',
    jobKind: 'kb',
    operation: 'kb.reindex',
    pool: 'default',
    enqueueSequence: 2,
    request: {},
    createdAt: '2026-08-21T00:00:01.000Z',
  });
}

function createHarness(): {
  store: JobStore;
  ports: HttpHandlerPorts;
  close: () => void;
} {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const runtime = new SimulationRuntime();
  const store = new JobStore('scope-integration', runtime, createEventBodyCodec(), {
    db,
    reducers: composeReducers(jobsRegistry, sessionsRegistry),
    providers: permissiveProviderLookupPort,
  });
  const control = createCoordinatorControl({
    world: { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld,
    listExecutionServices: () =>
      [
        {
          abort: (jobIds: string[]) => ({ aborted: jobIds, notFound: [] }),
        },
      ] as never,
    getLifecycleController: () => null,
    getProgressStore: () => store,
    internalJobAbortRegistry: new AbortRegistry(runtime.ids),
  });
  const ports = {
    identity: { pluginRoot: '/plugin' },
    coralEnvSnapshot: {},
    admin: { isLaunchFenceActive: () => false },
    jobs: {
      scopeCheck: control.scopeCheckJobs,
      abort: control.abortJobs,
      list: () => [],
      detail: (jobId: string) => store.loadJobProjectionDetail(jobId),
      waitStream: async function* () {},
    },
  } as unknown as HttpHandlerPorts;
  return { store, ports, close: () => db.close() };
}

async function invoke(
  ports: HttpHandlerPorts,
  name: JobCommand,
  jobId: string,
  callerRoot: CanonicalWorkDir,
): Promise<CatalogRequestExecution> {
  const spec = commandSpec(name);
  const request = spec.requestSchema.parse(commandRequest(name, jobId, callerRoot));
  return executeCatalogRequest(spec, request, ports, testProjectPrincipal(callerRoot));
}

function expectAccepted(result: CatalogRequestExecution, command: JobCommand): void {
  if (command === 'jobs.wait') {
    expect(result.kind).toBe('subscription');
    return;
  }
  expect(result).toMatchObject({ kind: 'unary' });
  expect(result.kind === 'unary' ? result.statusCode : undefined).toBeUndefined();
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CLI job scope containment after an explicit --work-dir launch', () => {
  it('accepts equal and ancestor callers, while refusing descendant and sibling callers', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'coral-job-scope-'));
    tempRoots.push(fixtureRoot);
    const projectRoot = join(fixtureRoot, 'repo');
    const workDir = join(projectRoot, 'sub');
    const descendant = join(workDir, 'deeper');
    const sibling = join(fixtureRoot, 'sibling');
    mkdirSync(descendant, { recursive: true });
    mkdirSync(sibling);
    const canonicalProjectRoot = canonicalizeWorkDir(projectRoot, fixtureRoot);
    const canonicalWorkDir = canonicalizeWorkDir(workDir, projectRoot);
    const canonicalDescendant = canonicalizeWorkDir(descendant, workDir);
    const canonicalSibling = canonicalizeWorkDir(sibling, fixtureRoot);
    const harness = createHarness();

    try {
      launchProviderJob(harness.store, 'job-sub', canonicalProjectRoot, canonicalWorkDir);
      launchProviderJob(harness.store, 'job-root', canonicalProjectRoot, canonicalProjectRoot);
      expect(harness.store.readStatus('job-sub')).toMatchObject({
        projectRoot: canonicalProjectRoot,
        workDir: canonicalWorkDir,
      });

      for (const command of ['jobs.wait', 'jobs.abort', 'jobs.detail'] as const) {
        expectAccepted(await invoke(harness.ports, command, 'job-sub', canonicalWorkDir), command);
        expectAccepted(await invoke(harness.ports, command, 'job-sub', canonicalProjectRoot), command);

        for (const [jobId, callerRoot] of [
          ['job-root', canonicalDescendant],
          ['job-sub', canonicalSibling],
        ] as const) {
          expect(await invoke(harness.ports, command, jobId, callerRoot)).toMatchObject({
            kind: 'unary',
            statusCode: 403,
            body: { code: 'scope_mismatch', detail: { jobs: [jobId] } },
          });
        }
      }
    } finally {
      harness.close();
    }
  });

  it('keeps KB jobs addressable from any working directory', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'coral-kb-job-scope-'));
    tempRoots.push(fixtureRoot);
    const projectRoot = join(fixtureRoot, 'repo');
    const elsewhere = join(fixtureRoot, 'elsewhere');
    mkdirSync(projectRoot);
    mkdirSync(elsewhere);
    const canonicalProjectRoot = canonicalizeWorkDir(projectRoot, fixtureRoot);
    const canonicalElsewhere = canonicalizeWorkDir(elsewhere, fixtureRoot);
    const harness = createHarness();

    try {
      launchKbJob(harness.store, 'kb-job', canonicalProjectRoot);
      expect(harness.store.readStatus('kb-job')?.workDir).toBeNull();
      for (const command of ['jobs.wait', 'jobs.abort', 'jobs.detail'] as const) {
        expectAccepted(await invoke(harness.ports, command, 'kb-job', canonicalElsewhere), command);
      }
    } finally {
      harness.close();
    }
  });
});
