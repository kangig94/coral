import {
  SERIALIZED_THROWN_IDENTIFIER_MAX_LENGTH,
  SERIALIZED_THROWN_IDENTIFIER_PATTERN,
  serializeThrown,
  thrownErrnoCode,
  type SerializedThrown,
} from '../infra/error-format.js';
import { sha256Hex } from '../infra/hash.js';
import type { ProcessIncarnation } from '../infra/node-process.js';
import type { StoragePort, TimePort } from '../infra/port-types.js';
import {
  shutdownRemainderRecordPath,
  shutdownRemainderStagePath,
  type ShutdownRemainderRecord,
} from '../infra/shutdown-remainder-record.js';
import { shutdownModeFromReason, type ShutdownReason, type ShutdownUndischarged } from '../infra/shutdown-contract.js';
import { nowIsoString } from '../infra/time.js';

type ShutdownRemainderWriteRuntime = Readonly<{
  storage: Pick<StoragePort, 'mkdirSync' | 'readFileSync' | 'renameSync' | 'unlinkSync' | 'writeAtomicSync'>;
  time: Pick<TimePort, 'now'>;
  runDir: string;
  writer: Readonly<{ pid: number; incarnation: ProcessIncarnation | null }>;
}>;

export type ShutdownRemainderRecordInput = Readonly<{
  instanceId: string;
  reason: ShutdownReason;
  undischarged: readonly ShutdownUndischarged[];
}>;

export type ShutdownRemainderWriteDisposition =
  | Readonly<{ kind: 'published' }>
  | Readonly<{
      kind: 'refused';
      operation: 'publish';
      code: 'write-returned-false' | 'filesystem-operation-failed';
      correlation: string;
      diagnostic: SerializedThrown;
    }>
  | Readonly<{
      kind: 'verification-unavailable';
      operation: 'verify-publication';
      code: 'filesystem-operation-failed';
      correlation: string;
      diagnostic: SerializedThrown;
    }>;

function shutdownRemainderWriteFailure<
  Operation extends 'publish' | 'verify-publication',
  Code extends 'write-returned-false' | 'filesystem-operation-failed',
>(
  operation: Operation,
  code: Code,
  error: unknown,
): Readonly<{
  operation: Operation;
  code: Code;
  correlation: string;
  diagnostic: SerializedThrown;
}> {
  const diagnostic = serializeThrown(error);
  return {
    operation,
    code,
    correlation: sha256Hex(`${operation}\0${code}\0${JSON.stringify(diagnostic)}`),
    diagnostic,
  };
}

export function recordShutdownRemainder(
  runtime: ShutdownRemainderWriteRuntime,
  input: ShutdownRemainderRecordInput,
): ShutdownRemainderWriteDisposition {
  if (
    input.instanceId.length === 0 ||
    input.instanceId.length > SERIALIZED_THROWN_IDENTIFIER_MAX_LENGTH ||
    !SERIALIZED_THROWN_IDENTIFIER_PATTERN.test(input.instanceId)
  ) {
    throw new Error(
      `Shutdown remainder instanceId is not a valid identifier: it must match ${SERIALIZED_THROWN_IDENTIFIER_PATTERN} within ${SERIALIZED_THROWN_IDENTIFIER_MAX_LENGTH} characters.`,
    );
  }
  if (!Number.isSafeInteger(runtime.writer.pid) || runtime.writer.pid <= 0) {
    throw new Error('Shutdown remainder writer pid must be a positive safe integer.');
  }
  const path = shutdownRemainderRecordPath(runtime.runDir);
  const stagePath = shutdownRemainderStagePath(runtime.runDir, runtime.writer);
  const record: ShutdownRemainderRecord = {
    instanceId: input.instanceId,
    recordedAt: nowIsoString(runtime.time),
    reason: input.reason,
    mode: shutdownModeFromReason(input.reason),
    entries: input.undischarged,
  };
  const serializedRecord = `${JSON.stringify(record, null, 2)}\n`;
  // Constraint: do not use `writeAtomicDurableSync`; `docs/design-rationale.md` §12.5 excludes its unbounded
  // journal commit waits from the coordinator exit path.
  const removeStage = (): void => {
    for (const candidate of [stagePath, `${stagePath}.tmp`]) {
      try {
        runtime.storage.unlinkSync(candidate);
      } catch {
        // Publication cleanup must preserve the originating failure.
      }
    }
  };
  try {
    runtime.storage.mkdirSync(runtime.runDir, { recursive: true });
    if (
      !runtime.storage.writeAtomicSync(stagePath, serializedRecord, {
        encoding: 'utf-8',
        mode: 0o600,
      })
    ) {
      removeStage();
      return {
        kind: 'refused',
        ...shutdownRemainderWriteFailure('publish', 'write-returned-false', 'record publication returned false'),
      };
    }
    try {
      runtime.storage.renameSync(stagePath, path);
    } catch (error: unknown) {
      if (thrownErrnoCode(error) === 'ENOENT') {
        try {
          if (runtime.storage.readFileSync(path, 'utf-8') === serializedRecord) return { kind: 'published' };
        } catch (verificationError: unknown) {
          removeStage();
          return {
            kind: 'verification-unavailable',
            ...shutdownRemainderWriteFailure('verify-publication', 'filesystem-operation-failed', verificationError),
          };
        }
      }
      throw error;
    }
    return { kind: 'published' };
  } catch (error: unknown) {
    removeStage();
    return {
      kind: 'refused',
      ...shutdownRemainderWriteFailure('publish', 'filesystem-operation-failed', error),
    };
  }
}
