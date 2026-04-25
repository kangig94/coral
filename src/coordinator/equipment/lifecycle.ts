import { statSync } from 'node:fs';
import type BetterSqlite3 from 'better-sqlite3';

import type { ConsumerApplyError, ConsumerDriver, ConsumerHandle } from '../consumer-driver.js';
import { readCorpusState, normalizeCorpusCursor } from '../../kb/state/corpus-state.js';
import type { KbRuntime } from '../../kb/contracts.js';
import {
  NEEDLE_CONSUMER_ID,
  type NeedleBackend,
  type NeedleBackendModule,
  type NeedleBackendOptions,
} from '../../kb/search/needle-contract.js';
import type { VectorRetrieval } from '../../kb/search/contract.js';
import { nowDate } from '../../infra/time.js';
import { resolveEmbeddingProviderConfig } from '../../kb/search/embedding.js';
import { NeedleAddonLoadError } from '../../kb/search/needle-store.js';
import {
  equipmentAddonPath,
  equipmentInstallLockPath,
  type EquipmentPathOptions,
} from '../../infra/equipment-paths.js';
import type { EquipmentView, RegisterEquipmentResult, UnregisterResult } from '../../expansion/equipment-contract.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';
import { errorMessage } from '../../infra/error-format.js';
import { runtimeActivationFromHandle, type RuntimeActivationSnapshot } from './runtime-activation.js';
import type { SlotRegistry } from './slots.js';

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
  backend: NeedleBackend;
  handle: ConsumerHandle;
};

type EquipmentDescriptor = {
  name: 'needle';
  slotId: 'kb.vector';
  consumerId: typeof NEEDLE_CONSUMER_ID;
  addonPath: (pathOptions?: EquipmentPathOptions) => string;
};

type PreparedActivation = {
  descriptor: EquipmentDescriptor;
  runtime: KbRuntime;
  addonPath: string;
};

interface ActivateNeedleOptions {
  readonly consumerId?: string;
  readonly storeFactory?: NeedleBackendOptions['storeFactory'];
}

type ActivateNeedleFn = (
  runtime: KbRuntime,
  addonPath: string,
  options?: ActivateNeedleOptions,
) => NeedleBackend | Promise<NeedleBackend>;

type CloseNeedleBackendFn = (runtime: KbRuntime) => Promise<void>;

async function loadNeedleBackendModule(): Promise<NeedleBackendModule> {
  return import('../../kb/search/needle-backend.js');
}

const activateNeedle: ActivateNeedleFn = async (runtime, addonPath, options = {}) => {
  const { createNeedleBackend } = await loadNeedleBackendModule();
  return createNeedleBackend(runtime, {
    addonPath,
    ...(options.consumerId === undefined ? {} : { consumerId: options.consumerId }),
    ...(options.storeFactory === undefined ? {} : { storeFactory: options.storeFactory }),
  });
};

const closeNeedleBackend: CloseNeedleBackendFn = async (runtime) => {
  const needle = await loadNeedleBackendModule();
  await needle.closeNeedleBackend(runtime);
};

export interface EquipmentLifecycleServiceOptions {
  readonly db: BetterSqlite3.Database;
  readonly consumerDriver: ConsumerDriver;
  readonly slotRegistry: SlotRegistry;
  readonly resolveKbRuntime: () => KbRuntime | null;
  readonly removeInstallArtifacts?: (name: string) => Promise<void>;
  readonly now?: () => Date;
  readonly pathOptions?: EquipmentPathOptions;
  readonly closeNeedleBackend?: CloseNeedleBackendFn;
  readonly activateNeedle?: ActivateNeedleFn;
  readonly needleBackendOptions?: Pick<NeedleBackendOptions, 'storeFactory'>;
}

const TRANSIENT_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN']);

export class EquipmentLifecycleService {
  private readonly now: () => Date;
  private readonly closeNeedleBackendFn: CloseNeedleBackendFn;
  private readonly activateNeedleFn: ActivateNeedleFn;
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
    this.closeNeedleBackendFn = options.closeNeedleBackend ?? closeNeedleBackend;
    this.activateNeedleFn = options.activateNeedle ?? activateNeedle;
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
      consumerId: NEEDLE_CONSUMER_ID,
      addonPath: (pathOptions) => equipmentAddonPath('needle', pathOptions),
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
    const addonPath = descriptor.addonPath(this.options.pathOptions);

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
    const { descriptor, runtime, addonPath } = this.prepareActivation(name);
    let handle: ConsumerHandle | null = null;
    let backend: NeedleBackend | null = null;

    try {
      backend = await this.activateNeedleFn(runtime, addonPath, {
        consumerId: descriptor.consumerId,
        ...(this.options.needleBackendOptions?.storeFactory === undefined
          ? {}
          : { storeFactory: this.options.needleBackendOptions.storeFactory }),
      });
      backend.onApplyFailure = (error) => {
        void this.handleApplyFailure(name, error);
      };
      handle = this.registerConsumer(backend, name);
      this.commitActivation(name, handle, backend, descriptor, runtime);
      const equipment = this.getEquipment(name);
      return {
        status: equipment.status === 'equipped' ? 'equipped' : 'catching_up',
        equipment,
      };
    } catch (error) {
      await this.rollbackActivation(name, handle, backend);

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

    await this.rollbackActivation(name, active?.handle ?? null, active?.backend ?? null);
    await this.options.removeInstallArtifacts?.(name);
    return { status: 'uninstalled' };
  }

  getRuntimeActivation(): RuntimeActivationSnapshot | null {
    const active = this.activeBySlot.get('kb.vector');
    if (!active) {
      return null;
    }

    return runtimeActivationFromHandle(active.backend, active.handle);
  }

  async shutdownActiveEquipment(): Promise<void> {
    const activeEntries = [...this.activeBySlot.values()];
    if (activeEntries.length === 0) {
      return;
    }

    for (const entry of activeEntries) {
      await entry.handle.stop().catch(() => {});
    }

    this.activeBySlot.clear();
    this.safeUnequipSlot('kb.vector');
    await this.closeRuntimeBackend(this.options.resolveKbRuntime(), activeEntries[0]?.backend ?? null);
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
    if (resolveEmbeddingProviderConfig() === null) {
      throw documentedCoralSetupError('equipment_embedding_provider_missing', { name: 'Needle' });
    }

    const addonPath = descriptor.addonPath(this.options.pathOptions);
    if (!this.isAddonFileReadable(addonPath)) {
      throw documentedCoralSetupError('equipment_binary_corrupt', { name });
    }

    return { descriptor, runtime, addonPath };
  }

  private registerConsumer(backend: NeedleBackend, name: string): ConsumerHandle {
    let handle: ConsumerHandle | null = null;
    const registerTxn = this.options.db.transaction(() => {
      handle = this.options.consumerDriver.register(backend);
    });
    registerTxn.immediate();

    if (handle === null) {
      throw new Error(`Equipment registration did not produce a handle for ${name}.`);
    }

    return handle;
  }

  private commitActivation(
    name: string,
    handle: ConsumerHandle,
    backend: NeedleBackend,
    descriptor: EquipmentDescriptor,
    runtime: KbRuntime,
  ): void {
    const slot = this.options.slotRegistry.get<VectorRetrieval>(descriptor.slotId);
    const commitTxn = this.options.db.transaction(() => {
      slot.equip(backend, handle);
      this.activeBySlot.set(descriptor.slotId, {
        name: descriptor.name,
        slotId: descriptor.slotId,
        backend,
        handle,
      });
      this.writeStateRow(name, 'equipped');
      this.options.consumerDriver.notifyCorpus(runtime.getCorpusStateSnapshot());
    });
    commitTxn.immediate();
  }

  private async rollbackActivation(name: string, handle: ConsumerHandle | null, backend: NeedleBackend | null): Promise<void> {
    const descriptor = this.requireDescriptor(name);
    const active = this.activeBySlot.get(descriptor.slotId);
    const runtime = this.options.resolveKbRuntime();
    const handleToStop = active?.name === name ? active.handle : handle;

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
    this.safeUnequipSlot(descriptor.slotId);
    await this.closeRuntimeBackend(runtime, backend);
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
      // Apply-failure leaves local artifacts on disk; user must run 'coral-cli expansion unequip <name>' to reclaim.
      await this.rollbackActivation(name, active?.handle ?? null, active?.backend ?? null);
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

  private requireKbRuntime(name: string): KbRuntime {
    const runtime = this.options.resolveKbRuntime();
    if (!runtime) {
      throw documentedCoralSetupError('equipment_runtime_unavailable', { name });
    }
    return runtime;
  }

  private async closeRuntimeBackend(runtime: KbRuntime | null, backend: NeedleBackend | null = null): Promise<void> {
    if (runtime !== null) {
      await this.closeNeedleBackendFn(runtime).catch(() => {});
      return;
    }

    await backend?.close().catch(() => {});
  }

  private safeUnequipSlot(slotId: string): void {
    try {
      this.options.slotRegistry.get<VectorRetrieval>(slotId).unequip();
    } catch {
      // The slot may not be declared yet in isolated tests; treat as best-effort cleanup.
    }
  }

  private isInstallLockPresent(name: string): boolean {
    try {
      return statSync(equipmentInstallLockPath(name, this.options.pathOptions)).isDirectory();
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
