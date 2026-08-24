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
  let invocationOptionSeen = false;
  let forceUnobservableOptionSeen = false;
  for (let index = 3; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') {
      if (index !== tokens.length - 1) return null;
      break;
    }
    if (token === '--force-unobservable') {
      if (forceUnobservableOptionSeen) return null;
      forceUnobservableOptionSeen = true;
      forceUnobservable = true;
      continue;
    }
    if (token === '--invocation') {
      if (invocationOptionSeen) return null;
      invocationOptionSeen = true;
      const value = tokens[index + 1];
      const parsed = parseHandoffRoutingInvocationId(value);
      if (parsed === null) return null;
      invocationId = parsed;
      index += 1;
      continue;
    }
    if (token.startsWith('--invocation=')) {
      if (invocationOptionSeen) return null;
      invocationOptionSeen = true;
      const parsed = parseHandoffRoutingInvocationId(token.slice('--invocation='.length));
      if (parsed === null) return null;
      invocationId = parsed;
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

export function isHandoffRoutingStatusDiscardOperation(argv: readonly string[]): boolean {
  const tokens = argv.slice(2);
  return (
    tokens[0] === 'backend' &&
    tokens[1] === 'routing-status' &&
    tokens[2] === 'discard' &&
    (tokens.length === 3 || (tokens.length === 4 && tokens[3] === '--'))
  );
}
