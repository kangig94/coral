import { z } from 'zod';
import { processIncarnationSchema } from './node-process.js';

/** Private wrapper IPC distinguishes provider cessation from wrapper disappearance. */
export const providerHostObservationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('provider-host-started'),
    processToken: z.string(),
    pid: z.number().int().positive(),
    incarnation: processIncarnationSchema.nullable(),
  }),
  z.object({ kind: z.literal('provider-host-absent'), processToken: z.string() }),
]);
