import type { EndReason } from './session-types.js';

const END_REASON_CONTENT: Record<EndReason, string> = {
  all_below_threshold: 'All participants bid below the threshold. Ending discussion.',
  max_epochs_reached: 'Maximum epochs reached. Ending discussion.',
  all_blocked:
    'Discussion is structurally deadlocked. Agents who want to speak have no quota, and agents with quota do not want to speak.',
  no_participants: 'No eligible agents remaining. Ending discussion.',
};

export function endContent(reason: EndReason): string {
  return END_REASON_CONTENT[reason];
}

export function resolveSessionEndReasonContent(input: {
  currentContent: string | null;
  explicitContent: string | null | undefined;
  force: boolean | undefined;
  reason: string | undefined;
}): string | null {
  if (input.explicitContent !== undefined) {
    return input.explicitContent;
  }
  return input.force ? (input.reason ?? input.currentContent) : input.currentContent;
}
