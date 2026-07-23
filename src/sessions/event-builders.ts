import type { CoralEventInput } from '../store/envelope.js';
import type { SessionAdapterUnparseableFault, SessionInterruptedFault, SessionProviderFailedFault } from './fault.js';

export interface SessionFaultEventOptions {
  readonly sessionId: string;
  readonly jobId?: string;
  readonly namespace?: string;
  readonly project?: string;
  readonly correlationId?: string;
  readonly parentJobId?: string;
  readonly workflowSlotId?: string;
}

function sessionFaultRefs(options: SessionFaultEventOptions): NonNullable<CoralEventInput['refs']> {
  return {
    sessionId: options.sessionId,
    ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
    ...(options.parentJobId === undefined ? {} : { parentJobId: options.parentJobId }),
    ...(options.workflowSlotId === undefined ? {} : { workflowSlotId: options.workflowSlotId }),
  };
}

function sessionFaultEvent(
  type: 'session.interrupted' | 'session.provider_failed' | 'session.adapter_unparseable',
  fault: SessionInterruptedFault | SessionProviderFailedFault | SessionAdapterUnparseableFault,
  options: SessionFaultEventOptions,
): CoralEventInput {
  return {
    type,
    stream: { kind: 'session', id: options.sessionId },
    namespace: options.namespace,
    project: options.project,
    correlationId: options.correlationId,
    refs: sessionFaultRefs(options),
    body: fault,
  };
}

export function sessionInterruptedEvent(
  fault: SessionInterruptedFault,
  options: SessionFaultEventOptions,
): CoralEventInput<SessionInterruptedFault> {
  return sessionFaultEvent('session.interrupted', fault, options) as CoralEventInput<SessionInterruptedFault>;
}

export function sessionProviderFailedEvent(
  fault: SessionProviderFailedFault,
  options: SessionFaultEventOptions,
): CoralEventInput<SessionProviderFailedFault> {
  return sessionFaultEvent('session.provider_failed', fault, options) as CoralEventInput<SessionProviderFailedFault>;
}

export function sessionAdapterUnparseableEvent(
  fault: SessionAdapterUnparseableFault,
  options: SessionFaultEventOptions,
): CoralEventInput<SessionAdapterUnparseableFault> {
  return sessionFaultEvent(
    'session.adapter_unparseable',
    fault,
    options,
  ) as CoralEventInput<SessionAdapterUnparseableFault>;
}
