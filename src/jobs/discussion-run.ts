import { z } from 'zod';

/** The discussion-owned purpose attached to a durable provider-job launch. */
export const discussionJobPurposes = ['bid', 'speech', 'epoch_evaluation', 'follow_up', 'synthesis'] as const;

/** Canonical job-side descriptor for work delegated by a discussion aggregate. */
export const discussionRunDescriptorSchema = z
  .object({
    agent: z.string().min(1),
    purpose: z.enum(discussionJobPurposes),
    attempt: z.number().int().positive(),
  })
  .strict();
export type DiscussionRunDescriptor = z.infer<typeof discussionRunDescriptorSchema>;
