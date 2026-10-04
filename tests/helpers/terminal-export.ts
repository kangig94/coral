import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealRuntime } from '#src/runtime/real.js';
import { canonicalWorkDirWireSchema } from '#src/runtime/canonical-work-dir.js';
import { JobStore } from '#src/jobs/store.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { encodeResolvedStoreEpoch } from '#src/store/epoch/observation.js';
import { deriveLaunchReadiness } from '#src/jobs/launch-readiness.js';
import { renderWorkflowReport } from '#src/workflow/result-report.js';
import { permissiveProviderLookupPort } from './append-context.js';
import { initTestJob } from './session.js';
import { newRawDatabase } from './test-db.js';
import { commitJobTerminal } from './job-commits.js';
import { TerminalResultExportOwner } from '#src/jobs/terminal/export.js';
import type { JobTerminal } from '#src/jobs/records.js';

export const TERMINAL_EXPORT_NOW = Date.parse('2026-10-04T00:00:00.000Z');
export const TERMINAL_EXPORT_CUTOFF = TERMINAL_EXPORT_NOW - 14 * 86_400_000 - 60_000;

export function createTerminalExportFixture(jobKind: 'provider' | 'workflow' = 'provider', fileDatabase = false) {
  const root = mkdtempSync(join(tmpdir(), 'coral-terminal-export-'));
  const real = createRealRuntime('prod', { baseDir: root });
  let wall = TERMINAL_EXPORT_NOW;
  let monotonic = 0n;
  const runtime = { ...real, time: { ...real.time, now: () => wall, monotonicNow: () => monotonic } };
  const epochDir = join(root, 'db', 'epoch-1');
  mkdirSync(epochDir, { recursive: true });
  if (fileDatabase) newRawDatabase(join(epochDir, '.lock')).close();
  const epoch = { storeRoot: join(root, 'db'), epoch: '1', path: join(epochDir, 'store.db') };
  const epochKey = fileDatabase ? encodeResolvedStoreEpoch(runtime, epoch) : JSON.stringify(epoch);
  const db = newRawDatabase(fileDatabase ? epoch.path : ':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const index = new JobLocationIndex(runtime, root, renderWorkflowReport);
  const store = new JobStore('fixture', runtime, createEventBodyCodec(), {
    db,
    providers: permissiveProviderLookupPort,
    beforeAppend: (input) => index.beforeAppend(input, epochKey),
  });
  store.configureResultExports(index);
  const jobId = 'job-1';
  if (jobKind === 'provider') {
    initTestJob(store, {
      jobId,
      sessionId: 'session-1',
      provider: 'claude',
      projectRoot: root,
      backendNamespace: 'fixture',
    });
  } else {
    store.appendLaunchRequested(jobId, {
      jobId,
      owner: { kind: 'workflow', id: jobId },
      sessionId: null,
      provider: null,
      projectRoot: root,
      backendNamespace: 'fixture',
      jobKind,
      pool: 'default',
      enqueueSequence: 1,
      request: { prompt: 'run', cwd: canonicalWorkDirWireSchema.parse(root), bypassPermissions: false, coralEnv: {} },
      createdAt: new Date(wall).toISOString(),
    });
  }
  let closed = false;
  if (!fileDatabase) {
    let locations = index;
    const makeOwner = () =>
      new TerminalResultExportOwner({
        runtime,
        jobsRoot: runtime.paths.coral.exports.jobsRoot,
        workflowReport: renderWorkflowReport,
        failures: locations.resultRepairFailures,
        hydrationRetry: (id) => {
          const location = locations.read(id);
          return location
            ? locations.unknownLocationHolds().find((hold) => hold.epochKey === location.epochKey)?.retryScheduled
            : undefined;
        },
        prepareTerminal: (id) => {
          const location = locations.read(id);
          if (!location || locations.unknownLocationHold(location.epochKey) || closed) return;
          const detail = store.loadJobProjectionDetail(id);
          const terminal = store.readJobEvents(id).find((event) => event.type === 'terminal');
          if (!detail.status || !detail.exit || !terminal) return;
          locations.recordTerminal(
            id,
            {
              status: detail.status,
              exit: detail.exit,
              events: store.readJobEvents(id),
              readiness: deriveLaunchReadiness(detail),
            },
            locations.resultPathFor(id),
            terminal.seq,
            db,
          );
        },
        location: (id) => locations.read(id),
        withSource: (_id, read) => (closed ? null : read(db, store)),
      });
    let owner = makeOwner();
    Object.assign(store, {
      getResultExportOwner: () => owner,
      publishTerminalResult: (id: string) => owner.publishTerminalResult(id),
      ensureResultArtifact: (id: string) => owner.ensureResultMarkdownArtifact(id),
      configureResultExports: (next: JobLocationIndex | null) => {
        if (next) locations = next;
        owner = makeOwner();
      },
    });
  }
  return {
    root,
    runtime,
    epoch,
    epochKey,
    epochDir,
    db,
    index,
    store,
    jobId,
    locationPath: join(root, 'job-locations.v1', 'jobs', `${Buffer.from(jobId).toString('base64url')}.json`),
    resultPath: index.resultPathFor(jobId),
    complete: (
      options: {
        terminalAt?: number;
        precedingAt?: number;
        terminal?: JobTerminal;
        steps?: Array<{ stepIndex: number; atomIndex: number; label: string; output: string }>;
      } = {},
    ) => {
      const terminalAt = options.terminalAt ?? wall;
      db.prepare('UPDATE events SET ts = ? WHERE stream_id = ?').run(
        new Date(options.precedingAt ?? terminalAt).toISOString(),
        jobId,
      );
      if (jobKind === 'workflow' && options.steps !== undefined) {
        db.prepare('INSERT INTO events(ts, type, stream_kind, stream_id, refs, body) VALUES (?, ?, ?, ?, ?, ?)').run(
          new Date(terminalAt).toISOString(),
          'workflow.completed',
          'workflow',
          jobId,
          JSON.stringify({ workflowId: jobId }),
          Buffer.from(
            JSON.stringify({ outcome: options.terminal?.outcome.kind ?? 'completed', stepDetails: options.steps }),
          ),
        );
      }
      const seq = commitJobTerminal(
        store,
        jobId,
        jobKind === 'provider' ? 'session-1' : null,
        options.terminal ?? { content: 'canonical result', outcome: { kind: 'completed' }, durationMs: 1 },
      );
      db.prepare('UPDATE events SET ts = ? WHERE seq = ?').run(new Date(terminalAt).toISOString(), seq);
      const detail = store.loadJobProjectionDetail(jobId);
      if (!detail.status) throw new Error('Missing fixture status');
      index.recordTerminal(
        jobId,
        {
          status: detail.status,
          events: store.readJobEvents(jobId),
          exit: detail.exit,
          readiness: deriveLaunchReadiness(detail),
        },
        index.resultPathFor(jobId),
        seq,
        db,
        true,
      );
      return seq;
    },
    advance: (ms: number) => {
      wall += ms;
      monotonic += BigInt(ms);
    },
    jump: (ms: number) => {
      wall += ms;
    },
    removeSource: () => {
      db.close();
      closed = true;
      rmSync(epochDir, { recursive: true, force: true });
    },
    close: () => {
      if (!closed) db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
