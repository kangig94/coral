import { z } from 'zod';
import type { Runtime } from '../runtime/ports.js';
import { AGENT_IDENT_RE, identPattern, providerIdentPattern } from '../shared/identifiers.js';
import type { SessionCloseReason, SessionInterruptedFault } from './fault.js';
import type { SessionEntry, SessionHandle } from './entry.js';
import type { ContinuitySnapshot } from './continuity.js';
import type { SessionLookup } from './lookup.js';
import { resolveSession, type SessionResolveRef } from './shell/resolve.js';
import { type SessionAllocateOptions, type SessionManager } from './shell/store.js';

type SessionRuntime = Pick<Runtime, 'storage' | 'paths' | 'time' | 'ids'>;

const modelNameSchema = z
  .string()
  .regex(identPattern, 'Model name must be alphanumeric with dots, hyphens, or underscores');
const promptSchema = z.string().min(1, 'Prompt is required');
const projectRootSchema = z.string().min(1, 'Project root is required');
const ownerSchema = z.string().regex(identPattern, 'Owner must be token-safe');
const effortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const claudeModelCapSchema = modelNameSchema.optional();

export const providerNameSchema = z
  .string()
  .regex(providerIdentPattern, 'Provider name must be lowercase letters, digits, or hyphens');

export const agentIdentSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.endsWith('.md') ? value.slice(0, -3) : value),
  z
    .string()
    .regex(
      AGENT_IDENT_RE,
      'Agent must be "<name>" or "<namespace>:<name>" (lowercase letters, digits, hyphens)',
    ),
);

export const sessionIdSchema = z.string().min(1, 'Session ID is required');

const continuationFieldsShape = {
  projectRoot: projectRootSchema,
  provider: providerNameSchema.optional(),
  model: modelNameSchema.optional(),
  workDir: z.string().optional(),
  owner: ownerSchema.optional(),
  effort: effortLevelSchema.optional(),
  claudeModelCap: claudeModelCapSchema,
  bypassPermissions: z.boolean().optional(),
  systemPrompt: z.string().optional(),
} satisfies z.ZodRawShape;

export const sessionCreateSchema = z
  .object({
    provider: providerNameSchema,
    prompt: promptSchema,
    projectRoot: projectRootSchema,
    model: modelNameSchema.optional(),
    agent: agentIdentSchema.optional(),
    workDir: z.string().optional(),
    owner: ownerSchema.optional(),
    effort: effortLevelSchema.optional(),
    claudeModelCap: claudeModelCapSchema,
    bypassPermissions: z.boolean().optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

export const sessionMessageSchema = z
  .object({
    prompt: promptSchema,
    ...continuationFieldsShape,
  })
  .strict();

export const sessionForkSchema = z
  .object({
    prompt: z.string().optional(),
    ...continuationFieldsShape,
  })
  .strict();

export const sessionMessageRequestSchema = sessionMessageSchema.extend({
  sessionId: sessionIdSchema,
});

export const sessionForkRequestSchema = sessionForkSchema.extend({
  sessionId: sessionIdSchema,
});

export type SessionCreateRequest = z.infer<typeof sessionCreateSchema>;
export type SessionMessageRequest = z.infer<typeof sessionMessageRequestSchema>;
export type SessionForkRequest = z.infer<typeof sessionForkRequestSchema>;

export type SessionListFilter = {
  provider: string;
};

export const sessionsCommands = {
  open(store: Pick<SessionManager, 'open'>, args: SessionAllocateOptions): SessionHandle {
    return store.open(args);
  },
  checkpoint(
    store: Pick<SessionManager, 'checkpoint'>,
    sessionId: string,
    snapshot: ContinuitySnapshot,
  ): void {
    store.checkpoint(sessionId, snapshot);
  },
  interrupt(
    store: Pick<SessionManager, 'interrupt'>,
    sessionId: string,
    fault: SessionInterruptedFault,
  ): void {
    store.interrupt(sessionId, fault);
  },
  close(
    store: Pick<SessionManager, 'close'>,
    sessionId: string,
    reason: SessionCloseReason,
  ): void {
    store.close(sessionId, reason);
  },
} as const;

export const sessionsQueries = {
  get(store: Pick<SessionManager, 'readById'>, id: string): SessionEntry | undefined {
    return store.readById(id, { forceFresh: true }) ?? undefined;
  },
  list(store: Pick<SessionManager, 'list'>, filter: SessionListFilter): SessionEntry[] {
    return store.list(filter.provider);
  },
  resolve(
    runtime: SessionRuntime,
    ref: SessionResolveRef,
    sessionLookup: Pick<SessionLookup, 'lookupSessionShard'>,
  ): SessionEntry | undefined {
    return resolveSession(ref, runtime, sessionLookup) ?? undefined;
  },
} as const;

export type { SessionEntry } from './entry.js';
export type { SessionAllocateOptions, SessionManager } from './shell/store.js';
