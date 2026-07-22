export function buildProviderFailureMessage(label: string, message?: string, status?: string): string {
  if (typeof message === 'string') {
    const trimmed = message.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  if (typeof status === 'string') {
    const trimmed = status.trim();
    if (trimmed.length > 0) {
      return `${label} turn failed with status ${trimmed}.`;
    }
  }
  return `${label} session driver reported a failed turn.`;
}
