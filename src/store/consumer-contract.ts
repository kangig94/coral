import type { Database } from './db.js';

import type { KbProjectionInput } from '../kb/projection-input-contract.js';
import type { CorpusSnapshot } from '../kb/corpus/snapshot.js';

/**
 * Lifecycle/storage axis. Persisted in `consumer_cursors.registration_kind`
 * (see `src/store/schemas/001_initial.sql:103-116`). Distinct from the
 * behavior axis `kind` ('cursor' | 'apply' | 'stateless'). Two-axis
 * invariant enforced compile-time on every arm of `ConsumerRegistration`:
 *   `kind: 'stateless' ⟺ registrationKind: 'stateless'`
 *   `kind: 'cursor' | 'apply' ⟹ registrationKind: 'base' | 'expansion'`
 */
export type ConsumerRegistrationKind = 'base' | 'expansion' | 'stateless';

export interface ConsumerApplyError {
  readonly message: string;
  readonly at: string;
  readonly cause?: unknown;
}

/**
 * Two-axis discriminated union — narrow journal/corpus via `'authority' in status`;
 * narrow stateless via `status.kind === 'stateless'`. The journal/corpus arms
 * have no `kind` field; the stateless arm has no `authority` field.
 */
export type ConsumerHandleStatus =
  | {
      authority: 'journal';
      cursor: number;
      pending: boolean;
      lastApplyError: ConsumerApplyError | null;
    }
  | {
      authority: 'corpus';
      corpusInterest: CorpusInterest;
      snapshotId: string | null;
      contentSeq: number;
      metadataSeq: number;
      contentManifestHash: string | null;
      metadataManifestHash: string | null;
      pending: boolean;
      lastApplyError: ConsumerApplyError | null;
    }
  | {
      kind: 'stateless';
      pending: false;
    };

export interface ConsumerHandle {
  readonly id: string;
  readonly registrationKind: ConsumerRegistrationKind;
  /**
   * Retained as `null` for stateless handles — removing it would be a wider
   * type change and is explicitly out of scope. Stateless handles never
   * accumulate apply errors; this field is dead state for that arm.
   */
  readonly lastApplyError: ConsumerApplyError | null;
  stop(): Promise<void>;
  unregister(): Promise<void>;
  status(): ConsumerHandleStatus;
}

export interface JournalApplyContext {
  readonly fromSeq: number;
  readonly upToSeq: number;
  readonly db: Database;
  /**
   * Aborts when the consumer is stopping or the driver is shutting down.
   * Late-notify supersession does NOT abort the signal.
   */
  readonly signal: AbortSignal;
}

/**
 * Cursor-only journal consumer. Used by base 4 projections (jobs/sessions/
 * discuss/workflow) that are written by the commit-time reducer per spec
 * §3.3. The driver advances the cursor directly on `notify`; no `apply` runs.
 */
export interface JournalCursorRegistration {
  readonly id: string;
  readonly authority: 'journal';
  readonly kind: 'cursor';
  readonly registrationKind: 'base' | 'expansion';
  readonly onApplyFailure?: (err: ConsumerApplyError) => void;
}

/**
 * Apply-bearing journal consumer. Reserved for expansion-tier journal
 * consumers that project out-of-band; idempotency invariant #44 applies
 * to this arm only. `signal` is non-optional in the apply context.
 *
 * Contract:
 * - ConsumerDriver does NOT wrap apply() in a transaction.
 * - apply() owns its own write atomicity.
 * - Cursor advances only on clean return; crash between apply commit and
 *   cursor update is tolerated because the same range re-applies on next start.
 */
export interface JournalApplyRegistration {
  readonly id: string;
  readonly authority: 'journal';
  readonly kind: 'apply';
  readonly registrationKind: 'base' | 'expansion';
  readonly onApplyFailure?: (err: ConsumerApplyError) => void;
  apply(ctx: JournalApplyContext): Promise<void>;
}

export type JournalConsumerRegistration = JournalCursorRegistration | JournalApplyRegistration;

export type CorpusLaneHint = 'content' | 'metadata';
export type CorpusInterest = CorpusLaneHint | 'both';
export type CorpusApplyResult =
  | { readonly advance: false; readonly reason: 'stale-snapshot' }
  | { readonly advanceTo: CorpusSnapshot };

export interface JournalConsumerReadPort {
  readCursor(consumerId: string): number;
}

export interface CorpusStateReadPort {
  readConsumerCursor(consumerId: string): CorpusSnapshot;
  readCurrentSnapshot(): CorpusSnapshot;
}

export interface CorpusConsumerApplyContext {
  readonly snapshot: CorpusSnapshot;
  readonly journalReader: JournalConsumerReadPort;
  readonly corpusStateReader: CorpusStateReadPort;
  readonly projectionInput: KbProjectionInput;
  /**
   * Aborts when the consumer is stopping or the driver is shutting down.
   * Late-notify supersession does NOT abort the signal.
   */
  readonly signal: AbortSignal;
}

export interface CorpusConsumerRegistration {
  readonly id: string;
  readonly authority: 'corpus';
  readonly kind: 'apply';
  readonly registrationKind: 'base' | 'expansion';
  readonly corpusInterest: CorpusInterest;
  readonly projectionSync?: 'text-index';
  readonly onApplyFailure?: (err: ConsumerApplyError) => void;
  apply(ctx: CorpusConsumerApplyContext): Promise<void | CorpusApplyResult>;
}

/**
 * Provider/service registrations that own no journal cursor and no
 * corpus snapshot — Gemini, ONNX, fake embedders. Lifecycle only:
 * `onStop` runs once on shutdown via `ConsumerDriver.stopConsumer`;
 * `unregister` is a no-op past internal state cleanup.
 *
 * `waitFreshUntil` rejects stateless ids structurally with
 * `consumer_wait_fresh_invalid_target`.
 */
export interface StatelessProviderLifecycleRegistration {
  readonly id: string;
  readonly kind: 'stateless';
  readonly registrationKind: 'stateless';
  readonly authority?: never;
  readonly onStop?: () => void | Promise<void>;
}

export type ConsumerRegistration =
  | JournalCursorRegistration
  | JournalApplyRegistration
  | CorpusConsumerRegistration
  | StatelessProviderLifecycleRegistration;
