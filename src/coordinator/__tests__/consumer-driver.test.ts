import { readFileSync, readdirSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StoragePort } from '../../runtime/ports.js';
import { applyMigrations } from '../../store/migrations.js';
import { backendLog } from '../../shared/backend-log.js';
import { ConsumerDriver, type JournalConsumerRegistration } from '../consumer-driver.js';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyMigrations({ db, storage: nodeStorage });
  return db;
}

function readCursor(db: InstanceType<typeof Database>, consumerId: string): number {
  const row = db
    .prepare('SELECT cursor FROM equipment_cursors WHERE consumer_id = ?')
    .get(consumerId) as { cursor: number } | undefined;

  return row?.cursor ?? 0;
}

describe('ConsumerDriver fault isolation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a failing consumer and still applies healthy consumers on the same journal notify', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db });
    const errorSpy = vi.spyOn(backendLog, 'error').mockImplementation(() => {});
    const healthyCalls: Array<{ fromSeq: number; upToSeq: number }> = [];

    const failing: JournalConsumerRegistration = {
      id: 'failing-consumer',
      authority: 'journal',
      async apply() {
        throw new Error('boom');
      },
    };
    const healthy: JournalConsumerRegistration = {
      id: 'healthy-consumer',
      authority: 'journal',
      async apply({ fromSeq, upToSeq }) {
        healthyCalls.push({ fromSeq, upToSeq });
      },
    };

    try {
      driver.register(failing);
      driver.register(healthy);

      driver.notify('journal', 7);
      await driver.drainAll();

      expect(errorSpy).toHaveBeenCalledWith('ConsumerDriver apply failed (failing-consumer)', expect.any(Error));
      expect(healthyCalls).toEqual([{ fromSeq: 0, upToSeq: 7 }]);
      expect(readCursor(db, failing.id)).toBe(0);
      expect(readCursor(db, healthy.id)).toBe(7);
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('skips duplicate in-flight journal targets once the consumer is already caught up', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db });
    let startApply!: () => void;
    let releaseApply!: () => void;
    const applyStarted = new Promise<void>((resolve) => {
      startApply = resolve;
    });
    const applyReleased = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const apply = vi.fn(async () => {
      startApply();
      await applyReleased;
    });
    const runApplySpy = vi.spyOn(
      driver as unknown as {
        runApply(state: unknown, target: number, snapshot: unknown): Promise<boolean>;
      },
      'runApply',
    );

    try {
      driver.register({
        id: 'coalesced-consumer',
        authority: 'journal',
        apply,
      });

      driver.notify('journal', 7);
      await applyStarted;
      driver.notify('journal', 7);
      driver.notify('journal', 7);
      releaseApply();
      await driver.drainAll();

      expect(runApplySpy).toHaveBeenCalledTimes(1);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(readCursor(db, 'coalesced-consumer')).toBe(7);
    } finally {
      releaseApply?.();
      await driver.shutdown();
      db.close();
    }
  });
});
