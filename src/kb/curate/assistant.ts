export type CurateAssistantPurpose =
  | 'classification'
  | 'principle-discovery'
  | 'community-summary'
  | 'git-conflict-resolution';

export const CURATE_ASSISTANT_MODEL = 'sonnet';
export const CURATE_COMMUNITY_SUMMARY_AGENT_MODEL = 'sonnet[1m]';
export const CURATE_ASSISTANT_PERMISSION_MODE = 'auto';

type CurateAssistantPermissionMode = 'default' | 'auto' | 'bypassPermissions';

type CurateAssistantRequest = {
  prompt: string;
  purpose: CurateAssistantPurpose;
  model?: string;
  permissionMode?: CurateAssistantPermissionMode;
  signal?: AbortSignal;
};

export interface CurateAssistantPort {
  complete(request: CurateAssistantRequest): Promise<string>;
}
