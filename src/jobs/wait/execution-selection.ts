import { z } from 'zod';

export const waitExecutionSelectionSchema = z.object({
  jobId: z.string().min(1),
  epochKey: z.string().min(1),
  requestedSeq: z.number().int().positive().safe(),
  deliveredEndSeq: z.number().int().positive().safe().optional(),
  awaitingArtifact: z.boolean(),
}).strict().superRefine((selection, ctx) => {
  if ((selection.deliveredEndSeq !== undefined && selection.deliveredEndSeq <= selection.requestedSeq) ||
      (selection.awaitingArtifact && selection.deliveredEndSeq === undefined))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid execution delivery boundary' });
});

export type WaitExecutionSelection = z.infer<typeof waitExecutionSelectionSchema>;

export const waitExecutionSelectionsSchema = z.array(waitExecutionSelectionSchema).max(128).superRefine((selections, ctx) => {
  if (new Set(selections.map((selection) => selection.jobId)).size !== selections.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Each job may have only one execution selection' });
});
