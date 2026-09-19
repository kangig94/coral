import { z } from 'zod';
import { discussBidSchema, discussSeedSchema, discussSpeechSchema, discussStartSchema } from '../command-schemas.js';
import { deriveDiscussErrorMessage, discussToolError, discussToolSuccess, type DiscussToolResult } from '../result.js';
import { type DiscussContext } from './types.js';
import { DiscussManagerError } from './errors.js';
import * as discussOperations from './operations.js';
import { getWatchState } from './registry.js';
import { seedPersonas } from '../persona/seed.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';

function toolValidationError(error: { message: string }): DiscussToolResult {
  return discussToolError('invalid_request', error.message);
}

const discussSessionSchema = z.object({
  session: z.string().min(1),
});

const discussWatchSchema = z.object({
  session: z.string().min(1),
  cursor: z.number().int().min(0).optional(),
});

type DiscussToolHelpers = {
  getDiscussContext: (ctx: InvocationContext) => DiscussContext;
};

type DiscussSeedArgs = z.infer<typeof discussSeedSchema>;
type DiscussStartArgs = z.infer<typeof discussStartSchema>;
type DiscussSessionArgs = z.infer<typeof discussSessionSchema>;
type DiscussWatchArgs = z.infer<typeof discussWatchSchema>;
type DiscussBidArgs = z.infer<typeof discussBidSchema>;
type DiscussSpeechArgs = z.infer<typeof discussSpeechSchema>;

function discussManagerError(error: DiscussManagerError): DiscussToolResult {
  return discussToolError(error.code, deriveDiscussErrorMessage(error.code, error.detail), error.detail);
}

function unexpectedDiscussError(error: unknown): DiscussToolResult {
  return discussToolError('discuss_error', error instanceof Error ? error.message : 'unexpected error');
}

function handleDiscussOperationError(error: unknown): DiscussToolResult {
  if (error instanceof DiscussManagerError) {
    return discussManagerError(error);
  }
  return unexpectedDiscussError(error);
}

function executeDiscussSeed(args: DiscussSeedArgs): DiscussToolResult {
  const seeded = seedPersonas(args);
  if (!seeded.ok) {
    return discussToolError(seeded.error, deriveDiscussErrorMessage(seeded.error, seeded.detail), seeded.detail);
  }
  return discussToolSuccess(seeded.value);
}

async function executeDiscussStart(
  args: DiscussStartArgs,
  context: InvocationContext,
  helpers: DiscussToolHelpers,
): Promise<DiscussToolResult> {
  try {
    const ctx = helpers.getDiscussContext(context);
    const sessionId = ctx.runtime.ids.uuid();
    await discussOperations.startDiscussSession(ctx, sessionId, args.topic, args.agents, args.config ?? {}, context);
    return discussToolSuccess({ session: sessionId });
  } catch (error: unknown) {
    return handleDiscussOperationError(error);
  }
}

async function executeDiscussAbort(
  args: DiscussSessionArgs,
  context: InvocationContext,
  helpers: DiscussToolHelpers,
): Promise<DiscussToolResult> {
  try {
    await discussOperations.abortDiscussSession(helpers.getDiscussContext(context), args.session);
    return discussToolSuccess({ ok: true, session: args.session });
  } catch (error: unknown) {
    return handleDiscussOperationError(error);
  }
}

function executeDiscussWatch(
  args: DiscussWatchArgs,
  context: InvocationContext,
  helpers: DiscussToolHelpers,
): DiscussToolResult {
  try {
    return discussToolSuccess(getWatchState(helpers.getDiscussContext(context), args.session, args.cursor));
  } catch (error: unknown) {
    return handleDiscussOperationError(error);
  }
}

async function executeDiscussBid(
  args: DiscussBidArgs,
  context: InvocationContext,
  helpers: DiscussToolHelpers,
): Promise<DiscussToolResult> {
  try {
    return discussToolSuccess(
      await discussOperations.submitManualBid(
        helpers.getDiscussContext(context),
        args.session,
        args.agent_name,
        args.score,
        args.thought,
        context,
      ),
    );
  } catch (error: unknown) {
    return handleDiscussOperationError(error);
  }
}

async function executeDiscussSpeech(
  args: DiscussSpeechArgs,
  context: InvocationContext,
  helpers: DiscussToolHelpers,
): Promise<DiscussToolResult> {
  try {
    return discussToolSuccess(
      await discussOperations.submitManualSpeech(
        helpers.getDiscussContext(context),
        args.session,
        args.agent_name,
        args.content,
        context,
      ),
    );
  } catch (error: unknown) {
    return handleDiscussOperationError(error);
  }
}

export function handleDiscussSeed(args: unknown): DiscussToolResult {
  const parsed = discussSeedSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return executeDiscussSeed(parsed.data);
}

export function handleDiscussWatch(
  args: unknown,
  context: InvocationContext,
  helpers: DiscussToolHelpers,
): DiscussToolResult {
  const parsed = discussWatchSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return executeDiscussWatch(parsed.data, context, helpers);
}

export async function handleDiscussStart(
  args: unknown,
  context: InvocationContext,
  helpers: DiscussToolHelpers,
): Promise<DiscussToolResult> {
  const parsed = discussStartSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return executeDiscussStart(parsed.data, context, helpers);
}

export async function handleDiscussAbort(
  args: unknown,
  context: InvocationContext,
  helpers: DiscussToolHelpers,
): Promise<DiscussToolResult> {
  const parsed = discussSessionSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return executeDiscussAbort(parsed.data, context, helpers);
}

export async function handleDiscussBid(
  args: unknown,
  context: InvocationContext,
  helpers: DiscussToolHelpers,
): Promise<DiscussToolResult> {
  const parsed = discussBidSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return executeDiscussBid(parsed.data, context, helpers);
}

export async function handleDiscussSpeech(
  args: unknown,
  context: InvocationContext,
  helpers: DiscussToolHelpers,
): Promise<DiscussToolResult> {
  const parsed = discussSpeechSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return executeDiscussSpeech(parsed.data, context, helpers);
}
