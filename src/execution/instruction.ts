import type { ProviderInstruction } from '../types.js';

/** Build a ProviderInstruction for coral agent injection (channel: system). */
export function buildCoralInstruction(strippedAgentContent: string): ProviderInstruction {
  return { content: strippedAgentContent, channel: 'system' };
}

/** Build a ProviderInstruction for workflow/inline injection. */
export function buildPromptInstruction(content: string): ProviderInstruction {
  return { content, channel: 'prompt' };
}
