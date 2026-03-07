import type { ProviderInstruction } from '../types.js';

export function buildCoralInstruction(strippedAgentContent: string): ProviderInstruction {
  return { content: strippedAgentContent, channel: 'system' };
}
