import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealRuntime } from '#src/runtime/real.js';
import { JobStore } from '#src/jobs/store.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { composeReducers } from '#src/store/reducers.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import type { RetentionOutcome, RetentionRunBudget } from '#src/store/retention-outcome.js';
import { newRawDatabase } from './test-db.js';
import { permissiveProviderLookupPort } from './append-context.js';

export const RETENTION_NOW = Date.parse('2026-10-20T00:00:00.000Z');
export const RETENTION_CUTOFF = RETENTION_NOW - 14 * 86_400_000;

export function createRetentionFixture(fileDatabase = false) {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-storage-retention-'));
  let now = RETENTION_NOW;
  const real = createRealRuntime('prod', { baseDir });
  const runtime = { ...real, time: { ...real.time, now: () => now } };
  const db = newRawDatabase(fileDatabase ? join(baseDir, 'store.db') : ':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
  const store = new JobStore('test-ns', runtime, createEventBodyCodec(), {
    db,
    reducers,
    providers: permissiveProviderLookupPort,
  });
  const outcomes: RetentionOutcome[] = [];
  const budget: RetentionRunBudget = { canContinue: () => true, record: (outcome) => outcomes.push(outcome) };
  return {
    baseDir,
    runtime,
    db,
    store,
    reducers,
    outcomes,
    budget,
    setNow: (value: number) => {
      now = value;
    },
    close: () => {
      db.close();
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}
