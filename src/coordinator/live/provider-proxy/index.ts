import type { ProviderProxyOperationAuthority } from './operation-route.js';

/**
 * Acquiring one guardian/reaper/proxy set.
 *
 * The whole module exists for its failure path. A half-built set is worse than none: it holds endpoints and
 * capsules, it may already have spawned a process group, and — because the enforcers arm on their own
 * clocks — it will eventually reap itself while the coordinator still believes it never existed. So every
 * step records what it created before it can fail, and one non-short-circuiting cleanup unwinds exactly
 * that record.
 */

/** A step that produced something needing removal if a later step fails. */
export type AcquisitionUndo = Readonly<{
  /** Named so a cleanup failure says which artifact outlived the attempt. */
  label: string;
  run(): Promise<void> | void;
}>;

export type ProviderProxyAcquisitionFailure = Readonly<{
  kind: 'provider_proxy_acquisition_failed';
  /** Which cut failed. The set is never partially published, so this is the whole outcome. */
  cut: string;
  reason: string;
  /** Cleanup actions that themselves failed. Non-empty means something was left behind. */
  strandedArtifacts: readonly string[];
}>;

export type ProviderProxyAcquisitionResult =
  | Readonly<{ kind: 'acquired'; set: ProviderProxyOperationAuthority }>
  | ProviderProxyAcquisitionFailure;

/**
 * One acquisition attempt's steps, in order. Each returns the undo for what it created, so the record is
 * built by the same code that does the creating — a separate list would drift the first time a step changed.
 */
export interface ProviderProxyAcquisitionSteps {
  /** Writes the three one-use capsules. */
  createCapsules(): Promise<AcquisitionUndo>;
  /** Spawns the detached guardian, which in turn spawns the reaper and then the proxy. */
  spawnGuardian(): Promise<AcquisitionUndo>;
  /**
   * Opens and activates control on all three endpoints, checks the strict backend identities, and confirms
   * the containment the guardian recorded. Returns the authority only once every check has passed.
   */
  establishControl(): Promise<Readonly<{ set: ProviderProxyOperationAuthority; undo: AcquisitionUndo }>>;
}

export type ProviderProxyAcquisitionOptions = Readonly<{
  steps: ProviderProxyAcquisitionSteps;
  /**
   * The one absolute budget the whole attempt — including its cleanup — is bounded by. An acquisition that
   * hung would hold the caller's single-flight slot forever, and the set it was building reaps itself on a
   * deadline nobody is watching. `unwind` races every undo against this same signal, so a hung cleanup
   * action cannot hold the slot open past it either.
   */
  deadlineSignal: AbortSignal;
  onCleanupFailure?(label: string, error: unknown): void;
}>;

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/** Rejects once `deadlineSignal` aborts, and never otherwise. */
function deadlineElapsed(deadlineSignal: AbortSignal): Promise<never> {
  const reason = new Error('the acquisition deadline elapsed during cleanup');
  if (deadlineSignal.aborted) return Promise.reject(reason);
  return new Promise((_resolve, reject) => {
    deadlineSignal.addEventListener('abort', () => reject(reason), { once: true });
  });
}

/**
 * Runs one undo, bounded by the same deadline the whole acquisition attempt is bounded by.
 *
 * `run()` is invoked eagerly here, before the race — a hung close still gets triggered — but this call site
 * never waits on it past the deadline: a cleanup that could hold the caller's single-flight slot forever is
 * exactly the failure a bounded attempt exists to rule out. What the hung action eventually does is no longer
 * this attempt's concern, so its rejection is swallowed here instead of surfacing as unhandled later.
 */
function boundedUndo(undo: AcquisitionUndo, deadlineSignal: AbortSignal): Promise<void> {
  let attempt: Promise<void>;
  try {
    attempt = Promise.resolve(undo.run());
  } catch (error: unknown) {
    attempt = Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  void attempt.catch(() => {});
  return Promise.race([attempt, deadlineElapsed(deadlineSignal)]);
}

/**
 * Runs every undo, newest first, without short-circuiting.
 *
 * Order matters: the later a thing was created, the more it depends on the earlier ones, and closing a
 * control before removing the capsule that authorised it keeps the window in which a stale capsule is
 * redeemable as short as it can be. Failures are collected rather than thrown, because a cleanup that
 * abandoned the rest on its first error is how the abandoned set keeps its endpoint.
 */
async function unwind(
  undos: readonly AcquisitionUndo[],
  deadlineSignal: AbortSignal,
  onCleanupFailure: ((label: string, error: unknown) => void) | undefined,
): Promise<string[]> {
  const stranded: string[] = [];
  for (const undo of [...undos].reverse()) {
    try {
      await boundedUndo(undo, deadlineSignal);
    } catch (error: unknown) {
      stranded.push(undo.label);
      onCleanupFailure?.(undo.label, error);
    }
  }
  return stranded;
}

/**
 * Acquires one set, or leaves nothing behind trying.
 *
 * There is no partial success: the caller receives either a set whose three controls are all active and all
 * agree on the same identities, or a typed failure. An abandoned set has no published recovery authority and
 * self-expires from its own guardian-start deadline even if this cleanup could not reach it.
 */
export async function acquireProviderProxySet(
  options: ProviderProxyAcquisitionOptions,
): Promise<ProviderProxyAcquisitionResult> {
  const undos: AcquisitionUndo[] = [];

  const fail = async (cut: string, reason: string): Promise<ProviderProxyAcquisitionFailure> => ({
    kind: 'provider_proxy_acquisition_failed',
    cut,
    reason,
    strandedArtifacts: await unwind(undos, options.deadlineSignal, options.onCleanupFailure),
  });

  const runCut = async <T>(cut: string, step: () => Promise<T>): Promise<T | ProviderProxyAcquisitionFailure> => {
    if (options.deadlineSignal.aborted) return fail(cut, 'the acquisition deadline elapsed');
    try {
      return await step();
    } catch (error: unknown) {
      return fail(cut, failureReason(error));
    }
  };

  const capsules = await runCut('capsule creation', () => options.steps.createCapsules());
  if ('kind' in capsules) return capsules;
  undos.push(capsules);

  const spawned = await runCut('guardian spawn', () => options.steps.spawnGuardian());
  if ('kind' in spawned) return spawned;
  undos.push(spawned);

  const control = await runCut('control establishment', () => options.steps.establishControl());
  if ('kind' in control) return control;
  undos.push(control.undo);

  // Last check before publishing: a deadline that elapsed while the final handshake was in flight means the
  // caller has already given up, and publishing here would hand out a set nobody is holding.
  if (options.deadlineSignal.aborted) {
    return fail('readiness publication', 'the acquisition deadline elapsed before the set was published');
  }
  return { kind: 'acquired', set: control.set };
}
