import { z } from 'zod';

import { providerInstructionSchema, type ProviderInstruction } from '../providers/contract.js';
import type { ProviderContinuityBlob } from './continuity.js';

export const sessionStateSchema = z.enum(['pending', 'ready', 'non_resumable']);

export type SessionState = z.infer<typeof sessionStateSchema>;

/** Identifier string for the session controller selecting per-session
 * provider continuity defaults. Distinct from the in-process
 * `SingleSessionController` class in `providers/claude-appserver/` — that
 * one orchestrates the live turn lifecycle, this one just names the
 * profile. */
export type SessionControllerId = string;

export const DEFAULT_SESSION_CONTROLLER: SessionControllerId = 'default';

export const sessionControllerProfileSchema = z
  .object({
    owner: z.string().optional(),
    effort: z.string().optional(),
    claudeModelCap: z.string().optional(),
  })
  .strict();

export type SessionControllerProfile = z.infer<typeof sessionControllerProfileSchema>;

export interface SessionEntry {
  sessionId: string;
  provider: string;
  name: string;
  state: SessionState;
  activeJobId?: string;
  conversationRef?: string;
  providerContinuity: ProviderContinuityBlob | null;
  model?: string;
  cwd: string;
  projectRoot: string;
  backendNamespace: string;
  agentName?: string;
  instruction?: ProviderInstruction;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  controllerProfile?: SessionControllerProfile;
  createdAt: string;
  lastUsedAt: string;
  version: number;
}

export const sessionEntrySchema = z
  .object({
    sessionId: z.string(),
    provider: z.string(),
    name: z.string(),
    state: sessionStateSchema,
    activeJobId: z.string().optional(),
    conversationRef: z.string().optional(),
    providerContinuity: z.record(z.unknown()).nullable(),
    model: z.string().optional(),
    cwd: z.string(),
    projectRoot: z.string(),
    backendNamespace: z.string(),
    agentName: z.string().optional(),
    instruction: providerInstructionSchema.optional(),
    bypassPermissions: z.boolean().optional(),
    systemPrompt: z.string().optional(),
    controllerProfile: sessionControllerProfileSchema.optional(),
    createdAt: z.string(),
    lastUsedAt: z.string(),
    version: z.number().int().nonnegative(),
  })
  .strict();

export function sessionControllerFromProfile(profile?: SessionControllerProfile): SessionControllerId {
  if (typeof profile?.owner === 'string' && profile.owner.length > 0) {
    return profile.owner;
  }
  return DEFAULT_SESSION_CONTROLLER;
}
