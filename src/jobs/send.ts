import { z } from 'zod';

import { acceptedLaunchResponseSchema } from './launch.js';
import {
  providerSendDeliveredSchema,
  providerSendRefusedSchema,
  providerSendUnknownSchema,
} from '../providers/contract.js';
import { jobSendTargetSchema } from './send-target.js';
import type { JobLocation } from './location-index.js';

export const JOB_SEND_MAX_INPUT_LENGTH = 65_536;
export const UNSUPPORTED_JOB_SEND_BUILD_REASON = 'The running Coral build predates this jobs send contract.';

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
  providerSendDeliveredSchema,
  providerSendRefusedSchema.extend({
    invalidFields: z.array(z.string()).optional(),
    code: z.enum([
      ...providerSendRefusedSchema.shape.code.options,
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
      'busy',
      'succession_admission_paused',
      'session_busy',
      'native_unobservable',
      'archive_invalid',
      'provider_preflight_failed',
      'session_not_found',
      'execution_superseded',
      'work_directory_unobservable',
      'provider_preflight_undetermined',
    ]),
  }),
  providerSendUnknownSchema,
  z.object({ state: z.literal('launched'), launch: acceptedLaunchResponseSchema.options[0] }).strict(),
]);

export type JobSendOutcome = Readonly<z.infer<typeof jobSendOutcomeSchema>>;
export type JobSendResult =
  | (Extract<JobSendOutcome, { state: 'delivered' }> & { providerTurnId: string })
  | Exclude<JobSendOutcome, { state: 'delivered' }>;

export function missingJobSendRefusal(location: JobLocation | null): Extract<JobSendOutcome, { state: 'refused' }> {
  return location === null
    ? { state: 'refused', code: 'not_found', reason: 'The job was not found.' }
    : {
        state: 'refused',
        code: 'pre_generation_job',
        reason: 'The job predates the current store format generation and cannot be continued.',
      };
}
