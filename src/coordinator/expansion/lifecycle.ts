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

export interface ExpansionLifecycleServiceOptions {
  readonly makeHost: (id: string, scope: Disposable, tier: 'bundled' | 'installed') => ExpansionHost;
  readonly state: ExpansionStateStore;
  readonly manifest?: readonly EngineManifest[];
  readonly now?: () => string;
  readonly resolveKbRuntime?: () => KbRuntime | null;
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

  constructor(private readonly options: ExpansionLifecycleServiceOptions) {
    this.manifest = options.manifest ?? BUNDLED_ENGINES;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async equip(name: string): Promise<void> {
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

  async unequip(name: string): Promise<void> {
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

    await this.applyBundledFallback();
  }

  /**
   * Walks bundled-tier engines in manifest order. For each, creates a fresh
   * scope and invokes the Expansion body. The body's `if (binding.heldBy === undefined)`
   * guard ensures the bundled engine fills only currently-empty bindings.
   * Per-engine failures are collected; the method itself does not throw.
   */
  async applyBundledFallback(): Promise<{ equipped: string[]; failed: Map<string, Error> }> {
    const equipped: string[] = [];
    const failed = new Map<string, Error>();

    for (const entry of this.manifest) {
      if (entry.tier !== 'bundled') {
        continue;
      }

      const scope = createScope();
      const host = this.options.makeHost(entry.id, scope, entry.tier);

      try {
        const module = (await import(entry.specifier)) as ExpansionModule;
        await module.default(host);
        this.appendScope(entry.id, scope);
        this.failedRecovery.delete(entry.id);
        equipped.push(entry.id);
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
      return kb.embedding.heldBy === undefined
        ? { bound: false }
        : { bound: true, heldBy: kb.embedding.heldBy };
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

  /**
   * Refuse to unequip an engine that fills a binding another active engine
   * declared as a `require-binding` onboarding step (R11). Avoids stale
   * cross-binding captures (e.g., needle holding a stale embedder reference
   * after the user unequips gemini).
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
