import { documentedCoralSetupError } from '../../runtime/errors.js';
import type { ConsumerRegistration } from '../../store/consumer-contract.js';
import type { ConsumerCursorRepository } from './persistence.js';
import type { ConsumerState } from './state.js';
import {
  consumerAuthorityMismatchError,
  consumerInterestMismatchError,
  consumerRegistrationKindMismatchError,
  isCorpusInterest,
  isRegistrationKind,
  renderConsumerId,
} from './state.js';

export interface StopConsumerDeps {
  readonly now: () => Date;
  readonly rejectWaiters: (state: ConsumerState, err: Error) => void;
}

export interface FinalizeStoppedConsumerOptions {
  readonly preserveCursor?: boolean;
}

export interface FinalizeStoppedConsumerDeps {
  readonly consumers: Map<string, ConsumerState>;
  readonly repository: ConsumerCursorRepository;
}

export type UnregisterConsumerDeps = FinalizeStoppedConsumerDeps;

export function assertValidRegistration(reg: ConsumerRegistration): void {
  const regLike = reg as { id?: unknown; authority?: unknown; kind?: unknown };
  if (regLike.kind === 'stateless') {
    if (reg.registrationKind !== undefined && !isRegistrationKind(reg.registrationKind)) {
      throw documentedCoralSetupError('consumer_registration_kind_invalid', { id: reg.id });
    }
    return;
  }
  if (regLike.authority !== 'journal' && regLike.authority !== 'corpus') {
    throw consumerAuthorityMismatchError(
      renderConsumerId(regLike.id),
      'journal|corpus',
      renderConsumerId(regLike.authority),
    );
  }
  if ('lane' in reg && (reg as { lane?: unknown }).lane !== undefined) {
    throw documentedCoralSetupError('consumer_lane_invalid', { id: reg.id });
  }
  if (reg.authority === 'corpus' && !isCorpusInterest(reg.corpusInterest)) {
    throw documentedCoralSetupError('consumer_interest_invalid', { id: reg.id });
  }
  if (reg.authority === 'journal' && 'corpusInterest' in reg) {
    throw documentedCoralSetupError('consumer_interest_invalid', { id: reg.id });
  }
  if (reg.registrationKind !== undefined && !isRegistrationKind(reg.registrationKind)) {
    throw documentedCoralSetupError('consumer_registration_kind_invalid', { id: reg.id });
  }
}

export function assertExistingRegistrationMatches(state: ConsumerState, reg: ConsumerRegistration): void {
  switch (state.kind) {
    case 'stateless':
      if (reg.kind !== 'stateless') {
        throw consumerRegistrationKindMismatchError(reg.id, reg.registrationKind, state.registrationKind);
      }
      return;

    case 'journal':
      if (reg.kind === 'stateless') {
        throw consumerRegistrationKindMismatchError(reg.id, reg.registrationKind, state.registrationKind);
      }
      if (state.reg.kind !== reg.kind) {
        throw consumerRegistrationKindMismatchError(reg.id, reg.registrationKind, state.registrationKind);
      }
      if (reg.authority !== 'journal') {
        throw consumerAuthorityMismatchError(reg.id, reg.authority, state.reg.authority);
      }
      if (reg.registrationKind !== undefined && state.registrationKind !== reg.registrationKind) {
        throw consumerRegistrationKindMismatchError(reg.id, reg.registrationKind, state.registrationKind);
      }
      return;

    case 'corpus':
      if (reg.kind === 'stateless') {
        throw consumerRegistrationKindMismatchError(reg.id, reg.registrationKind, state.registrationKind);
      }
      if (state.reg.kind !== reg.kind) {
        throw consumerRegistrationKindMismatchError(reg.id, reg.registrationKind, state.registrationKind);
      }
      if (reg.authority !== 'corpus') {
        throw consumerAuthorityMismatchError(reg.id, reg.authority, state.reg.authority);
      }
      if (state.reg.corpusInterest !== reg.corpusInterest) {
        throw consumerInterestMismatchError(reg.id);
      }
      if (reg.registrationKind !== undefined && state.registrationKind !== reg.registrationKind) {
        throw consumerRegistrationKindMismatchError(reg.id, reg.registrationKind, state.registrationKind);
      }
      return;
  }
}

export async function stopConsumer(state: ConsumerState, waiterError: Error, deps: StopConsumerDeps): Promise<void> {
  if (state.stopPromise !== null) {
    return state.stopPromise;
  }

  state.stopped = true;
  state.stopRequestedAt = deps.now().getTime();

  if (state.kind === 'stateless') {
    const onStop = state.reg.onStop;
    state.stopPromise = (async () => {
      if (onStop !== undefined) {
        await onStop();
      }
      deps.rejectWaiters(state, waiterError);
    })();
    return state.stopPromise;
  }

  if (state.kind === 'journal' && state.reg.kind === 'cursor') {
    state.pendingTarget = null;
    deps.rejectWaiters(state, waiterError);
    state.stopPromise = Promise.resolve();
    return state.stopPromise;
  }

  state.activeController?.abort('shutdown');
  state.stopPromise = (async () => {
    await state.inFlight;
    if (state.kind === 'journal') {
      state.pendingTarget = null;
    } else {
      state.pendingCorpusSnapshot = null;
      state.pendingForcedCorpusApply = null;
    }
    deps.rejectWaiters(state, waiterError);
  })();

  return state.stopPromise;
}

export async function unregisterConsumer(state: ConsumerState, deps: UnregisterConsumerDeps): Promise<void> {
  if (state.unregistered) {
    return;
  }
  if (state.stopPromise === null) {
    throw documentedCoralSetupError('consumer_unregister_requires_stop', { id: state.reg.id });
  }

  await state.stopPromise;
  finalizeStoppedConsumer(state, {}, deps);
}

export function finalizeStoppedConsumer(
  state: ConsumerState,
  options: FinalizeStoppedConsumerOptions,
  deps: FinalizeStoppedConsumerDeps,
): void {
  if (state.unregistered) {
    return;
  }

  if (deps.consumers.get(state.reg.id) === state) {
    deps.consumers.delete(state.reg.id);
  }
  if (state.registrationKind === 'expansion' && options.preserveCursor !== true) {
    deps.repository.deleteExpansionCursor(state.reg.id);
  }

  state.unregistered = true;
}
