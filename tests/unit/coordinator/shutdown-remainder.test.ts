import { describe, expect, it, vi } from 'vitest';

import { readShutdownRemainderStatus, recordShutdownRemainder } from '#src/coordinator/shutdown-remainder.js';
import type { StoragePort } from '#src/infra/port-types.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

function storageWith(
  initial: string | null,
  publish: boolean = true,
): Pick<StoragePort, 'existsSync' | 'readFileSync' | 'writeAtomicDurableSync'> & {
  readPublished(): string | null;
} {
  let value = initial;
  return {
    existsSync: () => value !== null,
    readFileSync: () => {
      if (value === null) throw new Error('missing');
      return value;
    },
    writeAtomicDurableSync: vi.fn((_path, data) => {
      if (!publish) return false;
      value = String(data);
      return true;
    }),
    readPublished: () => value,
  };
}

const KNOWN_LOSS = {
  label: 'known loss',
  remainder: { owner: 'process-exit' },
  settlement: { cause: 'timed-out', detail: 'known detail' },
} as const;

function recordAt(instanceId: string, entries: readonly unknown[] = [KNOWN_LOSS]) {
  return {
    instanceId,
    recordedAt: '2026-09-07T00:00:00.000Z',
    reason: 'sigterm',
    mode: 'handoff',
    entries,
  };
}

describe('shutdown remainder status', () => {
  it('publishes every structured ledger disposition with its shutdown metadata', () => {
    const storage = storageWith(null);

    expect(
      recordShutdownRemainder(
        { storage, time: { now: () => 1_788_739_200_000 }, runDir: '/run' },
        {
          instanceId: 'current-instance',
          reason: 'provider-proxy-lifecycle-fatal',
          mode: 'handoff',
          undischarged: [
            {
              label: 'pending durable launch settlement',
              remainder: { owner: 'process-exit' },
              settlement: { cause: 'timed-out', detail: 'launch settlement did not finish' },
            },
            {
              label: 'store services availability check',
              remainder: { owner: 'successor-recovery', evidence: { kind: 'startup-store-recovery' } },
              settlement: { cause: 'unconfirmed', detail: 'store availability was not confirmed' },
            },
          ],
        },
      ),
    ).toBe(true);

    expect(storage.writeAtomicDurableSync).toHaveBeenCalledOnce();
    expect(storage.writeAtomicDurableSync).toHaveBeenCalledWith(
      '/run/shutdown-remainder.v1.json',
      `${JSON.stringify(
        {
          version: 1,
          records: [
            {
              instanceId: 'current-instance',
              recordedAt: '2026-09-07T00:00:00.000Z',
              reason: 'provider-proxy-lifecycle-fatal',
              mode: 'handoff',
              entries: [
                {
                  label: 'pending durable launch settlement',
                  remainder: { owner: 'process-exit' },
                  settlement: { cause: 'timed-out', detail: 'launch settlement did not finish' },
                },
                {
                  label: 'store services availability check',
                  remainder: { owner: 'successor-recovery', evidence: { kind: 'startup-store-recovery' } },
                  settlement: { cause: 'unconfirmed', detail: 'store availability was not confirmed' },
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf-8', mode: 0o600 },
    );
  });

  it('skips an unknown successor evidence kind without rejecting readable entries', () => {
    const storage = storageWith(
      JSON.stringify({
        version: 1,
        records: [
          {
            instanceId: 'future-instance',
            recordedAt: '2026-09-07T00:00:00.000Z',
            reason: 'provider-proxy-lifecycle-fatal',
            mode: 'handoff',
            entries: [
              {
                label: 'known loss',
                remainder: { owner: 'process-exit' },
                settlement: { cause: 'timed-out', detail: 'known detail' },
              },
              {
                label: 'future successor',
                remainder: {
                  owner: 'successor-recovery',
                  evidence: { kind: 'future-recovery', durableKey: 'future-key' },
                },
                settlement: { cause: 'unconfirmed', detail: 'future recovery owns this' },
              },
            ],
          },
        ],
      }),
    );

    expect(readShutdownRemainderStatus({ storage, runDir: '/run' })).toEqual({
      kind: 'available',
      path: '/run/shutdown-remainder.v1.json',
      status: {
        version: 1,
        records: [
          {
            instanceId: 'future-instance',
            recordedAt: '2026-09-07T00:00:00.000Z',
            reason: 'provider-proxy-lifecycle-fatal',
            mode: 'handoff',
            entries: [
              {
                label: 'known loss',
                remainder: { owner: 'process-exit' },
                settlement: { cause: 'timed-out', detail: 'known detail' },
              },
            ],
          },
        ],
      },
      skippedEntries: 1,
      skippedRecords: 0,
    });
  });

  it('counts every malformed entry while retaining the rest of the record', () => {
    const storage = storageWith(
      JSON.stringify({
        version: 1,
        records: [
          {
            instanceId: 'malformed-instance',
            recordedAt: '2026-09-07T00:00:00.000Z',
            reason: 'sigterm',
            mode: 'handoff',
            entries: [
              {
                label: 'known loss',
                remainder: { owner: 'process-exit' },
                settlement: { cause: 'rejected', detail: 'known detail' },
              },
              { label: 'missing settlement', remainder: { owner: 'process-exit' } },
              'not-an-entry',
            ],
          },
        ],
      }),
    );

    const read = readShutdownRemainderStatus({ storage, runDir: '/run' });
    expect(read).toMatchObject({ kind: 'available', skippedEntries: 2 });
    if (read.kind !== 'available') throw new Error('expected readable remainder status');
    expect(read.status.records[0]?.entries).toHaveLength(1);
  });

  it('decodes an older record that carries exitCode', () => {
    const storage = storageWith(
      JSON.stringify({
        version: 1,
        records: [{ ...recordAt('older-instance'), exitCode: 1 }],
      }),
    );

    expect(readShutdownRemainderStatus({ storage, runDir: '/run' })).toEqual({
      kind: 'available',
      path: '/run/shutdown-remainder.v1.json',
      status: { version: 1, records: [recordAt('older-instance')] },
      skippedEntries: 0,
      skippedRecords: 0,
    });
  });

  it('replaces an instance before retaining only the latest 32 whole records', () => {
    const storage = storageWith(null);
    let now = 1_788_739_200_000;
    const runtime = { storage, time: { now: () => now++ }, runDir: '/run' };
    const write = (instanceId: string, entryCount = 1) =>
      recordShutdownRemainder(runtime, {
        instanceId,
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: Array.from({ length: entryCount }, (_, index) => ({
          label: `${instanceId} loss`,
          remainder: { owner: 'process-exit' },
          settlement: { cause: 'unconfirmed', detail: `${instanceId} detail ${index}` },
        })),
      });

    for (let index = 0; index < 32; index += 1) expect(write(`instance-${index}`)).toBe(true);
    expect(write('instance-31', 40)).toBe(true);
    let read = readShutdownRemainderStatus({ storage, runDir: '/run' });
    if (read.kind !== 'available') throw new Error('expected readable remainder status');
    expect(read.status.records).toHaveLength(32);
    expect(read.status.records[0]?.instanceId).toBe('instance-0');
    expect(read.status.records.at(-1)?.instanceId).toBe('instance-31');
    expect(read.status.records.at(-1)?.entries).toHaveLength(40);

    expect(write('instance-32')).toBe(true);
    read = readShutdownRemainderStatus({ storage, runDir: '/run' });
    if (read.kind !== 'available') throw new Error('expected readable remainder status');
    expect(read.status.records).toHaveLength(32);
    expect(read.status.records[0]?.instanceId).toBe('instance-1');
    expect(read.status.records.at(-1)?.instanceId).toBe('instance-32');
    expect(read.status.records.find(({ instanceId }) => instanceId === 'instance-31')?.entries).toHaveLength(40);
  });

  it('round-trips startup-adoption evidence for every retained durably-published child', () => {
    const storage = storageWith(null);
    const evidence = {
      kind: 'durable-cli-runtime',
      jobId: 'adopted-job',
      pid: 4_242,
      leaderIncarnation: testIncarnation('adopted-child'),
    } as const;

    expect(
      recordShutdownRemainder(
        { storage, time: { now: () => 1_788_739_200_000 }, runDir: '/run' },
        {
          instanceId: 'current-instance',
          reason: 'test-teardown',
          mode: 'hard',
          undischarged: [
            {
              label: 'child termination',
              remainder: { owner: 'successor-recovery', evidence: { kind: 'startup-adoption', processes: [evidence] } },
              settlement: { cause: 'timed-out', detail: '1 cleanup handle(s) remain owned by launch-coordinator' },
            },
          ],
        },
      ),
    ).toBe(true);

    expect(readShutdownRemainderStatus({ storage, runDir: '/run' })).toMatchObject({
      kind: 'available',
      skippedEntries: 0,
      status: {
        records: [
          {
            instanceId: 'current-instance',
            entries: [
              {
                label: 'child termination',
                remainder: {
                  owner: 'successor-recovery',
                  evidence: { kind: 'startup-adoption', processes: [evidence] },
                },
              },
            ],
          },
        ],
      },
    });
  });

  it('counts an undecodable record beside a readable one instead of refusing the document', () => {
    const storage = storageWith(
      JSON.stringify({
        version: 1,
        records: [{ instanceId: 'foreign-instance', shape: 'unknown-to-this-build' }, recordAt('known-instance')],
      }),
    );

    expect(readShutdownRemainderStatus({ storage, runDir: '/run' })).toEqual({
      kind: 'available',
      path: '/run/shutdown-remainder.v1.json',
      status: { version: 1, records: [{ ...recordAt('known-instance'), entries: [KNOWN_LOSS] }] },
      skippedEntries: 0,
      skippedRecords: 1,
    });
  });

  it('carries an undecodable record forward verbatim while writing the current one', () => {
    const foreign = { instanceId: 'foreign-instance', shape: 'unknown-to-this-build', nested: { keep: [1, 2] } };
    const storage = storageWith(JSON.stringify({ version: 1, records: [foreign, recordAt('known-instance')] }));

    expect(
      recordShutdownRemainder(
        { storage, time: { now: () => 1_788_739_200_000 }, runDir: '/run' },
        { instanceId: 'current-instance', reason: 'sigterm', mode: 'handoff', undischarged: [KNOWN_LOSS] },
      ),
    ).toBe(true);

    const written = JSON.parse(storage.readPublished() ?? '') as { records: unknown[] };
    expect(written.records).toEqual([
      foreign,
      recordAt('known-instance'),
      expect.objectContaining({ instanceId: 'current-instance', entries: [KNOWN_LOSS] }),
    ]);
  });

  it('replaces an undecodable record that names the current instance', () => {
    const storage = storageWith(
      JSON.stringify({ version: 1, records: [{ instanceId: 'current-instance', shape: 'unknown-to-this-build' }] }),
    );

    expect(
      recordShutdownRemainder(
        { storage, time: { now: () => 1_788_739_200_000 }, runDir: '/run' },
        { instanceId: 'current-instance', reason: 'sigterm', mode: 'handoff', undischarged: [KNOWN_LOSS] },
      ),
    ).toBe(true);

    const written = JSON.parse(storage.readPublished() ?? '') as { records: unknown[] };
    expect(written.records).toEqual([
      expect.objectContaining({ instanceId: 'current-instance', entries: [KNOWN_LOSS] }),
    ]);
  });

  it('refuses the write only when the envelope itself is unreadable', () => {
    const runtime = { time: { now: () => 1_788_739_200_000 }, runDir: '/run' };
    const input = {
      instanceId: 'current-instance',
      reason: 'sigterm',
      mode: 'handoff',
      undischarged: [KNOWN_LOSS],
    } as const;

    const unreadableJson = storageWith('{not-json');
    expect(recordShutdownRemainder({ ...runtime, storage: unreadableJson }, input)).toBe(false);
    expect(unreadableJson.writeAtomicDurableSync).not.toHaveBeenCalled();

    const foreignEnvelope = storageWith(JSON.stringify({ version: 1, records: 'not-an-array' }));
    expect(recordShutdownRemainder({ ...runtime, storage: foreignEnvelope }, input)).toBe(false);
    expect(foreignEnvelope.writeAtomicDurableSync).not.toHaveBeenCalled();
  });
});
