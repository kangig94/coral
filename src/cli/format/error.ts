import { isRecord } from '../../infra/json.js';
import type { CoordinatorHttpError } from '../../transport/http/client.js';
import type { CliErrorEnvelope } from '../errors.js';
import { formatUnknown } from './primitives.js';

function isCoordinatorHttpError(value: unknown): value is CoordinatorHttpError {
  return (
    isRecord(value) && typeof value.statusCode === 'number' && 'body' in value && typeof value.message === 'string'
  );
}

export function formatErrorEnvelope(envelope: CliErrorEnvelope, statusCode?: number): string {
  const tags = [`code=${envelope.code}`];
  if (statusCode !== undefined) tags.push(`http=${statusCode}`);
  const needsCoordinatorStatusHint =
    envelope.code === 'coordinator_unreachable'
    && !envelope.message.includes('coordinator status');
  const message = needsCoordinatorStatusHint
    ? `${envelope.message} Run 'coral-cli coordinator status' to diagnose.`
    : envelope.message;
  const head = `${message} [${tags.join(', ')}]`;
  if (envelope.detail === undefined) return head;
  return `${head}\nDetail: ${JSON.stringify(envelope.detail)}`;
}

export function formatError(error: unknown): string {
  if (isCoordinatorHttpError(error)) {
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
