import type { ProviderInstruction } from '../../providers/contract.js';

export function buildCoralInstruction(strippedAgentContent: string): ProviderInstruction {
  return { content: strippedAgentContent, channel: 'system' };
}
