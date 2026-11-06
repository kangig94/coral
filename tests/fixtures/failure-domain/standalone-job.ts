import { readDurableCliExecution } from '#src/jobs/durable-cli-execution.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { appendProviderTerminalInCommit } from '#src/coordinator/services/terminal-materializer.js';
import { ConversationManager } from '#src/jobs/conversation/shell.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { ExecutionFinisher, readExecutionFinishingState } from '#src/jobs/finishing.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
import { JobStore } from '#src/jobs/store.js';
import type { BoundProvider, BoundProviderStandaloneExecutionRuntime } from '#src/providers/bound-provider-contract.js';
import type { ProviderCliRequest } from '#src/providers/protocol.js';
import type { Runtime } from '#src/runtime/ports.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

export async function launchStandaloneJob(
  runtime: Runtime,
  workDir: string,
): Promise<{
  jobId: string;
  execution: number;
  pid: number;
  cli: number;
}> {
  const db = newRawDatabase(join(workDir, 'job-store.sqlite'));
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const store = new JobStore('failure-domain-test', runtime, createEventBodyCodec(), {
    db,
    providers: permissiveProviderLookupPort,
    reducers: composeReducers(jobsRegistry),
  });
  const sessions = new ConversationManager(workDir, runtime, (cb) => store.commit(cb), db);
  const jobId = randomUUID();
  const cwd = fixtureCanonicalWorkDir(workDir);
  const session = sessions.prepare({
    jobId,
    binding: TEST_CODEX_BINDING,
    name: 'failure-domain-test',
    cwd,
    projectRoot: workDir,
    backendNamespace: 'failure-domain-test',
  });
  const admission = new LaunchCoordinator({ runtime });
  const epoch = join(runtime.paths.coral.store.dbDir, 'epoch-1');
  runtime.storage.mkdirSync(epoch, { recursive: true });
  admission.bindActiveEpochPath(epoch);
  const finisher = new ExecutionFinisher({
    time: runtime.time,
    commit: (cb) => store.commit(cb),
    read: (address) => readExecutionFinishingState(db, address, store),
    quiesce: async () => true,
    retentionAction: async () => ({ attempt: 0, handles: [] }),
    settleRetention: async () => ({ kind: 'completed', outcome: 'skipped_no_handles' }),
  });
  const runningFile = join(workDir, 'standalone-cli.pid');
  let firstExecution = true;
  const provider = {
    name: 'codex',
    envelope: TEST_CODEX_BINDING,
    artifacts: { kind: 'none', reason: 'fixture' },
    compareIdentity: () => ({ ok: true }),
    decodeContinuity: () => ({ ok: true, value: undefined }),
    readiness: async () => ({ ok: true }),
    prepareExecution: () => ({
      kind: 'standalone',
      prepareCliRequest: (request: ProviderCliRequest) => request,
      execute: async function* (executionRuntime: BoundProviderStandaloneExecutionRuntime) {
        if (firstExecution) {
          firstExecution = false;
          await executionRuntime.runCli({ command: process.execPath, args: ['-e', 'process.exit(0)'] });
          yield {
            kind: 'terminal',
            terminal: { content: 'first execution complete', outcome: { kind: 'completed' }, durationMs: 0 },
            diagnostics: {},
          };
          return;
        }
        await executionRuntime.runCli({
          command: process.execPath,
          args: [
            '-e',
            'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)',
            runningFile,
          ],
        });
      },
    }),
  } as unknown as BoundProvider;
  const orchestrator = new LaunchOrchestrator({
    executionFinisher: finisher,
    runtime,
    progressStore: store,
    conversationManager: sessions,
    abortRegistry: new AbortRegistry(),
    launchAdmission: admission,
    providerOperationBinding: admission,
    durableSpawner: admission,
    providerRegistry: {} as never,
    backendNamespace: 'failure-domain-test',
    bundleHash: 'test',
    coordinatorCommit: (cb) => store.commit(cb),
    settlementRefusalRecorder: { record: () => true },
    terminalMaterializer: { appendProviderTerminalInCommit },
  });
  await orchestrator.launchExecution(
    provider,
    session,
    { action: 'exec', jobId, prompt: 'hold', cwd, coralEnv: {}, bypassPermissions: false },
    {
      owner: { kind: 'provider-session', id: jobId },
      mintProtectedEnv: () => ({ env: {}, childAuthorization: {} as never }),
    },
  );
  while (store.readStatus(jobId)?.phase !== 'completed') {
    const status = store.readStatus(jobId);
    if (status?.phase === 'error') throw new Error(`Initial standalone execution failed: ${JSON.stringify(status)}`);
    await sleep(10);
  }
  const continued = sessions.readById(jobId);
  if (continued === null) throw new Error('Completed standalone conversation disappeared');
  await orchestrator.launchExecution(
    provider,
    continued,
    { action: 'resume', jobId, prompt: 'hold', cwd, coralEnv: {}, bypassPermissions: false },
    {
      owner: { kind: 'provider-session', id: jobId },
      originatingClientMessageId: randomUUID(),
      mintProtectedEnv: () => ({ env: {}, childAuthorization: {} as never }),
    },
  );
  while (!existsSync(runningFile)) {
    const status = store.readStatus(jobId);
    if (status?.phase === 'error') throw new Error(`Standalone launch failed: ${JSON.stringify(status)}`);
    await sleep(10);
  }
  const cli = Number(readFileSync(runningFile, 'utf8'));
  const stat = readFileSync(`/proc/${cli}/stat`, 'utf8');
  const pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  const execution = store.readStatus(jobId)?.execution;
  if (typeof execution !== 'number') throw new Error('Standalone launch has no execution ordinal');
  const incarnation = runtime.process.readProcessIncarnation(pid, 'linux');
  if (incarnation === null || readDurableCliExecution(db, jobId, { pid, incarnation }) !== execution)
    throw new Error('Payload entered without its durable execution association');
  return { jobId, execution, pid, cli };
}
