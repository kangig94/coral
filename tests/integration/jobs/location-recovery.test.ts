import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { appendJobExecutionOutcomeAccepted } from '#src/jobs/terminal/recording.js';
import { sha256Hex } from '#src/infra/hash.js';
import * as retained from '#src/jobs/retained-current.js';
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  symlinkSync,
  renameSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { renderWorkflowReport } from '#src/workflow/result-report.js';
import { afterEach, expect, it, vi } from 'vitest';
import { recoverJobLocations } from '#src/jobs/location-recovery.js';
import { createTerminalExportFixture, TERMINAL_EXPORT_CUTOFF } from '#tests/helpers/terminal-export.js';
import { initTestJob, testConversationFacet } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { loadReleasedBuild } from '#tests/helpers/released-build.js';
import { requestedExecution } from '#tests/helpers/job-executions.js';

afterEach(() => vi.restoreAllMocks());

it('an undecodable launch row cannot stop recovery of the rows after it', () => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    f.index.markUncertified(f.jobId);
    f.db
      .prepare(
        "INSERT INTO events(seq, ts, type, stream_kind, stream_id, body) VALUES (0, ?, 'job.opened', 'job', 'job-0', ?)",
      )
      .run(new Date(TERMINAL_EXPORT_CUTOFF).toISOString(), Buffer.from('not json'));
    expect(() => recoverJobLocations(f.index, f.epochKey, f.store)).toThrow();
    expect(f.index.read(f.jobId)?.disposition).toBe('terminal');
    expect(f.index.unknownLocationHold(f.epochKey)).not.toBeNull();
  } finally {
    f.close();
  }
});

it('reuses certified retained history across index instances without rebuilding it', () => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    recoverJobLocations(f.index, f.epochKey, f.store);
    const index = new JobLocationIndex(f.runtime, f.root, renderWorkflowReport, currentCoralStoreFormat().fingerprint);
    const record = vi.spyOn(index, 'recordExecutionDetails');
    const inventory = vi.spyOn(index, 'locationsFor');
    const load = vi.spyOn(retained, 'loadRetainedCurrentJob');
    recoverJobLocations(index, f.epochKey, f.store);
    expect(record).not.toHaveBeenCalled();
    expect(inventory).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(index.execution(f.jobId, 1)?.detail.exit?.content).toBe('canonical result');
    expect(index.certificate(f.epochKey)).not.toBeNull();
  } finally {
    f.close();
  }
});

it.each(['missing', 'corrupt', 'fingerprint'])('rebuilds an index with %s recovery evidence', (state) => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    recoverJobLocations(f.index, f.epochKey, f.store);
    const epochs = join(f.root, 'job-locations.v1', 'epochs');
    const marker = readdirSync(epochs, { recursive: true })
      .map(String)
      .find((name) => name.endsWith('recovery-evidence.v1.json'))!;
    const path = join(epochs, marker);
    if (state === 'missing') unlinkSync(path);
    else if (state === 'corrupt') writeFileSync(path, '{');
    else {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      raw.fingerprint = 'foreign';
      delete raw.digest;
      raw.digest = sha256Hex(JSON.stringify(raw));
      writeFileSync(path, JSON.stringify(raw));
    }
    const record = vi.spyOn(f.index, 'recordExecutionDetails');
    recoverJobLocations(f.index, f.epochKey, f.store);
    expect(record).toHaveBeenCalledTimes(1);
    expect(f.index.execution(f.jobId, 1)?.detail.exit?.content).toBe('canonical result');
  } finally {
    f.close();
  }
});

it('reprocesses advanced journal evidence and preserves opaque retained fields', () => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    const raw = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    raw.future = { opaque: true };
    writeFileSync(f.locationPath, JSON.stringify(raw));
    const otherId = '90000000-0000-4000-8000-000000000002';
    initTestJob(f.store, {
      jobId: otherId,
      projectRoot: f.root,
      backendNamespace: 'fixture',
      conversation: testConversationFacet('claude', f.root),
    });
    commitJobTerminal(f.store, otherId, 1, {
      content: 'unchanged result',
      outcome: { kind: 'completed' },
      durationMs: 1,
    });
    recoverJobLocations(f.index, f.epochKey, f.store);
    f.store.withExecutionAdmission(f.jobId, 2, { projectRoot: f.root, workDir: f.root, jobKind: 'provider' }, () =>
      f.store.commit((c) => {
        c.append({
          ...requestedExecution(2, { backendNamespace: 'fixture' }),
          stream: { kind: 'job', id: f.jobId },
        });
        return undefined;
      }),
    );
    commitJobTerminal(f.store, f.jobId, 2, {
      content: 'continued result',
      outcome: { kind: 'completed' },
      durationMs: 2,
    });
    const record = vi.spyOn(f.index, 'recordExecutionDetails');
    const load = vi.spyOn(retained, 'loadRetainedCurrentJob');
    recoverJobLocations(f.index, f.epochKey, f.store);
    expect(record).toHaveBeenCalledTimes(1);
    expect(load.mock.calls.map((call) => call[2])).toEqual([f.jobId]);
    expect(record.mock.calls[0][0]).toBe(f.jobId);
    expect(f.index.execution(f.jobId, 1)?.detail.exit?.content).toBe('canonical result');
    expect(f.index.execution(f.jobId, 2)?.detail.exit?.content).toBe('continued result');
    expect(f.index.execution(otherId, 1)?.detail.exit?.content).toBe('unchanged result');
    expect(JSON.parse(readFileSync(f.locationPath, 'utf8')).future).toEqual({ opaque: true });
  } finally {
    f.close();
  }
});

it.each(['missing', 'corrupt'])('revalidates a %s release certificate despite unchanged journal evidence', (state) => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    recoverJobLocations(f.index, f.epochKey, f.store);
    const epochs = join(f.root, 'job-locations.v1', 'epochs');
    const certificate = readdirSync(epochs, { recursive: true })
      .map(String)
      .find((name) => name.endsWith('certificate.v1.json'))!;
    const path = join(epochs, certificate);
    if (state === 'missing') unlinkSync(path);
    else writeFileSync(path, '{');
    const record = vi.spyOn(f.index, 'recordExecutionDetails');
    if (state === 'corrupt') {
      expect(() => recoverJobLocations(f.index, f.epochKey, f.store)).toThrow(SyntaxError);
      expect(f.index.unknownLocationHold(f.epochKey)).not.toBeNull();
    } else {
      recoverJobLocations(f.index, f.epochKey, f.store);
      expect(f.index.certificate(f.epochKey)?.jobIds).toEqual([f.jobId]);
    }
    expect(record).toHaveBeenCalledTimes(1);
  } finally {
    f.close();
  }
});

it('keeps new recovery evidence invisible to the released v0.10.17 location reader', async () => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    recoverJobLocations(f.index, f.epochKey, f.store);
    const released = await loadReleasedBuild('v0.10.17', []);
    if (released.JobLocationIndex === undefined) throw new Error('Released fixture has no location reader');
    const rolledBack = new released.JobLocationIndex(f.runtime, f.root);
    expect(rolledBack.read(f.jobId)?.disposition).toBe('terminal');
    expect(rolledBack.read(f.jobId)?.detail).toMatchObject({
      kind: 'recorded',
      value: { exit: { content: 'canonical result' } },
    });
    expect(rolledBack.certificate(f.epochKey)?.jobIds).toEqual([f.jobId]);
    expect(rolledBack.locationsFor(f.epochKey).map((location) => location.jobId)).toEqual([f.jobId]);
  } finally {
    f.close();
  }
});

it('rebuilds changed retained bytes even when the journal did not advance', () => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    recoverJobLocations(f.index, f.epochKey, f.store);
    const raw = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    delete raw.executions;
    writeFileSync(f.locationPath, JSON.stringify(raw));
    const record = vi.spyOn(f.index, 'recordExecutionDetails');
    recoverJobLocations(f.index, f.epochKey, f.store);
    expect(record).toHaveBeenCalledTimes(1);
    expect(f.index.execution(f.jobId, 1)?.detail.exit?.content).toBe('canonical result');
  } finally {
    f.close();
  }
});

it('refreshes retained workflow usage when a draining child ends without advancing the parent stream', () => {
  const f = createTerminalExportFixture('workflow');
  try {
    const childId = '90000000-0000-4000-8000-000000000002';
    const refs = { workflowId: f.jobId, parentJobId: f.jobId, workflowSlotId: 'slot-1' };
    f.store.withExecutionAdmission(childId, 1, { projectRoot: f.root, workDir: f.root, jobKind: 'provider' }, () =>
      f.store.commit((c) => {
        c.append({
          type: 'job.opened',
          stream: { kind: 'job', id: childId },
          refs,
          body: {
            jobKind: 'provider',
            owner: { kind: 'workflow', id: f.jobId },
            projectRoot: f.root,
            createdAt: new Date(TERMINAL_EXPORT_CUTOFF).toISOString(),
            conversation: testConversationFacet('claude', f.root),
            workflowSlotId: 'slot-1',
          },
        });
        c.append({ ...requestedExecution(), stream: { kind: 'job', id: childId }, refs });
        return undefined;
      }),
    );
    f.complete();
    recoverJobLocations(f.index, f.epochKey, f.store);
    expect(f.index.execution(f.jobId, 1)?.detail.exit?.diagnostics.usage).toBeUndefined();
    const parentHighWater = f.db.prepare('SELECT MAX(seq) AS seq FROM events WHERE stream_id = ?').get(f.jobId);
    commitJobTerminal(
      f.store,
      childId,
      1,
      { content: 'drained child', outcome: { kind: 'completed' }, durationMs: 1 },
      { diagnostics: { usage: { inputTokens: 50, costUsd: 0.01 } } },
    );
    const record = vi.spyOn(f.index, 'recordExecutionDetails');
    recoverJobLocations(f.index, f.epochKey, f.store);
    expect(record.mock.calls.map(([jobId]) => jobId)).toContain(f.jobId);
    expect(f.db.prepare('SELECT MAX(seq) AS seq FROM events WHERE stream_id = ?').get(f.jobId)).toEqual(
      parentHighWater,
    );
    expect(f.index.execution(f.jobId, 1)?.detail.exit?.diagnostics.usage).toMatchObject({
      inputTokens: 50,
      costUsd: 0.01,
    });
  } finally {
    f.close();
  }
});

it('does not retire a journal-opened active job for a self-consistent cache inventory that omits it', () => {
  const f = createTerminalExportFixture();
  try {
    const stored = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    stored.future = { opaque: 'must survive recovery' };
    writeFileSync(f.locationPath, JSON.stringify(stored));
    recoverJobLocations(f.index, f.epochKey, f.store);
    const epochs = join(f.root, 'job-locations.v1', 'epochs');
    const marker = readdirSync(epochs, { recursive: true })
      .map(String)
      .find((name) => name.endsWith('recovery-evidence.v1.json'))!;
    const path = join(epochs, marker);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.streams.find((stream: { stream_id: string }) => stream.stream_id === f.jobId).opened = 0;
    raw.jobs = [];
    delete raw.digest;
    raw.digest = sha256Hex(JSON.stringify(raw));
    writeFileSync(path, JSON.stringify(raw));
    expect(f.index.recoveryEvidence(f.epochKey)).not.toBeNull();
    f.store.appendProgress(f.jobId, 'progress after certification');
    const retire = vi.spyOn(f.index, 'retireNeverAccepted');
    recoverJobLocations(f.index, f.epochKey, f.store);
    expect(retire).not.toHaveBeenCalled();
    expect(f.index.read(f.jobId)).not.toBeNull();
    expect(JSON.parse(readFileSync(f.locationPath, 'utf8')).future).toEqual({ opaque: 'must survive recovery' });
    expect(
      f.db.prepare("SELECT COUNT(*) AS count FROM events WHERE stream_id = ? AND type = 'job.opened'").get(f.jobId),
    ).toEqual({ count: 1 });
  } finally {
    f.close();
  }
});

it('reconstructs unchanged history when the integrity digest is tampered with', () => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    recoverJobLocations(f.index, f.epochKey, f.store);
    const epochs = join(f.root, 'job-locations.v1', 'epochs');
    const marker = readdirSync(epochs, { recursive: true })
      .map(String)
      .find((name) => name.endsWith('recovery-evidence.v1.json'))!;
    const path = join(epochs, marker);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.digest = '0'.repeat(64);
    writeFileSync(path, JSON.stringify(raw));
    const load = vi.spyOn(retained, 'loadRetainedCurrentJob');
    recoverJobLocations(f.index, f.epochKey, f.store);
    expect(load.mock.calls.map((call) => call[2])).toEqual([f.jobId]);
    expect(f.index.execution(f.jobId, 1)?.detail.exit?.content).toBe('canonical result');
  } finally {
    f.close();
  }
});

it.each(['omitted-opened-job', 'stream-count', 'stream-seq', 'journal-count', 'journal-seq', 'missing-digest'])(
  'falls back to full reconstruction for %s checkpoint evidence',
  (corruption) => {
    const f = createTerminalExportFixture();
    try {
      f.complete();
      recoverJobLocations(f.index, f.epochKey, f.store);
      const epochs = join(f.root, 'job-locations.v1', 'epochs');
      const marker = readdirSync(epochs, { recursive: true })
        .map(String)
        .find((name) => name.endsWith('recovery-evidence.v1.json'))!;
      const path = join(epochs, marker);
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      if (corruption === 'omitted-opened-job') {
        raw.streams[0].opened = 0;
        raw.jobs = [];
      }
      if (corruption === 'stream-count') {
        raw.streams[0].count++;
        raw.jobs[0].count++;
      }
      if (corruption === 'stream-seq') {
        raw.streams[0].seq = 0;
        raw.jobs[0].seq = 0;
      }
      if (corruption === 'journal-count') raw.journal.count++;
      if (corruption === 'journal-seq') raw.journal.seq++;
      delete raw.digest;
      if (corruption !== 'missing-digest') raw.digest = sha256Hex(JSON.stringify(raw));
      writeFileSync(path, JSON.stringify(raw));
      expect(f.index.recoveryEvidence(f.epochKey) === null).toBe(corruption === 'missing-digest');
      const load = vi.spyOn(retained, 'loadRetainedCurrentJob');
      recoverJobLocations(f.index, f.epochKey, f.store);
      expect(load.mock.calls.map((call) => call[2])).toEqual([f.jobId]);
      expect(f.index.execution(f.jobId, 1)?.detail.exit?.content).toBe('canonical result');
    } finally {
      f.close();
    }
  },
);

it('retires only locations whose job.opened evidence is absent from the journal', () => {
  const f = createTerminalExportFixture();
  try {
    recoverJobLocations(f.index, f.epochKey, f.store);
    f.index.register('never-opened', f.epochKey, { projectRoot: f.root, workDir: f.root, jobKind: 'provider' });
    const retire = vi.spyOn(f.index, 'retireNeverAccepted');
    recoverJobLocations(f.index, f.epochKey, f.store);
    expect(retire.mock.calls.map((call) => call[0])).toEqual(['never-opened']);
    expect(f.index.read(f.jobId)).not.toBeNull();
    expect(f.index.read('never-opened')).toBeNull();
  } finally {
    f.close();
  }
});

it('reconstructs retained history after a certified symlink target changes', () => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    const target = join(f.root, 'retained-target.json');
    writeFileSync(target, readFileSync(f.locationPath, 'utf8'));
    unlinkSync(f.locationPath);
    symlinkSync(target, f.locationPath);
    recoverJobLocations(f.index, f.epochKey, f.store);
    writeFileSync(target, readFileSync(target, 'utf8').replaceAll('canonical result', 'CORRUPTED result'));
    const load = vi.spyOn(retained, 'loadRetainedCurrentJob');
    recoverJobLocations(f.index, f.epochKey, f.store);
    expect(load.mock.calls.map((call) => call[2])).toEqual([f.jobId]);
    expect(f.index.execution(f.jobId, 1)?.detail.exit?.content).toBe('canonical result');
  } finally {
    f.close();
  }
});

it('does not reuse a release certificate symlink after its target changes', () => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    recoverJobLocations(f.index, f.epochKey, f.store);
    const epochs = join(f.root, 'job-locations.v1', 'epochs');
    const certificate = readdirSync(epochs, { recursive: true })
      .map(String)
      .find((name) => name.endsWith('certificate.v1.json'))!;
    const path = join(epochs, certificate);
    const target = join(f.root, 'certificate-target.json');
    writeFileSync(target, readFileSync(path, 'utf8'));
    unlinkSync(path);
    symlinkSync(target, path);
    recoverJobLocations(f.index, f.epochKey, f.store);
    expect(f.index.recoveryEvidence(f.epochKey)).toBeNull();
    const raw = JSON.parse(readFileSync(target, 'utf8'));
    raw.jobIds = [];
    writeFileSync(target, JSON.stringify(raw));
    const load = vi.spyOn(retained, 'loadRetainedCurrentJob');
    recoverJobLocations(f.index, f.epochKey, f.store);
    expect(load.mock.calls.map((call) => call[2])).toEqual([f.jobId]);
    expect(f.index.certificate(f.epochKey)?.jobIds).toEqual([f.jobId]);
  } finally {
    f.close();
  }
});

it('reconciles locations added behind a symlinked inventory directory', () => {
  const f = createTerminalExportFixture();
  try {
    const directory = join(f.root, 'job-locations.v1', 'jobs');
    const target = join(f.root, 'retained-directory');
    renameSync(directory, target);
    symlinkSync(target, directory);
    recoverJobLocations(f.index, f.epochKey, f.store);
    const orphanId = 'never-accepted';
    const orphanPath = join(target, `${Buffer.from(orphanId).toString('base64url')}.json`);
    writeFileSync(
      orphanPath,
      JSON.stringify({
        version: 'v1',
        jobId: orphanId,
        epochKey: f.epochKey,
        subject: { projectRoot: f.root, workDir: f.root, jobKind: 'provider' },
        disposition: 'active-owner',
      }),
    );
    expect(existsSync(orphanPath)).toBe(true);
    const index = new JobLocationIndex(f.runtime, f.root, renderWorkflowReport, currentCoralStoreFormat().fingerprint);
    recoverJobLocations(index, f.epochKey, f.store);
    expect(existsSync(orphanPath)).toBe(false);
    expect(index.read(f.jobId)).not.toBeNull();
  } finally {
    f.close();
  }
});

it('still skips unchanged active jobs when the release certificate is genuinely absent', () => {
  const f = createTerminalExportFixture();
  try {
    recoverJobLocations(f.index, f.epochKey, f.store);
    expect(f.index.certificate(f.epochKey)).toBeNull();
    const load = vi.spyOn(retained, 'loadRetainedCurrentJob');
    recoverJobLocations(f.index, f.epochKey, f.store);
    expect(load).not.toHaveBeenCalled();
    expect(f.index.read(f.jobId)).not.toBeNull();
  } finally {
    f.close();
  }
});

it('reconstructs history for an incompatible marker version with a valid digest', () => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    recoverJobLocations(f.index, f.epochKey, f.store);
    const epochs = join(f.root, 'job-locations.v1', 'epochs');
    const marker = readdirSync(epochs, { recursive: true })
      .map(String)
      .find((name) => name.endsWith('recovery-evidence.v1.json'))!;
    const path = join(epochs, marker);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.version = 'v99';
    delete raw.digest;
    raw.digest = sha256Hex(JSON.stringify(raw));
    writeFileSync(path, JSON.stringify(raw));
    const load = vi.spyOn(retained, 'loadRetainedCurrentJob');
    recoverJobLocations(f.index, f.epochKey, f.store);
    expect(load.mock.calls.map((call) => call[2])).toEqual([f.jobId]);
    expect(f.index.execution(f.jobId, 1)?.detail.exit?.content).toBe('canonical result');
  } finally {
    f.close();
  }
});

it('reconstructs after a released v0.10.17 writer rewrites a retained record at the same size', async () => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    recoverJobLocations(f.index, f.epochKey, f.store);
    const released = await loadReleasedBuild('v0.10.17', []);
    if (released.JobLocationIndex === undefined) throw new Error('Released fixture has no location writer');
    const writer = new released.JobLocationIndex(f.runtime, f.root);
    const location = writer.read(f.jobId);
    if (location?.detail.kind !== 'recorded' || location.resultPath === undefined || location.terminalSeq === undefined)
      throw new Error('Fixture has no retained terminal');
    const detail = structuredClone(location.detail.value);
    if (detail.exit === null || detail.status.result === undefined) throw new Error('Fixture terminal has no result');
    detail.exit.content = 'rollback! result';
    detail.status.result.content = 'rollback! result';
    for (const event of detail.events) if (event.type === 'terminal') event.result.content = 'rollback! result';
    const beforeSize = statSync(f.locationPath).size;
    const beforeRevision = f.index.revision(f.epochKey);
    writer.recordTerminal(f.jobId, detail, location.resultPath, location.terminalSeq);
    expect(statSync(f.locationPath).size).toBe(beforeSize);
    expect(f.index.revision(f.epochKey)).toBe(beforeRevision);
    expect(writer.read(f.jobId)?.detail).toMatchObject({
      kind: 'recorded',
      value: { exit: { content: 'rollback! result' } },
    });
    const load = vi.spyOn(retained, 'loadRetainedCurrentJob');
    recoverJobLocations(f.index, f.epochKey, f.store);
    expect(load.mock.calls.map((call) => call[2])).toEqual([f.jobId]);
    expect(f.index.read(f.jobId)?.detail).toMatchObject({
      kind: 'recorded',
      value: { exit: { content: 'canonical result' } },
    });
    expect(f.index.execution(f.jobId, 1)?.detail.exit?.content).toBe('canonical result');
  } finally {
    f.close();
  }
});

it('refreshes retained finishing status after a quarantine-only change during warm recovery', () => {
  const f = createTerminalExportFixture();
  try {
    f.store.commit((c) => {
      appendJobExecutionOutcomeAccepted(c, {
        jobId: f.jobId,
        execution: 1,
        terminal: { content: 'accepted result', outcome: { kind: 'completed' }, durationMs: 1 },
      });
      return undefined;
    });
    const quarantine = new RecoveryQuarantineStore(f.db, f.runtime.time);
    const initial = {
      stage: 'finish',
      kind: 'blocked',
      reason: 'awaiting release evidence',
      successor: 'recovery-quarantine',
    } as const;
    const write = {
      boundary: 'job-execution-finishing',
      subject: { key: `${f.jobId}:1`, revision: { kind: 'until-cleared' as const } },
      state: 'active' as const,
      stage: 'settle' as const,
      errorMessage: initial.reason,
      detail: JSON.stringify(initial),
    };
    expect(quarantine.upsert(write)).toBe(true);
    recoverJobLocations(f.index, f.epochKey, f.store);
    expect(f.index.read(f.jobId)?.detail).toMatchObject({
      kind: 'recorded',
      value: { status: { finishing: true, finishingStatus: initial } },
    });
    const journal = f.db.prepare('SELECT * FROM events ORDER BY seq').all();
    const projections = f.db.prepare('SELECT * FROM projection_jobs ORDER BY job_id').all();
    const retainedJson = readFileSync(f.locationPath, 'utf8');
    const updated = { ...initial, reason: 'awaiting retention evidence' };
    expect(quarantine.upsert({ ...write, errorMessage: updated.reason, detail: JSON.stringify(updated) })).toBe(true);
    expect(f.db.prepare('SELECT * FROM events ORDER BY seq').all()).toEqual(journal);
    expect(f.db.prepare('SELECT * FROM projection_jobs ORDER BY job_id').all()).toEqual(projections);
    expect(readFileSync(f.locationPath, 'utf8')).toBe(retainedJson);
    recoverJobLocations(f.index, f.epochKey, f.store);
    expect(f.index.read(f.jobId)?.detail).toMatchObject({
      kind: 'recorded',
      value: { status: { finishing: true, finishingStatus: updated } },
    });
  } finally {
    f.close();
  }
});
