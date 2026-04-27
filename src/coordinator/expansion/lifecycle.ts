import { backendLog } from '../../infra/backend-log.js';
import type { BundledExpansion, BundledExpansionSlot, ExpansionHost } from '../../expansion/contract.js';
import { BUNDLED_EXPANSIONS } from '../../expansion/bundled.js';
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
  status: 'active' | 'inactive' | 'installed-not-active';
  lastError?: string;
};

export interface ExpansionLifecycleServiceOptions {
  readonly makeHost: (id: string, scope: Disposable) => ExpansionHost;
  readonly state: ExpansionStateStore;
  readonly manifest?: readonly BundledExpansion[];
  readonly now?: () => string;
  readonly resolveKbRuntime?: () => KbRuntime | null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const KB_BINDING_BY_SLOT: Record<BundledExpansionSlot, keyof Pick<KbRuntime, 'vector' | 'embedding' | 'fts'>> = {
  'kb.vector': 'vector',
  'kb.embedding': 'embedding',
  'kb.fts': 'fts',
};

function bindingOf(kb: KbRuntime, slot: string) {
  if (slot in KB_BINDING_BY_SLOT) {
    return kb[KB_BINDING_BY_SLOT[slot as BundledExpansionSlot]];
  }
  return null;
}

export class ExpansionLifecycleService {
  private readonly manifest: readonly BundledExpansion[];
  private readonly now: () => string;
  private readonly scopes = new Map<string, Disposable>();
  private readonly failedRecovery = new Map<string, Error>();

  constructor(private readonly options: ExpansionLifecycleServiceOptions) {
    this.manifest = options.manifest ?? BUNDLED_EXPANSIONS;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async equip(name: string): Promise<void> {
    const entry = this.manifest.find((candidate) => candidate.id === name);
    if (!entry) {
      throw documentedCoralSetupError('unknown_expansion', { name });
    }

    const scope = createScope();
    const host = this.options.makeHost(entry.id, scope);

    try {
      const module = (await import(entry.specifier)) as ExpansionModule;
      await module.default(host);
      this.options.state.insert({
        id: entry.id,
        version: entry.version,
        installed_at: this.now(),
      });
      this.scopes.set(entry.id, scope);
      this.failedRecovery.delete(entry.id);
    } catch (error) {
      await this.disposeScope(scope);
      throw error;
    }
  }

  async unequip(name: string): Promise<void> {
    const scope = this.scopes.get(name);
    const row = this.options.state.get(name);
    const failed = this.failedRecovery.has(name);
    if (!scope && !row && !failed) {
      throw documentedCoralSetupError('expansion_not_equipped', { name });
    }

    if (scope) {
      await this.disposeScope(scope);
      this.scopes.delete(name);
    }
    this.options.state.delete(name);
    this.failedRecovery.delete(name);
  }

  async recoverOnBoot(): Promise<void> {
    const manifestOrder = new Map(this.manifest.map((entry, index) => [entry.id, index]));
    const orderedRows = this.options.state
      .list()
      .sort((left, right) => (manifestOrder.get(left.id) ?? Number.POSITIVE_INFINITY) - (manifestOrder.get(right.id) ?? Number.POSITIVE_INFINITY));

    // Bundled expansions replay only when expansion_state already contains a row.
    // First-time bootstrap on an empty table loads nothing automatically.
    for (const row of orderedRows) {
      const entry = this.manifest.find((candidate) => candidate.id === row.id);
      if (!entry) {
        this.options.state.delete(row.id);
        this.failedRecovery.delete(row.id);
        backendLog.warn(`Orphan expansion row '${row.id}' deleted; expansion no longer in BUNDLED_EXPANSIONS`);
        continue;
      }

      try {
        await this.equip(row.id);
      } catch (error) {
        this.failedRecovery.set(row.id, asError(error));
      }
    }
  }

  info(name: string): ExpansionLifecycleView {
    const row = this.options.state.get(name);
    const failed = this.failedRecovery.get(name);
    return {
      id: name,
      version: row?.version ?? 'unknown',
      status: failed ? 'installed-not-active' : (this.scopes.has(name) ? 'active' : 'inactive'),
      ...(failed === undefined ? {} : { lastError: failed.message }),
    };
  }

  list(): ExpansionLifecycleView[] {
    const manifestOrder = new Map(this.manifest.map((entry, index) => [entry.id, index]));
    return this.options.state
      .list()
      .sort((left, right) => (manifestOrder.get(left.id) ?? Number.POSITIVE_INFINITY) - (manifestOrder.get(right.id) ?? Number.POSITIVE_INFINITY))
      .map((row) => this.info(row.id));
  }

  has(name: string): boolean {
    return this.options.state.get(name) !== undefined || this.scopes.has(name) || this.failedRecovery.has(name);
  }

  isActive(name: string): boolean {
    return this.scopes.has(name);
  }

  readBinding(name: string): { bound: boolean; heldBy?: string } {
    const kb = this.options.resolveKbRuntime?.();
    if (!kb) {
      return { bound: false };
    }

    const binding = bindingOf(kb, name);
    if (!binding || binding.heldBy === undefined) {
      return { bound: false };
    }

    return {
      bound: true,
      heldBy: binding.heldBy,
    };
  }

  async shutdownActiveExpansions(): Promise<void> {
    const activeScopes = [...this.scopes.values()];
    this.scopes.clear();
    for (const scope of activeScopes) {
      await this.disposeScope(scope);
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
