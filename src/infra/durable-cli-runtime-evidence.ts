import { z } from 'zod';

import { serializedThrownIdentifierSchema } from './error-format.js';
import { persistedProcessIncarnationSchema } from './persisted-scalar-contracts.js';

export const durableCliRuntimePublicationEvidenceSchema = z
  .object({
    kind: z.literal('durable-cli-runtime'),
    jobId: serializedThrownIdentifierSchema,
    pid: z.number().int().positive(),
    leaderIncarnation: persistedProcessIncarnationSchema,
  })
  .readonly();

export type DurableCliRuntimePublicationEvidence = z.infer<typeof durableCliRuntimePublicationEvidenceSchema>;
