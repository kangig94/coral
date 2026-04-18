import { z } from 'zod';
import { errorMessage, isRecord } from '../../shared/utils.js';
import { discussBidSchema, discussSeedSchema, discussSpeechSchema, discussStartSchema } from '../schemas.js';
import { DiscussManagerError, type DiscussContext } from './context.js';
import * as discussOperations from './operations.js';
import { seedPersonas } from '../persona-seed.js';
import type { CallerContext } from '../../shared/request-context.js';

type ToolDomainResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; message: string; detail?: unknown };

function domainSuccess(data: unknown): ToolDomainResult {
  return { ok: true, data };
}

function domainError(code: string, message: string, detail?: unknown): ToolDomainResult {
  return detail === undefined ? { ok: false, code, message } : { ok: false, code, message, detail };
}

function toolValidationError(error: { message: string }): ToolDomainResult {
  return domainError('invalid_request', error.message);
}

function deriveErrorMessage(code: string, detail?: unknown): string {
  if (typeof detail === 'string' && detail.length > 0) {
    return detail;
  }

  if (detail instanceof Error && detail.message.length > 0) {
    return detail.message;
  }

  if (isRecord(detail) && typeof detail.message === 'string' && detail.message.length > 0) {
    return detail.message;
  }

  return code.replaceAll('_', ' ');
}

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
type DiscussParticipateArgs = z.infer<typeof legacyDiscussParticipateSchema>;

function isDiscussSpeechArgs(args: DiscussParticipateArgs): args is DiscussSpeechArgs {
  return typeof args.content === 'string';
}

function discussManagerError(error: DiscussManagerError): ToolDomainResult {
  return domainError(error.code, deriveErrorMessage(error.code, error.detail), error.detail);
}

function unexpectedDiscussError(error: unknown): ToolDomainResult {
  return domainError('discuss_error', error instanceof Error ? error.message : 'unexpected error');
}

function handleDiscussOperationError(error: unknown): ToolDomainResult {
  if (error instanceof DiscussManagerError) {
    return discussManagerError(error);
  }
  return unexpectedDiscussError(error);
}

function executeDiscussSeed(args: DiscussSeedArgs): ToolDomainResult {
  const seeded = seedPersonas(args);
  if (!seeded.ok) {
    return domainError(seeded.error, deriveErrorMessage(seeded.error, seeded.detail), seeded.detail);
  }
  return domainSuccess(seeded.value);
}

async function executeDiscussStart(
  args: DiscussStartArgs,
  context: CallerContext,
  helpers: DiscussToolHelpers,
): Promise<ToolDomainResult> {
  try {
    const ctx = helpers.getDiscussContext(context);
    const sessionId = ctx.runtime.ids.uuid();
    await discussOperations.startDiscussSession(
      ctx,
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
    return handleDiscussOperationError(error);
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
    return handleDiscussOperationError(error);
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
    return handleDiscussOperationError(error);
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
    return handleDiscussOperationError(error);
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

  if (isDiscussSpeechArgs(parsed.data)) {
    return executeDiscussSpeech(parsed.data, context, helpers);
  }

  return executeDiscussBid(parsed.data, context, helpers);
}
