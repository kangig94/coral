import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JobLocationIndex } from '#src/jobs/location-index.js';
import type { JobDetailResponse } from '#src/jobs/records.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { canonicalWorkDirWireSchema } from '#src/runtime/canonical-work-dir.js';

const runtime = createRealRuntime('prod', { baseDir: tmpdir() });
const directories: string[] = [];

function fixture(): { root: string; index: JobLocationIndex } {
  const root = mkdtempSync(join(tmpdir(), 'coral-red-job-location-'));
  directories.push(root);
  return { root, index: new JobLocationIndex(runtime, root) };
}

function terminalDetail(jobId: string): JobDetailResponse {
  const result = { content: 'done', outcome: { kind: 'completed' as const }, durationMs: 1 };
  return {
    status: {
      jobId,
      owner: { kind: 'provider-session', id: 'session-1' },
      sessionId: 'session-1',
      provider: 'claude',
      projectRoot: '/workspace/project',
      workDir: canonicalWorkDirWireSchema.parse('/workspace/project'),
      backendNamespace: 'test',
      jobKind: 'provider',
      phase: 'completed',
      updatedAt: '2026-09-25T00:00:00.000Z',
      result,
    },
    events: [
      {
        type: 'terminal',
        jobId,
        sessionId: 'session-1',
        seq: 2,
        ts: '2026-09-25T00:00:00.000Z',
        result,
        usage: { inputTokens: 1 },
      },
    ],
    readiness: 'ready',
    exit: {
      ...result,
      diagnostics: {
        progressFaults: [{ kind: 'missing_launch_record' }],
        usage: { outputTokens: 2 },
        processExit: { exitCode: 0, signal: null },
        byteCounts: { stdout: 1, stderr: 0 },
      },
      endTime: '2026-09-25T00:00:00.000Z',
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('job location additive records', () => {
  it.each(['recordObserved', 'recordTerminal'] as const)(
    'preserves unknown detail fields at every nesting level in %s',
    (method) => {
      const { root, index } = fixture();
      const jobId = 'job-1';
      index.register(jobId, 'lineage-1:1', {
        projectRoot: '/workspace/project',
        workDir: '/workspace/project',
        jobKind: 'provider',
      });
      const path = join(root, 'job-locations.v1', 'jobs', `${Buffer.from(jobId).toString('base64url')}.json`);
      const detail = terminalDetail(jobId);
      writeFileSync(
        path,
        `${JSON.stringify({
          ...JSON.parse(readFileSync(path, 'utf-8')),
          detail: {
            ...detail,
            futureRoot: 'keep',
            status: {
              ...detail.status,
              futureStatus: 'keep',
              owner: { ...detail.status.owner, futureOwner: 'keep' },
              result: {
                ...detail.status.result,
                futureResult: 'keep',
                outcome: { kind: 'completed', futureOutcome: 'keep' },
              },
            },
            events: [
              {
                ...detail.events[0],
                futureEvent: 'keep',
                result: {
                  ...detail.status.result,
                  futureEventResult: 'keep',
                  outcome: { kind: 'completed', futureEventOutcome: 'keep' },
                },
                usage: { inputTokens: 1, futureUsage: 'keep' },
              },
            ],
            exit: {
              ...detail.exit,
              futureExit: 'keep',
              outcome: { kind: 'completed', futureExitOutcome: 'keep' },
              diagnostics: {
                ...detail.exit!.diagnostics,
                futureDiagnostics: 'keep',
                usage: { outputTokens: 2, futureDiagnosticUsage: 'keep' },
                processExit: { exitCode: 0, signal: null, futureProcessExit: 'keep' },
                byteCounts: { stdout: 1, stderr: 0, futureByteCounts: 'keep' },
                progressFaults: [{ kind: 'missing_launch_record', futureFault: 'keep' }],
              },
            },
          },
        })}\n`,
      );

      if (method === 'recordTerminal') index.recordTerminal(jobId, detail, join(root, 'result.md'), 2);
      else index.recordObserved(jobId, detail);

      expect(JSON.parse(readFileSync(path, 'utf-8')).detail).toMatchObject({
        futureRoot: 'keep',
        status: { futureStatus: 'keep', result: { futureResult: 'keep' } },
        events: [{ futureEvent: 'keep', result: { futureEventResult: 'keep' } }],
        exit: { futureExit: 'keep', diagnostics: { futureDiagnostics: 'keep' } },
      });
      expect(index.read(jobId)?.detail).toMatchObject({
        kind: 'recorded',
        value: {
          futureRoot: 'keep',
          status: {
            futureStatus: 'keep',
            owner: { futureOwner: 'keep' },
            result: { futureResult: 'keep', outcome: { futureOutcome: 'keep' } },
          },
          events: [
            {
              futureEvent: 'keep',
              result: { futureEventResult: 'keep', outcome: { futureEventOutcome: 'keep' } },
              usage: { futureUsage: 'keep' },
            },
          ],
          exit: {
            futureExit: 'keep',
            outcome: { futureExitOutcome: 'keep' },
            diagnostics: {
              futureDiagnostics: 'keep',
              usage: { futureDiagnosticUsage: 'keep' },
              processExit: { futureProcessExit: 'keep' },
              byteCounts: { futureByteCounts: 'keep' },
              progressFaults: [{ futureFault: 'keep' }],
            },
          },
        },
      });
    },
  );
  it('does not retain a removed known status field while preserving unknown fields', () => {
    const { root, index } = fixture();
    const jobId = 'job-1';
    index.register(jobId, 'lineage-1:1', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    const detail = terminalDetail(jobId);
    index.recordObserved(jobId, { ...detail, status: { ...detail.status, futureStatus: 'keep' } } as JobDetailResponse);
    const { result: _result, ...status } = detail.status;

    index.recordObserved(jobId, { ...detail, status });

    const path = join(root, 'job-locations.v1', 'jobs', `${Buffer.from(jobId).toString('base64url')}.json`);
    const stored = JSON.parse(readFileSync(path, 'utf-8')) as { detail: { status: Record<string, unknown> } };
    expect(stored.detail.status).toMatchObject({ futureStatus: 'keep' });
    expect(stored.detail.status).not.toHaveProperty('result');
  });
  it('does not release a certified result whose existing artifact cannot be synced', () => {
    const { root, index } = fixture();
    const epochKey = 'lineage-1:1';
    const jobId = 'job-1';
    const resultPath = join(root, 'result.md');
    writeFileSync(resultPath, 'done\n');
    index.register(jobId, epochKey, {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    index.recordTerminal(jobId, terminalDetail(jobId), resultPath, 2);
    expect(index.certify(epochKey, 2)).not.toBeNull();
    vi.spyOn(runtime.storage, 'fdatasyncSync').mockImplementation(() => {
      throw new Error('sync failed');
    });

    expect(index.resultsReleased(epochKey)).toBe(false);
  });
  it('requires readable terminal detail both to certify and to release results', () => {
    const { root, index } = fixture();
    const epochKey = 'lineage-1:1';
    const jobId = 'job-1';
    const resultPath = join(root, 'result.md');
    writeFileSync(resultPath, 'done\n');
    index.register(jobId, epochKey, {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    index.recordTerminal(jobId, terminalDetail(jobId), resultPath, 2);
    expect(index.certify(epochKey, 2)).not.toBeNull();
    expect(index.resultsReleased(epochKey)).toBe(true);

    const path = join(root, 'job-locations.v1', 'jobs', `${Buffer.from(jobId).toString('base64url')}.json`);
    const record = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({ ...record, detail: { futureFormat: true } })}\n`);

    expect(index.read(jobId)?.detail.kind).toBe('unreadable');
    expect(index.certify(epochKey, 2)).toBeNull();
    expect(index.resultsReleased(epochKey)).toBe(false);

    writeFileSync(path, `${JSON.stringify({ ...record, detail: { ...terminalDetail(jobId), exit: null } })}\n`);
    expect(index.read(jobId)?.detail.kind).toBe('recorded');
    expect(index.certify(epochKey, 2)).toBeNull();
    expect(index.resultsReleased(epochKey)).toBe(false);
  });
  it('preserves a newer nested subject field while recording an unresolved outcome', () => {
    const { root, index } = fixture();
    index.register('job-1', 'lineage-1:1', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    const path = join(root, 'job-locations.v1', 'jobs', `${Buffer.from('job-1').toString('base64url')}.json`);
    const record = JSON.parse(readFileSync(path, 'utf-8')) as { subject: Record<string, unknown> };
    writeFileSync(path, `${JSON.stringify({ ...record, subject: { ...record.subject, futureScope: 'tenant-a' } })}\n`);

    index.markUnresolved('job-1');

    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
      disposition: 'unresolved',
      subject: { futureScope: 'tenant-a' },
    });
    expect(index.read('job-1')).toMatchObject({ disposition: 'unresolved', subject: { futureScope: 'tenant-a' } });
  });

  it('preserves newer nested subject and controller fields through terminal recording', () => {
    const { root, index } = fixture();
    index.register(
      'job-1',
      'lineage-1:1',
      {
        projectRoot: '/workspace/project',
        workDir: '/workspace/project',
        jobKind: 'provider',
      },
      { buildSetId: 'build-1', instanceId: 'controller-1', controlGeneration: 1 },
    );
    const path = join(root, 'job-locations.v1', 'jobs', `${Buffer.from('job-1').toString('base64url')}.json`);
    const record = JSON.parse(readFileSync(path, 'utf-8')) as {
      subject: Record<string, unknown>;
      controller: Record<string, unknown>;
    };
    writeFileSync(
      path,
      `${JSON.stringify({
        ...record,
        subject: { ...record.subject, futureScope: 'tenant-a' },
        controller: { ...record.controller, futureLease: 'lease-a' },
      })}\n`,
    );

    index.recordTerminal(
      'job-1',
      {
        status: {
          projectRoot: '/workspace/project',
          workDir: '/workspace/project',
          jobKind: 'provider',
        },
      } as JobDetailResponse,
      join(root, 'result.md'),
      2,
    );

    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
      disposition: 'terminal',
      subject: { futureScope: 'tenant-a' },
      controller: { futureLease: 'lease-a' },
    });
    expect(index.read('job-1')).toMatchObject({
      disposition: 'terminal',
      subject: { futureScope: 'tenant-a' },
      controller: { futureLease: 'lease-a' },
    });
  });

  it('preserves additive epoch fields across revision, hold, and certificate rewrites', () => {
    const { root, index } = fixture();
    const epochKey = 'lineage-1:1';
    const epochDir = join(root, 'job-locations.v1', 'epochs', runtime.ids.sha256(epochKey));
    index.register('job-1', epochKey, {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    const revisionPath = join(epochDir, 'revision.v1.json');
    const revision = JSON.parse(readFileSync(revisionPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(revisionPath, `${JSON.stringify({ ...revision, futureRevision: 'keep' })}\n`);
    index.invalidateTerminalCertificate(epochKey);
    expect(JSON.parse(readFileSync(revisionPath, 'utf-8'))).toMatchObject({ futureRevision: 'keep' });
    expect(index.certificate(epochKey)).toBeNull();

    index.holdUnknownLocations(epochKey, 'first');
    const holdPath = join(epochDir, 'unknown-locations.v1.json');
    const hold = JSON.parse(readFileSync(holdPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(holdPath, `${JSON.stringify({ ...hold, futureHold: 'keep' })}\n`);
    index.holdUnknownLocations(epochKey, 'second');
    expect(JSON.parse(readFileSync(holdPath, 'utf-8'))).toMatchObject({ futureHold: 'keep' });
    expect(index.unknownLocationHold(epochKey)).toBe('second');
    index.clearUnknownLocations(epochKey);

    index.recordTerminal('job-1', terminalDetail('job-1'), join(root, 'result.md'), 2);
    expect(index.certify(epochKey, 2)).not.toBeNull();
    const certificatePath = join(epochDir, 'certificate.v1.json');
    const certificate = JSON.parse(readFileSync(certificatePath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(certificatePath, `${JSON.stringify({ ...certificate, futureCertificate: 'keep' })}\n`);
    expect(index.certify(epochKey, 3)).not.toBeNull();
    expect(JSON.parse(readFileSync(certificatePath, 'utf-8'))).toMatchObject({ futureCertificate: 'keep' });
    expect(index.certificate(epochKey)).toMatchObject({ futureCertificate: 'keep' });
  });
});
