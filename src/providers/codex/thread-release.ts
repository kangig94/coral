import { z } from 'zod';
import type { TimePort } from '../../infra/port-types.js';
import type { AppServerSession, AppServerTransport } from '../contract.js';
import { ProviderRpcError } from '../app-server-transport.js';
import { errorMessage } from '../../infra/error-format.js';

const RELEASE_OBSERVATION_MS = 1_000;
const threadOwners = new WeakMap<object, Map<string, CodexThreadOwnership>>();
const claimState = Symbol('codex-thread-claim');
const unsubscribeResponseSchema = z.object({ status: z.enum(['unsubscribed', 'notLoaded', 'notSubscribed']) });

export type CodexThreadOwnership = Readonly<{
  threadId: string;
  token: symbol;
  connection: object;
  [claimState]: ThreadClaim;
}>;

type ThreadClaim = {
  phase: 'provisional' | 'loaded' | 'failed';
  predecessor: CodexThreadOwnership | null;
  release: ThreadReleaseObservation | null;
};

type ThreadReleaseObservation = {
  phase: 'waiting' | 'dispatched' | 'superseded' | 'finished';
  requested: boolean;
  handoff: () => void;
};

export function acquireCodexThread(lease: AppServerTransport, threadId: string): CodexThreadOwnership {
  const connection = lease.connectionIdentity ?? lease.closed;
  let owners = threadOwners.get(connection);
  if (owners === undefined) {
    const connectionOwners = new Map<string, CodexThreadOwnership>();
    owners = connectionOwners;
    threadOwners.set(connection, connectionOwners);
    const clear = (): void => {
      connectionOwners.clear();
      threadOwners.delete(connection);
    };
    void lease.closed.then(clear, clear);
  }
  const token = Symbol(threadId);
  const ownership: CodexThreadOwnership = {
    threadId,
    token,
    connection,
    [claimState]: { phase: 'provisional', predecessor: owners.get(threadId) ?? null, release: null },
  };
  owners.set(threadId, ownership);
  return ownership;
}

function retireCodexThread(ownership: CodexThreadOwnership): void {
  const owners = threadOwners.get(ownership.connection);
  if (owners?.get(ownership.threadId)?.token === ownership.token) owners.delete(ownership.threadId);
}

export function confirmCodexThreadLoaded(ownership: CodexThreadOwnership): void {
  const claim = ownership[claimState];
  claim.phase = 'loaded';
  claim.predecessor = null;
}

export function handoffFailedCodexResume(ownership: CodexThreadOwnership): void {
  const claim = ownership[claimState];
  if (claim.phase !== 'provisional') return;
  claim.phase = 'failed';
  const owners = threadOwners.get(ownership.connection);
  if (owners?.get(ownership.threadId)?.token !== ownership.token) return;
  let predecessor = claim.predecessor;
  while (predecessor !== null && predecessor[claimState].phase === 'failed') {
    predecessor = predecessor[claimState].predecessor;
  }
  claim.predecessor = null;
  if (predecessor === null) {
    retireCodexThread(ownership);
    return;
  }
  const release = predecessor[claimState].release;
  if (release === null || release.phase === 'waiting') {
    owners.set(ownership.threadId, predecessor);
  } else if (!release.requested) {
    release.handoff();
  } else {
    retireCodexThread(ownership);
  }
}

type ThreadReleaseDisposition =
  | { kind: 'superseded' }
  | { kind: 'accepted' }
  | { kind: 'refused'; reason: string }
  | { kind: 'unknown'; reason: string };

export function releaseCodexThread(
  lease: AppServerSession,
  time: Pick<TimePort, 'setTimeout' | 'clearTimeout'>,
  ownership: CodexThreadOwnership,
  threadUse: Promise<unknown> | null,
  report: (message: string) => void,
): Promise<ThreadReleaseDisposition> {
  const { threadId, token, connection } = ownership;
  const isCurrent = (): boolean => threadOwners.get(connection)?.get(threadId)?.token === token;
  let dispatchEnabled = true;
  const observation: ThreadReleaseObservation = {
    phase: 'waiting',
    requested: false,
    handoff: () => {
      const cleanup = acquireCodexThread(lease, threadId);
      confirmCodexThreadLoaded(cleanup);
      void releaseCodexThread(lease, time, cleanup, threadUse, report);
    },
  };
  ownership[claimState].release = observation;
  let timer: ReturnType<TimePort['setTimeout']>;
  const timeout = new Promise<ThreadReleaseDisposition>((resolve) => {
    timer = time.setTimeout(() => {
      dispatchEnabled = false;
      if (!observation.requested && !isCurrent()) {
        observation.phase = 'superseded';
        resolve({ kind: 'superseded' });
        return;
      }
      observation.phase = 'finished';
      resolve({
        kind: 'unknown',
        reason: observation.requested
          ? 'release observation expired while awaiting reply'
          : 'thread use has not finished within 1000 ms',
      });
    }, RELEASE_OBSERVATION_MS);
  });
  const release = async (): Promise<ThreadReleaseDisposition> => {
    try {
      // Steering and interrupt use must finish before unloading the thread.
      if (threadUse !== null) await threadUse;
      if (!dispatchEnabled) return { kind: 'unknown', reason: 'release observation expired before dispatch' };
      if (!isCurrent()) {
        observation.phase = 'superseded';
        return { kind: 'superseded' };
      }
      observation.requested = true;
      observation.phase = 'dispatched';
      const response = unsubscribeResponseSchema.safeParse(
        await lease.rpc<unknown>('thread/unsubscribe', { threadId }),
      );
      if (!response.success) return { kind: 'unknown', reason: 'malformed unsubscribe reply' };
      return response.data.status === 'notSubscribed'
        ? { kind: 'refused', reason: 'notSubscribed' }
        : { kind: 'accepted' };
    } catch (error: unknown) {
      return {
        kind:
          observation.requested &&
          error instanceof ProviderRpcError &&
          error.method === 'thread/unsubscribe' &&
          Number.isInteger(error.rpcCode) &&
          typeof error.providerMessage === 'string'
            ? 'refused'
            : 'unknown',
        reason: errorMessage(error),
      };
    }
  };
  return Promise.race([release(), timeout]).then((disposition) => {
    time.clearTimeout(timer);
    dispatchEnabled = false;
    if (observation.phase !== 'superseded') observation.phase = 'finished';
    retireCodexThread(ownership);
    if (disposition.kind === 'unknown' || disposition.kind === 'refused') {
      const status = disposition.kind === 'unknown' ? 'unconfirmed' : 'refused';
      try {
        report(
          `Codex thread ${threadId} release ${status} (${disposition.reason}); the writer lock may remain until its host closes.`,
        );
      } catch {
        // Diagnostic delivery cannot hold execution ownership.
      }
    }
    return disposition;
  });
}
