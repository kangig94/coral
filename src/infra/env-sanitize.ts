/**
 * Environment sanitization primitives.
 *
 * Prevents E2BIG (execve argument-list-too-long) in environments with large
 * env blocks — common in Kubernetes where service discovery, ConfigMaps, and
 * Secrets can push process.env to hundreds of KB while ARG_MAX may be as low
 * as 128KB.
 *
 * Strategy: size-budget with pure size-based shedding.
 * - If total env fits within budget → pass everything unchanged.
 * - If over budget → drop the largest vars first until it fits.
 * - Passthrough set protects specific vars from being shed.
 *
 * This module also owns the CORAL_* env vocabulary that crosses the child /
 * wire boundary: which keys the daemon strips from an inherited env
 * (`stripInternalCoralKeys`), and which `CORAL_*` config a caller may forward
 * per request versus the daemon-owned keys it may never set
 * (`DAEMON_OWNED_CORAL_ENV_KEYS` / `filterForwardableCoralEnv`).
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { backendLog } from './backend-log.js';
import { BUILD_FLAVOR_ENV_KEY } from './build-flavor.js';
import { CORAL_KB_ENABLE_ENV } from './kb-toggle.js';

const ENV_BUDGET_FALLBACK_BYTES = 2 * 1024 * 1024;
const ENV_BUDGET_HEADROOM_RATIO = 0.8;

let cachedBudgetBytes: number | undefined;

/**
 * Resolve the system's ARG_MAX and derive an env budget (80% of ARG_MAX,
 * leaving 20% headroom for argv, the executable path, and padding).
 *
 * Detection order:
 * 1. /proc/sys/kernel/argmax (Linux, no subprocess)
 * 2. `getconf ARG_MAX` (POSIX, cross-platform)
 * 3. Fallback: 2MB (standard Linux default)
 *
 * Result is computed lazily on first call and cached.
 */
export function resolveEnvBudgetBytes(): number {
  if (cachedBudgetBytes !== undefined) return cachedBudgetBytes;

  let argMax: number | undefined;

  // 1. procfs (fast, no spawn)
  try {
    argMax = parseInt(readFileSync('/proc/sys/kernel/argmax', 'utf8').trim(), 10);
  } catch {
    // not Linux or procfs unavailable
  }

  // 2. getconf (POSIX)
  if (!argMax || Number.isNaN(argMax)) {
    try {
      argMax = parseInt(execSync('getconf ARG_MAX', { encoding: 'utf8', timeout: 2_000 }).trim(), 10);
    } catch {
      // getconf not available
    }
  }

  // 3. Fallback
  if (!argMax || Number.isNaN(argMax) || argMax <= 0) {
    argMax = ENV_BUDGET_FALLBACK_BYTES;
  }

  cachedBudgetBytes = Math.floor(argMax * ENV_BUDGET_HEADROOM_RATIO);
  return cachedBudgetBytes;
}

/** Parse comma-separated CORAL_ENV_PASSTHROUGH value into a set of protected var names. */
export function parsePassthrough(raw: string | undefined): Set<string> {
  if (!raw) return new Set<string>();
  const passthrough = new Set<string>();
  for (const entry of raw.split(',')) {
    const name = entry.trim();
    if (name.length > 0) {
      passthrough.add(name);
    }
  }
  return passthrough;
}

/** Measure total execve env size: sum of "KEY=VALUE\0" per entry. */
export function measureEnv(env: Record<string, string>): number {
  let size = 0;
  for (const [key, value] of Object.entries(env)) {
    size += key.length + 1 + value.length + 1;
  }
  return size;
}

/**
 * Drop the largest env vars until total size fits within budget.
 * Vars in the passthrough set are never dropped.
 * Returns the original object unchanged if already within budget.
 */
function shedIfOverBudget(
  base: Record<string, string>,
  budget: number,
  passthrough: Set<string>,
): Record<string, string> {
  const originalSize = measureEnv(base);
  if (originalSize <= budget) return base;

  const entries = Object.entries(base).sort((left, right) => right[1].length - left[1].length);
  const originalCount = entries.length;
  const kept: Record<string, string> = {};
  let currentSize = originalSize;
  let shedCount = 0;
  const shedNames: string[] = [];

  for (const [key, value] of entries) {
    if (currentSize <= budget || passthrough.has(key)) {
      kept[key] = value;
      continue;
    }

    currentSize -= key.length + 1 + value.length + 1;
    shedCount += 1;
    if (shedNames.length < 10) {
      shedNames.push(key);
    }
  }

  const shedList =
    shedNames.join(', ') + (shedCount > shedNames.length ? `, ... (+${shedCount - shedNames.length} more)` : '');
  backendLog.warn(
    `child-env: shed ${shedCount}/${originalCount} vars ` +
      `(${(originalSize / 1024).toFixed(0)}KB -> ${(currentSize / 1024).toFixed(0)}KB, ` +
      `budget=${(budget / 1024).toFixed(0)}KB) [${shedList}]` +
      (shedCount > 0 ? ' - set CORAL_ENV_PASSTHROUGH=VAR1,VAR2 to protect specific vars' : ''),
  );

  return kept;
}

/** Remove all keys starting with `CORAL_` from an env record. */
function stripInternalCoralKeys(env: Readonly<Record<string, string>>): Record<string, string> {
  const stripped: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('CORAL_')) continue;
    stripped[key] = value;
  }
  return stripped;
}

/**
 * `CORAL_*` keys the daemon owns and a caller may never set through the
 * per-request `coralEnv` forwarding channel (see `filterForwardableCoralEnv`).
 * A key lands here for one of two reasons:
 *
 * - Identity / auth / lineage. `CORAL_CHILD_PRINCIPAL_HANDLE` is minted per
 *   child by the daemon, `CORAL_JOB_ID` / `CORAL_SESSION_ID` are set from the
 *   validated jobId/sessionId body fields, and `CORAL_CHILD` marks the child
 *   boundary. Taking any of these from untrusted wire input would let a caller
 *   forge child credentials or misattribute work to another job/session.
 * - Daemon boot-fixed infra. The build-flavor key (see {@link BUILD_FLAVOR_ENV_KEY}),
 *   `CORAL_KB_PATH`, `CORAL_ENV_PASSTHROUGH`, and the startup markers are resolved
 *   once at boot and pin which daemon a spawned child talks back to; they are
 *   re-asserted from the daemon's own snapshot so a nested `coral-cli` targets the
 *   right daemon rather than one the caller names.
 * - Daemon-scoped decisions that are nonetheless read per request from the
 *   controller env. `CORAL_KB_ENABLE` gates whether the daemon booted its KB
 *   runtime at all, yet `applyInjectBundle` reads it off the request's coralEnv to
 *   decide KB injection — so it must reflect the daemon's boot state, not a value
 *   a caller forwards, or injection would disagree with the running KB daemon.
 *   (The parent daemon's KB boot gate and the CLI's re-enable reconcile read it
 *   from `runtime.env`/`process.env` directly, so they are unaffected either way.)
 */
export const DAEMON_OWNED_CORAL_ENV_KEYS: ReadonlySet<string> = new Set([
  'CORAL_CHILD',
  'CORAL_CHILD_PRINCIPAL_HANDLE',
  'CORAL_JOB_ID',
  'CORAL_SESSION_ID',
  BUILD_FLAVOR_ENV_KEY,
  'CORAL_KB_PATH',
  'CORAL_ENV_PASSTHROUGH',
  CORAL_KB_ENABLE_ENV,
  'CORAL_STARTUP_ATTEMPT_ID',
  'CORAL_STARTUP_STARTED_AT',
]);

/** True when `key` is a `CORAL_*` config key a caller may forward per request. */
export function isForwardableCoralEnvKey(key: string): boolean {
  return key.startsWith('CORAL_') && !DAEMON_OWNED_CORAL_ENV_KEYS.has(key);
}

/**
 * Pick the caller's forwardable `CORAL_*` config from an env snapshot: keys that
 * pass {@link isForwardableCoralEnvKey}, with non-empty string values. Empty
 * values are dropped so an exported-but-empty var reads as "unset" (the daemon
 * then falls back to its code default) rather than masking that default.
 */
export function filterForwardableCoralEnv(source: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.length > 0 && isForwardableCoralEnvKey(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Parse the untrusted request-body `coralEnv` map into the forwardable
 * `CORAL_*` config. Returns the filtered map — **possibly empty** — whenever the
 * caller sent a `coralEnv` object; an empty result is authoritative and clears
 * the daemon's boot config so the provider falls back to its code default.
 * Returns `undefined` only when the field is absent (or not an object), which a
 * caller that does not participate in config forwarding leaves untouched. The
 * present-but-empty vs absent distinction is what makes "the caller unset their
 * last CORAL_* var" revert to defaults instead of stalling on the boot value.
 *
 * Mirrors the defensive re-filtering `buildControllerEnv` applies inline for
 * `networkEnv`: the RPC schema rejects reserved keys at ingress, and this
 * re-applies the same allowlist on the raw body before it is trusted.
 */
export function readForwardedCoralEnv(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  return filterForwardableCoralEnv(value as Record<string, string | undefined>);
}

const RESERVED_CORAL_ENV_KEYS = [...DAEMON_OWNED_CORAL_ENV_KEYS].join(', ');

/**
 * Request-body schema for the forwarded `CORAL_*` config map: non-reserved
 * `CORAL_*` keys, non-empty string values. The key refinement is the
 * reject-reserved-keys guard at RPC ingress; `buildControllerEnv` re-applies
 * {@link readForwardedCoralEnv} defensively on the raw body before use.
 */
export const coralEnvForwardSchema = z.record(
  z
    .string()
    .refine(
      isForwardableCoralEnvKey,
      `Only non-reserved CORAL_* keys may be forwarded (reserved: ${RESERVED_CORAL_ENV_KEYS})`,
    ),
  z.string().min(1),
);

/**
 * Delete the inherited Claude Code session identity — `CLAUDECODE` and the `CLAUDE_*`
 * family (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_ENV_FILE`, …) —
 * from `env`, in place. `CLAUDE_CONFIG_DIR` is the one exception, preserved (see below).
 *
 * The Coral backend is a long-lived shared daemon, almost always spawned from inside a
 * Claude Code session (the SessionStart hook or the CLI auto-ensure path). It therefore
 * inherits that one session's Claude Code env and would freeze it onto every provider
 * child it spawns for the daemon's whole lifetime. Most damaging: an inherited
 * `CLAUDE_CODE_CHILD_SESSION` makes every spawned `claude` treat itself as a parent-owned
 * sub-session and skip writing its own `~/.claude/projects/<id>.jsonl` session log — the
 * very log the broker tails to detect turn completion (its absence hangs every turn until
 * the staleness watchdog aborts it). The backend reads none of these vars at runtime (its
 * plugin root is the build-time `__PLUGIN_ROOT__`), so the daemon sheds them at startup:
 * every provider child then launches with a clean, top-level environment, exactly as if
 * run from a fresh shell. Coral still tags its children with `CORAL_CHILD` so its own
 * hooks self-suppress.
 *
 * Pass the live `process.env` — it is mutated in place. `CLAUDE_CONFIG_DIR` is preserved:
 * the daemon is isolated per config dir (its plugin and backend binary install *inside*
 * that dir), so every session it serves shares the one config dir. The daemon resolves its
 * `.claude` paths and partitions its state tree from it, and forwards it to spawned `claude`
 * children so they read the matching settings/credentials/session logs. Only the per-session
 * identity vars are shed — freezing one launcher session's identity onto every child would
 * make each `claude` skip its own session log and hang the broker's turn detection.
 */
export function shedInheritedClaudeCodeEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDE_CONFIG_DIR') continue;
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_')) {
      delete env[key];
    }
  }
}

/**
 * Compose the launch env for a child process from a captured inherited env snapshot.
 *
 * Applies the same production ordering everywhere:
 * 1. Strip internal CORAL_* keys from the inherited env snapshot
 * 2. Shed oversized inherited env entries against the provided budget
 * 3. Overlay launch-specific additions
 * 4. Mark the child boundary with CORAL_CHILD=1
 */
export function composeChildEnv(
  baseEnv: Readonly<Record<string, string>>,
  envAdditions: Record<string, string>,
  budgetBytes: number,
  passthrough: Set<string>,
): Record<string, string> {
  const stripped = stripInternalCoralKeys(baseEnv);
  // CLAUDE_CONFIG_DIR is load-bearing for spawned `claude` children: it routes
  // their session logs to the daemon's config dir, which the broker tails for
  // turn detection. Protect it from size-based shedding regardless of budget.
  const protectedPassthrough = new Set(passthrough).add('CLAUDE_CONFIG_DIR');
  const inheritedEnv = shedIfOverBudget(stripped, budgetBytes, protectedPassthrough);
  return {
    ...inheritedEnv,
    ...envAdditions,
    CORAL_CHILD: '1',
  };
}

/**
 * Convenience wrapper that reads the live `process.env` and applies the same
 * sanitization pipeline. Used at provider call sites that don't have an
 * explicit env captured by the runtime layer.
 */
export function buildChildEnv(extraEnv?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      base[key] = value;
    }
  }
  return composeChildEnv(
    base,
    extraEnv ?? {},
    resolveEnvBudgetBytes(),
    parsePassthrough(process.env.CORAL_ENV_PASSTHROUGH),
  );
}
