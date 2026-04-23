export const TRANSPORT_CONTEXT_FIELDS = ['owner', 'effort', 'claudeModelCap'] as const;

export type TransportContextField = (typeof TRANSPORT_CONTEXT_FIELDS)[number];

export const CONTEXT_ENV_KEY: Record<TransportContextField, string> = {
  owner: 'CORAL_OWNER',
  effort: 'CORAL_EFFORT',
  claudeModelCap: 'CORAL_CLAUDE_MODEL_CAP',
};
