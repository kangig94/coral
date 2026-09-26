import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  observeRetirementDisposition,
  recordRetirementDisposition,
} from '#src/coordinator/succession/retirement-disposition.js';
import { createRealRuntime } from '#src/runtime/real.js';

const ATTEMPT_ID = '00000000-0000-4000-8000-000000000002';
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'coral-retirement-disposition-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const path = join(runtime.paths.coral.coordinator.runDir, 'retirement-dispositions.v1', `${ATTEMPT_ID}.json`);
  return { runtime, path };
}

describe('retirement disposition records', () => {
  it('should distinguish an absent record from an unreadable one', () => {
    const { runtime, path } = fixture();
    expect(observeRetirementDisposition(runtime, ATTEMPT_ID)).toEqual({ kind: 'absent' });

    recordRetirementDisposition(runtime, {
      version: 'v1',
      attemptId: ATTEMPT_ID,
      incumbentEpochKey: 'lineage:7',
      incumbentFingerprint: 'sha256:old',
      successorFingerprint: 'sha256:new',
      certificateRevision: 2,
      certificateJobIds: ['job-1'],
      custodySettled: true,
    });
    writeFileSync(path, '{"version":');

    expect(observeRetirementDisposition(runtime, ATTEMPT_ID)).toEqual({ kind: 'unreadable', path });
  });

  it('should read a record a newer build extended with an unknown field', () => {
    const { runtime, path } = fixture();
    recordRetirementDisposition(runtime, {
      version: 'v1',
      attemptId: ATTEMPT_ID,
      incumbentEpochKey: 'lineage:7',
      incumbentFingerprint: 'sha256:old',
      successorFingerprint: 'sha256:new',
      certificateRevision: 2,
      certificateJobIds: ['job-1'],
      custodySettled: true,
    });
    const record = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({ ...record, laterField: 1 })}\n`);

    expect(observeRetirementDisposition(runtime, ATTEMPT_ID)).toMatchObject({
      kind: 'recorded',
      disposition: { incumbentEpochKey: 'lineage:7', certificateRevision: 2 },
    });
  });

  it('should treat a parseable record without settled custody as unreadable, not as authority', () => {
    const { runtime, path } = fixture();
    recordRetirementDisposition(runtime, disposition());
    const record = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({ ...record, custodySettled: false })}\n`);

    expect(observeRetirementDisposition(runtime, ATTEMPT_ID)).toEqual({ kind: 'unreadable', path });
  });

  it('should throw rather than report success when the record cannot be written durably', () => {
    const { runtime } = fixture();
    vi.spyOn(runtime.storage, 'writeAtomicDurableSync').mockReturnValue(false);

    expect(() => recordRetirementDisposition(runtime, disposition())).toThrow(/could not be recorded durably/u);
    expect(observeRetirementDisposition(runtime, ATTEMPT_ID)).toEqual({ kind: 'absent' });
  });
});

function disposition() {
  return {
    version: 'v1' as const,
    attemptId: ATTEMPT_ID,
    incumbentEpochKey: 'lineage:7',
    incumbentFingerprint: 'sha256:old',
    successorFingerprint: 'sha256:new',
    certificateRevision: 2,
    certificateJobIds: ['job-1'],
    custodySettled: true as const,
  };
}
