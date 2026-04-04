import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { errorMessage } from '../shared/mcp-utils.js';
import { discussParticipateSchema, discussSeedSchema, discussStartSchema } from '../discuss/schemas.js';
import { DiscussManagerError, type DiscussContext } from './discuss/context.js';
import * as discussOperations from './discuss/operations.js';
import { seedPersonas } from '../discuss/persona-seed.js';
import { deriveLegacyErrorMessage, domainError, domainSuccess, type ToolDomainResult } from './tool-response.js';
import type { CallerContext, ToolRequest } from './request-context.js';

const discussSessionSchema = z.object({
  session: z.string().min(1),
});

const discussWatchSchema = z.object({
  session: z.string().min(1),
  cursor: z.number().int().min(0).optional(),
});

function toolValidationError(error: z.ZodError): ToolDomainResult {
  return domainError('invalid_request', error.message);
}

function discussManagerError(error: DiscussManagerError): ToolDomainResult {
  return domainError(error.code, deriveLegacyErrorMessage(error.code, error.detail), error.detail);
}

function unexpectedDiscussError(error: unknown): ToolDomainResult {
  return domainError('discuss_error', error instanceof Error ? error.message : 'unexpected error');
}

/**
 * Handle discuss_* tool calls. Returns a response if the request is a discuss
 * tool, or `null` if the tool name is not a discuss tool.
 */
export async function handleDiscussToolCall(
  request: ToolRequest,
  helpers: {
    getDiscussContext: (ctx: CallerContext) => DiscussContext;
  },
): Promise<ToolDomainResult | null> {
  if (request.name === 'discuss_seed') {
    const parsed = discussSeedSchema.safeParse(request.args);
    if (!parsed.success) {
      return toolValidationError(parsed.error);
    }

    const seeded = seedPersonas(parsed.data);
    if (!seeded.ok) {
      return domainError(seeded.error, deriveLegacyErrorMessage(seeded.error, seeded.detail), seeded.detail);
    }
    return domainSuccess(seeded.value);
  }

  if (request.name === 'discuss_start') {
    const parsed = discussStartSchema.safeParse(request.args);
    if (!parsed.success) {
      return toolValidationError(parsed.error);
    }

    const sessionId = randomUUID();
    try {
      await discussOperations.startDiscussSession(
        helpers.getDiscussContext(request.context),
        sessionId,
        parsed.data.topic,
        parsed.data.agents,
        parsed.data.config ?? {},
        request.context,
      );
      return domainSuccess({ session: sessionId });
    } catch (error: unknown) {
      return domainError('start_failed', errorMessage(error));
    }
  }

  if (request.name === 'discuss_abort') {
    const parsed = discussSessionSchema.safeParse(request.args);
    if (!parsed.success) {
      return toolValidationError(parsed.error);
    }

    try {
      await discussOperations.abortDiscussSession(helpers.getDiscussContext(request.context), parsed.data.session);
      return domainSuccess({ ok: true, session: parsed.data.session });
    } catch (error: unknown) {
      if (error instanceof DiscussManagerError) {
        return discussManagerError(error);
      }
      return unexpectedDiscussError(error);
    }
  }

  if (request.name === 'discuss_watch') {
    const parsed = discussWatchSchema.safeParse(request.args);
    if (!parsed.success) {
      return toolValidationError(parsed.error);
    }

    try {
      return domainSuccess(
        discussOperations.getWatchState(
          helpers.getDiscussContext(request.context),
          parsed.data.session,
          parsed.data.cursor,
        ),
      );
    } catch (error: unknown) {
      if (error instanceof DiscussManagerError) {
        return discussManagerError(error);
      }
      return unexpectedDiscussError(error);
    }
  }

  if (request.name === 'discuss_participate') {
    const parsed = discussParticipateSchema.safeParse(request.args);
    if (!parsed.success) {
      return toolValidationError(parsed.error);
    }

    try {
      if (typeof parsed.data.content === 'string') {
        return domainSuccess(
          await discussOperations.submitManualSpeech(
            helpers.getDiscussContext(request.context),
            parsed.data.session,
            parsed.data.agent_name,
            parsed.data.content,
            request.context,
          ),
        );
      }

      return domainSuccess(
        await discussOperations.submitManualBid(
          helpers.getDiscussContext(request.context),
          parsed.data.session,
          parsed.data.agent_name,
          parsed.data.score,
          parsed.data.thought,
          request.context,
        ),
      );
    } catch (error: unknown) {
      if (error instanceof DiscussManagerError) {
        return discussManagerError(error);
      }
      return unexpectedDiscussError(error);
    }
  }

  return null;
}
