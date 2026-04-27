import type { ProviderInstruction } from '../providers/contract.js';
import type { SessionControllerProfile } from './entry.js';

export type SessionAllocateOptions = {
  provider: string;
  name: string;
  model?: string;
  cwd: string;
  projectRoot: string;
  coordinatorNamespace: string;
  agentName?: string;
  instruction?: ProviderInstruction;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  controllerProfile?: SessionControllerProfile;
};
