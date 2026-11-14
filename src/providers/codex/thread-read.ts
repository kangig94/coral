import type { AppServerTransport } from '../contract.js';

type ThreadRead = { readers: Set<(response: unknown) => void> };
const connectionReads = new WeakMap<object, Map<string, ThreadRead>>();

function pendingThreadRead(lease: AppServerTransport, threadId: string): ThreadRead {
  const connection = lease.connectionIdentity ?? lease.closed;
  let reads = connectionReads.get(connection);
  if (reads === undefined) {
    const pending = new Map<string, ThreadRead>();
    reads = pending;
    connectionReads.set(connection, pending);
    const clear = (): void => {
      for (const read of pending.values()) read.readers.clear();
      pending.clear();
      connectionReads.delete(connection);
    };
    void lease.closed.then(clear, clear);
  }
  let read = reads.get(threadId);
  if (read === undefined) {
    const pending = reads;
    const request: ThreadRead = { readers: new Set() };
    read = request;
    reads.set(threadId, request);
    const complete = (response: unknown): void => {
      pending.delete(threadId);
      for (const reader of [...request.readers]) {
        if (request.readers.delete(reader)) reader(response);
      }
    };
    void lease.rpc('thread/read', { threadId, includeTurns: true }).then(complete, () => complete(null));
  }
  return read;
}

/** Stopped readers must release their callbacks without duplicating the connection's unanswered request. */
export function observeCodexThreadRead(
  lease: AppServerTransport,
  threadId: string,
  onResponse: (response: unknown) => void,
): () => void {
  const readers = pendingThreadRead(lease, threadId).readers;
  readers.add(onResponse);
  return () => {
    readers.delete(onResponse);
  };
}
