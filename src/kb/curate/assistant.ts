export type CurateAssistantPurpose =
  | 'classification'
  | 'principle-discovery'
  | 'community-summary'
  | 'git-conflict-resolution';

export const CURATE_ASSISTANT_MODEL = 'sonnet';
// The community-summary agent runs ONE tool-using turn that loops the three
// `coral-cli kb community` commands until convergence, so it needs the 1M
// context window to hold the full work-list and per-community inputs.
export const CURATE_COMMUNITY_SUMMARY_AGENT_MODEL = 'sonnet[1m]';
export const CURATE_ASSISTANT_PERMISSION_MODE = 'auto';

export type CurateAssistantPermissionMode = 'default' | 'auto' | 'bypassPermissions';

export type CurateAssistantRequest = {
  prompt: string;
  purpose: CurateAssistantPurpose;
  model?: string;
  permissionMode?: CurateAssistantPermissionMode;
  signal?: AbortSignal;
};

export interface CurateAssistantPort {
  complete(request: CurateAssistantRequest): Promise<string>;
}
