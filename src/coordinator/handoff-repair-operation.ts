import { canonicalUuidSchema } from '../provider-proxy/protocol.js';

export type HandoffRepairOperation = Readonly<{
  kind: 'routing-status-resolve';
  invocationId: string;
  forceUnobservable: boolean;
}>;

export function parseHandoffRoutingInvocationId(value: unknown): string | null {
  const parsed = canonicalUuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseHandoffRepairOperation(argv: readonly string[]): HandoffRepairOperation | null {
  const tokens = argv.slice(2);
  if (tokens[0] !== 'backend' || tokens[1] !== 'routing-status' || tokens[2] !== 'resolve') return null;

  let invocationId: string | undefined;
  let forceUnobservable = false;
  for (let index = 3; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--force-unobservable') {
      if (forceUnobservable) return null;
      forceUnobservable = true;
      continue;
    }
    if (token === '--invocation') {
      if (invocationId !== undefined) return null;
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith('--')) return null;
      invocationId = value;
      index += 1;
      continue;
    }
    if (token.startsWith('--invocation=')) {
      if (invocationId !== undefined) return null;
      invocationId = token.slice('--invocation='.length);
      continue;
    }
    return null;
  }

  const parsedInvocationId = parseHandoffRoutingInvocationId(invocationId);
  if (parsedInvocationId === null) return null;
  return {
    kind: 'routing-status-resolve',
    invocationId: parsedInvocationId,
    forceUnobservable,
  };
}
