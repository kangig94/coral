import { isRecord } from '../../infra/json.js';
import type { BackendToolHttpError } from '../../transport/http/client.js';
import type { CliErrorEnvelope } from '../errors.js';
import { formatUnknown } from '../../infra/text.js';

function isBackendToolHttpError(value: unknown): value is BackendToolHttpError {
  return (
    isRecord(value) && typeof value.statusCode === 'number' && 'body' in value && typeof value.message === 'string'
  );
}

export function formatErrorEnvelope(envelope: CliErrorEnvelope, statusCode?: number): string {
  const tags = [`code=${envelope.code}`];
  if (statusCode !== undefined) tags.push(`http=${statusCode}`);
  const needsCoordinatorStatusHint =
    envelope.code === 'backend_unreachable'
    && !envelope.message.includes('backend status');
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

export function formatError(error: unknown): string {
  if (isBackendToolHttpError(error)) {
    const detail = error.body === null || error.body === undefined ? error.message : formatUnknown(error.body);
    return `HTTP ${error.statusCode}: ${detail}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }

  return String(error);
}
