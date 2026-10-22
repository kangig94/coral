import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExecutionFinisher, readExecutionFinishingState } from '#src/jobs/finishing.js';
import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { JobStore } from '#src/jobs/store.js';
import { ConversationManager } from '#src/jobs/conversation/shell.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { createLifecycleReactor } from '#src/jobs/conversation/lifecycle-reactor.js';
import { readProjectionJobConversation } from '#src/jobs/conversation/projections.js';
import { conversationArchiveDirectory, publishConversationRestore, restoreStagePath, verifyConversationRestore } from '#src/jobs/conversation/provider-artifact-archive.js';
import { appendJobExecutionOutcomeAccepted } from '#src/jobs/terminal/recording.js';
import { providerArtifactIdentityKey } from '#src/providers/artifact-identity.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { pruneJobExports } from '#src/jobs/export-retention.js';
import { withJobArtifactGuard } from '#src/jobs/conversation/artifact-guard.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import type { ProviderBindingCatalog } from '#src/providers/catalog.js';
import { discardRecordedArtifacts, managed } from '#src/providers/capability.js';
import type { ProviderAccess } from '#src/providers/contract.js';
import { EXECUTION_JOB_ID as jobId, executionHarness, executionInput as input, openedJob, requestedExecution } from '#tests/helpers/job-executions.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';

const native = '/home/user/.codex/sessions/2026/10/22/rollout-thread.jsonl';
const content = Buffer.from([0xff, 0x00, 0xc0, 0x80, 0x0a]);
const journals: ReturnType<typeof executionHarness>[] = [];
afterEach(() => { for (const h of journals.splice(0)) h.db.close(); vi.restoreAllMocks(); });
function fixture(options: { recorded?: boolean; native?: boolean; workflow?: boolean } = {}) {
  const h = executionHarness(); journals.push(h);
  const runtime = new SimulationRuntime();
  runtime.storage.mkdirSync(dirname(native), { recursive: true });
  if (options.native !== false) runtime.storage.writeFileSync(native, content);
  vi.spyOn(runtime.time, 'sleep').mockImplementation(async ms => { runtime.time.tick(ms); });
  const opened = openedJob();
  if (opened.body.jobKind !== 'provider') throw new Error('provider fixture');
  opened.body.conversation.retention = 'discard_provider_artifacts_on_terminal';
  opened.body.conversation.binding = TEST_CODEX_BINDING;
  if (options.workflow) { opened.body.owner = { kind: 'workflow', id: 'workflow-owner' }; opened.body.workflowSlotId = 'slot'; }
  h.append(opened, requestedExecution());
  h.append(input('job.continuity.checkpointed', { execution: 1,
    snapshot: { conversationRef: 'thread', resumable: true, providerContinuity: null } }));
  const artifact = (execution = 1) => {
    const identity = { kind: 'native', threadId: 'thread' };
    h.append(input('job.artifact.recorded', { execution, provider: 'codex', handle: native, identity,
      identityKey: providerArtifactIdentityKey('codex', identity) }));
  };
  if (options.recorded !== false) artifact();
  const issuer = vi.fn(async ({ handles, runtime: cleanup }: Parameters<ReturnType<typeof managed>['discardArtifacts']>[0]) =>
    discardRecordedArtifacts(handles, cleanup));
  const capability = managed({ discardArtifacts: issuer });
  const artifacts: Extract<BoundProvider['artifacts'], { kind: 'managed' }> = {
    kind: 'managed', protocol: capability.protocol,
    locateArtifact: () => native,
    discardArtifacts: opts => capability.discardArtifacts({ ...opts, access: {} as ProviderAccess }),
    reconcileDiscard: opts => capability.reconcileDiscard({ ...opts, access: {} as ProviderAccess }),
    discardResidue: vi.fn(async () => ({ discarded: [], retained: [] })),
  };
  const bound = { name: 'codex', envelope: TEST_CODEX_BINDING, artifacts,
    readiness: async () => ({ ok: true, value: { ready: true, use: 'recovery' } }) } as unknown as BoundProvider;
  const providers = { rehydrateBinding: () => ({ ok: true, value: bound }) } as unknown as ProviderBindingCatalog;
  const reactorOptions = { db: () => h.db, readCtx: h.readCtx, providers, runtime, time: runtime.time,
    commitEvents: h.commit, signal: new AbortController().signal };
  let reactor = createLifecycleReactor(reactorOptions);
  const finisher = () => new ExecutionFinisher({ time: runtime.time, commit: h.commit,
    read: address => readExecutionFinishingState(h.db, address, h.readCtx), quiesce: async () => true,
    retentionAction: address => reactor.retentionAction(address), settleRetention: (address, action) => reactor.settleRetention(address, action) });
  const accept = (execution = 1) => h.commit(c => {
    appendJobExecutionOutcomeAccepted(c, { jobId, execution, terminal: { content: `result-${execution}`,
      durationMs: 0, outcome: { kind: 'completed' } } }); return undefined;
  });
  const finish = async (execution = 1) => { accept(execution); await finisher().finish({ jobId, execution }); };
  const manifestPath = join(conversationArchiveDirectory(runtime, jobId), 'manifest.json');
  const manifest = () => JSON.parse(runtime.storage.readFileSync(manifestPath, 'utf-8')) as {
    execution: number; artifacts: { archivePath: string }[];
  };
  return { h, runtime, bound, artifacts, providers, issuer, artifact, accept, finish, finisher, manifestPath, manifest,
    reactor: () => reactor, restart: () => { reactor = createLifecycleReactor(reactorOptions); return reactor; } };
}

function launcher(f: ReturnType<typeof fixture>) {
  const store = new JobStore('tests', f.runtime, f.h.ctx.bodyCodec, { db: f.h.db,
    providers: f.h.ctx.providers, reducers: f.h.ctx.reducers, eventBus: new TypedEventBus() });
  const conversations = new ConversationManager('/workspace', f.runtime, f.h.commit, f.h.db);
  const admission = new LaunchCoordinator({ runtime: f.runtime });
  const finisher = new ExecutionFinisher({ time: f.runtime.time, commit: f.h.commit,
    read: address => readExecutionFinishingState(f.h.db, address, f.h.readCtx),
    quiesce: async () => admission.reservationFor(jobId) === null,
    retentionAction: address => f.reactor().retentionAction(address),
    settleRetention: (address, action) => f.reactor().settleRetention(address, action) });
  const execute = vi.fn(() => { throw new Error('provider must not activate'); });
  Object.assign(f.bound, { compareIdentity: () => ({ ok: true, value: true }), prepareExecution: execute });
  const orchestrator = new LaunchOrchestrator({ runtime: f.runtime, progressStore: store, conversationManager: conversations,
    launchAdmission: admission, abortRegistry: new AbortRegistry(), executionFinisher: finisher,
    providerOperationBinding: admission, durableSpawner: admission, providerRegistry: f.providers,
    backendNamespace: 'tests', bundleHash: 'tests', coordinatorCommit: f.h.commit,
    settlementRefusalRecorder: { record: () => true }, terminalMaterializer: { recordProviderTerminal: vi.fn() } });
  const launch = (mintProtectedEnv = () => ({})) => orchestrator.launchExecution(f.bound, conversations.readById(jobId)!,
    { jobId, action: 'resume', conversationRef: 'thread', prompt: 'next', cwd: '/workspace', coralEnv: {}, bypassPermissions: false },
    { owner: { kind: 'workflow', id: 'workflow-owner' }, parentWorkflowJobId: 'workflow-owner', workflowSlotId: 'slot', mintProtectedEnv });
  return { launch, finisher, execute, admission };
}
function assertEnd(f: ReturnType<typeof fixture>, execution = 1, result = 'completed') {
  const events = f.h.events().filter(event => (event.body as { execution?: number }).execution === execution);
  expect(events.filter(event => event.type === 'job.execution.outcome.accepted')).toHaveLength(1);
  expect(events.filter(event => event.type === 'job.execution.ended')).toHaveLength(1);
  expect(events.at(-2)?.type).toBe(`job.retention.discard.${result}`);
  expect(events.at(-1)?.type).toBe('job.execution.ended');
  return events;
}

describe('conversation retention belongs to every committed execution', () => {
  it.each(['recorded', 'pre-existing'])('archives and discards %s native bytes before the sole end', async source => {
    const f = fixture({ recorded: source === 'recorded' });
    await f.finish(); assertEnd(f);
    const archive = f.manifest();
    expect(f.runtime.storage.readFileBytesSync(join(conversationArchiveDirectory(f.runtime, jobId), archive.artifacts[0].archivePath))).toEqual(content);
    expect(f.runtime.storage.existsSync(native)).toBe(false);
    expect(f.artifacts.discardResidue).toHaveBeenCalledTimes(1);
  });

  it('replaces #1 with #2 independently of the earlier outcome, including restored bytes that never activated', async () => {
    const f = fixture(); await f.finish(); assertEnd(f);
    const conversation = readProjectionJobConversation(f.h.db, jobId)!;
    const verification = await verifyConversationRestore({ runtime: f.runtime, conversation, nativeHandle: native, minimumExecution: 1 });
    f.h.append(requestedExecution(2));
    expect(await publishConversationRestore({ runtime: f.runtime, jobId, execution: 2, verification })).toMatchObject({ kind: 'restored' });
    expect(f.h.events().some(event => event.type === 'job.execution.started' && (event.body as { execution: number }).execution === 2)).toBe(false);
    await f.finish(2); assertEnd(f, 2);
    expect(f.manifest().execution).toBe(2);
    expect(f.issuer).toHaveBeenCalledTimes(2);
    expect(f.runtime.storage.existsSync(native)).toBe(false);
  });

  it('still retains #2 after #1 retention failed', async () => {
    const f = fixture();
    const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockReturnValue(false);
    await f.finish(); assertEnd(f, 1, 'failed');
    write.mockRestore();
    f.h.append(requestedExecution(2));
    f.runtime.storage.writeFileSync(native, 'second execution');
    await f.finish(2); assertEnd(f, 2);
    expect(f.manifest().execution).toBe(2);
    expect(f.runtime.storage.existsSync(native)).toBe(false);
  });

  it('commits #2, restores, rejects activation and retains the restored execution before its sole end', async () => {
    const f = fixture({ workflow: true }); await f.finish();
    const l = launcher(f);
    await expect(l.launch(() => {
      expect(f.runtime.storage.readFileBytesSync(native)).toEqual(content);
      const events = f.h.events().filter(event => (event.body as { execution?: number }).execution === 2);
      expect(events.map(event => event.type)).toEqual(['job.execution.requested', 'job.execution.admitted']);
      throw new Error('activation refused');
    })).rejects.toThrow('activation refused');
    await l.finisher.finish({ jobId, execution: 2 });
    assertEnd(f, 2);
    expect(f.manifest().execution).toBe(2);
    expect(f.runtime.storage.existsSync(native)).toBe(false);
    expect(f.issuer).toHaveBeenCalledTimes(2);
    expect(l.execute).not.toHaveBeenCalled();
    const count = f.h.events().length;
    await l.finisher.finish({ jobId, execution: 2 });
    expect(f.h.events()).toHaveLength(count);
    expect(f.issuer).toHaveBeenCalledTimes(2);
  });

  it('routes post-commit restore failure through committed setup failure without activating the provider', async () => {
    const f = fixture({ workflow: true }); await f.finish();
    const l = launcher(f);
    vi.spyOn(f.runtime.storage, 'publishFileNoReplaceSync').mockImplementation(() => {
      expect(f.h.events().filter(event => event.type === 'job.execution.requested')).toHaveLength(2);
      return { kind: 'failed', reason: 'unsupported link publication', linked: false };
    });
    expect(await l.launch()).toMatchObject({ status: 'refused', code: 'publication_failed' });
    await l.finisher.finish({ jobId, execution: 2 });
    assertEnd(f, 2);
    expect(l.execute).not.toHaveBeenCalled();
    expect(f.runtime.storage.existsSync(restoreStagePath(native, jobId, 2))).toBe(false);
    expect(f.manifest().execution).toBe(1);
    expect(l.admission.reservationFor(jobId)).toBeNull();
  });

  it('refuses invalid restore before committing any new execution', async () => {
    const f = fixture({ workflow: true }); await f.finish();
    f.runtime.storage.unlinkSync(f.manifestPath);
    const l = launcher(f);
    const before = f.h.events().length;
    expect(await l.launch()).toMatchObject({ status: 'refused', code: 'archive_missing' });
    expect(f.h.events()).toHaveLength(before);
    expect(l.execute).not.toHaveBeenCalled();
    expect(l.admission.reservationFor(jobId)).toBeNull();
  });

  it('cannot restore an older archive after a later completed native run lost its file', async () => {
    const f = fixture({ workflow: true }); await f.finish();
    f.h.append(requestedExecution(2, { originatingClientMessageId: undefined }),
      input('job.execution.started', { execution: 2, transport: 'app-server', startedAt: '2026-10-22T00:00:00.000Z',
        providerMeta: { provider: 'codex', leaseState: 'waiting' } }));
    await f.finish(2);
    expect(f.manifest().execution).toBe(1);
    const l = launcher(f); const before = f.h.events().length;
    expect(await l.launch()).toMatchObject({ status: 'refused', code: 'archive_stale' });
    expect(f.h.events()).toHaveLength(before);
    expect(l.execute).not.toHaveBeenCalled();
    expect(f.runtime.storage.existsSync(native)).toBe(false);
  });

  it('finishes without effect when no native file exists', async () => {
    const f = fixture({ native: false, recorded: false });
    await f.finish();
    const events = assertEnd(f);
    expect(events.at(-2)?.body).toMatchObject({ outcome: 'skipped_no_handles' });
    expect(f.issuer).not.toHaveBeenCalled();
    expect(f.runtime.storage.existsSync(conversationArchiveDirectory(f.runtime, jobId))).toBe(false);
  });

  it('settles a provider declaring no artifacts without invoking discard', async () => {
    const f = fixture({ native: false, recorded: false });
    Object.assign(f.bound, { artifacts: { kind: 'none', reason: 'No native conversation files.' } });
    await f.finish();
    expect(assertEnd(f).at(-2)?.body).toMatchObject({ outcome: 'provider_declares_none' });
    expect(f.issuer).not.toHaveBeenCalled();
    expect(f.runtime.storage.existsSync(conversationArchiveDirectory(f.runtime, jobId))).toBe(false);
  });

  it.each(['binding failure', 'binding exception', 'readiness failure', 'readiness exception', 'discovery exception',
    'native read', 'byte publication', 'manifest publication', 'unknown directory sync'])(
    'closes %s as failed with native bytes kept', async failure => {
      const f = fixture();
      if (failure === 'binding failure') vi.spyOn(f.providers, 'rehydrateBinding').mockReturnValue({ ok: false,
        failure: { provider: 'codex', reason: 'invalid-persisted-binding' } });
      if (failure === 'binding exception') vi.spyOn(f.providers, 'rehydrateBinding').mockImplementation(() => { throw new Error('binding'); });
      if (failure === 'readiness failure') vi.spyOn(f.bound, 'readiness').mockResolvedValue({ ok: false,
        failure: { provider: 'codex', reason: 'identity-unavailable' } });
      if (failure === 'readiness exception') vi.spyOn(f.bound, 'readiness').mockRejectedValue(new Error('readiness'));
      if (failure === 'discovery exception') vi.spyOn(f.artifacts, 'locateArtifact').mockImplementation(() => { throw new Error('discovery'); });
      if (failure === 'native read') vi.spyOn(f.runtime.storage, 'readFileBytesSync').mockImplementation(() => { throw new Error('read'); });
      if (failure === 'unknown directory sync') vi.spyOn(f.runtime.storage, 'syncDirectoryDurableSync').mockReturnValue(false);
      if (failure === 'byte publication' || failure === 'manifest publication') {
        const write = f.runtime.storage.writeAtomicDurableSync.bind(f.runtime.storage);
        vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockImplementation((path, bytes, options) =>
          (failure === 'manifest publication' ? path.endsWith('manifest.json') : path.endsWith('.bytes')) ? false : write(path, bytes, options));
      }
      await f.finish();
      assertEnd(f, 1, 'failed');
      expect(f.runtime.storage.readFileSync(native, 'utf-8')).toBe(content.toString('utf8'));
      expect(f.issuer).not.toHaveBeenCalled();
    },
  );

  it.each(['archive', 'discard'])('blocks continuation while %s is suspended', async phase => {
    const f = fixture();
    const l = launcher(f);
    const entered = createDeferred<void>(); const resume = createDeferred<void>();
    if (phase === 'archive') {
      const guard = await import('#src/jobs/conversation/artifact-guard.js');
      const hold = guard.withJobArtifactGuard(f.runtime, jobId, async () => { entered.resolve(); await resume.promise; });
      await entered.promise;
      const finished = f.finish();
      await Promise.resolve();
      expect(() => f.h.append(requestedExecution(2))).toThrow();
      expect(await l.launch()).toMatchObject({ status: 'refused', code: 'execution_finishing' });
      expect(f.runtime.storage.existsSync(native)).toBe(true);
      resume.resolve(); await hold; await finished;
    } else {
      const discard = f.artifacts.discardArtifacts;
      f.artifacts.discardArtifacts = async options => { entered.resolve(); await resume.promise; return discard(options); };
      const finished = f.finish(); await entered.promise;
      expect(() => f.h.append(requestedExecution(2))).toThrow();
      expect(await l.launch()).toMatchObject({ status: 'refused', code: 'execution_finishing' });
      expect(f.manifest().execution).toBe(1);
      resume.resolve(); await finished;
    }
    assertEnd(f); expect(l.execute).not.toHaveBeenCalled(); f.h.append(requestedExecution(2));
  });

  it('bounds unknown removal to six observations, persists uncertainty and seals the action', async () => {
    const f = fixture();
    const reconcile = vi.spyOn(f.artifacts, 'reconcileDiscard').mockResolvedValue({ kind: 'unknown' });
    await f.finish(); const events = assertEnd(f, 1, 'failed');
    expect(events.at(-2)?.body).toMatchObject({ reason: expect.stringContaining('cannot be asserted') });
    expect(reconcile).toHaveBeenCalledTimes(6);
    expect(f.issuer).not.toHaveBeenCalled();
    f.restart();
    await f.finisher().finish({ jobId, execution: 1 });
    expect(reconcile).toHaveBeenCalledTimes(6);
  });

  it('preserves the six-observation budget and original action across a crash', async () => {
    const f = fixture(); f.accept();
    const address = { jobId, execution: 1 };
    const action = { execution: 1, ...await f.reactor().retentionAction(address) };
    f.h.append(input('job.retention.discard.requested', action));
    const reconcile = vi.spyOn(f.artifacts, 'reconcileDiscard').mockResolvedValue({ kind: 'unknown' });
    vi.spyOn(f.runtime.time, 'sleep').mockRejectedValueOnce(new Error('process lost'));
    await expect(f.reactor().settleRetention(address, action)).rejects.toThrow('process lost');
    expect(reconcile).toHaveBeenCalledTimes(1);
    f.restart(); await f.finisher().finish(address);
    assertEnd(f, 1, 'failed');
    expect(reconcile).toHaveBeenCalledTimes(6);
    expect(new Set(reconcile.mock.calls.map(([call]) => `${call.actionId}:${call.payloadHash}`)).size).toBe(1);
    expect(f.issuer).not.toHaveBeenCalled();
  });

  it('serializes export pruning with artifact readers and rechecks the open execution after acquiring the guard', async () => {
    const f = fixture(); await f.finish();
    const entered = createDeferred<void>(); const release = createDeferred<void>();
    const reader = withJobArtifactGuard(f.runtime, jobId, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const jobState = vi.fn(() => readProjectionJobConversation(f.h.db, jobId)?.open
      ? { kind: 'nonterminal' as const } : { kind: 'terminal' as const, terminalAt: 0 });
    const prune = pruneJobExports({ db: f.h.db, runtime: f.runtime, cutoff: f.runtime.time.now() + 1, afterId: '',
      budget: { canContinue: () => true, record: () => {} }, jobState, resultHold: () => 'released', mutate: work => work() });
    await flushMicrotasks(20);
    expect(jobState).not.toHaveBeenCalled();
    f.h.append(requestedExecution(2));
    release.resolve(); await reader; await prune;
    expect(jobState).toHaveBeenCalledWith(jobId);
    expect(f.runtime.storage.existsSync(f.manifestPath)).toBe(true);
    expect(f.runtime.storage.existsSync(join(f.runtime.paths.coral.exports.jobsRoot, '.provider-artifact-discard'))).toBe(true);
  });

  it.each(['job.retention.discard.requested', 'job.retention.discard.completed', 'job.execution.ended'])(
    'recovers %s commit failures live without issuing a second discard', async boundary => {
      const f = fixture();
      let fail = true;
      let retries = 0;
      f.h.ctx.beforeAppend = event => { if (fail && event.type === boundary) throw new Error('journal unavailable'); };
      vi.spyOn(f.runtime.time, 'sleep').mockImplementation(async ms => {
        f.runtime.time.tick(ms); retries++;
        expect(() => f.h.append(requestedExecution(2))).toThrow();
        if (retries === 3) fail = false;
      });
      await f.finish(); assertEnd(f);
      expect(retries).toBeGreaterThanOrEqual(3);
      expect(f.issuer).toHaveBeenCalledTimes(1);
      expect(f.runtime.storage.existsSync(native)).toBe(false);
    },
  );

  it('reconciles a discarded file after losing outcome persistence and restarting the retention owner', async () => {
    const f = fixture(); f.accept();
    const address = { jobId, execution: 1 };
    const action = { execution: 1, ...await f.reactor().retentionAction(address) };
    f.h.append(input('job.retention.discard.requested', action));
    const discard = f.artifacts.discardArtifacts;
    let block: { mockRestore(): void } | undefined;
    f.artifacts.discardArtifacts = async options => {
      const outcome = await discard(options);
      block = vi.spyOn(RecoveryQuarantineStore.prototype, 'upsert').mockImplementation(() => { throw new Error('crash'); });
      return outcome;
    };
    await expect(f.reactor().settleRetention(address, action)).rejects.toThrow();
    expect(f.runtime.storage.existsSync(native)).toBe(false);
    expect(f.h.events().at(-1)?.type).toBe('job.retention.discard.requested');
    block?.mockRestore(); f.restart();
    vi.spyOn(f.providers, 'rehydrateBinding').mockReturnValue({ ok: false,
      failure: { provider: 'codex', reason: 'invalid-persisted-binding' } });
    await f.finisher().finish(address); assertEnd(f);
    expect(f.issuer).toHaveBeenCalledTimes(1);
  });

  it('cleans a deterministic restore hard link before archive/discard and never acts on ended work', async () => {
    const f = fixture();
    const stage = restoreStagePath(native, jobId, 1);
    f.runtime.storage.linkSync(native, stage);
    await f.finish(); assertEnd(f);
    expect(f.runtime.storage.existsSync(stage)).toBe(false);
    expect(f.runtime.storage.existsSync(native)).toBe(false);
    f.runtime.storage.writeFileSync(native, 'next execution');
    f.restart().admitRetention(); await f.reactor().waitForIdle();
    expect(f.issuer).toHaveBeenCalledTimes(1);
    expect(f.runtime.storage.readFileSync(native, 'utf-8')).toBe('next execution');
  });
});
