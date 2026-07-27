import { backendLog } from '../../infra/backend-log.js';
import type { EngineManifest, Expansion, ExpansionHost } from '../../expansion/contract.js';
import { BUNDLED_ENGINES, loadBundledEngine } from '../../expansion/bundled.js';
import { disposeExpansionScope } from '../../expansion/host.js';
import { createScope } from '../../expansion/scope.js';
import type { KbRuntime } from '../../kb/contract.js';
import type { KbCapabilityName, KbCapabilityStatus } from '../../kb/capability/contract.js';
import { kbCapabilityNameSchema } from '../../kb/capability/contract.js';
import { AbortError, throwIfAborted } from '../../runtime/abort.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';
import type { Disposable } from '../../runtime/ports.js';
import { validateManifestCompleteness } from '../../expansion/manifest/completeness.js';
import type { EngineManifestProvides } from '../../expansion/contract.js';
import type { ExpansionManifestCatalog } from '../../expansion/manifest/catalog.js';
import { LIFECYCLE_BUNDLED_LOADERS } from './bundled-loaders.js';
import type { ExpansionStateStore } from './state.js';

type ExpansionModule = {
  default: (host: ExpansionHost) => void | Promise<void>;
};

function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, stage: string): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  throwIfAborted(signal, stage);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new AbortError({ stage, reason: signal.reason }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export interface ExpansionLifecycleView {
  readonly id: string;
  readonly version: string;
  readonly tier: 'bundled' | 'installed';
  readonly status: 'active' | 'inactive' | 'installed-not-active';
  readonly lastError?: string;
  readonly provides?: EngineManifestProvides;
  readonly capabilityStatus?: KbCapabilityStatus[];
}

export type CoordinatorLifecyclePhase = 'starting' | 'running' | 'draining' | 'stopped';

function expansionStatus(failed: unknown | undefined, isActive: boolean): ExpansionLifecycleView['status'] {
  if (failed !== undefined) {
    return 'installed-not-active';
  }

  return isActive ? 'active' : 'inactive';
}

export interface ExpansionLifecycleServiceOptions {
  readonly makeHost: (manifest: EngineManifest, scope: Disposable) => ExpansionHost;
  readonly state: ExpansionStateStore;
  readonly manifest?: readonly EngineManifest[];
  readonly manifestCatalog?: ExpansionManifestCatalog;
  /**
   * Override map for `tier: 'bundled'` engine loaders. Defaults to the
   * production `BUNDLED_LOADERS` registry. Tests inject custom `Expansion`
   * functions here to exercise failure / partial-bind / success paths
   * without going through the dynamic-import surface.
   */
  readonly bundledLoaders?: Readonly<Record<string, Expansion>>;
  readonly now: () => string;
  readonly resolveKbRuntime?: () => KbRuntime | null;
  /**
   * Reports the coordinator's current lifecycle phase. `equip()` consults this
   * BEFORE any async work so a draining coordinator refuses new equips
   * immediately, before `await import` could resolve into a soon-to-be-disposed
   * binding. Past the fence, `shutdownActiveExpansions` cooperates via
   * `engineMutex` and waits for the in-flight equip to publish its scope before
   * disposing it.
   */
  readonly getLifecyclePhase?: () => CoordinatorLifecyclePhase;
  /** Current non-manifest package ids that must never enter retirement. */
  readonly protectedPackageIds?: ReadonlySet<string>;
  readonly retireCatalogAbsent?: (name: string, finalizeState: () => void) => Promise<'current' | 'removed'>;
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

  private readonly options: ExpansionLifecycleServiceOptions;
  constructor(options: ExpansionLifecycleServiceOptions) {
    this.options = options;
    this.manifest = options.manifest ?? BUNDLED_ENGINES;
    this.now = options.now;
  }

  async equip(name: string): Promise<void> {
    return this.runSerial(name, () => this.equipLocked(name));
  }

  async unequip(name: string): Promise<void> {
    return this.runSerial(name, () => this.unequipLocked(name));
  }

  async removeExpansionCatalog(name: string): Promise<RemoveExpansionCatalogResult> {
    return this.runSerial(name, () => this.removeExpansionCatalogLocked(name));
  }

  private async equipLocked(name: string): Promise<void> {
    const entry = this.manifestEntries().find((candidate) => candidate.id === name);
    if (!entry) {
      throw documentedCoralSetupError('unknown_expansion', { name });
    }

    if (entry.tier === 'bundled') {
      throw documentedCoralSetupError('expansion_bundled_immutable', { name });
    }

    // Phase fence BEFORE any async work — refuse new equips while the
    // coordinator is draining or stopped. Past the fence, the equip runs to
    // completion under its `engineMutex` slot; `shutdownActiveExpansions`
    // queues behind that slot and observes the published scope.
    this.assertNotDraining(entry.id);

    const scope = createScope();
    const host = this.options.makeHost(entry, scope);

    try {
      const module = (await import(entry.specifier)) as ExpansionModule;
      await module.default(host);
      const kb = this.requireKbRuntime(entry.id);
      validateManifestCompleteness(entry, kb.roleRegistry, kb.capabilityRegistry);
      this.options.state.insert({
        id: entry.id,
        version: entry.version,
        installed_at: this.now(),
      });
      this.appendScope(entry.id, scope);
      this.failedRecovery.delete(entry.id);
    } catch (error) {
      await disposeExpansionScope(scope);
      throw error;
    }
  }

  private assertNotDraining(name: string): void {
    const phase = this.options.getLifecyclePhase?.();
    if (phase === 'draining' || phase === 'stopped') {
      throw documentedCoralSetupError('expansion_equip_aborted', { name });
    }
  }

  private async unequipLocked(name: string): Promise<void> {
    const entry = this.manifestEntries().find((candidate) => candidate.id === name);
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
      for (let index = scopes.length - 1; index >= 0; index -= 1) {
        await disposeExpansionScope(scopes[index]);
      }
      this.scopes.delete(name);
    }
    this.options.state.delete(name);
    this.failedRecovery.delete(name);

    // Refill any now-empty bundled-tier slot the unequipped engine was filling.
    await this.applyBundledFallback();
  }

  private async removeExpansionCatalogLocked(name: string): Promise<RemoveExpansionCatalogResult> {
    const entry = this.manifestEntries().find((candidate) => candidate.id === name);
    if (entry === undefined) {
      if (this.options.protectedPackageIds?.has(name) === true || this.options.retireCatalogAbsent === undefined) {
        return { status: 'unknown' };
      }
      const retirement = await this.options.retireCatalogAbsent(name, () => {
        this.options.state.delete(name);
      });
      if (retirement === 'current') {
        return { status: 'unknown' };
      }
      this.failedRecovery.delete(name);
      return { status: 'removed' };
    }

    const isStatic =
      this.options.manifestCatalog?.isStatic(name) ?? BUNDLED_ENGINES.some((candidate) => candidate.id === name);
    if (isStatic) {
      return { status: 'immutable' };
    }

    const blockers = this.catalogDependents(entry);
    if (blockers.size > 0) {
      return blockedCatalogRemoval(entry.id, blockers);
    }

    const scopes = this.scopes.get(name);
    if (scopes !== undefined && scopes.length > 0) {
      for (let index = scopes.length - 1; index >= 0; index -= 1) {
        await disposeExpansionScope(scopes[index]);
      }
      this.scopes.delete(name);
    }
    this.options.state.delete(name);
    this.failedRecovery.delete(name);

    const kb = this.options.resolveKbRuntime?.() ?? null;
    if (kb !== null) {
      for (const fill of entry.fills ?? []) {
        const status = kb.capabilityRegistry.runtimeView().status(fill);
        if (status?.heldBy === entry.id) {
          return blockedCatalogRemoval(entry.id, new Map([[fill, []]]));
        }
      }
      for (const descriptor of entry.provides?.capabilities ?? []) {
        const status = kb.capabilityRegistry.runtimeView().status(descriptor.name);
        if (status?.bound === true) {
          return blockedCatalogRemoval(entry.id, new Map([[descriptor.name, []]]));
        }
        kb.capabilityRegistry.unregisterManifest(descriptor.name, entry.id);
      }
    }

    const removal = this.options.manifestCatalog?.removeInstalledEntry(name);
    return removal === 'missing' ? { status: 'unknown' } : { status: 'removed' };
  }

  private async runSerial<T>(name: string, work: () => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    const previous = this.engineMutex.get(name) ?? Promise.resolve();
    // Tail tracks "this call's completion ignoring its outcome" so the next
    // chained caller waits for serialization regardless of whether `work`
    // resolved or threw.
    const tail = previous
      .catch(() => {})
      .then(() => {
        if (options.signal !== undefined) {
          throwIfAborted(options.signal, 'expansion_serial_work');
        }
        return work();
      });
    const tracked = tail.then(
      () => {},
      () => {},
    );
    this.engineMutex.set(name, tracked);
    try {
      return await waitForAbortable(tail, options.signal, 'expansion_serial_wait');
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
    const manifest = this.manifestEntries();
    const manifestOrder = new Map<string, number>();
    const manifestById = new Map<string, EngineManifest>();
    for (let index = 0; index < manifest.length; index += 1) {
      const entry = manifest[index];
      manifestOrder.set(entry.id, index);
      manifestById.set(entry.id, entry);
    }
    const orderedRows = this.options.state
      .list()
      .sort(
        (left, right) =>
          (manifestOrder.get(left.id) ?? Number.POSITIVE_INFINITY) -
          (manifestOrder.get(right.id) ?? Number.POSITIVE_INFINITY),
      );

    for (const row of orderedRows) {
      const entry = manifestById.get(row.id);
      if (!entry) {
        const remediation = `Run 'coral-cli expansion remove-catalog ${row.id}' to remove retired expansion artifacts.`;
        this.failedRecovery.set(row.id, new Error(remediation));
        backendLog.warn(`Retired expansion row '${row.id}' preserved. ${remediation}`);
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
      const details: string[] = [];
      for (const [id, err] of fallback.failed) {
        details.push(`${id}: ${err.message}`);
      }
      const detail = details.join('; ');
      throw new Error(`Bundled-engine equip failed: ${detail}`);
    }
  }

  /**
   * Walks bundled-tier engines in manifest order. Engines with declared fills
   * that are already fully held are skipped before import. For invoked engines,
   * capability single-occupancy rejects any late conflicting bind and the
   * partial scope is disposed. Per-engine failures are collected; the method
   * itself does not throw.
   */
  async applyBundledFallback(): Promise<{ equipped: string[]; failed: Map<string, Error> }> {
    const equipped: string[] = [];
    const failed = new Map<string, Error>();
    const kb = this.options.resolveKbRuntime?.() ?? null;

    for (const entry of this.manifestEntries()) {
      if (entry.tier !== 'bundled') {
        continue;
      }

      // Acquire the per-engine mutex so user equip(X) and bundled fallback
      // for the same engine — both of which mutate `this.scopes` and bindings
      // — are serialized at the lifecycle layer. The `before`/`after` binding
      // holder snapshot is captured INSIDE the slot so it reflects the state
      // the bundled body actually saw.
      await this.runSerial(entry.id, async () => {
        const before = this.captureFallbackBindingHolders(entry, kb);
        if (this.hasAllDeclaredFillsHeld(entry, before)) {
          return;
        }

        const scope = createScope();
        const host = this.options.makeHost(entry, scope);

        try {
          await loadBundledEngine(entry, host, this.options.bundledLoaders ?? LIFECYCLE_BUNDLED_LOADERS);
          const currentKb = this.requireKbRuntime(entry.id);
          validateManifestCompleteness(entry, currentKb.roleRegistry, currentKb.capabilityRegistry);
          if (this.didFillFallbackBinding(entry, before, kb)) {
            this.appendScope(entry.id, scope);
            this.failedRecovery.delete(entry.id);
            equipped.push(entry.id);
          } else {
            await disposeExpansionScope(scope);
          }
        } catch (error) {
          await disposeExpansionScope(scope);
          const recordedError = asError(error);
          failed.set(entry.id, recordedError);
          this.failedRecovery.set(entry.id, recordedError);
        }
      });
    }

    return { equipped, failed };
  }

  info(name: string): ExpansionLifecycleView {
    const row = this.options.state.get(name);
    const failed = this.failedRecovery.get(name);
    const manifest = this.manifestEntries().find((entry) => entry.id === name);
    const tier = manifest?.tier ?? 'installed';
    const isActive = (this.scopes.get(name) ?? []).length > 0;

    if (tier === 'bundled') {
      return {
        id: name,
        version: manifest?.version ?? row?.version ?? 'unknown',
        tier,
        status: expansionStatus(failed, isActive),
        ...(failed === undefined ? {} : { lastError: failed.message }),
        ...(manifest?.provides === undefined ? {} : { provides: manifest.provides }),
        ...this.capabilityStatusFor(manifest),
      };
    }

    return {
      id: name,
      version: row?.version ?? manifest?.version ?? 'unknown',
      tier,
      status: expansionStatus(failed, isActive),
      ...(failed === undefined ? {} : { lastError: failed.message }),
      ...(manifest?.provides === undefined ? {} : { provides: manifest.provides }),
      ...this.capabilityStatusFor(manifest),
    };
  }

  list(): ExpansionLifecycleView[] {
    const manifest = this.manifestEntries();
    const manifestOrder = new Map<string, number>();
    const ids = new Set<string>();
    for (let index = 0; index < manifest.length; index += 1) {
      const entry = manifest[index];
      manifestOrder.set(entry.id, index);
      ids.add(entry.id);
    }
    for (const row of this.options.state.list()) {
      ids.add(row.id);
    }

    const orderedIds = [...ids].sort(
      (left, right) =>
        (manifestOrder.get(left) ?? Number.POSITIVE_INFINITY) - (manifestOrder.get(right) ?? Number.POSITIVE_INFINITY),
    );
    const views: ExpansionLifecycleView[] = [];
    for (const id of orderedIds) {
      views.push(this.info(id));
    }
    return views;
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

    const parsed = kbCapabilityNameSchema.safeParse(name);
    if (!parsed.success) {
      return { bound: false };
    }
    const status = kb.capabilityRegistry.runtimeView().status(parsed.data);
    if (status?.bound !== true) {
      return { bound: false };
    }
    return status.heldBy === undefined ? { bound: true } : { bound: true, heldBy: status.heldBy };
  }

  async shutdownActiveExpansions(options: { signal?: AbortSignal } = {}): Promise<void> {
    const signal = options.signal;
    if (signal !== undefined) {
      throwIfAborted(signal, 'expansion_shutdown');
    }
    // Snapshot every engine id we know about — including any with an
    // in-flight `engineMutex` slot. An equip mid-import has not yet
    // published its scope, so `this.scopes` alone would miss it; routing
    // through `runSerial` ensures the publish step completes BEFORE we
    // dispose. The phase fence in `equipLocked` keeps NEW equips out for
    // the duration of shutdown — past engines either aborted at the fence
    // (nothing to clean up) or completed registration (visible below).
    const engineIds = new Set<string>();
    for (const id of this.scopes.keys()) {
      engineIds.add(id);
    }
    for (const id of this.failedRecovery.keys()) {
      engineIds.add(id);
    }
    for (const id of this.engineMutex.keys()) {
      engineIds.add(id);
    }
    for (const id of engineIds) {
      if (signal !== undefined) {
        throwIfAborted(signal, 'expansion_shutdown_engine');
      }
      await this.runSerial(
        id,
        async () => {
          if (signal !== undefined) {
            throwIfAborted(signal, 'expansion_shutdown_engine_serial');
          }
          const scopes = this.scopes.get(id);
          if (scopes === undefined || scopes.length === 0) {
            return;
          }
          this.scopes.delete(id);
          // LIFO disposal of chained scopes for this engine.
          for (let index = scopes.length - 1; index >= 0; index -= 1) {
            await disposeExpansionScope(scopes[index], signal === undefined ? {} : { signal });
          }
        },
        signal === undefined ? {} : { signal },
      );
    }
  }

  private appendScope(id: string, scope: Disposable): void {
    const existing = this.scopes.get(id) ?? [];
    existing.push(scope);
    this.scopes.set(id, existing);
  }

  private manifestEntries(): readonly EngineManifest[] {
    return this.options.manifestCatalog?.listManifests() ?? this.manifest;
  }

  private requireKbRuntime(name: string): KbRuntime {
    const kb = this.options.resolveKbRuntime?.() ?? null;
    if (kb === null) {
      throw documentedCoralSetupError('expansion_runtime_unavailable', { name });
    }
    return kb;
  }

  private capabilityStatusFor(manifest: EngineManifest | undefined): { capabilityStatus?: KbCapabilityStatus[] } {
    if (manifest === undefined) {
      return {};
    }
    const kb = this.options.resolveKbRuntime?.() ?? null;
    if (kb === null) {
      return {};
    }
    const names = new Set<KbCapabilityName>();
    for (const name of manifest.fills ?? []) {
      names.add(name);
    }
    for (const descriptor of manifest.provides?.capabilities ?? []) {
      names.add(descriptor.name);
    }

    const statuses: KbCapabilityStatus[] = [];
    for (const name of names) {
      const status = kb.capabilityRegistry.runtimeView().status(name);
      if (status !== undefined) {
        statuses.push(status);
      }
    }
    return statuses.length === 0 ? {} : { capabilityStatus: statuses };
  }

  private captureFallbackBindingHolders(
    entry: EngineManifest,
    kb: KbRuntime | null,
  ): Map<string, string | undefined> | null {
    if (kb === null) {
      return null;
    }

    const names = entry.fills ?? [];
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
    for (const name of entry.fills) {
      if (holders.get(name) === undefined) {
        return false;
      }
    }
    return true;
  }

  private didFillFallbackBinding(
    entry: EngineManifest,
    before: Map<string, string | undefined> | null,
    kb: KbRuntime | null,
  ): boolean {
    if (before === null || kb === null) {
      return true;
    }

    const names = entry.fills ?? [];
    for (const name of names) {
      if (before.get(name) === undefined && this.readKnownBindingHolder(kb, name) === entry.id) {
        return true;
      }
    }
    return false;
  }

  private readKnownBindingHolder(kb: KbRuntime, name: KbCapabilityName): string | undefined {
    return kb.capabilityRegistry.runtimeView().status(name)?.heldBy;
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

    const blockers = new Map<KbCapabilityName, CapabilityDependent[]>();
    for (const candidate of this.manifestEntries()) {
      if (candidate.id === entry.id) {
        continue;
      }
      if (!this.isActive(candidate.id)) {
        continue;
      }
      for (const edge of readEdgesFor(candidate, 'active')) {
        if (!fillsSet.has(edge.capability)) {
          continue;
        }
        const dependents = blockers.get(edge.capability) ?? [];
        dependents.push(edge.dependent);
        blockers.set(edge.capability, dependents);
      }
    }

    if (blockers.size > 0) {
      throw documentedCoralSetupError({
        code: 'capability_required_by_active_engine',
        target: entry.id,
        capabilities: [...blockers.entries()].map(([capability, dependents]) => ({
          capability,
          dependents,
        })),
      });
    }
  }

  private catalogDependents(entry: EngineManifest): Map<KbCapabilityName, CapabilityDependent[]> {
    const declared = new Set<KbCapabilityName>();
    for (const descriptor of entry.provides?.capabilities ?? []) {
      declared.add(descriptor.name);
    }
    if (declared.size === 0) {
      return new Map();
    }

    const blockers = new Map<KbCapabilityName, CapabilityDependent[]>();
    for (const candidate of this.manifestEntries()) {
      if (candidate.id === entry.id) {
        continue;
      }
      const state: CapabilityDependent['state'] = this.isActive(candidate.id) ? 'active' : 'catalog';
      for (const edge of readEdgesFor(candidate, state)) {
        if (!declared.has(edge.capability)) {
          continue;
        }
        const dependents = blockers.get(edge.capability) ?? [];
        dependents.push(edge.dependent);
        blockers.set(edge.capability, dependents);
      }
      for (const edge of writeEdgesFor(candidate, state)) {
        if (!declared.has(edge.capability)) {
          continue;
        }
        const dependents = blockers.get(edge.capability) ?? [];
        dependents.push(edge.dependent);
        blockers.set(edge.capability, dependents);
      }
    }

    return blockers;
  }
}

type CapabilityDependent = {
  readonly expansion: string;
  readonly edgeKind: 'read' | 'write';
  readonly source: 'onboarding' | 'retrievalRole' | 'fills';
  readonly state: 'active' | 'catalog';
};

type CapabilityRemovalBlocker = {
  readonly capability: KbCapabilityName;
  readonly dependents: CapabilityDependent[];
};

type RemoveExpansionCatalogResult =
  | { readonly status: 'removed' }
  | { readonly status: 'immutable' }
  | { readonly status: 'unknown' }
  | {
      readonly status: 'blocked';
      readonly target: string;
      readonly capabilities: CapabilityRemovalBlocker[];
      readonly dependents: (CapabilityDependent & { readonly capability: KbCapabilityName })[];
    };

type CapabilityEdge = {
  readonly capability: KbCapabilityName;
  readonly dependent: CapabilityDependent;
};

function readEdgesFor(manifest: EngineManifest, state: CapabilityDependent['state']): CapabilityEdge[] {
  const edges: CapabilityEdge[] = [];
  for (const step of manifest.onboarding ?? []) {
    if (step.kind === 'require-binding') {
      edges.push({
        capability: step.binding,
        dependent: { expansion: manifest.id, edgeKind: 'read', source: 'onboarding', state },
      });
    }
  }
  for (const descriptor of manifest.provides?.retrievalRoles ?? []) {
    for (const capability of descriptor.requires ?? []) {
      edges.push({
        capability,
        dependent: { expansion: manifest.id, edgeKind: 'read', source: 'retrievalRole', state },
      });
    }
  }
  return edges;
}

function writeEdgesFor(manifest: EngineManifest, state: CapabilityDependent['state']): CapabilityEdge[] {
  const edges: CapabilityEdge[] = [];
  for (const capability of manifest.fills ?? []) {
    edges.push({
      capability,
      dependent: { expansion: manifest.id, edgeKind: 'write', source: 'fills', state },
    });
  }
  return edges;
}

function blockedCatalogRemoval(
  target: string,
  blockers: ReadonlyMap<KbCapabilityName, readonly CapabilityDependent[]>,
): Extract<RemoveExpansionCatalogResult, { status: 'blocked' }> {
  const capabilities: CapabilityRemovalBlocker[] = [];
  for (const [capability, dependents] of blockers) {
    capabilities.push({
      capability,
      dependents: [...dependents],
    });
  }
  const dependents: (CapabilityDependent & { readonly capability: KbCapabilityName })[] = [];
  for (const { capability, dependents: capabilityDependents } of capabilities) {
    for (const dependent of capabilityDependents) {
      dependents.push({ capability, ...dependent });
    }
  }

  return {
    status: 'blocked',
    target,
    capabilities,
    dependents,
  };
}
