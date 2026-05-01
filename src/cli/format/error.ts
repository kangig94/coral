import type { CliErrorEnvelope } from '../errors.js';

export function formatErrorEnvelope(envelope: CliErrorEnvelope, statusCode?: number): string {
  const tags = [`code=${envelope.code}`];
  if (statusCode !== undefined) tags.push(`http=${statusCode}`);
  const needsCoordinatorStatusHint =
    envelope.code === 'backend_unreachable' && !envelope.message.includes('backend status');
  const message = needsCoordinatorStatusHint
    ? `${envelope.message} Run 'coral-cli backend status' to diagnose.`
    : envelope.message;
  const head = `${message} [${tags.join(', ')}]`;
  const lines = [head];
  if (envelope.remediation !== undefined) {
    lines.push(`remediation: ${envelope.remediation}`);
  }
  if (envelope.detail !== undefined) {
    lines.push(`Detail: ${JSON.stringify(envelope.detail)}`);
  }
  return lines.join('\n');
}

