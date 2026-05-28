export type CurateAssistantPurpose =
  | 'classification'
  | 'principle-discovery'
  | 'community-summary'
  | 'git-conflict-resolution';

export type CurateAssistantPermissionMode = 'default' | 'bypassPermissions';

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
