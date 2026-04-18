import type { ProviderInstruction } from '../../shared/types.js';

export function buildCoralInstruction(strippedAgentContent: string): ProviderInstruction {
  return { content: strippedAgentContent, channel: 'system' };
}
