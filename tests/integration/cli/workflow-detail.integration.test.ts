import { Command } from 'commander';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, it, vi } from 'vitest';
import { registerSessionCommands } from '#src/cli/commands/session.js';
import { CHILD_PRINCIPAL_CAPABILITIES } from '#src/coordinator/child-principal-registry.js';
import { createCoordinatorRpcPorts } from '#src/coordinator/composition/rpc-ports.js';
import { JobAttention } from '#src/coordinator/services/job-attention.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { readProjectionJobAddress } from '#src/jobs/projection-row.js';
import { createBuiltInProviderRegistry } from '#src/providers/bootstrap.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';
import { attenuate } from '#src/security/attenuate.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import type * as IpcEnsure from '#src/transport/ipc/ensure.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { EXECUTION_JOB_ID, openedJob, requestedExecution } from '#tests/helpers/job-executions.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';

const client = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('#src/transport/ipc/ensure.js', async (importOriginal) => ({
  ...(await importOriginal<typeof IpcEnsure>()),
  issueWithSuccessorAfterLifecycleRefusal: async (
    _method: string,
    _root: unknown,
    issue: (reached: unknown) => Promise<unknown>,
  ) => issue(client),
}));

it('prints bound workflow detail and its children after the worktree is removed', async () => {
  const f = createTerminalExportFixture('workflow');
  try {
    const workDir = canonicalizeWorkDir(f.root, f.root);
    const callerRoot = dirname(workDir);
    const childId = EXECUTION_JOB_ID;
    const child = openedJob({
      projectRoot: workDir,
      owner: { kind: 'workflow', id: f.jobId },
      workflowSlotId: `${f.jobId}:0:0`,
    });
    if (child.body.jobKind !== 'provider') throw new Error('Expected a provider child');
    child.body.conversation.cwd = workDir;
    f.store.withExecutionAdmission(childId, 1, { projectRoot: workDir, workDir, jobKind: 'provider' }, () =>
      f.store.commit((commit) => {
        commit.append(child);
        commit.append(requestedExecution());
        return undefined;
      }),
    );
    const outcome = { content: 'finished', outcome: { kind: 'completed' }, durationMs: 0 } as const;
    commitJobTerminal(f.store, childId, 1, outcome);
    f.complete();
    rmSync(f.root, { recursive: true });

    const addressing = new JobAddressing(
      f.index.readOnlyView(),
      {
        epochKey: () => f.epochKey,
        detail: (id) => f.store.loadJobDetailResponse(id),
        address: (id) => readProjectionJobAddress(f.db, id),
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'decided',
      undefined,
      () => ({ kind: 'retained-away', retentionDays: 14 }),
    );
    const ports = createCoordinatorRpcPorts({
      jobAddressing: addressing,
      services: { jobAttention: new JobAttention() },
      getProgressStore: () => f.store,
      time: f.runtime.time,
    } as unknown as Parameters<typeof createCoordinatorRpcPorts>[0]) as unknown as HttpHandlerPorts;
    const principal = attenuate(testProjectPrincipal(callerRoot), CHILD_PRINCIPAL_CAPABILITIES);
    client.request.mockImplementation(async (method: string, params: unknown) => {
      const spec = rpcCatalog.find((entry) => entry.name === method)!;
      const response = await executeCatalogRequest(spec, spec.requestSchema.parse(params), ports, principal);
      if (response.kind !== 'unary' || (response.statusCode ?? 200) !== 200) {
        throw new Error(JSON.stringify(response));
      }
      return response.body;
    });

    vi.stubEnv('CORAL_CHILD_PRINCIPAL_HANDLE', 'bound-session');
    vi.stubEnv('CORAL_JOB_ID', 'calling-job');
    vi.spyOn(process, 'cwd').mockReturnValue(callerRoot);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const program = new Command().name('coral-cli').exitOverride();
    registerSessionCommands(program, createBuiltInProviderRegistry());

    await program.parseAsync(['jobs', 'detail', f.jobId], { from: 'user' });

    expect(process.exitCode).toBeUndefined();
    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain(`Job ${f.jobId}`);
    expect(output).toContain('Phase: completed');
    expect(output).toContain(childId);
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(['jobs.detail']);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    f.close();
  }
});
