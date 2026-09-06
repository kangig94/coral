import { describe, expect, it, vi } from 'vitest';

import {
  readShutdownAbandonmentStatus,
  recordShutdownObligationAbandonment,
} from '#src/coordinator/shutdown-abandonment.js';
import type { StoragePort } from '#src/infra/port-types.js';

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

describe('shutdown abandonment status', () => {
  it('publishes abandoned-unconfirmed status before returning the receipt', () => {
    const storage = storageWith(null);
    const recorded = recordShutdownObligationAbandonment(
      { storage, time: { now: () => 1_725_000_000_000 }, runDir: '/run' },
      {
        subject: 'app-server-handoff-quiesce',
        instanceId: 'current-instance',
        detail: 'App-server write completion was not observed; the write may or may not have landed.',
      },
    );

    expect(recorded).toMatchObject({
      kind: 'recorded',
      receipt: {
        subject: 'app-server-handoff-quiesce',
        instanceId: 'current-instance',
        disposition: 'abandoned-unconfirmed',
        statusPath: '/run/shutdown-abandonment-status.v1.json',
      },
    });
    expect(readShutdownAbandonmentStatus({ storage, runDir: '/run' })).toMatchObject({
      kind: 'available',
      status: {
        entries: [
          expect.objectContaining({
            subject: 'app-server-handoff-quiesce',
            instanceId: 'current-instance',
            disposition: 'abandoned-unconfirmed',
          }),
        ],
      },
    });
  });

  it('refuses abandonment when existing durable status is unreadable', () => {
    const storage = storageWith('{not-json');

    expect(
      recordShutdownObligationAbandonment(
        { storage, time: { now: () => 0 }, runDir: '/run' },
        {
          subject: 'app-server-handoff-quiesce',
          instanceId: 'current-instance',
          detail: 'completion unconfirmed',
        },
      ),
    ).toMatchObject({ kind: 'refused', detail: expect.stringContaining('existing status is unreadable') });
    expect(storage.writeAtomicDurableSync).not.toHaveBeenCalled();
  });

  it('refuses abandonment when atomic durable publication is not confirmed', () => {
    const storage = storageWith(null, false);

    expect(
      recordShutdownObligationAbandonment(
        { storage, time: { now: () => 0 }, runDir: '/run' },
        {
          subject: 'app-server-handoff-quiesce',
          instanceId: 'current-instance',
          detail: 'completion unconfirmed',
        },
      ),
    ).toEqual({ kind: 'refused', detail: 'atomic durable status publication was not confirmed' });
  });

  it('retains another instance only as visible status, not current acceptance state', () => {
    const storage = storageWith(
      JSON.stringify({
        version: 1,
        entries: [
          {
            subject: 'app-server-handoff-quiesce',
            instanceId: 'stale-instance',
            recordedAt: '2026-09-07T00:00:00.000Z',
            disposition: 'abandoned-unconfirmed',
            detail: 'completion unconfirmed',
            statusPath: '/run/shutdown-abandonment-status.v1.json',
          },
        ],
      }),
    );

    const recorded = recordShutdownObligationAbandonment(
      { storage, time: { now: () => 1_788_739_200_000 }, runDir: '/run' },
      {
        subject: 'app-server-handoff-quiesce',
        instanceId: 'current-instance',
        detail: 'completion unconfirmed',
      },
    );

    expect(recorded).toMatchObject({ kind: 'recorded', receipt: { instanceId: 'current-instance' } });
    const read = readShutdownAbandonmentStatus({ storage, runDir: '/run' });
    expect(read).toMatchObject({
      kind: 'available',
      status: {
        entries: [
          expect.objectContaining({ instanceId: 'stale-instance' }),
          expect.objectContaining({ instanceId: 'current-instance' }),
        ],
      },
    });
  });
});
