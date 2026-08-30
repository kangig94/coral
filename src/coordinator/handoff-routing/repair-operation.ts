import { canonicalUuidSchema } from '../../provider-proxy/protocol.js';

export type HandoffRepairOperation = Readonly<{
  kind: 'routing-status-resolve';
  invocationId: string;
  forceUnobservable: boolean;
}>;

export function parseHandoffRoutingInvocationId(value: unknown): string | null {
  const parsed = canonicalUuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseRoutingStatusResolveOperation(argv: readonly string[]): HandoffRepairOperation | null {
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

export type HandoffRoutingStatusOperatorInvocation =
  | Readonly<{
      kind: 'operator';
      command: 'resolve';
      repairOperation: HandoffRepairOperation | null;
    }>
  | Readonly<{ kind: 'operator'; command: 'discard' | 'quarantine-list' | 'quarantine-clear' }>
  | Readonly<{ kind: 'unclassified-routing-status' }>
  | Readonly<{ kind: 'not-routing-status' }>;

export function classifyHandoffRoutingStatusOperatorInvocation(
  argv: readonly string[],
): HandoffRoutingStatusOperatorInvocation {
  const tokens = argv.slice(2);
  if (tokens[0] !== 'backend' || tokens[1] !== 'routing-status') return { kind: 'not-routing-status' };

  switch (tokens[2]) {
    case 'resolve':
      return { kind: 'operator', command: 'resolve', repairOperation: parseRoutingStatusResolveOperation(argv) };
    case 'discard':
      return { kind: 'operator', command: 'discard' };
    case 'quarantine':
      switch (tokens[3]) {
        case 'list':
          return { kind: 'operator', command: 'quarantine-list' };
        case 'clear':
          return { kind: 'operator', command: 'quarantine-clear' };
        default:
          return { kind: 'unclassified-routing-status' };
      }
    default:
      return { kind: 'unclassified-routing-status' };
  }
}

export function parseHandoffRepairOperation(argv: readonly string[]): HandoffRepairOperation | null {
  const classification = classifyHandoffRoutingStatusOperatorInvocation(argv);
  return classification.kind === 'operator' && classification.command === 'resolve'
    ? classification.repairOperation
    : null;
}
