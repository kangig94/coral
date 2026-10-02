import { truncate } from '../../infra/text.js';
import { type FileLockLease, waitSync } from '../../infra/fs-lock.js';
import { type Runtime } from '../../runtime/ports.js';
import { backendLog } from '../../infra/backend-log.js';
import {
  type StoreEpochFailureCause,
  type StoreEpochOpenFailureStage,
  type StoreEpochClassification,
  type StoreEpoch,
} from './types.js';
import {
  STORE_EPOCH_CLASSIFICATION_STRING_MAX_LENGTH,
  STORE_EPOCH_FAILURE_CAUSE_UNAVAILABLE,
  SQLITE_PRIMARY_ERRCODE_MASK,
  SQLITE_NOTADB_ERRCODE,
  SQLITE_CORRUPT_ERRCODE,
  STORE_EPOCH_OPEN_RETRY_BUDGET_MS,
  STORE_EPOCH_OPEN_RETRY_INTERVAL_MS,
} from './constants.js';

export function errorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

function failureCause(error: unknown): StoreEpochFailureCause {
  try {
    const reported = typeof error === 'object' && error !== null ? error : null;
    const reportedCode =
      reported !== null && 'code' in reported && typeof reported.code === 'string'
        ? reported.code
        : reported !== null && 'errno' in reported && typeof reported.errno === 'string'
          ? reported.errno
          : undefined;
    const code =
      reportedCode === undefined ? undefined : truncate(reportedCode, STORE_EPOCH_CLASSIFICATION_STRING_MAX_LENGTH);
    const errcode =
      reported !== null &&
      'errcode' in reported &&
      typeof reported.errcode === 'number' &&
      Number.isInteger(reported.errcode)
        ? reported.errcode
        : undefined;
    const message = truncate(
      (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, ' '),
      STORE_EPOCH_CLASSIFICATION_STRING_MAX_LENGTH,
    );
    return {
      ...(code === undefined ? {} : { code }),
      ...(errcode === undefined ? {} : { errcode }),
      message,
    };
  } catch {
    return { message: STORE_EPOCH_FAILURE_CAUSE_UNAVAILABLE };
  }
}

export function unavailableClassification(
  stage?: StoreEpochOpenFailureStage,
  error?: unknown,
): StoreEpochClassification {
  return stage === undefined ? { kind: 'unavailable' } : { kind: 'unavailable', stage, cause: failureCause(error) };
}

export function classificationAfterLeaseRelease(
  lease: FileLockLease,
  classification: StoreEpochClassification,
): StoreEpochClassification {
  try {
    lease();
    return classification;
  } catch (error: unknown) {
    return { ...classification, releaseFailure: failureCause(error) };
  }
}

export function classificationWithAttempts(
  classification: StoreEpochClassification,
  attempts: number,
): StoreEpochClassification {
  if (classification.kind === 'unavailable' && classification.cause !== undefined) {
    return { ...classification, cause: { ...classification.cause, attempts } };
  }
  if (classification.kind === 'absent') return { ...classification, attempts };
  return classification;
}

function sqlitePrimaryErrcode(classification: StoreEpochClassification): number | null {
  if (classification.kind !== 'unavailable' || classification.cause?.errcode === undefined) return null;
  return classification.cause.errcode & SQLITE_PRIMARY_ERRCODE_MASK;
}

export function isDecisiveStoreEpochFailure(classification: StoreEpochClassification): boolean {
  if (
    classification.kind === 'older-incompatible' ||
    classification.kind === 'newer-incompatible' ||
    classification.kind === 'corrupt-or-unsupported'
  ) {
    return true;
  }
  const errcode = sqlitePrimaryErrcode(classification);
  return errcode === SQLITE_NOTADB_ERRCODE || errcode === SQLITE_CORRUPT_ERRCODE;
}

export function storeEpochRetryDeadline(runtime: Runtime): bigint {
  return runtime.time.monotonicNow() + BigInt(STORE_EPOCH_OPEN_RETRY_BUDGET_MS);
}

export function remainingStoreEpochRetryBudgetMs(runtime: Runtime, deadline: bigint): number {
  return Math.max(0, Number(deadline - runtime.time.monotonicNow()));
}

export function waitForStoreEpochRetry(runtime: Runtime, deadline: bigint, minimumAttemptMs: number): boolean {
  const remainingMs = remainingStoreEpochRetryBudgetMs(runtime, deadline);
  if (remainingMs === 0) return false;
  waitSync(Math.min(STORE_EPOCH_OPEN_RETRY_INTERVAL_MS, remainingMs));
  return remainingStoreEpochRetryBudgetMs(runtime, deadline) >= minimumAttemptMs;
}

export function logStoreEpochReplacement(
  supersedes: StoreEpoch | null,
  classification: StoreEpochClassification,
): void {
  try {
    if (
      classification.kind === 'unavailable' &&
      classification.stage !== undefined &&
      classification.cause !== undefined
    ) {
      backendLog.warn(
        `Store epoch mint decision: superseded=${supersedes ?? 'none'} classification=${classification.kind} stage=${classification.stage} cause=${JSON.stringify(classification.cause)}`,
      );
      return;
    }
    if (classification.kind === 'absent' && classification.candidates !== undefined) {
      backendLog.warn(
        `Store epoch mint decision: superseded=${supersedes ?? 'none'} classification=${classification.kind} stage=epoch-observation cause=${JSON.stringify(classification.candidates)}`,
      );
      return;
    }
    backendLog.warn(
      `Store epoch mint decision: superseded=${supersedes ?? 'none'} classification=${classification.kind} cause=${classification.kind}`,
    );
  } catch {
    return;
  }
}
