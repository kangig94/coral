import { ClaudeBrokerRpcError } from './protocol.js';
import type {
  ClaudeChildShutdownSubject,
  ControllerShutdownDisposition,
  ControllerShutdownHold,
  ControllerShutdownObservedAbsent,
  ControllerShutdownSuccessor,
} from './session-contract.js';

export class ClaudeControllerCleanupHeldError extends ClaudeBrokerRpcError {
  readonly hold: ControllerShutdownHold;

  constructor(cause: ClaudeBrokerRpcError, hold: ControllerShutdownHold) {
    super(cause.code, cause.message, cause.data);
    this.name = 'ClaudeControllerCleanupHeldError';
    this.hold = hold;
    Object.setPrototypeOf(this, ClaudeControllerCleanupHeldError.prototype);
  }
}

export function observedChildShutdown(
  subjects: readonly ClaudeChildShutdownSubject[],
): ControllerShutdownObservedAbsent {
  return {
    kind: 'observed-absent',
    observation: 'absent',
    subjects,
  };
}

export function heldChildShutdown(options: {
  kind: ControllerShutdownHold['kind'];
  subjects: readonly ClaudeChildShutdownSubject[];
  settled: Promise<ControllerShutdownObservedAbsent>;
  retry(): Promise<ControllerShutdownDisposition>;
}): ControllerShutdownHold {
  // eslint-disable-next-line prefer-const
  let hold!: ControllerShutdownHold;
  const operatorExit = {
    kind: 'transfer-to-broker-session-pool' as const,
    transfer(successor: ControllerShutdownSuccessor) {
      return successor.accept(hold);
    },
  };
  const continuation = {
    subjects: options.subjects,
    settled: options.settled,
    retry: options.retry,
    operatorExit,
  };
  hold =
    options.kind === 'held-alive'
      ? { ...continuation, kind: 'held-alive', observation: 'alive' }
      : { ...continuation, kind: 'held-unobservable', observation: 'unobservable' };
  return hold;
}

export function combineChildShutdownDispositions(
  dispositions: readonly ControllerShutdownDisposition[],
  retry: () => Promise<ControllerShutdownDisposition>,
): ControllerShutdownDisposition {
  const subjects = dispositions.flatMap((disposition) => disposition.subjects);
  const holds = dispositions.filter((disposition): disposition is ControllerShutdownHold => {
    return disposition.kind === 'held-alive' || disposition.kind === 'held-unobservable';
  });
  if (holds.length === 0) {
    return observedChildShutdown(subjects);
  }

  return heldChildShutdown({
    kind: holds.some((hold) => hold.kind === 'held-alive') ? 'held-alive' : 'held-unobservable',
    subjects,
    settled: Promise.all(holds.map((hold) => hold.settled)).then(() => observedChildShutdown(subjects)),
    retry,
  });
}
