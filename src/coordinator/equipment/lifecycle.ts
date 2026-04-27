import { statSync } from 'node:fs';
import type BetterSqlite3 from 'better-sqlite3';

import type { ConsumerApplyError, ConsumerDriver } from '../consumer-driver.js';
import { createHostFactory } from '../expansion/host-factory.js';
import type { BundledExpansion } from '../../expansion/contract.js';
import { BUNDLED_EXPANSIONS } from '../../expansion/bundled.js';
import { registeredConsumerHandles } from '../../expansion/host.js';
import { loadExpansions } from '../../expansion/loader.js';
import type { KbRuntime } from '../../kb/contract.js';
import { configureNeedleBacked } from '../../kb/search/needle/backed-config.js';
import type { NeedleBackend, NeedleBackendOptions } from '../../kb/search/needle/contract.js';
import { NeedleAddonLoadError } from '../../kb/search/needle/store.js';
import { readCorpusState, normalizeCorpusCursor } from '../../kb/state/corpus-state.js';
import { errorMessage } from '../../infra/error-format.js';
import { nowDate } from '../../infra/time.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';
import type { Disposable, Runtime } from '../../runtime/ports.js';
import type { EquipmentView, RegisterEquipmentResult, UnregisterResult } from '../../expansion/equipment-contract.js';
import type { ConsumerHandle } from '../../store/consumer-contract.js';

type DurableEquipmentState = 'equipped' | 'disabled_pending_reinstall';
type StoredEquipmentState = DurableEquipmentState | 'unequipped';

type EquipmentStateRow = {
  name: string;
  state: StoredEquipmentState;
  installed_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
};

type EquipmentCursorRow = {
  snapshot_id: string | null;
  content_seq: number | null;
  metadata_seq: number | null;
  content_manifest_hash: string | null;
  metadata_manifest_hash: string | null;
};

type ActiveEquipmentEntry = {
  name: 'needle';
  slotId: 'kb.vector';
  bindingScope: Disposable;
  backend: NeedleBackend;
  handle: ConsumerHandle;
};

type EquipmentDescriptor = {
  name: 'needle';
  slotId: 'kb.vector';
  consumerId: 'needle';
  addonPath: () => string;
};

type PreparedActivation = {
  descriptor: EquipmentDescriptor;
  runtime: KbRuntime;
  entry: BundledExpansion;
};

export interface EquipmentLifecycleServiceOptions {
  readonly db: BetterSqlite3.Database;
  readonly runtime: Runtime;
  readonly consumerDriver: ConsumerDriver;
  readonly resolveKbRuntime: () => KbRuntime | null;
  readonly removeInstallArtifacts?: (name: string) => Promise<void>;
  readonly now?: () => Date;
  readonly needleBackendOptions?: Pick<NeedleBackendOptions, 'storeFactory'>;
}

const TRANSIENT_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN']);

export class EquipmentLifecycleService {
  private readonly now: () => Date;
  private readonly descriptors = new Map<string, EquipmentDescriptor>();
  private readonly activeBySlot = new Map<string, ActiveEquipmentEntry>();
  private readonly slotGuardQueues = new Map<string, Array<(release: () => void) => void>>();
  private readonly slotGuardLocked = new Set<string>();
  private readonly selectStateStmt: BetterSqlite3.Statement<[string], EquipmentStateRow>;
  private readonly upsertStateStmt: BetterSqlite3.Statement<[string, StoredEquipmentState, string | null, string | null, string | null]>;
  private readonly deleteStateStmt: BetterSqlite3.Statement<[string]>;
  private readonly readCursorStmt: BetterSqlite3.Statement<[string], EquipmentCursorRow>;
  private readonly deleteCursorStmt: BetterSqlite3.Statement<[string]>;

  constructor(private readonly options: EquipmentLifecycleServiceOptions) {
    this.now = options.now ?? (() => nowDate());
    this.selectStateStmt = options.db.prepare<[string], EquipmentStateRow>(
      `
        SELECT name, state, installed_at, last_error_code, last_error_message
          FROM equipment_state
         WHERE name = ?
      `,
    );
    this.upsertStateStmt = options.db.prepare<
      [string, StoredEquipmentState, string | null, string | null, string | null]
    >(
      `
        INSERT INTO equipment_state (name, state, installed_at, last_error_code, last_error_message)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          state = excluded.state,
          installed_at = excluded.installed_at,
          last_error_code = excluded.last_error_code,
          last_error_message = excluded.last_error_message
      `,
    );
    this.deleteStateStmt = options.db.prepare<[string]>('DELETE FROM equipment_state WHERE name = ?');
    this.readCursorStmt = options.db.prepare<[string], EquipmentCursorRow>(
      `
        SELECT snapshot_id, content_seq, metadata_seq, content_manifest_hash, metadata_manifest_hash
          FROM equipment_cursors
         WHERE consumer_id = ?
      `,
    );
    this.deleteCursorStmt = options.db.prepare<[string]>('DELETE FROM equipment_cursors WHERE consumer_id = ?');

    this.descriptors.set('needle', {
      name: 'needle',
      slotId: 'kb.vector',
      consumerId: 'needle',
      addonPath: () => options.runtime.paths.coral.equipment.addonPath('needle'),
    });
  }

  async acquireSlotGuard(name: string): Promise<() => void> {
    const descriptor = this.requireDescriptor(name);
    return await new Promise<() => void>((resolve) => {
      const queue = this.slotGuardQueues.get(descriptor.slotId) ?? [];
      queue.push(resolve);
      this.slotGuardQueues.set(descriptor.slotId, queue);
      this.drainSlotGuardQueue(descriptor.slotId);
    });
  }

  async listEquipment(): Promise<EquipmentView[]> {
    return [...this.descriptors.keys()].map((name) => this.getEquipment(name));
  }

  getEquipment(name: string): EquipmentView {
    const descriptor = this.requireDescriptor(name);
    const durableState = this.readStateRow(name);
    const active = this.activeBySlot.get(descriptor.slotId);
    const addonPath = descriptor.addonPath();

    let status: EquipmentView['status'] = 'not_equipped';
    if (this.isInstallLockPresent(name)) {
      status = 'installing';
    } else if (durableState?.state === 'disabled_pending_reinstall') {
      status = 'disabled_pending_reinstall';
    } else if (active?.name === name) {
      status = this.isCursorFresh(descriptor.consumerId) ? 'equipped' : 'catching_up';
    } else if (durableState?.state === 'equipped') {
      status = this.isAddonFileReadable(addonPath) ? 'inactive' : 'unavailable';
    }

    return {
      slot: descriptor.slotId,
      name: descriptor.name,
      status,
    };
  }

  async equip(name: string): Promise<RegisterEquipmentResult> {
    const current = this.getEquipment(name);
    if (current.status === 'equipped' || current.status === 'catching_up') {
      return {
        status: 'already_equipped',
        equipment: current,
      };
    }

    const { descriptor, runtime, entry } = this.prepareActivation(name);
    let scope: Disposable | null = null;
    let handle: ConsumerHandle | null = null;
    let backend: NeedleBackend | null = null;

    try {
      const hostFactory = createHostFactory({
        runtime: this.options.runtime,
        kbRuntime: runtime,
        consumerDriver: this.options.consumerDriver,
      });
      const scopes = await loadExpansions(hostFactory, [entry]);
      scope = scopes[0] ?? null;
      if (scope === null) {
        throw new Error(`Expansion '${name}' did not return a scope.`);
      }

      handle = registeredConsumerHandles(scope)[0] ?? null;
      if (handle === null) {
        throw new Error(`Expansion '${name}' did not register a consumer.`);
      }

      const vectorBacked = runtime.vector.read();
      if (vectorBacked.consumer.id !== descriptor.consumerId) {
        throw new Error(`Expansion '${name}' did not bind '${descriptor.slotId}'.`);
      }

      backend = vectorBacked.consumer as NeedleBackend;
      backend.onApplyFailure = (error) => {
        void this.handleApplyFailure(name, error);
      };

      this.commitActivation(name, scope, handle, backend, descriptor, runtime);
      const equipment = this.getEquipment(name);
      return {
        status: equipment.status === 'equipped' ? 'equipped' : 'catching_up',
        equipment,
      };
    } catch (error) {
      await this.rollbackActivation(name, scope, handle, backend);

      if (this.isBinaryLoadFailure(error)) {
        this.writeStateRow(name, 'disabled_pending_reinstall', {
          lastErrorCode: 'equipment_binary_corrupt',
          lastErrorMessage: errorMessage(error),
        });
        throw documentedCoralSetupError('equipment_binary_corrupt', { name });
      }

      throw error;
    }
  }

  async uninstall(name: string): Promise<UnregisterResult> {
    const descriptor = this.requireDescriptor(name);
    const active = this.activeBySlot.get(descriptor.slotId);
    const durableState = this.readStateRow(name);
    if (!active && (durableState === null || durableState.state === 'unequipped')) {
      return { status: 'not_equipped' };
    }

    await this.rollbackActivation(name, active?.bindingScope ?? null, active?.handle ?? null, active?.backend ?? null);
    await this.options.removeInstallArtifacts?.(name);
    return { status: 'uninstalled' };
  }

  async shutdownActiveEquipment(): Promise<void> {
    const activeEntries = [...this.activeBySlot.values()];
    this.activeBySlot.clear();

    for (const entry of activeEntries) {
      await entry.handle.stop().catch(() => {});
      try {
        this.options.consumerDriver.unregisterStoppedConsumer(entry.handle.id);
      } catch {}
      entry.bindingScope[Symbol.dispose]();
      await entry.backend.close().catch(() => {});
    }
  }

  private drainSlotGuardQueue(slotId: string): void {
    if (this.slotGuardLocked.has(slotId)) {
      return;
    }

    const queue = this.slotGuardQueues.get(slotId);
    const next = queue?.shift();
    if (!next) {
      this.slotGuardQueues.delete(slotId);
      return;
    }

    this.slotGuardLocked.add(slotId);
    let released = false;
    next(() => {
      if (released) {
        return;
      }
      released = true;
      this.slotGuardLocked.delete(slotId);
      this.drainSlotGuardQueue(slotId);
    });
  }

  private prepareActivation(name: string): PreparedActivation {
    const descriptor = this.requireDescriptor(name);
    const active = this.activeBySlot.get(descriptor.slotId);
    if (active) {
      throw documentedCoralSetupError('slot_already_equipped', {
        slotId: descriptor.slotId,
        equippedBy: active.name,
      });
    }

    const runtime = this.requireKbRuntime(name);
    if (this.options.needleBackendOptions !== undefined) {
      configureNeedleBacked(runtime, this.options.needleBackendOptions);
    }

    if (!this.isAddonFileReadable(descriptor.addonPath())) {
      throw documentedCoralSetupError('equipment_binary_corrupt', { name });
    }

    return {
      descriptor,
      runtime,
      entry: this.requireEntry(name),
    };
  }

  private commitActivation(
    name: string,
    scope: Disposable,
    handle: ConsumerHandle,
    backend: NeedleBackend,
    descriptor: EquipmentDescriptor,
    runtime: KbRuntime,
  ): void {
    const commitTxn = this.options.db.transaction(() => {
      this.activeBySlot.set(descriptor.slotId, {
        name: descriptor.name,
        slotId: descriptor.slotId,
        bindingScope: scope,
        backend,
        handle,
      });
      this.writeStateRow(name, 'equipped');
      this.options.consumerDriver.notifyCorpus(runtime.getCorpusStateSnapshot());
    });
    commitTxn.immediate();
  }

  private async rollbackActivation(
    name: string,
    scope: Disposable | null,
    handle: ConsumerHandle | null,
    backend: NeedleBackend | null,
  ): Promise<void> {
    const descriptor = this.requireDescriptor(name);
    const active = this.activeBySlot.get(descriptor.slotId);
    const bindingScope = active?.name === name ? active.bindingScope : scope;
    const handleToStop = active?.name === name ? active.handle : handle;
    const backendToClose = active?.name === name ? active.backend : backend;

    if (handleToStop !== null) {
      await handleToStop.stop().catch(() => {});
    }

    const rollbackTxn = this.options.db.transaction(() => {
      if (handleToStop !== null) {
        try {
          this.options.consumerDriver.unregisterStoppedConsumer(handleToStop.id);
        } catch {
          this.deleteCursorStmt.run(descriptor.consumerId);
        }
      } else {
        this.deleteCursorStmt.run(descriptor.consumerId);
      }
      this.deleteStateStmt.run(name);
    });
    rollbackTxn.immediate();

    this.activeBySlot.delete(descriptor.slotId);
    bindingScope?.[Symbol.dispose]();
    await backendToClose?.close().catch(() => {});
  }

  private async handleApplyFailure(name: string, applyError: ConsumerApplyError): Promise<void> {
    if (this.isTransientFailure(applyError.cause)) {
      return;
    }

    const release = await this.acquireSlotGuard(name);
    try {
      const descriptor = this.requireDescriptor(name);
      const active = this.activeBySlot.get(descriptor.slotId);
      const installedAt = this.readStateRow(name)?.installed_at ?? this.now().toISOString();
      await this.rollbackActivation(name, active?.bindingScope ?? null, active?.handle ?? null, active?.backend ?? null);
      this.writeStateRow(name, 'disabled_pending_reinstall', {
        installedAt,
        lastErrorCode: this.isBinaryLoadFailure(applyError.cause) ? 'equipment_binary_corrupt' : null,
        lastErrorMessage: applyError.message,
      });
    } finally {
      release();
    }
  }

  private writeStateRow(
    name: string,
    state: DurableEquipmentState,
    options: { installedAt?: string | null; lastErrorCode?: string | null; lastErrorMessage?: string | null } = {},
  ): void {
    const existing = this.readStateRow(name);
    this.upsertStateStmt.run(
      name,
      state,
      options.installedAt ?? existing?.installed_at ?? this.now().toISOString(),
      options.lastErrorCode ?? null,
      options.lastErrorMessage ?? null,
    );
  }

  private readStateRow(name: string): EquipmentStateRow | null {
    return this.selectStateStmt.get(name) ?? null;
  }

  private requireDescriptor(name: string): EquipmentDescriptor {
    const descriptor = this.descriptors.get(name);
    if (!descriptor) {
      throw documentedCoralSetupError('unknown_equipment', { name });
    }
    return descriptor;
  }

  private requireEntry(name: string): BundledExpansion {
    const entry = BUNDLED_EXPANSIONS.find((candidate) => candidate.id === name);
    if (entry === undefined) {
      throw documentedCoralSetupError('unknown_equipment', { name });
    }
    return entry;
  }

  private requireKbRuntime(name: string): KbRuntime {
    const runtime = this.options.resolveKbRuntime();
    if (!runtime) {
      throw documentedCoralSetupError('equipment_runtime_unavailable', { name });
    }
    return runtime;
  }

  private isInstallLockPresent(name: string): boolean {
    try {
      return statSync(this.options.runtime.paths.coral.equipment.installLockPath(name)).isDirectory();
    } catch {
      return false;
    }
  }

  private isAddonFileReadable(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }

  private isCursorFresh(consumerId: string): boolean {
    const latest = readCorpusState(this.options.db);
    const cursor = normalizeCorpusCursor(this.readCursorStmt.get(consumerId));
    return (
      cursor.contentSeq === latest.contentSeq &&
      cursor.contentManifestHash === latest.contentManifestHash &&
      cursor.metadataSeq === latest.metadataSeq &&
      cursor.metadataManifestHash === latest.metadataManifestHash
    );
  }

  private isTransientFailure(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code);
  }

  private isBinaryLoadFailure(error: unknown): boolean {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
      if (current instanceof NeedleAddonLoadError) {
        return true;
      }
      if (current instanceof Error) {
        const code = (current as NodeJS.ErrnoException).code;
        if (code === 'ERR_DLOPEN_FAILED' || code === 'MODULE_NOT_FOUND') {
          return true;
        }
      }
      current = current instanceof Error ? current.cause : undefined;
    }

    return false;
  }
}
