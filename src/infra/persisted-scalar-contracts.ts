import { z } from 'zod';

import { MAX_PROCESS_INCARNATION_LENGTH, type ProcessIncarnation } from './node-process.js';

export const persistedNonEmptyStringSchema = z.string().min(1);

/** A durable root may not derive from `processIncarnationSchema` in src/infra/node-process.ts (see
 *  DURABLE_SCHEMA_ROOTS in tests/invariants/durable-schema-independence.test.ts). */
export const persistedProcessIncarnationSchema = z
  .string()
  .min(1)
  .max(MAX_PROCESS_INCARNATION_LENGTH) as unknown as z.ZodType<ProcessIncarnation>;

/**
 * Owner of the coordinator's shutdown reason vocabulary — every consumer, including
 * `src/coordinator/shutdown.ts`, imports `SHUTDOWN_REASONS`/`ShutdownReason` from here directly; none
 * re-exports them (tests/invariants/no-foreign-re-exports.test.ts). The definition lives here, one level
 * below `src/coordinator/`, only because `src/infra/` may not import `src/coordinator/`
 * (tests/invariants/architecture-layering.test.ts) while `src/infra/shutdown-remainder-record.ts` must type
 * the persisted `reason` field against the exact same union the coordinator assigns from, and derive its
 * `z.enum` validator from the same array — two independent copies of this list is the defect this constant
 * exists to close.
 */
export const SHUTDOWN_REASONS = [
  'replaced',
  'sigterm',
  'sigint',
  'provider-proxy-lifecycle-fatal',
  'idle',
  'test-teardown',
] as const;

export type ShutdownReason = (typeof SHUTDOWN_REASONS)[number];

/** Same ownership rationale as `SHUTDOWN_REASONS` above, for the coordinator's shutdown mode vocabulary. */
export const SHUTDOWN_MODES = ['handoff', 'hard'] as const;

export type ShutdownMode = (typeof SHUTDOWN_MODES)[number];
