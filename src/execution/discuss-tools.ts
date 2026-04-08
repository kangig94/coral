import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { errorMessage } from '../shared/utils.js';
import { discussBidSchema, discussSeedSchema, discussSpeechSchema, discussStartSchema } from '../discuss/schemas.js';
import { DiscussManagerError, type DiscussContext } from './discuss/context.js';
import * as discussOperations from './discuss/operations.js';
import { seedPersonas } from '../discuss/persona-seed.js';
import { deriveLegacyErrorMessage, domainError, domainSuccess, type ToolDomainResult } from './tool-response.js';
import type { CallerContext } from './request-context.js';

const discussSessionSchema = z.object({
  session: z.string().min(1),
});

const discussWatchSchema = z.object({
  session: z.string().min(1),
  cursor: z.number().int().min(0).optional(),
});

const legacyDiscussParticipateSchema = z.union([discussBidSchema, discussSpeechSchema]);

type DiscussToolHelpers = {
  getDiscussContext: (ctx: CallerContext) => DiscussContext;
};

type DiscussSeedArgs = z.infer<typeof discussSeedSchema>;
type DiscussStartArgs = z.infer<typeof discussStartSchema>;
type DiscussSessionArgs = z.infer<typeof discussSessionSchema>;
type DiscussWatchArgs = z.infer<typeof discussWatchSchema>;
type DiscussBidArgs = z.infer<typeof discussBidSchema>;
type DiscussSpeechArgs = z.infer<typeof discussSpeechSchema>;
type LegacyDiscussParticipateArgs = z.infer<typeof legacyDiscussParticipateSchema>;

function isDiscussSpeechArgs(args: LegacyDiscussParticipateArgs): args is DiscussSpeechArgs {
  return typeof args.content === 'string';
}

function toolValidationError(error: z.ZodError): ToolDomainResult {
  return domainError('invalid_request', error.message);
}

function discussManagerError(error: DiscussManagerError): ToolDomainResult {
  return domainError(error.code, deriveLegacyErrorMessage(error.code, error.detail), error.detail);
}

function unexpectedDiscussError(error: unknown): ToolDomainResult {
  return domainError('discuss_error', error instanceof Error ? error.message : 'unexpected error');
}

function executeDiscussSeed(args: DiscussSeedArgs): ToolDomainResult {
  const seeded = seedPersonas(args);
  if (!seeded.ok) {
    return domainError(seeded.error, deriveLegacyErrorMessage(seeded.error, seeded.detail), seeded.detail);
  }
  return domainSuccess(seeded.value);
}

async function executeDiscussStart(
  args: DiscussStartArgs,
  context: CallerContext,
  helpers: DiscussToolHelpers,
): Promise<ToolDomainResult> {
  const sessionId = randomUUID();
  try {
    await discussOperations.startDiscussSession(
      helpers.getDiscussContext(context),
      sessionId,
      args.topic,
      args.agents,
      args.config ?? {},
      context,
    );
    return domainSuccess({ session: sessionId });
  } catch (error: unknown) {
    return domainError('start_failed', errorMessage(error));
  }
}

async function executeDiscussAbort(
  args: DiscussSessionArgs,
  context: CallerContext,
  helpers: DiscussToolHelpers,
): Promise<ToolDomainResult> {
  try {
    await discussOperations.abortDiscussSession(helpers.getDiscussContext(context), args.session);
    return domainSuccess({ ok: true, session: args.session });
  } catch (error: unknown) {
    if (error instanceof DiscussManagerError) {
      return discussManagerError(error);
    }
    return unexpectedDiscussError(error);
  }
}

function executeDiscussWatch(
  args: DiscussWatchArgs,
  context: CallerContext,
  helpers: DiscussToolHelpers,
): ToolDomainResult {
  try {
    return domainSuccess(
      discussOperations.getWatchState(helpers.getDiscussContext(context), args.session, args.cursor),
    );
  } catch (error: unknown) {
    if (error instanceof DiscussManagerError) {
      return discussManagerError(error);
    }
    return unexpectedDiscussError(error);
  }
}

async function executeDiscussBid(
  args: DiscussBidArgs,
  context: CallerContext,
  helpers: DiscussToolHelpers,
): Promise<ToolDomainResult> {
  try {
    return domainSuccess(
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
    if (error instanceof DiscussManagerError) {
      return discussManagerError(error);
    }
    return unexpectedDiscussError(error);
  }
}

async function executeDiscussSpeech(
  args: DiscussSpeechArgs,
  context: CallerContext,
  helpers: DiscussToolHelpers,
): Promise<ToolDomainResult> {
  try {
    return domainSuccess(
      await discussOperations.submitManualSpeech(
        helpers.getDiscussContext(context),
        args.session,
        args.agent_name,
        args.content,
        context,
      ),
    );
  } catch (error: unknown) {
    if (error instanceof DiscussManagerError) {
      return discussManagerError(error);
    }
    return unexpectedDiscussError(error);
  }
}

export function handleDiscussSeed(args: unknown): ToolDomainResult {
  const parsed = discussSeedSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return executeDiscussSeed(parsed.data);
}

export function handleDiscussWatch(
  args: unknown,
  context: CallerContext,
  helpers: DiscussToolHelpers,
): ToolDomainResult {
  const parsed = discussWatchSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return executeDiscussWatch(parsed.data, context, helpers);
}

export async function handleDiscussStart(
  args: unknown,
  context: CallerContext,
  helpers: DiscussToolHelpers,
): Promise<ToolDomainResult> {
  const parsed = discussStartSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return executeDiscussStart(parsed.data, context, helpers);
}

export async function handleDiscussAbort(
  args: unknown,
  context: CallerContext,
  helpers: DiscussToolHelpers,
): Promise<ToolDomainResult> {
  const parsed = discussSessionSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return executeDiscussAbort(parsed.data, context, helpers);
}

export async function handleDiscussBid(
  args: unknown,
  context: CallerContext,
  helpers: DiscussToolHelpers,
): Promise<ToolDomainResult> {
  const parsed = discussBidSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return executeDiscussBid(parsed.data, context, helpers);
}

export async function handleDiscussSpeech(
  args: unknown,
  context: CallerContext,
  helpers: DiscussToolHelpers,
): Promise<ToolDomainResult> {
  const parsed = discussSpeechSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return executeDiscussSpeech(parsed.data, context, helpers);
}

export async function handleDiscussParticipate(
  args: unknown,
  context: CallerContext,
  helpers: DiscussToolHelpers,
): Promise<ToolDomainResult> {
  const parsed = legacyDiscussParticipateSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return isDiscussSpeechArgs(parsed.data)
    ? executeDiscussSpeech(parsed.data, context, helpers)
    : executeDiscussBid(parsed.data, context, helpers);
}
