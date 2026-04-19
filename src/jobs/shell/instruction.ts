import type { ProviderInstruction } from '../../providers/protocol.js';

export function buildCoralInstruction(strippedAgentContent: string): ProviderInstruction {
  return { content: strippedAgentContent, channel: 'system' };
}
