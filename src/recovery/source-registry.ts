import type { IdPort } from '../runtime/ports.js';
import {
  RecoveryContainment,
  type RecoveryPolicy,
  type RecoveryQuarantinePort,
  type RecoveryReport,
  type RecoveryRetry,
  type RecoverySource,
  type RecoverySubject,
} from './containment.js';
import type { RecoveryQuarantineClaim, RecoveryQuarantineReclaim } from './quarantine.js';

export const repeatableRecoveryBoundaryIds = [
  'coordinator-job-recovery',
  'discussion-source',
  'discussion-candidate',
  'session-projection',
  'session-continuation-lease',
  'terminal-retention-outcome',
  'retention-release-pair',
  'session-retention-work',
  'workflow-recovery',
  'stale-job-cleanup',
  'crashed-job-terminalization',
] as const;

export type RepeatableRecoveryBoundaryId = (typeof repeatableRecoveryBoundaryIds)[number];

export type RecoveryRetryPolicy<Raw, Item> = Omit<RecoveryPolicy<Raw, Item>, 'quarantine' | 'retry' | 'signal'>;

export interface RecoverySourceFactoryPlan<Raw, Item> {
  readonly source: RecoverySource<Raw>;
  readonly policy: RecoveryRetryPolicy<Raw, Item>;
}

export type RepeatableRecoverySourceFactory<Raw, Item> = (
  subject: RecoverySubject,
  signal: AbortSignal,
  quarantine: RecoveryQuarantinePort,
) => RecoverySourceFactoryPlan<Raw, Item> | Promise<RecoverySourceFactoryPlan<Raw, Item>>;

type RegisteredRecoverySourceFactory = (
  retry: RecoveryRetry,
  quarantine: RecoveryQuarantinePort,
  signal: AbortSignal,
) => Promise<RecoveryReport<unknown>>;

export interface RecoverySourceRegistry {
  register<Raw, Item>(
    boundary: RepeatableRecoveryBoundaryId,
    factory: RepeatableRecoverySourceFactory<Raw, Item>,
  ): void;
  has(boundary: string): boundary is RepeatableRecoveryBoundaryId;
  boundaries(): readonly RepeatableRecoveryBoundaryId[];
  retry(
    boundary: RepeatableRecoveryBoundaryId,
    retry: RecoveryRetry,
    quarantine: RecoveryQuarantinePort,
    signal: AbortSignal,
  ): Promise<RecoveryReport<unknown>>;
}

/** Holds the runtime-owned, exact-subject factories used by operator retries. */
export function createRecoverySourceRegistry(): RecoverySourceRegistry {
  const factories = new Map<RepeatableRecoveryBoundaryId, RegisteredRecoverySourceFactory>();

  return {
    register<Raw, Item>(
      boundary: RepeatableRecoveryBoundaryId,
      factory: RepeatableRecoverySourceFactory<Raw, Item>,
    ): void {
      if (factories.has(boundary)) {
        throw new Error(`Recovery source factory is already registered for ${boundary}`);
      }
      factories.set(boundary, async (retry, quarantine, signal) => {
        const plan = await factory(retry.subject, signal, quarantine);
        if (plan.source.boundary !== boundary) {
          throw new Error(`Recovery source factory for ${boundary} returned boundary ${plan.source.boundary}`);
        }
        return RecoveryContainment.each(plan.source, {
          ...plan.policy,
          signal,
          quarantine,
          retry,
        });
      });
    },
    has(boundary): boundary is RepeatableRecoveryBoundaryId {
      return factories.has(boundary as RepeatableRecoveryBoundaryId);
    },
    boundaries(): readonly RepeatableRecoveryBoundaryId[] {
      return repeatableRecoveryBoundaryIds.filter((boundary) => factories.has(boundary));
    },
    retry(boundary, retry, quarantine, signal): Promise<RecoveryReport<unknown>> {
      const factory = factories.get(boundary);
      if (factory === undefined) {
        throw new Error(`Recovery source factory is not registered for ${boundary}`);
      }
      return factory(retry, quarantine, signal);
    },
  };
}

/** Fails composition unless the runtime registry exactly matches the repeatable-boundary manifest. */
export function assertRecoverySourceRegistryComplete(sources: RecoverySourceRegistry): void {
  const boundaries = sources.boundaries();
  if (
    boundaries.length !== repeatableRecoveryBoundaryIds.length ||
    boundaries.some((boundary, index) => boundary !== repeatableRecoveryBoundaryIds[index])
  ) {
    throw new Error(
      `Recovery source registry is incomplete: expected ${repeatableRecoveryBoundaryIds.join(', ')}, received ${boundaries.join(', ')}`,
    );
  }
}

export type RecoveryQuarantineClearRequest = {
  readonly boundary: string;
  readonly key: string;
  readonly revision: string | null;
};

export type RecoveryQuarantineClearResult = RecoveryQuarantineClearRequest & {
  readonly disposition: 'advanced' | 'quarantined' | 'continuation';
};

export type RecoveryQuarantineClearErrorCode =
  | 'invalid-coordinate'
  | 'boundary-not-registered'
  | 'subject-not-found'
  | 'revision-mismatch'
  | 'continuation-not-active'
  | 'retry-in-progress'
  | 'lost-authority'
  | 'invalid-retry-report';

export class RecoveryQuarantineClearError extends Error {
  readonly code: RecoveryQuarantineClearErrorCode;

  constructor(code: RecoveryQuarantineClearErrorCode, message: string) {
    super(message);
    this.name = 'RecoveryQuarantineClearError';
    this.code = code;
  }
}

export interface RecoveryRetryQuarantinePort extends RecoveryQuarantinePort {
  claimRetry(request: RecoveryQuarantineClaim): boolean | Promise<boolean>;
  reclaimRetry(request: RecoveryQuarantineReclaim): boolean | Promise<boolean>;
}

export interface RecoveryQuarantineRetryService {
  clear(request: RecoveryQuarantineClearRequest, signal?: AbortSignal): Promise<RecoveryQuarantineClearResult>;
}

export type RecoveryQuarantineRetryServiceOptions = {
  readonly instanceId: string;
  readonly ids: Pick<IdPort, 'uuid'>;
  readonly quarantine: RecoveryRetryQuarantinePort;
  readonly sources: RecoverySourceRegistry;
};

const neverAbortedSignal = new AbortController().signal;

/** Creates the canonical-coordinator service that claims or reclaims one retained row before retrying it. */
export function createRecoveryQuarantineRetryService(
  options: RecoveryQuarantineRetryServiceOptions,
): RecoveryQuarantineRetryService {
  if (options.instanceId.length === 0) {
    throw new Error('Recovery retry owner instanceId must be non-empty');
  }

  return {
    async clear(request, signal = neverAbortedSignal): Promise<RecoveryQuarantineClearResult> {
      const subject = clearSubject(request);
      if (!options.sources.has(request.boundary)) {
        throw new RecoveryQuarantineClearError(
          'boundary-not-registered',
          `Recovery boundary is not registered: ${request.boundary}`,
        );
      }

      const current = await options.quarantine.read(request.boundary, request.key);
      if (current === null) {
        throw new RecoveryQuarantineClearError(
          'subject-not-found',
          `Recovery quarantine subject does not exist: ${request.boundary}:${request.key}`,
        );
      }
      if (!sameSubject(current.subject, subject)) {
        throw new RecoveryQuarantineClearError(
          'revision-mismatch',
          `Recovery quarantine revision changed for ${request.boundary}:${request.key}`,
        );
      }
      if (current.state === 'continuation') {
        throw new RecoveryQuarantineClearError(
          'continuation-not-active',
          `Recovery quarantine subject is a continuation: ${request.boundary}:${request.key}`,
        );
      }

      const token = options.ids.uuid();
      if (token.length === 0) {
        throw new Error('Recovery retry token must be non-empty');
      }
      const retry: RecoveryRetry = {
        subject,
        owner: options.instanceId,
        token,
      };

      let claimed: boolean;
      if (current.state === 'active') {
        claimed = await options.quarantine.claimRetry({
          boundary: request.boundary,
          subject,
          retry,
        });
      } else {
        const previousRetry = current.retry;
        if (previousRetry === undefined) {
          throw new Error(`Recovery retry authority is missing for ${request.boundary}:${request.key}`);
        }
        if (previousRetry.owner === options.instanceId) {
          throw new RecoveryQuarantineClearError(
            'retry-in-progress',
            `Recovery retry is already owned by this coordinator for ${request.boundary}:${request.key}`,
          );
        }
        claimed = await options.quarantine.reclaimRetry({
          boundary: request.boundary,
          subject,
          expectedRetry: previousRetry,
          retry,
        });
      }

      if (!claimed) {
        throw new RecoveryQuarantineClearError(
          'lost-authority',
          `Recovery quarantine changed while claiming ${request.boundary}:${request.key}`,
        );
      }

      const report = await options.sources.retry(request.boundary, retry, options.quarantine, signal);
      return {
        ...request,
        disposition: retryDisposition(report, request),
      };
    },
  };
}

function clearSubject(request: RecoveryQuarantineClearRequest): RecoverySubject {
  if (
    request.boundary.length === 0 ||
    request.key.length === 0 ||
    (request.revision !== null && request.revision.length === 0)
  ) {
    throw new RecoveryQuarantineClearError(
      'invalid-coordinate',
      'Recovery quarantine clear requires a non-empty boundary, key, and non-empty revision when present',
    );
  }
  return {
    key: request.key,
    revision: request.revision === null ? { kind: 'until-cleared' } : { kind: 'fingerprint', value: request.revision },
  };
}

function sameSubject(left: RecoverySubject, right: RecoverySubject): boolean {
  return (
    left.key === right.key &&
    left.revision.kind === right.revision.kind &&
    (left.revision.kind === 'until-cleared' ||
      (right.revision.kind === 'fingerprint' && left.revision.value === right.revision.value))
  );
}

function retryDisposition(
  report: RecoveryReport<unknown>,
  request: RecoveryQuarantineClearRequest,
): RecoveryQuarantineClearResult['disposition'] {
  const dispositions = report.advanced + report.quarantined + report.deferred;
  if (dispositions !== 1 || report.skipped !== 0) {
    throw new RecoveryQuarantineClearError(
      'invalid-retry-report',
      `Recovery retry returned an invalid one-shot report for ${request.boundary}:${request.key}`,
    );
  }
  if (report.advanced === 1) return 'advanced';
  if (report.quarantined === 1) return 'quarantined';
  return 'continuation';
}
