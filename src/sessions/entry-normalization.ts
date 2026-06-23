import type { SessionEntry } from './entry.js';

export function normalizeSessionEntry(entry: SessionEntry): SessionEntry {
  const {
    activeJobId,
    conversationRef,
    continuationLease,
    model,
    agentName,
    instruction,
    bypassPermissions,
    systemPrompt,
    controllerProfile,
    ...required
  } = entry;
  return {
    ...required,
    ...(continuationLease !== undefined ? { continuationLease } : {}),
    ...(activeJobId !== undefined ? { activeJobId } : {}),
    ...(conversationRef !== undefined ? { conversationRef } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(agentName !== undefined ? { agentName } : {}),
    ...(instruction !== undefined ? { instruction } : {}),
    ...(bypassPermissions !== undefined ? { bypassPermissions } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(controllerProfile !== undefined ? { controllerProfile } : {}),
  };
}
