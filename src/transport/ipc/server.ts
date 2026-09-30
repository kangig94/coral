import type { ProcessIncarnation } from '../../infra/node-process.js';
import { timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server as NetServer, type Socket } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import * as timers from 'node:timers';
import type { ZodError } from 'zod';
import type { HttpHandlerPorts } from '../server-ports.js';
import { formatZodError } from '../validation.js';
import {
  encode,
  encodeIpcErrorData,
  decode,
  type IpcAuthMetadata,
  type JsonRpcEnvelope,
  type JsonRpcErrorEnvelope,
  type JsonRpcRequestEnvelope,
  type JsonRpcResponseEnvelope,
} from './json-rpc.js';

import {
  ensurePrivateSocketDir,
  SocketDirectoryError,
  type SocketDirectoryRefusal,
} from '../../infra/private-socket-directory.js';
import { isRelocatedSocket } from '../../infra/path/index.js';
import { documentedCoralSetupError, type DocumentedCoralSetupErrorCode } from '../../runtime/errors.js';
import { createLineFramer, FrameTooLargeError } from '../line-framing.js';
import {
  providerHostEvictRpcSpec,
  providerProxySetContainBooleanRpcSpec,
  providerProxySetContainRpcSpec,
  rpcCatalog,
  type RpcMethodSpec,
} from '../rpc/catalog.js';
import { readIpcOperationalSpec, type IpcOperationalSpec } from '../rpc/operational-catalog.js';
import { JOBS_WAIT_EXTENSIONS } from '../rpc/jobs.js';
import { authorizationFailurePayload, type CatalogRequestExecution, executeCatalogRequest } from '../dispatch.js';
import { writeAuditEvent, writeAuthorizationDecisionAudit } from '../../infra/audit-log.js';
import { buildJsonRpcError } from '../../infra/json-rpc.js';
import { formatError } from '../../infra/error-format.js';
import { isNoEntryError } from '../../infra/fs-errors.js';
import { linkRequestLeaseIdentity } from '../../runtime/request-lease-identity.js';
import { acquireDirectoryLock } from '../../infra/fs-lock.js';
import type { Capability } from '../../security/capability.js';
import type { Principal } from '../../security/principal.js';
import type { ChildAuthChallenge } from '../../security/child-credential.js';
import { authorize } from '../../security/policy/authorize.js';
import { buildTransportErrorResponse } from '../error-response.js';
import { lifecycleRefusalResult } from '../lifecycle-refusal.js';

const INVALID_JSON_RESPONSE = {
  code: 'invalid_request',
  message: 'Invalid JSON body',
};
const SHUTDOWN_UNAUTHORIZED_RESPONSE = {
  code: 'shutdown_unauthorized',
  message:
    'Shutdown refused: the shutdown capability is missing or invalid. The incumbent keeps serving, and any upgrade is deferred.',
};
const KB_RESTART_UNAUTHORIZED_RESPONSE = {
  code: 'shutdown_unauthorized',
  message: 'Manual KB daemon restart requires shutdown capability',
};
const IPC_UNAUTHORIZED_RESPONSE = {
  code: 'unauthorized',
  message: 'IPC boot token or child principal required',
};
const CHALLENGE_UNAVAILABLE_RESPONSE = {
  code: 'unauthorized',
  message: 'This coordinator issues no further authentication challenge on this connection',
};
const CHILD_CREDENTIAL_UNREADABLE_RESPONSE = {
  code: 'child_credential_unavailable',
  message:
    "This nested Coral command's credential cannot be verified because its authorization record is unreadable, so it was refused. Other jobs are unaffected. Retry the parent workflow instead of editing CORAL_* environment variables.",
};

/**
 * A challenge lives only in the memory of the connection it was issued on, and is taken from there before the
 * request after it is dispatched, so it authenticates at most one request.
 */
type IpcConnectionChallenge = Readonly<{
  taken: ChildAuthChallenge | null;
  issued: boolean;
  awaitProof(challenge: ChildAuthChallenge): void;
}>;

type IpcAuthentication =
  | Readonly<{ kind: 'principal'; principal: Principal | null }>
  | Readonly<{ kind: 'credential-unreadable'; credentialId: string }>;

const IPC_OPERATOR_PRINCIPAL: Principal = {
  subject: 'operator',
  transport: 'ipc',
  credential: { kind: 'boot-token', id: 'ipc-operator' },
  binding: { kind: 'unbound' },
};
const IPC_BOOTSTRAP_LIVENESS_PRINCIPAL: Principal = {
  subject: 'agent',
  transport: 'ipc',
  credential: { kind: 'bootstrap-liveness', id: 'ipc-ping' },
  binding: { kind: 'unbound' },
  attenuatedCaps: new Set<Capability>(['liveness']),
};
const KB_RESTART_UNAVAILABLE_RESPONSE = {
  code: 'not_implemented',
  message: 'KB daemon supervisor is not available',
};
const IPC_DEFAULT_MAX_OPEN_SOCKETS = 128;
const IPC_DEFAULT_FIRST_FRAME_TIMEOUT_MS = 5_000;
const IPC_DEFAULT_MAX_AGGREGATE_PENDING_FRAME_BYTES = 32 * 1024 * 1024;
const IPC_DEFAULT_WRITE_DRAIN_TIMEOUT_MS = 5_000;

export type IpcServerOptions = {
  readonly maxOpenSockets?: number;
  readonly firstFrameTimeoutMs?: number;
  readonly maxAggregatePendingFrameBytes?: number;
  readonly writeDrainTimeoutMs?: number;
};

export type IpcListener = {
  readonly server: NetServer;
  readonly sockets: Set<Socket>;
  readonly compatibilityListeners?: IpcListener[];
  createCompatibilityListener?(): IpcListener;
  acceptSocket?(socket: Socket, pendingFrameBase64?: string): void;
  forwardConnections?(forward: (socket: Socket, pendingFrameBase64: string) => void): () => void;
  drainConnections?(): Promise<void>;
  socketPath: string | null;
  inheritedServer?: NetServer;
  unlinkInheritedOnClose?: boolean;
  onShutdownRecoveryAccepted?: (() => void) | null;
};

type IpcResourceTracker = {
  readonly sockets: Set<Socket>;
  readonly maxOpenSockets: number;
  readonly maxAggregatePendingFrameBytes: number;
  aggregatePendingFrameBytes: number;
};

export type IpcDispatchEntry = {
  readonly method: string;
  readonly spec: RpcMethodSpec<unknown, unknown>;
  dispatch(request: unknown, principal: Principal, abortSignal?: AbortSignal): Promise<CatalogRequestExecution>;
};

function transportErrorResponse(message: string, data?: unknown): JsonRpcErrorEnvelope {
  return {
    kind: 'error',
    id: null,
    error: buildJsonRpcError(-32603, message, data),
  };
}

function requestErrorResponse(
  id: JsonRpcRequestEnvelope['id'] | null,
  message: string,
  data?: unknown,
): JsonRpcErrorEnvelope {
  return {
    kind: 'error',
    id,
    error: buildJsonRpcError(-32603, message, encodeIpcErrorData(data)),
  };
}

function validationErrorResponse(id: JsonRpcRequestEnvelope['id'], error: ZodError): JsonRpcErrorEnvelope {
  return {
    kind: 'error',
    id,
    error: buildJsonRpcError(-32602, 'Invalid params', {
      issues: error.issues,
      message: formatZodError(error),
    }),
  };
}

function methodNotFoundResponse(id: JsonRpcRequestEnvelope['id']): JsonRpcErrorEnvelope {
  return {
    kind: 'error',
    id,
    error: buildJsonRpcError(-32601, 'Method not found'),
  };
}

function invalidRequestResponse(id: JsonRpcRequestEnvelope['id'] | null): JsonRpcErrorEnvelope {
  return {
    kind: 'error',
    id,
    error: buildJsonRpcError(-32600, 'Invalid request'),
  };
}

function constantTimeCredentialMatch(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf-8');
  const bBuf = Buffer.from(b, 'utf-8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function waitForSocketDrain(socket: Socket, timeoutMs: number): Promise<boolean> {
  if (socket.destroyed || socket.writableEnded) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timeout = timers.setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();

    const finish = (drained: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      timers.clearTimeout(timeout);
      socket.off('drain', onDrain);
      socket.off('close', onClose);
      socket.off('error', onError);
      resolve(drained);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const onError = () => finish(false);

    socket.once('drain', onDrain);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

async function writeEnvelope(
  socket: Socket,
  envelope: JsonRpcEnvelope,
  options: { drainTimeoutMs?: number } = {},
): Promise<boolean> {
  if (socket.destroyed || socket.writableEnded) {
    return false;
  }

  let accepted: boolean;
  try {
    accepted = socket.write(`${encode(envelope)}\n`);
  } catch {
    return false;
  }

  if (accepted) {
    return true;
  }

  const drained = await waitForSocketDrain(socket, options.drainTimeoutMs ?? IPC_DEFAULT_WRITE_DRAIN_TIMEOUT_MS);
  if (!drained && !socket.destroyed) {
    socket.destroy();
  }
  return drained;
}

export function ipcAdapter(spec: RpcMethodSpec<unknown, unknown>, rpcPorts: HttpHandlerPorts): IpcDispatchEntry {
  return {
    method: spec.name,
    spec,
    dispatch: async (request, principal, abortSignal) =>
      await executeCatalogRequest(spec, request, rpcPorts, principal, abortSignal),
  };
}

export function buildCoordinatorIpcDispatchTable(rpcPorts: HttpHandlerPorts): readonly IpcDispatchEntry[] {
  return rpcCatalog.map((spec) => ipcAdapter(spec, rpcPorts));
}

function acceptedDrainingRecovery(method: string): boolean {
  return (
    method === 'jobs.abort' ||
    method === providerProxySetContainRpcSpec.name ||
    method === providerProxySetContainBooleanRpcSpec.name ||
    method === providerHostEvictRpcSpec.name
  );
}

function armShutdownRecoveryContinuation(socket: Socket, continuation: () => void): () => void {
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    socket.off('finish', complete);
    socket.off('close', complete);
    continuation();
  };

  socket.once('finish', complete);
  socket.once('close', complete);
  if (socket.destroyed || socket.writableEnded) complete();
  return complete;
}

/** The bearer `child` protocol is refused outright: this build never issues a credential it could verify. */
function authenticateIpcRequest(
  request: JsonRpcRequestEnvelope,
  challenge: ChildAuthChallenge | null,
  rpcPorts: HttpHandlerPorts,
): IpcAuthentication {
  const auth: IpcAuthMetadata | undefined = request.auth;
  if (auth?.kind === 'child-proof') {
    const authentication = rpcPorts.childPrincipals?.authenticate(
      auth,
      challenge,
      { method: request.method, id: request.id, params: request.params },
      rpcPorts.identity.now(),
    ) ?? { kind: 'refused' as const };
    if (authentication.kind === 'credential-unreadable') return authentication;
    return {
      kind: 'principal',
      principal: authentication.kind === 'authenticated' ? authentication.principal : null,
    };
  }

  if (auth?.kind !== 'boot' || !constantTimeCredentialMatch(auth.token, rpcPorts.identity.bootToken)) {
    return { kind: 'principal', principal: null };
  }
  return { kind: 'principal', principal: IPC_OPERATOR_PRINCIPAL };
}

function routeCredentialRefusal(spec: IpcOperationalSpec): typeof IPC_UNAUTHORIZED_RESPONSE | null {
  if (spec.dispatch.kind === 'shutdown') {
    return SHUTDOWN_UNAUTHORIZED_RESPONSE;
  }
  if (spec.dispatch.kind === 'kb-restart') {
    return KB_RESTART_UNAUTHORIZED_RESPONSE;
  }
  return null;
}

function authorizeIpcOperation(
  request: JsonRpcRequestEnvelope,
  spec: IpcOperationalSpec,
  principal: Principal | null,
): JsonRpcErrorEnvelope | null {
  const requestedBinding = { kind: 'unbound' } as const;
  const authz = authorize(principal, spec.requires, requestedBinding);
  writeAuthorizationDecisionAudit(principal, spec.id, authz, requestedBinding);
  if (authz.ok) {
    return null;
  }
  const credentialRefusal = routeCredentialRefusal(spec);
  // `IPC_UNAUTHORIZED_RESPONSE` names a credential the caller never presented; a principal that authenticated
  // and only lacks the capability is a settled authorization answer, and must read the same on this gate as
  // on catalog dispatch or the operator loses the nested-session instruction and its exit code.
  if (credentialRefusal !== null || principal === null) {
    const payload = credentialRefusal ?? IPC_UNAUTHORIZED_RESPONSE;
    return requestErrorResponse(request.id, payload.message, payload);
  }
  const { code, message, detail } = authorizationFailurePayload(authz, principal);
  return requestErrorResponse(request.id, message, { code, message, detail });
}

function readPingSnapshot(rpcPorts: HttpHandlerPorts): {
  status: string;
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace: string;
  instanceId: string;
  pid: number;
  incarnation?: ProcessIncarnation;
  jobsWaitExtensions: readonly string[];
  sentinel?: { version: 1; id: string };
} {
  const health = rpcPorts.health.read();
  return {
    status: health.status,
    version: health.version,
    bundleHash: health.bundleHash,
    flavor: health.flavor,
    namespace: health.namespace,
    instanceId: health.instanceId,
    pid: health.pid,
    ...(health.incarnation === undefined ? {} : { incarnation: health.incarnation }),
    ...(health.sentinel === undefined ? {} : { sentinel: health.sentinel }),
    jobsWaitExtensions: JOBS_WAIT_EXTENSIONS,
  };
}

async function listenSocket(server: NetServer, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

async function clearStaleSocket(socketPath: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.once('connect', () => {
        socket.destroy();
        reject(new Error('socket-in-use'));
      });
      socket.once('error', (error: Error) => {
        socket.destroy();
        reject(error);
      });
    });
    return false;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ECONNREFUSED' && code !== 'ENOENT') {
      return false;
    }
  }

  try {
    unlinkSync(socketPath);
    return true;
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return true;
    }
    throw error;
  }
}

/**
 * Bind result distinguishes "stale orphan socket file" (auto-cleared) from
 * "live incumbent listening" so handoff callers can react instead of being
 * killed by `EADDRINUSE`. The next binder is the only path-cleanup authority.
 */
export type BindSocketResult = { kind: 'bound' } | { kind: 'incumbent'; reason: 'live-listener' };

export type PublishedIpcSocketAddress = Readonly<{
  socketPath: string;
  ownedSocketName: string;
}>;

export type ListenIpcServerResult =
  | Readonly<{ kind: 'bound'; socketPath: string }>
  | Readonly<{ kind: 'incumbent'; socketPath: string }>;

function staleSocketClearLockDir(socketPath: string): string {
  return join(dirname(socketPath), `${basename(socketPath)}.clear.lock`);
}

/**
 * One code may not span both a settled verdict and no verdict — see errorCodeToExit in src/cli/errors.ts.
 */
const SOCKET_DIRECTORY_REFUSAL_CODES = {
  foreign: 'coordinator_socket_dir_insecure',
  unusable: 'coordinator_socket_dir_insecure',
  unsecurable: 'coordinator_socket_dir_insecure',
  unverified: 'coordinator_socket_dir_unverified',
} as const satisfies Record<SocketDirectoryRefusal, DocumentedCoralSetupErrorCode>;

/**
 * A relocated socket shares one root with every other user on the host, so its parent is asserted rather
 * than assumed. A run directory is not shared and must not be held to the same mode.
 */
function prepareSocketParent(socketPath: string): void {
  const directory = resolve(dirname(socketPath));
  if (!isRelocatedSocket(directory)) {
    mkdirSync(directory, { recursive: true });
    return;
  }
  const uid = process.getuid?.() ?? 0;
  try {
    ensurePrivateSocketDir(directory, uid, { chmodSync, lstatSync, mkdirSync, statSync });
  } catch (error: unknown) {
    if (!(error instanceof SocketDirectoryError)) throw error;
    throw documentedCoralSetupError({
      code: SOCKET_DIRECTORY_REFUSAL_CODES[error.refusal],
      reason: error.refusal,
      directory,
      socketPath,
      uid: error.uid,
      cause: error.detail ?? error.message,
    });
  }
}

function assertPublishedSocketAddress(address: PublishedIpcSocketAddress): void {
  if (basename(address.socketPath) !== address.ownedSocketName) {
    throw new Error(`Published coordinator socket is outside Coral's namespace: ${address.socketPath}`);
  }
  // An absent path has nothing to unlink, which is the only authority this address is being admitted for.
  // Anything that exists and is not a socket is refused rather than cleared.
  let entry;
  try {
    entry = lstatSync(address.socketPath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }
  if (!entry.isSocket()) {
    throw new Error(`Published coordinator socket path is not a socket: ${address.socketPath}`);
  }
}

async function bindSocketAtAddress(
  server: NetServer,
  address: string | PublishedIpcSocketAddress,
): Promise<BindSocketResult> {
  const socketPath = typeof address === 'string' ? address : address.socketPath;
  if (typeof address === 'string') {
    prepareSocketParent(socketPath);
  } else {
    assertPublishedSocketAddress(address);
  }

  const finalize = (): void => {
    if (process.platform !== 'win32') {
      try {
        chmodSync(socketPath, 0o600);
      } catch {
        return;
      }
    }
  };

  try {
    await listenSocket(server, socketPath);
    finalize();
    return { kind: 'bound' };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
      throw error;
    }
  }

  const releaseLock = await acquireDirectoryLock(staleSocketClearLockDir(socketPath));
  try {
    try {
      await listenSocket(server, socketPath);
      finalize();
      return { kind: 'bound' };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        throw error;
      }
    }

    if (typeof address !== 'string') assertPublishedSocketAddress(address);
    const cleared = await clearStaleSocket(socketPath);
    if (cleared) {
      try {
        await listenSocket(server, socketPath);
        finalize();
        return { kind: 'bound' };
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
          throw error;
        }
        return { kind: 'incumbent', reason: 'live-listener' };
      }
    }

    return { kind: 'incumbent', reason: 'live-listener' };
  } finally {
    releaseLock();
  }
}

export async function bindSocket(server: NetServer, socketPath: string): Promise<BindSocketResult> {
  return bindSocketAtAddress(server, socketPath);
}

export async function bindPublishedSocket(
  server: NetServer,
  address: PublishedIpcSocketAddress,
): Promise<BindSocketResult> {
  return bindSocketAtAddress(server, address);
}

export async function listenIpcServer(
  listener: IpcListener,
  socketPath: string,
  compatibilitySocketPaths: readonly string[] = [],
  publishedCompatibilitySocketAddresses: readonly PublishedIpcSocketAddress[] = [],
): Promise<ListenIpcServerResult> {
  const result = await bindSocket(listener.server, socketPath);
  if (result.kind === 'incumbent') {
    return { kind: 'incumbent', socketPath };
  }
  listener.socketPath = socketPath;
  try {
    const compatibilityAddresses = [
      ...compatibilitySocketPaths.map((path) => ({ kind: 'computed' as const, path })),
      ...publishedCompatibilitySocketAddresses.map((address) => ({
        kind: 'published' as const,
        path: address.socketPath,
        address,
      })),
    ];
    const attempted = new Set([socketPath]);
    for (const compatibilityAddress of compatibilityAddresses) {
      const compatibilitySocketPath = compatibilityAddress.path;
      if (attempted.has(compatibilitySocketPath)) continue;
      attempted.add(compatibilitySocketPath);
      if (compatibilitySocketPath === socketPath) continue;
      const compatibility = listener.createCompatibilityListener?.();
      if (compatibility === undefined || listener.compatibilityListeners === undefined) {
        throw new Error('IPC listener does not support compatibility sockets');
      }
      compatibility.onShutdownRecoveryAccepted = () => listener.onShutdownRecoveryAccepted?.();
      const compatibilityResult =
        compatibilityAddress.kind === 'published'
          ? await bindPublishedSocket(compatibility.server, compatibilityAddress.address)
          : await bindSocket(compatibility.server, compatibilitySocketPath);
      if (compatibilityResult.kind === 'incumbent') {
        await closeIpcServer(listener);
        return { kind: 'incumbent', socketPath: compatibilitySocketPath };
      }
      compatibility.socketPath = compatibilitySocketPath;
      listener.compatibilityListeners.push(compatibility);
    }
  } catch (error: unknown) {
    await closeIpcServer(listener);
    throw error;
  }
  return { kind: 'bound', socketPath };
}

export async function closeIpcServer(listener: IpcListener): Promise<void> {
  for (const compatibility of listener.compatibilityListeners?.splice(0) ?? []) {
    await closeIpcServer(compatibility);
  }
  for (const socket of listener.sockets) {
    socket.destroy();
  }

  const closeServer = (server: NetServer): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }

      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  if (listener.inheritedServer !== undefined) await closeServer(listener.inheritedServer);
  await closeServer(listener.server);
  if (
    process.platform !== 'win32' &&
    listener.inheritedServer !== undefined &&
    listener.unlinkInheritedOnClose &&
    listener.socketPath !== null
  ) {
    try {
      unlinkSync(listener.socketPath);
    } catch (error: unknown) {
      if (!isNoEntryError(error)) throw error;
    }
  }

  listener.socketPath = null;
}

export function attachInheritedIpcServer(listener: IpcListener, inherited: NetServer, socketPath: string): void {
  if (listener.inheritedServer !== undefined || listener.server.listening || listener.acceptSocket === undefined) {
    throw new Error('IPC listener cannot adopt another listening handle');
  }
  listener.inheritedServer = inherited;
  listener.socketPath = socketPath;
  inherited.on('connection', listener.acceptSocket);
}

export function enableInheritedIpcCleanup(listener: IpcListener): void {
  listener.unlinkInheritedOnClose = true;
  for (const compatibility of listener.compatibilityListeners ?? []) enableInheritedIpcCleanup(compatibility);
}

function declaresHandover(request: JsonRpcRequestEnvelope): boolean {
  return (
    typeof request.params === 'object' &&
    request.params !== null &&
    'supportsHandover' in request.params &&
    request.params.supportsHandover === true
  );
}

async function streamSubscription(
  socket: Socket,
  request: JsonRpcRequestEnvelope,
  entry: IpcDispatchEntry,
  invocation: Extract<CatalogRequestExecution, { kind: 'subscription' }>,
  controller: AbortController,
  options: { writeDrainTimeoutMs: number },
  handover: AbortSignal | null,
): Promise<void> {
  const iterator = invocation.notifications[Symbol.asyncIterator]();
  let onHandover = (): void => {};
  const handedOver = new Promise<'handover'>((resolve) => {
    onHandover = () => resolve('handover');
  });
  if (handover?.aborted === true) onHandover();
  else handover?.addEventListener('abort', onHandover, { once: true });
  let released = false;
  const releaseSubscription = () => {
    if (released) {
      return;
    }
    released = true;
    controller.abort();
    socket.off('close', releaseSubscription);
    void iterator.return?.().catch(() => undefined);
  };
  socket.once('close', releaseSubscription);

  if (
    !(await writeEnvelope(
      socket,
      {
        kind: 'response',
        id: request.id,
        result: { status: 'subscribed', method: entry.method },
      },
      { drainTimeoutMs: options.writeDrainTimeoutMs },
    ))
  ) {
    releaseSubscription();
    return;
  }

  try {
    while (true) {
      const next = await Promise.race([iterator.next(), handedOver]);
      if (next === 'handover') {
        // Every shipped CLI retries this refusal and resubscribes with the cursor it holds, which the successor
        // now answers; a plain close would read to it as a stream that ended without its terminal.
        await writeEnvelope(
          socket,
          requestErrorResponse(request.id, lifecycleRefusalResult.message, lifecycleRefusalResult),
          { drainTimeoutMs: options.writeDrainTimeoutMs },
        );
        break;
      }
      if (next.done || socket.destroyed || socket.writableEnded) {
        break;
      }

      const wrote = await writeEnvelope(
        socket,
        {
          kind: 'notification',
          method: entry.method,
          params: next.value,
        },
        { drainTimeoutMs: options.writeDrainTimeoutMs },
      );
      if (!wrote) {
        break;
      }
    }
  } finally {
    handover?.removeEventListener('abort', onHandover);
    releaseSubscription();
  }

  socket.end();
}

async function handleIpcOperationalRequest(
  request: JsonRpcRequestEnvelope,
  operationalSpec: IpcOperationalSpec,
  rpcPorts: HttpHandlerPorts,
  socket: Socket,
  backendUnavailable: boolean,
  startRequest: () => void,
  finishRequest: () => void,
  finishUnaryResponse: (response: JsonRpcEnvelope, onUnwritten?: () => void) => Promise<void>,
): Promise<boolean> {
  if (operationalSpec.requiresRunningLifecycle && backendUnavailable) {
    await finishUnaryResponse({ kind: 'response', id: request.id, result: lifecycleRefusalResult });
    return true;
  }

  if (operationalSpec.dispatch.kind === 'health') {
    await finishUnaryResponse({
      kind: 'response',
      id: request.id,
      result: { ...rpcPorts.health.read(), jobsWaitExtensions: JOBS_WAIT_EXTENSIONS },
    });
    return true;
  }

  if (operationalSpec.dispatch.kind === 'shutdown') {
    const refusal = rpcPorts.admin.decideLegacyShutdown?.() ?? SHUTDOWN_UNAUTHORIZED_RESPONSE;
    await finishUnaryResponse(requestErrorResponse(request.id, refusal.message, refusal));
    return true;
  }

  if (operationalSpec.dispatch.kind === 'succession') {
    const lease = rpcPorts.admin.beginRequestLease?.(request.method, String(request.id));
    if (lease === undefined) startRequest();
    try {
      const execute = async (): Promise<unknown> =>
        rpcPorts.admin.succession
          ? rpcPorts.admin.succession(request.method, request.params ?? {})
          : { kind: 'refused', reason: 'succession protocol unavailable' };
      const result = lease === undefined ? await execute() : await lease.run(execute);
      await finishUnaryResponse({ kind: 'response', id: request.id, result });
    } catch (error: unknown) {
      const response = buildTransportErrorResponse(error);
      await finishUnaryResponse(requestErrorResponse(request.id, response.message, response.data));
    } finally {
      if (lease === undefined) finishRequest();
    }
    return true;
  }

  if (operationalSpec.dispatch.kind === 'kb-restart') {
    const restartKbDaemon = rpcPorts.admin.restartKbDaemon;
    if (!restartKbDaemon) {
      await finishUnaryResponse(
        requestErrorResponse(request.id, KB_RESTART_UNAVAILABLE_RESPONSE.message, KB_RESTART_UNAVAILABLE_RESPONSE),
      );
      return true;
    }
    writeAuditEvent(
      'admin_kb_daemon_restart_requested',
      {
        transport: 'ipc',
        reason: 'admin',
        instanceId: rpcPorts.identity.instanceId,
      },
      'warn',
    );
    const lease = rpcPorts.admin.beginRequestLease?.(request.method, String(request.id));
    if (lease === undefined) startRequest();
    try {
      const kbDaemon =
        lease === undefined
          ? await restartKbDaemon('ipc-admin')
          : await lease.run((signal) => restartKbDaemon('ipc-admin', signal));
      await finishUnaryResponse({
        kind: 'response',
        id: request.id,
        result: { status: 'ok', instanceId: rpcPorts.identity.instanceId, kbDaemon },
      });
    } catch (error: unknown) {
      rpcPorts.identity.log(`IPC request error (${request.method}): ${formatError(error)}\n`);
      if (!socket.destroyed && !socket.writableEnded) {
        const response = buildTransportErrorResponse(error);
        await finishUnaryResponse(requestErrorResponse(request.id, response.message, response.data));
      }
    } finally {
      if (lease === undefined) finishRequest();
    }
    return true;
  }
  return false;
}

async function refuseUnavailableIpcRequest(
  request: JsonRpcRequestEnvelope,
  backendUnavailable: boolean,
  drainingRecoveryIngress: boolean,
  finishUnaryResponse: (response: JsonRpcEnvelope, onUnwritten?: () => void) => Promise<void>,
): Promise<boolean> {
  if (!backendUnavailable || drainingRecoveryIngress) return false;
  await finishUnaryResponse({ kind: 'response', id: request.id, result: lifecycleRefusalResult });
  return true;
}

async function dispatchIpcCatalogRequest(
  request: JsonRpcRequestEnvelope,
  principal: Principal | null,
  dispatchMap: ReadonlyMap<string, IpcDispatchEntry>,
  rpcPorts: HttpHandlerPorts,
  socket: Socket,
  onShutdownRecoveryAccepted: (() => void) | null,
  startRequest: () => void,
  finishRequest: () => void,
  options: { writeDrainTimeoutMs: number },
  drainingRecoveryIngress: boolean,
  finishUnaryResponse: (response: JsonRpcEnvelope, onUnwritten?: () => void) => Promise<void>,
): Promise<void> {
  const entry = dispatchMap.get(request.method);
  if (!entry) {
    await finishUnaryResponse(methodNotFoundResponse(request.id));
    return;
  }
  if (!principal) {
    await finishUnaryResponse(
      requestErrorResponse(request.id, IPC_UNAUTHORIZED_RESPONSE.message, IPC_UNAUTHORIZED_RESPONSE),
    );
    return;
  }

  const parsed = entry.spec.requestSchema.safeParse(request.params ?? {});
  if (!parsed.success) {
    await finishUnaryResponse(validationErrorResponse(request.id, parsed.error));
    return;
  }
  const requestIdentity = parsed.data as { jobId?: unknown; operationId?: unknown };
  const lease =
    entry.spec.kind === 'unary'
      ? rpcPorts.admin.beginRequestLease?.(request.method, String(request.id), {
          ...(typeof requestIdentity.jobId === 'string' ? { jobId: requestIdentity.jobId } : {}),
          ...(typeof requestIdentity.operationId === 'string' ? { operationId: requestIdentity.operationId } : {}),
        })
      : undefined;
  if (entry.spec.kind === 'unary' && lease === undefined) startRequest();

  let subscriptionController: AbortController | null = null;
  const abortDispatchOnClose = (): void => {
    subscriptionController?.abort(new Error('IPC client disconnected'));
  };
  try {
    const controller = new AbortController();
    subscriptionController = controller;
    socket.once('close', abortDispatchOnClose);
    const dispatch = async (signal: AbortSignal) => {
      linkRequestLeaseIdentity(controller.signal, signal);
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
      return entry.dispatch(parsed.data, principal, controller.signal);
    };
    const invocation = lease === undefined ? await dispatch(controller.signal) : await lease.run(dispatch);
    if (invocation.kind === 'unsupported-method') {
      await finishUnaryResponse(methodNotFoundResponse(request.id));
      return;
    }
    if (invocation.kind === 'lifecycle-refused') {
      await finishUnaryResponse({ kind: 'response', id: request.id, result: lifecycleRefusalResult });
      return;
    }
    if (invocation.kind === 'unary') {
      // Domain-level errors (statusCode >= 400) ride a JSON-RPC `error`
      // envelope so the client rejects with a typed error instead of
      // resolving with the error body. Without this, callers that expect a
      // success-shaped result silently mis-render the error payload (e.g. a
      // CLI formatter accessing `data.slug` on `{code, message}`).
      if (typeof invocation.statusCode === 'number' && invocation.statusCode >= 400) {
        const body = invocation.body as { code?: unknown; message?: unknown };
        const message = typeof body.message === 'string' ? body.message : 'request failed';
        await finishUnaryResponse(requestErrorResponse(request.id, message, invocation.body));
        return;
      }
      const completeShutdownRecovery =
        drainingRecoveryIngress && acceptedDrainingRecovery(request.method) && onShutdownRecoveryAccepted !== null
          ? armShutdownRecoveryContinuation(socket, onShutdownRecoveryAccepted)
          : null;
      await finishUnaryResponse(
        { kind: 'response', id: request.id, result: invocation.body } as JsonRpcResponseEnvelope,
        completeShutdownRecovery ?? undefined,
      );
      return;
    }

    socket.off('close', abortDispatchOnClose);
    await streamSubscription(
      socket,
      request,
      entry,
      invocation,
      subscriptionController,
      options,
      declaresHandover(request) ? null : rpcPorts.jobs.waitHandoverSignal(),
    );
  } catch (error: unknown) {
    if (socket.destroyed) {
      return;
    }
    rpcPorts.identity.log(`IPC request error (${request.method}): ${formatError(error)}\n`);
    if (!socket.destroyed && !socket.writableEnded) {
      const response = buildTransportErrorResponse(error);
      await finishUnaryResponse(requestErrorResponse(request.id, response.message, response.data));
    }
  } finally {
    socket.off('close', abortDispatchOnClose);
    if (lease === undefined) finishRequest();
  }
}

async function dispatchFrame(
  frame: string,
  socket: Socket,
  dispatchMap: ReadonlyMap<string, IpcDispatchEntry>,
  rpcPorts: HttpHandlerPorts,
  onShutdownRecoveryAccepted: (() => void) | null,
  startRequest: () => void,
  finishRequest: () => void,
  options: { writeDrainTimeoutMs: number },
  connection: IpcConnectionChallenge,
): Promise<void> {
  const finishUnaryResponse = async (response: JsonRpcEnvelope, onUnwritten?: () => void): Promise<void> => {
    const wroteResponse = await writeEnvelope(socket, response, {
      drainTimeoutMs: options.writeDrainTimeoutMs,
    });
    if (!wroteResponse) onUnwritten?.();
    socket.end();
  };

  let envelope: JsonRpcEnvelope;
  try {
    envelope = decode(frame);
  } catch (error: unknown) {
    await finishUnaryResponse(transportErrorResponse(INVALID_JSON_RESPONSE.message, { cause: String(error) }));
    return;
  }

  if (envelope.kind !== 'request') {
    await finishUnaryResponse(invalidRequestResponse('id' in envelope ? envelope.id : null));
    return;
  }

  const request = envelope;
  const operationalSpec = readIpcOperationalSpec(request.method);
  if (operationalSpec?.dispatch.kind === 'ping') {
    const authError = authorizeIpcOperation(request, operationalSpec, IPC_BOOTSTRAP_LIVENESS_PRINCIPAL);
    if (authError) {
      await finishUnaryResponse(authError);
      return;
    }
    await finishUnaryResponse({ kind: 'response', id: request.id, result: readPingSnapshot(rpcPorts) });
    return;
  }

  if (operationalSpec?.dispatch.kind === 'challenge') {
    const issuer = rpcPorts.childPrincipals;
    if (issuer === undefined || connection.issued) {
      await finishUnaryResponse(
        requestErrorResponse(request.id, CHALLENGE_UNAVAILABLE_RESPONSE.message, CHALLENGE_UNAVAILABLE_RESPONSE),
      );
      return;
    }
    const challenge = issuer.issueChallenge();
    // Armed before the answer is written: the proof frame can arrive as soon as the client reads it.
    connection.awaitProof(challenge);
    const answer = { kind: 'response', id: request.id, result: challenge } as const;
    if (!(await writeEnvelope(socket, answer, { drainTimeoutMs: options.writeDrainTimeoutMs }))) {
      socket.destroy();
    }
    return;
  }

  let authentication: IpcAuthentication;
  try {
    authentication = authenticateIpcRequest(request, connection.taken, rpcPorts);
  } catch (error: unknown) {
    rpcPorts.identity.log(`IPC authentication error (${request.method}): ${formatError(error)}\n`);
    const response = buildTransportErrorResponse(error);
    await finishUnaryResponse(requestErrorResponse(request.id, response.message, response.data));
    return;
  }
  if (authentication.kind === 'credential-unreadable') {
    await finishUnaryResponse(
      requestErrorResponse(request.id, CHILD_CREDENTIAL_UNREADABLE_RESPONSE.message, {
        ...CHILD_CREDENTIAL_UNREADABLE_RESPONSE,
        credentialId: authentication.credentialId,
      }),
    );
    return;
  }
  const principal = authentication.principal;
  if (operationalSpec?.authentication === 'principal') {
    const authError = authorizeIpcOperation(request, operationalSpec, principal);
    if (authError) {
      await finishUnaryResponse(authError);
      return;
    }
  }

  const lifecycleState =
    rpcPorts.admin.getLifecycleState?.() ?? (rpcPorts.admin.isLifecycleRunning() ? 'running' : 'stopped');
  const draining = lifecycleState === 'draining' || rpcPorts.admin.isDrainRequested();
  const backendUnavailable = draining || lifecycleState === 'stopped';
  const drainingRecoveryIngress = draining && operationalSpec?.dispatch.kind === 'catalog';

  if (
    operationalSpec &&
    (await handleIpcOperationalRequest(
      request,
      operationalSpec,
      rpcPorts,
      socket,
      backendUnavailable,
      startRequest,
      finishRequest,
      finishUnaryResponse,
    ))
  )
    return;

  if (await refuseUnavailableIpcRequest(request, backendUnavailable, drainingRecoveryIngress, finishUnaryResponse))
    return;

  await dispatchIpcCatalogRequest(
    request,
    principal,
    dispatchMap,
    rpcPorts,
    socket,
    onShutdownRecoveryAccepted,
    startRequest,
    finishRequest,
    options,
    drainingRecoveryIngress,
    finishUnaryResponse,
  );
}

/**
 * Measured on Node 26.3.1: `pause()` leaves a reading handle reading, and the bytes it reads before a handle transfer
 * queued behind another converts are dropped with the parent's socket (19 of 20 burst-forwarded frames lost).
 * Stopped here, they stay in the kernel for the process the socket reaches.
 */
function stopHandleReads(socket: Socket): boolean {
  const handle = (socket as unknown as { _handle?: { reading?: boolean; readStop?: unknown } | null })._handle;
  if (typeof handle?.readStop !== 'function') return false;
  handle.reading = false;
  handle.readStop();
  return true;
}

/**
 * `read()` on a stopped handle re-arms it through `_read`, so the handle is stopped again before any tick can
 * deliver bytes this process would then drop with its copy of the socket.
 */
function takeBufferedBytes(socket: Socket): Buffer {
  if (socket.readableLength === 0) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for (let chunk: unknown = socket.read(); chunk !== null; chunk = socket.read()) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  stopHandleReads(socket);
  return Buffer.concat(chunks);
}

/** A socket whose reads cannot be stopped would lose its frame in transfer, so it is served where it is. */
const UNSTOPPABLE_HANDLE_LOG = 'IPC socket handle cannot stop reading; serving it here instead of forwarding it\n';

export function createIpcServer(rpcPorts: HttpHandlerPorts, options: IpcServerOptions = {}): IpcListener {
  return createTrackedIpcListener(rpcPorts, options, {
    sockets: new Set(),
    maxOpenSockets: options.maxOpenSockets ?? IPC_DEFAULT_MAX_OPEN_SOCKETS,
    maxAggregatePendingFrameBytes:
      options.maxAggregatePendingFrameBytes ?? IPC_DEFAULT_MAX_AGGREGATE_PENDING_FRAME_BYTES,
    aggregatePendingFrameBytes: 0,
  });
}

function parseTrackedSocketChunk(
  chunk: Buffer | string,
  socket: Socket,
  framer: ReturnType<typeof createLineFramer>,
  pending: { frame: Buffer },
  resources: IpcResourceTracker,
  rpcPorts: HttpHandlerPorts,
  writeDrainTimeoutMs: number,
  updatePendingFrameBytes: (bytes: number) => void,
): string[] | null {
  let frames: string[];
  try {
    pending.frame = Buffer.concat([pending.frame, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
    const lastNewline = pending.frame.lastIndexOf(0x0a);
    if (lastNewline !== -1) pending.frame = pending.frame.subarray(lastNewline + 1);
    frames = framer.push(chunk);
    updatePendingFrameBytes(framer.pendingBytes());
  } catch (error: unknown) {
    if (error instanceof FrameTooLargeError) {
      updatePendingFrameBytes(error.observedBytes);
      rpcPorts.identity.log(
        `IPC frame too large (${error.observedBytes} > ${error.maxFrameBytes}); destroying socket\n`,
      );
      if (!socket.destroyed) {
        void writeEnvelope(
          socket,
          transportErrorResponse('Request frame too large', {
            code: error.code,
            maxFrameBytes: error.maxFrameBytes,
            observedBytes: error.observedBytes,
          }),
          { drainTimeoutMs: writeDrainTimeoutMs },
        ).finally(() => socket.destroy());
      }
      return null;
    }
    throw error;
  }
  if (resources.aggregatePendingFrameBytes > resources.maxAggregatePendingFrameBytes) {
    rpcPorts.identity.log(
      `IPC pending frame budget exceeded (${resources.aggregatePendingFrameBytes} > ${resources.maxAggregatePendingFrameBytes}); destroying socket\n`,
    );
    void writeEnvelope(
      socket,
      transportErrorResponse('Too many pending IPC frame bytes', {
        code: 'ipc_pending_frame_budget_exceeded',
        maxAggregatePendingFrameBytes: resources.maxAggregatePendingFrameBytes,
        observedBytes: resources.aggregatePendingFrameBytes,
      }),
      { drainTimeoutMs: writeDrainTimeoutMs },
    ).finally(() => socket.destroy());
    return null;
  }
  return frames;
}

type TrackedIpcListenerState = {
  rpcPorts: HttpHandlerPorts;
  resources: IpcResourceTracker;
  dispatchMap: ReadonlyMap<string, IpcDispatchEntry>;
  firstFrameTimeoutMs: number;
  writeDrainTimeoutMs: number;
  listenerRef: { current: IpcListener | null };
  pendingSockets: Map<Socket, () => void>;
  openSockets: Set<Socket>;
  drained: Set<() => void>;
  forwardAccepted: ((socket: Socket, pendingFrameBase64: string) => void) | null;
};

function releaseTrackedSocket(state: TrackedIpcListenerState, socket: Socket): void {
  state.openSockets.delete(socket);
  if (state.openSockets.size === 0) {
    for (const resolve of state.drained) resolve();
    state.drained.clear();
  }
}

function admitTrackedSocket(state: TrackedIpcListenerState, socket: Socket, pendingFrameBase64: string): boolean {
  const { rpcPorts, resources, writeDrainTimeoutMs } = state;
  if (state.forwardAccepted !== null) {
    if (stopHandleReads(socket)) {
      socket.pause();
      const pending = Buffer.concat([Buffer.from(pendingFrameBase64, 'base64'), takeBufferedBytes(socket)]);
      state.forwardAccepted(socket, pending.toString('base64'));
      return false;
    }
    rpcPorts.identity.log(UNSTOPPABLE_HANDLE_LOG);
  }
  if (resources.sockets.size >= resources.maxOpenSockets) {
    rpcPorts.identity.log(
      `IPC connection cap exceeded (${resources.sockets.size} >= ${resources.maxOpenSockets}); destroying socket\n`,
    );
    void writeEnvelope(
      socket,
      transportErrorResponse('Too many IPC connections', {
        code: 'too_many_ipc_connections',
        maxOpenSockets: resources.maxOpenSockets,
      }),
      { drainTimeoutMs: writeDrainTimeoutMs },
    ).finally(() => socket.destroy());
    return false;
  }
  resources.sockets.add(socket);
  state.openSockets.add(socket);
  return true;
}

function acceptTrackedSocket(state: TrackedIpcListenerState, socket: Socket, pendingFrameBase64 = ''): void {
  if (!admitTrackedSocket(state, socket, pendingFrameBase64)) return;
  const { rpcPorts, resources, dispatchMap, firstFrameTimeoutMs, writeDrainTimeoutMs, listenerRef, pendingSockets } =
    state;
  const framer = createLineFramer();
  const carriedFrame = Buffer.from(pendingFrameBase64, 'base64');
  const pending = { frame: Buffer.alloc(0) };
  let inflightRequest = false;
  let outstandingChallenge: ChildAuthChallenge | null = null;
  let challengeIssued = false;
  let pendingFrameBytes = framer.pendingBytes();
  resources.aggregatePendingFrameBytes += pendingFrameBytes;
  const armFrameTimer = (): ReturnType<typeof timers.setTimeout> => {
    const timer = timers.setTimeout(() => {
      rpcPorts.identity.log(`IPC socket did not send a complete frame within ${firstFrameTimeoutMs}ms; destroying\n`);
      socket.destroy();
    }, firstFrameTimeoutMs);
    timer.unref?.();
    return timer;
  };
  let firstFrameTimer = armFrameTimer();

  const updatePendingFrameBytes = (nextBytes: number) => {
    resources.aggregatePendingFrameBytes += nextBytes - pendingFrameBytes;
    pendingFrameBytes = nextBytes;
  };

  const releasePendingFrameBytes = () => {
    updatePendingFrameBytes(0);
  };

  const finishRequest = () => {
    if (!inflightRequest) {
      return;
    }
    inflightRequest = false;
    rpcPorts.admin.endRequest();
  };

  const onClose = () => {
    timers.clearTimeout(firstFrameTimer);
    releasePendingFrameBytes();
    finishRequest();
    resources.sockets.delete(socket);
    pendingSockets.delete(socket);
    releaseTrackedSocket(state, socket);
  };
  socket.once('close', onClose);

  const onError = (error: Error) => {
    rpcPorts.identity.log(`IPC socket error: ${formatError(error)}\n`);
    finishRequest();
  };
  socket.on('error', onError);

  const transferPending = (): void => {
    if (state.forwardAccepted === null || socket.destroyed) return;
    if (!stopHandleReads(socket)) {
      rpcPorts.identity.log(UNSTOPPABLE_HANDLE_LOG);
      return;
    }
    socket.pause();
    socket.off('data', onData);
    socket.off('close', onClose);
    socket.off('error', onError);
    timers.clearTimeout(firstFrameTimer);
    releasePendingFrameBytes();
    resources.sockets.delete(socket);
    pendingSockets.delete(socket);
    releaseTrackedSocket(state, socket);
    state.forwardAccepted(socket, Buffer.concat([pending.frame, takeBufferedBytes(socket)]).toString('base64'));
  };
  pendingSockets.set(socket, transferPending);

  const onData = (chunk: Buffer | string) => {
    const frames = parseTrackedSocketChunk(
      chunk,
      socket,
      framer,
      pending,
      resources,
      rpcPorts,
      writeDrainTimeoutMs,
      updatePendingFrameBytes,
    );
    if (frames === null) return;
    for (const frame of frames) {
      if (frame.trim().length === 0) {
        continue;
      }
      timers.clearTimeout(firstFrameTimer);
      releasePendingFrameBytes();
      socket.off('data', onData);
      pendingSockets.delete(socket);
      const taken = outstandingChallenge;
      outstandingChallenge = null;
      void dispatchFrame(
        frame,
        socket,
        dispatchMap,
        rpcPorts,
        listenerRef.current?.onShutdownRecoveryAccepted ?? null,
        () => {
          rpcPorts.admin.beginRequest();
          inflightRequest = true;
        },
        finishRequest,
        { writeDrainTimeoutMs },
        {
          taken,
          issued: challengeIssued,
          // Never re-offered for forwarding: the challenge exists only in this process.
          awaitProof: (challenge) => {
            outstandingChallenge = challenge;
            challengeIssued = true;
            firstFrameTimer = armFrameTimer();
            socket.on('data', onData);
          },
        },
      );
      return;
    }
  };

  socket.on('data', onData);
  if (carriedFrame.length > 0) onData(carriedFrame);
  socket.resume();
  // Succession's readStop() can leave libuv stopped after the stream resumes.
  const handle = (socket as unknown as { _handle?: { reading?: boolean; readStart?: () => void } })._handle;
  if (handle?.reading === false && typeof handle.readStart === 'function') {
    handle.readStart();
    handle.reading = true;
  }
}

function createTrackedIpcListener(
  rpcPorts: HttpHandlerPorts,
  options: IpcServerOptions,
  resources: IpcResourceTracker,
): IpcListener {
  const dispatchTable = buildCoordinatorIpcDispatchTable(rpcPorts);
  const dispatchMap = new Map(dispatchTable.map((entry) => [entry.method, entry]));
  const firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? IPC_DEFAULT_FIRST_FRAME_TIMEOUT_MS;
  const writeDrainTimeoutMs = options.writeDrainTimeoutMs ?? IPC_DEFAULT_WRITE_DRAIN_TIMEOUT_MS;
  const state: TrackedIpcListenerState = {
    rpcPorts,
    resources,
    dispatchMap,
    firstFrameTimeoutMs,
    writeDrainTimeoutMs,
    listenerRef: { current: null },
    pendingSockets: new Map(),
    openSockets: new Set(),
    drained: new Set(),
    forwardAccepted: null,
  };
  const acceptSocket = (socket: Socket, pendingFrameBase64 = ''): void =>
    acceptTrackedSocket(state, socket, pendingFrameBase64);
  const server = createServer({ pauseOnConnect: true }, acceptSocket);

  const listener: IpcListener = {
    server,
    sockets: resources.sockets,
    compatibilityListeners: [],
    createCompatibilityListener: () => createTrackedIpcListener(rpcPorts, options, resources),
    acceptSocket,
    forwardConnections: (forward) => {
      state.forwardAccepted = forward;
      for (const transfer of state.pendingSockets.values()) transfer();
      return () => {
        if (state.forwardAccepted === forward) state.forwardAccepted = null;
      };
    },
    drainConnections: () =>
      state.openSockets.size === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            state.drained.add(resolve);
          }),
    socketPath: null,
    onShutdownRecoveryAccepted: null,
  };
  state.listenerRef.current = listener;
  return listener;
}
