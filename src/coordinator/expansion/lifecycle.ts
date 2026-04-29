import { backendLog } from '../../infra/backend-log.js';
import type { EngineManifest, ExpansionHost } from '../../expansion/contract.js';
import { BUNDLED_ENGINES } from '../../expansion/bundled.js';
import { registeredConsumerHandles } from '../../expansion/host.js';
import { createScope } from '../../expansion/scope.js';
import type { KbRuntime } from '../../kb/contract.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';
import type { Disposable } from '../../runtime/ports.js';
import type { ExpansionStateStore } from './state.js';

type ExpansionModule = {
  default: (host: ExpansionHost) => void | Promise<void>;
};

export type ExpansionLifecycleView = {
  id: string;
  version: string;
  tier: 'bundled' | 'installed';
  status: 'active' | 'inactive' | 'installed-not-active';
  lastError?: string;
};

export type CoordinatorLifecyclePhase = 'starting' | 'running' | 'draining' | 'stopped';

export interface ExpansionLifecycleServiceOptions {
  readonly makeHost: (id: string, scope: Disposable, tier: 'bundled' | 'installed') => ExpansionHost;
  readonly state: ExpansionStateStore;
  readonly manifest?: readonly EngineManifest[];
  readonly now?: () => string;
  readonly resolveKbRuntime?: () => KbRuntime | null;
  /**
   * Reports the coordinator's current lifecycle phase. `equip()` checks this
   * after `await module.default(host)` returns and before the scope/row land
   * in the bookkeeping maps. If shutdown started during the import, the bound
   * resource is disposed and the equip throws `expansion_equip_aborted` —
   * preventing orphan bindings that `shutdownActiveExpansions` cannot see.
   */
  readonly getLifecyclePhase?: () => CoordinatorLifecyclePhase;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class ExpansionLifecycleService {
  private readonly manifest: readonly EngineManifest[];
  private readonly now: () => string;
  /**
   * Multi-scope per id: each `unequip → applyBundledFallback` cycle appends a
   * new scope. Disposing a bundled engine disposes the chain LIFO, preserving
   * the binding-level single-occupancy invariant while letting the bundled
   * engine re-attach to whichever bindings emptied.
   */
  private readonly scopes = new Map<string, Disposable[]>();
  private readonly failedRecovery = new Map<string, Error>();
  /**
   * Per-engine async mutex. `equip(X)` and `unequip(X)` both chain on the
   * same key so DB-row + scope bookkeeping stays serialized — preserving
   * the post-condition `scopes.has(id) iff state.get(id)` even under
   * overlapping callers (§16 #43 single-occupancy).
   */
  private readonly engineMutex = new Map<string, Promise<void>>();

  constructor(private readonly options: ExpansionLifecycleServiceOptions) {
    this.manifest = options.manifest ?? BUNDLED_ENGINES;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async equip(name: string): Promise<void> {
    return this.runSerial(name, () => this.equipLocked(name));
  }

  async unequip(name: string): Promise<void> {
    return this.runSerial(name, () => this.unequipLocked(name));
  }

  private async equipLocked(name: string): Promise<void> {
    const entry = this.manifest.find((candidate) => candidate.id === name);
    if (!entry) {
      throw documentedCoralSetupError('unknown_expansion', { name });
    }

    if (entry.tier === 'bundled') {
      throw documentedCoralSetupError('expansion_bundled_immutable', { name });
    }

    const scope = createScope();
    const host = this.options.makeHost(entry.id, scope, entry.tier);

    try {
      const module = (await import(entry.specifier)) as ExpansionModule;
      await module.default(host);
      // Shutdown can fire during `await module.default(host)`. The scope is
      // not yet in `this.scopes`, so `shutdownActiveExpansions` cannot see
      // it — dispose explicitly and surface a structured aborted error so
      // the caller knows to retry against the next coordinator.
      const phase = this.options.getLifecyclePhase?.();
      if (phase === 'draining' || phase === 'stopped') {
        await this.disposeScope(scope);
        throw documentedCoralSetupError('expansion_equip_aborted', { name: entry.id });
      }
      this.options.state.insert({
        id: entry.id,
        version: entry.version,
        installed_at: this.now(),
      });
      this.appendScope(entry.id, scope);
      this.failedRecovery.delete(entry.id);
    } catch (error) {
      await this.disposeScope(scope);
      throw error;
    }
  }

  private async unequipLocked(name: string): Promise<void> {
    const entry = this.manifest.find((candidate) => candidate.id === name);
    if (entry?.tier === 'bundled') {
      throw documentedCoralSetupError('expansion_bundled_immutable', { name });
    }

    const scopes = this.scopes.get(name);
    const row = this.options.state.get(name);
    const failed = this.failedRecovery.has(name);
    if (!scopes && !row && !failed) {
      throw documentedCoralSetupError('expansion_not_equipped', { name });
    }

    if (entry !== undefined) {
      this.assertNoActiveDependents(entry);
    }

    if (scopes && scopes.length > 0) {
      // LIFO disposal of chained scopes for this engine.
      for (const scope of [...scopes].reverse()) {
        await this.disposeScope(scope);
      }
      this.scopes.delete(name);
    }
    this.options.state.delete(name);
    this.failedRecovery.delete(name);

    // Refill any now-empty bundled-tier slot the unequipped engine was filling.
    await this.applyBundledFallback();
  }

  private async runSerial(name: string, work: () => Promise<void>): Promise<void> {
    const previous = this.engineMutex.get(name) ?? Promise.resolve();
    // Tail tracks "this call's completion ignoring its outcome" so the next
    // chained caller waits for serialization regardless of whether `work`
    // resolved or threw.
    const tail = previous.catch(() => {}).then(work);
    const tracked = tail.then(
      () => {},
      () => {},
    );
    this.engineMutex.set(name, tracked);
    try {
      await tail;
    } finally {
      // Drop the slot only if no later caller chained behind us; an in-flight
      // successor will have replaced the value already.
      void tracked.then(() => {
        if (this.engineMutex.get(name) === tracked) {
          this.engineMutex.delete(name);
        }
      });
    }
  }

  async recoverOnBoot(): Promise<void> {
    const manifestOrder = new Map(this.manifest.map((entry, index) => [entry.id, index]));
    const orderedRows = this.options.state
      .list()
      .sort(
        (left, right) =>
          (manifestOrder.get(left.id) ?? Number.POSITIVE_INFINITY) -
          (manifestOrder.get(right.id) ?? Number.POSITIVE_INFINITY),
      );

    for (const row of orderedRows) {
      const entry = this.manifest.find((candidate) => candidate.id === row.id);
      if (!entry) {
        this.options.state.delete(row.id);
        this.failedRecovery.delete(row.id);
        backendLog.warn(`Orphan expansion row '${row.id}' deleted; expansion no longer in BUNDLED_ENGINES`);
        continue;
      }

      if (entry.tier === 'bundled') {
        // Bundled engines re-equip via the fallback pass at every boot — no durable row.
        continue;
      }

      try {
        await this.equip(row.id);
      } catch (error) {
        this.failedRecovery.set(row.id, asError(error));
      }
    }

    const fallback = await this.applyBundledFallback();
    if (fallback.failed.size > 0) {
      const detail = [...fallback.failed.entries()].map(([id, err]) => `${id}: ${err.message}`).join('; ');
      throw new Error(`Bundled-engine equip failed: ${detail}`);
    }
  }

  /**
   * Walks bundled-tier engines in manifest order. Engines with declared fills
   * that are already fully held are skipped before import. For invoked engines,
   * the body's `if (binding.heldBy === undefined)` guard ensures the bundled
   * engine fills only currently-empty bindings. Per-engine failures are
   * collected; the method itself does not throw.
   */
  async applyBundledFallback(): Promise<{ equipped: string[]; failed: Map<string, Error> }> {
    const equipped: string[] = [];
    const failed = new Map<string, Error>();
    const kb = this.options.resolveKbRuntime?.() ?? null;

    for (const entry of this.manifest) {
      if (entry.tier !== 'bundled') {
        continue;
      }

      const before = this.captureFallbackBindingHolders(entry, kb);
      if (this.hasAllDeclaredFillsHeld(entry, before)) {
        continue;
      }

      const scope = createScope();
      const host = this.options.makeHost(entry.id, scope, entry.tier);

      try {
        const module = (await import(entry.specifier)) as ExpansionModule;
        await module.default(host);
        if (this.didFillFallbackBinding(entry, before, kb)) {
          this.appendScope(entry.id, scope);
          this.failedRecovery.delete(entry.id);
          equipped.push(entry.id);
        } else {
          await this.disposeScope(scope);
        }
      } catch (error) {
        await this.disposeScope(scope);
        const recordedError = asError(error);
        failed.set(entry.id, recordedError);
        this.failedRecovery.set(entry.id, recordedError);
      }
    }

    return { equipped, failed };
  }

  info(name: string): ExpansionLifecycleView {
    const row = this.options.state.get(name);
    const failed = this.failedRecovery.get(name);
    const manifest = this.manifest.find((entry) => entry.id === name);
    const tier = manifest?.tier ?? 'installed';
    const isActive = (this.scopes.get(name) ?? []).length > 0;

    if (tier === 'bundled') {
      return {
        id: name,
        version: manifest?.version ?? row?.version ?? 'unknown',
        tier,
        status: failed ? 'installed-not-active' : isActive ? 'active' : 'inactive',
        ...(failed === undefined ? {} : { lastError: failed.message }),
      };
    }

    return {
      id: name,
      version: row?.version ?? 'unknown',
      tier,
      status: failed ? 'installed-not-active' : isActive ? 'active' : 'inactive',
      ...(failed === undefined ? {} : { lastError: failed.message }),
    };
  }

  list(): ExpansionLifecycleView[] {
    const manifestOrder = new Map(this.manifest.map((entry, index) => [entry.id, index]));
    const ids = new Set<string>();
    for (const entry of this.manifest) {
      if (entry.tier === 'bundled' || (this.scopes.get(entry.id) ?? []).length > 0) {
        ids.add(entry.id);
      }
    }
    for (const row of this.options.state.list()) {
      ids.add(row.id);
    }

    return [...ids]
      .sort(
        (left, right) =>
          (manifestOrder.get(left) ?? Number.POSITIVE_INFINITY) -
          (manifestOrder.get(right) ?? Number.POSITIVE_INFINITY),
      )
      .map((id) => this.info(id));
  }

  has(name: string): boolean {
    return (
      this.options.state.get(name) !== undefined ||
      (this.scopes.get(name) ?? []).length > 0 ||
      this.failedRecovery.has(name)
    );
  }

  isActive(name: string): boolean {
    return (this.scopes.get(name) ?? []).length > 0;
  }

  /** Diagnostic surface: reports whether a binding is filled and which engine holds it. */
  readBinding(name: string): { bound: boolean; heldBy?: string } {
    const kb = this.options.resolveKbRuntime?.();
    if (!kb) {
      return { bound: false };
    }

    if (name === 'kb.vector') {
      return kb.vector.heldBy === undefined ? { bound: false } : { bound: true, heldBy: kb.vector.heldBy };
    }
    if (name === 'kb.embedding') {
      return kb.embedding.heldBy === undefined ? { bound: false } : { bound: true, heldBy: kb.embedding.heldBy };
    }
    if (name === 'kb.fts') {
      return kb.fts.heldBy === undefined ? { bound: false } : { bound: true, heldBy: kb.fts.heldBy };
    }

    return { bound: false };
  }

  async shutdownActiveExpansions(): Promise<void> {
    const allScopes: Disposable[] = [];
    for (const scopes of this.scopes.values()) {
      allScopes.push(...scopes);
    }
    this.scopes.clear();
    for (const scope of [...allScopes].reverse()) {
      await this.disposeScope(scope);
    }
  }

  private appendScope(id: string, scope: Disposable): void {
    const existing = this.scopes.get(id) ?? [];
    existing.push(scope);
    this.scopes.set(id, existing);
  }

  private captureFallbackBindingHolders(
    entry: EngineManifest,
    kb: KbRuntime | null,
  ): Map<string, string | undefined> | null {
    if (kb === null) {
      return null;
    }

    const names = entry.fills && entry.fills.length > 0 ? entry.fills : ['kb.embedding', 'kb.vector', 'kb.fts'];
    const holders = new Map<string, string | undefined>();
    for (const name of names) {
      holders.set(name, this.readKnownBindingHolder(kb, name));
    }
    return holders;
  }

  private hasAllDeclaredFillsHeld(entry: EngineManifest, holders: Map<string, string | undefined> | null): boolean {
    if (!entry.fills || entry.fills.length === 0 || holders === null) {
      return false;
    }
    return entry.fills.every((name) => holders.get(name) !== undefined);
  }

  private didFillFallbackBinding(
    entry: EngineManifest,
    before: Map<string, string | undefined> | null,
    kb: KbRuntime | null,
  ): boolean {
    if (before === null || kb === null) {
      return true;
    }

    const names = entry.fills && entry.fills.length > 0 ? entry.fills : [...before.keys()];
    return names.some((name) => before.get(name) === undefined && this.readKnownBindingHolder(kb, name) === entry.id);
  }

  private readKnownBindingHolder(kb: KbRuntime, name: string): string | undefined {
    if (name === 'kb.vector') {
      return kb.vector.heldBy;
    }
    if (name === 'kb.embedding') {
      return kb.embedding.heldBy;
    }
    if (name === 'kb.fts') {
      return kb.fts.heldBy;
    }
    return undefined;
  }

  /**
   * Refuse to unequip an engine that fills a binding another active engine
   * declared as a `require-binding` onboarding step (R11). Avoids stale
   * cross-binding captures after the user unequips a binding holder.
   */
  private assertNoActiveDependents(entry: EngineManifest): void {
    const fillsSet = new Set(entry.fills ?? []);
    if (fillsSet.size === 0) {
      return;
    }

    for (const candidate of this.manifest) {
      if (candidate.id === entry.id) {
        continue;
      }
      if (!this.isActive(candidate.id)) {
        continue;
      }
      for (const step of candidate.onboarding ?? []) {
        if (step.kind !== 'require-binding') {
          continue;
        }
        if (fillsSet.has(step.binding)) {
          throw documentedCoralSetupError('binding_required_by_active_engine', {
            binding: step.binding,
            requiredBy: candidate.id,
          });
        }
      }
    }
  }

  private async disposeScope(scope: Disposable): Promise<void> {
    for (const handle of registeredConsumerHandles(scope)) {
      await handle.stop().catch(() => {});
      await handle.unregister().catch(() => {});
    }
    scope[Symbol.dispose]();
  }
}
