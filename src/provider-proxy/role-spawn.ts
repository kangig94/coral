import type { ProcessIncarnation } from '../infra/node-process.js';
import { basename, join } from 'node:path';

import { probeProcessIncarnation } from '../infra/node-process.js';
import type { ChildProcessLike } from '../infra/port-types.js';
import { gracefulKill } from '../infra/process-supervision.js';
import type { Runtime } from '../runtime/ports.js';
import {
  connectControlClient,
  type ControlClient,
  type ControlClientTimer,
  type ProviderEventHandler,
} from './control-client.js';
import type { ControlEndpointTimer } from './control-endpoint.js';
import { PROVIDER_ROLE_FLAGS, type ProviderRole } from './role-argv.js';

/**
 * The shared mechanics every role-spawning caller needs: launching one role process from the existing
 * backend artifact, and reaching the control endpoint it will eventually bind. Both the coordinator (spawning
 * the guardian) and the guardian's own role main (spawning the reaper, then the proxy) go through this file
 * rather than each re-deriving the artifact path or re-implementing a connect retry loop.
 */

/** Reverse of `PROVIDER_ROLE_FLAGS`, derived rather than hand-copied so a role added to the flag table stays spawnable. */
const ROLE_FLAG_BY_ROLE: Readonly<Record<ProviderRole, string>> = Object.freeze(
  Object.fromEntries(Object.entries(PROVIDER_ROLE_FLAGS).map(([flag, role]) => [role, flag])) as Record<
    ProviderRole,
    string
  >,
);

export type RoleSpawnErrorCode = 'role_spawn_no_pid' | 'role_spawn_start_time_unavailable';

export class RoleSpawnError extends Error {
  readonly code: RoleSpawnErrorCode;
  readonly role: ProviderRole;

  constructor(code: RoleSpawnErrorCode, role: ProviderRole, message: string) {
    super(message);
    this.name = 'RoleSpawnError';
    this.code = code;
    this.role = role;
    Object.setPrototypeOf(this, RoleSpawnError.prototype);
  }
}

export type RoleSpawnPorts = Readonly<{
  process: Pick<Runtime['process'], 'spawn'>;
  /** Passed whole, not narrowed to `time`, because `gracefulKill` (`infra/process-supervision.ts`) takes a
   *  full `Runtime` — used only to escalate a spawn that must be killed before it ever became a role this
   *  module tracks (`role_spawn_no_pid` / `role_spawn_start_time_unavailable`) from SIGTERM to SIGKILL after
   *  a grace period. */
  runtime: Runtime;
  platform: NodeJS.Platform;
  /** Injected so a test can fake a spawned pid's start time without a real process existing. Defaults to
   *  the real cross-platform `/proc` or `ps` probe. */
  readProcessIncarnation?(pid: number, platform: NodeJS.Platform): ProcessIncarnation | null;
}>;

export type RoleSpawnOptions = Readonly<{
  pluginRoot: string;
  /** `true` makes the child a new process-group leader (the future proxy containment); `false` for an
   *  ordinary child that inherits its parent's group. */
  detached: boolean;
  envAdditions?: Record<string, string>;
  /** Overrides "am I already running as the backend artifact"; defaults to `process.argv[1]`. */
  currentEntrypoint?: string;
  /** Overrides the node executable used to re-invoke the artifact; defaults to `process.execPath`. */
  command?: string;
}>;

export type SpawnedRoleProcess = Readonly<{
  child: ChildProcessLike;
  pid: number;
  incarnation: ProcessIncarnation;
  /**
   * Rejects if this child later emits an async spawn error (Node reports ENOENT/EACCES this way, after the
   * synchronous `spawn()` call above already returned a pid); never settles otherwise. A caller races this
   * against its own readiness wait so a failure Node reports asynchronously surfaces there as a rejected
   * promise, not as an uncaught exception in this process — the same race `kb-daemon-supervisor.ts` runs
   * against its own spawned child's `'error'` event.
   */
  spawnFailed: Promise<never>;
}>;

/** Mirrors `kb-daemon-supervisor.ts`'s own entrypoint resolution: reuse the artifact already running when
 *  its basename matches, otherwise resolve it under the plugin root's bundled bridge. */
function resolveBackendArtifact(pluginRoot: string, currentEntrypoint: string | undefined): string {
  if (typeof currentEntrypoint === 'string' && basename(currentEntrypoint) === 'coral-backend.cjs') {
    return currentEntrypoint;
  }
  return join(pluginRoot, 'bridge', 'coral-backend.cjs');
}

/**
 * Spawns one role process from the existing backend artifact and verifies its identity before returning it.
 *
 * A pid alone is not an identity — it is recycled — so a spawn whose start time cannot be read fails rather
 * than handing back a bare pid nothing could later verify against. The failed child is killed rather than
 * left to run unaccounted for.
 */
export function spawnRoleProcess(
  role: ProviderRole,
  capsulePath: string,
  ports: RoleSpawnPorts,
  options: RoleSpawnOptions,
): SpawnedRoleProcess {
  const entrypoint = resolveBackendArtifact(options.pluginRoot, options.currentEntrypoint ?? process.argv[1]);
  const command = options.command ?? process.execPath;
  const child = ports.process.spawn({
    command,
    args: [entrypoint, ROLE_FLAG_BY_ROLE[role], capsulePath],
    cwd: options.pluginRoot,
    envAdditions: options.envAdditions ?? {},
    detached: options.detached,
  });

  // Attached unconditionally and first: Node reports ENOENT/EACCES asynchronously on this event, and an
  // EventEmitter with no listener re-throws it as an uncaught exception in *this* process — the coordinator,
  // when this spawns the guardian, or the guardian, when this spawns the reaper or the proxy. The internal
  // `.catch` keeps an uncollected `spawnFailed` from itself becoming an unhandled rejection on the failure
  // paths below that throw before a caller ever gets the chance to observe it.
  const spawnFailed = new Promise<never>((_resolve, reject) => {
    child.on('error', reject);
  });
  spawnFailed.catch(() => {});

  // Nothing in this process reads the role's stdout/stderr. Draining keeps the OS pipe buffer from filling
  // and backpressuring the role's own writes, and the `'error'` listeners keep a later stream error from
  // reaching this process as an uncaught exception — the same guard `kb-daemon-supervisor.ts` installs on
  // its own spawned child's stdin.
  child.stdout?.on('data', () => {});
  child.stdout?.on('error', () => {});
  child.stderr?.on('data', () => {});
  child.stderr?.on('error', () => {});
  // A role is meant to outlive the process that spawned it, exactly like `runtime/real.ts`'s own detached,
  // unref'd durable-CLI wrapper spawn — so holding this handle must not itself keep this process's event
  // loop alive.
  child.unref?.();

  const killFailedSpawn = (): void => gracefulKill(child, ports.runtime);

  if (typeof child.pid !== 'number') {
    killFailedSpawn();
    throw new RoleSpawnError('role_spawn_no_pid', role, `Spawning the ${role} role did not return a pid.`);
  }

  const readStartedAt = ports.readProcessIncarnation ?? probeProcessIncarnation;
  const incarnation = readStartedAt(child.pid, ports.platform);
  if (incarnation === null) {
    killFailedSpawn();
    throw new RoleSpawnError(
      'role_spawn_start_time_unavailable',
      role,
      `Could not read the start time of the spawned ${role} process (pid ${child.pid}).`,
    );
  }

  return { child, pid: child.pid, incarnation, spawnFailed };
}

/** Adapts the `Runtime` time port to the shape every control endpoint and client in this domain expects.
 *  Both role main and the coordinator's own acquisition steps need this exact adapter, so it lives here
 *  rather than being rebuilt at each call site. */
export function runtimeControlTimer(runtime: Pick<Runtime, 'time'>): ControlEndpointTimer & ControlClientTimer {
  return {
    setTimeout: (callback, ms) => runtime.time.setTimeout(callback, ms),
    clearTimeout: (handle) => runtime.time.clearTimeout(handle),
  };
}

export type RoleConnectRetryOptions = Readonly<{
  connectTimeoutMs: number;
  retryIntervalMs: number;
  overallDeadlineMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
}>;

/**
 * Connects to a freshly spawned role's control endpoint, retrying until it is reachable or the overall
 * budget elapses. A spawn call returns as soon as the OS has scheduled the process, not once it has bound
 * its socket — so the first connect attempt legitimately racing a not-yet-listening peer is the ordinary
 * case, not a failure.
 *
 * `onProviderEvent`, when supplied, answers the one inbound method this connection may ever receive:
 * `provider.event.v1`. Only the proxy role ever pushes it (`protocol.ts`'s own doc), so only the caller
 * connecting to a proxy endpoint has a reason to pass one.
 */
export async function connectRoleControlWithRetry(
  socketPath: string,
  timer: ControlClientTimer,
  options: RoleConnectRetryOptions,
  onProviderEvent?: ProviderEventHandler,
): Promise<ControlClient> {
  const deadline = options.now() + options.overallDeadlineMs;
  while (true) {
    try {
      return await connectControlClient(socketPath, timer, options.connectTimeoutMs, onProviderEvent);
    } catch (error: unknown) {
      if (options.now() >= deadline) throw error;
      await options.sleep(options.retryIntervalMs);
    }
  }
}
