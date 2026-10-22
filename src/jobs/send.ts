import { z } from 'zod';

import { acceptedLaunchResponseSchema, executionOrdinalSchema } from './launch.js';
import { providerSendOutcomeSchema } from '../providers/contract.js';
import type { ProxyOperationSendResult } from '../provider-proxy/protocol.js';
import type { JobLocation } from './location-index.js';

export const jobSendTargetSchema = z
  .object({
    mode: z.enum(['steer', 'continue']),
    execution: executionOrdinalSchema,
    requestedSeq: z.number().int().positive().safe(),
    sourceEpoch: z.string().min(1),
  })
  .strict();

export type JobSendTarget = Readonly<z.infer<typeof jobSendTargetSchema>>;

export const JOB_SEND_MAX_INPUT_LENGTH = 65_536;

export const jobSendAttemptSchema = z
  .object({
    jobId: z.string().min(1, 'Job ID is required'),
    input: z
      .string()
      .min(1, 'Input is required')
      .max(JOB_SEND_MAX_INPUT_LENGTH, `Input must be at most ${JOB_SEND_MAX_INPUT_LENGTH} UTF-16 code units`)
      .refine((input) => input.trim().length > 0, 'Input must contain non-whitespace text'),
    clientMessageId: z.string().uuid('Client message ID must be a UUID'),
    target: jobSendTargetSchema,
  })
  .strict();

export const jobSendOutcomeSchema = z.discriminatedUnion('state', [
  providerSendOutcomeSchema.options[0],
  providerSendOutcomeSchema.options[1].extend({
    code: z.enum([
      ...providerSendOutcomeSchema.options[1].shape.code.options,
      'execution_finishing',
      'continuation_target_changed',
      'invalid_request',
      'non_provider_job',
      'owner_not_provider_session',
      'archive_missing',
      'archive_hash_mismatch',
      'profile_mismatch',
      'work_directory_missing',
      'pre_generation_job',
    ]),
    priorDeliveryUncertain: z.literal(true).optional(),
  }),
  providerSendOutcomeSchema.options[2],
  z.object({ state: z.literal('launched'), launch: acceptedLaunchResponseSchema.options[0] }).strict(),
]);

export type JobSendOutcome = Readonly<z.infer<typeof jobSendOutcomeSchema>>;
export type JobSendResult = ProxyOperationSendResult | Exclude<JobSendOutcome, { state: 'delivered' }>;

export function missingJobSendRefusal(location: JobLocation | null): Extract<JobSendOutcome, { state: 'refused' }> {
  return location === null
    ? { state: 'refused', code: 'not_found', reason: 'The job was not found.' }
    : {
        state: 'refused',
        code: 'pre_generation_job',
        reason: 'The job predates the current store format generation and cannot be continued.',
      };
}
