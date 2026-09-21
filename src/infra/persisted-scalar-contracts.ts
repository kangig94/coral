import { z } from 'zod';

import { MAX_PROCESS_INCARNATION_LENGTH, type ProcessIncarnation } from './node-process.js';

export const persistedNonEmptyStringSchema = z.string().min(1);

export const persistedProcessIncarnationSchema = z
  .string()
  .min(1)
  .max(MAX_PROCESS_INCARNATION_LENGTH) as unknown as z.ZodType<ProcessIncarnation>;

export const SHUTDOWN_REASONS = [
  'replaced',
  'sigterm',
  'sigint',
  'provider-proxy-lifecycle-fatal',
  'idle',
  'test-teardown',
] as const;

export type ShutdownReason = (typeof SHUTDOWN_REASONS)[number];

export const SHUTDOWN_MODES = ['handoff', 'hard'] as const;

export type ShutdownMode = (typeof SHUTDOWN_MODES)[number];

const SHUTDOWN_MODE_BY_REASON: Readonly<Record<ShutdownReason, ShutdownMode>> = {
  replaced: 'handoff',
  sigterm: 'handoff',
  'provider-proxy-lifecycle-fatal': 'handoff',
  sigint: 'hard',
  idle: 'hard',
  'test-teardown': 'hard',
};

export function shutdownModeFromReason(reason: ShutdownReason): ShutdownMode {
  return SHUTDOWN_MODE_BY_REASON[reason];
}
