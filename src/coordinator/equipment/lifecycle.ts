import { existsSync, statSync } from 'node:fs';
import type BetterSqlite3 from 'better-sqlite3';

import type { ConsumerApplyError, ConsumerDriver, ConsumerHandle } from '../consumer-driver.js';
import { readCorpusState, normalizeCorpusCursor } from '../../store/corpus-state.js';
import type { KbRuntime } from '../../kb/contracts.js';
import {
  closeNeedleBackend,
  createNeedleBackend,
  NEEDLE_CONSUMER_ID,
  type NeedleBackend,
  type NeedleBackendOptions,
} from '../../kb/search/needle-backend.js';
import { resolveEmbeddingProviderConfig } from '../../kb/search/embedding.js';
import { NeedleAddonLoadError } from '../../kb/search/needle-store.js';
import { equipmentAddonPath, equipmentInstallLockPath, type EquipmentPathOptions } from '../../infra/equipment-paths.js';
import { CoralSetupError, documentedCoralSetupError } from '../../runtime/errors.js';
import { runtimeActivationFromHandle, type RuntimeActivationSnapshot } from './runtime-activation.js';
import { errorMessage } from '../../shared/utils.js';

export type DurableEquipmentState = 'unequipped' | 'equipped' | 'disabled_pending_reinstall';
export type EquipmentLifecycleStatus =
  | DurableEquipmentState
  | 'installing'
  | 'equipping'
  | 'catching_up'
  | 'unavailable';

export interface EquipmentView {
  readonly slot: string;
  readonly installedName: string | null;
  readonly activeName: string | null;
  readonly status: EquipmentLifecycleStatus;
}

export interface RegisterEquipmentRequest {
  readonly name: string;
}

export interface RegisterEquipmentResult {
  readonly status: 'equipped' | 'catching_up' | 'already_equipped';
  readonly equipment: EquipmentView;
}

export interface UnregisterEquipmentRequest {
  readonly name: string;
}

export interface UnregisterEquipmentResult {
  readonly status: 'uninstalled' | 'not_equipped';
  readonly equipment: EquipmentView;
}

type EquipmentStateRow = {
  name: string;
  state: DurableEquipmentState;
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
  name: string;
  slotId: string;
  backend: NeedleBackend;
  handle: ConsumerHandle;
};

type EquipmentDescriptor = {
  name: 'needle';
  slotId: 'kb.vector';
  consumerId: string;
  addonPath: (pathOptions?: EquipmentPathOptions) => string;
  createBackend(runtime: KbRuntime, options: NeedleBackendOptions): NeedleBackend;
};

export interface EquipmentLifecycleServiceOptions {
  readonly db: BetterSqlite3.Database;
  readonly consumerDriver: ConsumerDriver;
  readonly resolveKbRuntime: () => KbRuntime | null;
  readonly now?: () => Date;
  readonly pathOptions?: EquipmentPathOptions;
  readonly closeNeedleBackend?: typeof closeNeedleBackend;
  readonly createNeedleBackend?: typeof createNeedleBackend;
  readonly needleBackendOptions?: Omit<NeedleBackendOptions, 'addonPath' | 'consumerId'>;
}

const TRANSIENT_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN']);

export class EquipmentLifecycleService {
  private readonly now: () => Date;
  private readonly closeNeedleBackendFn: typeof closeNeedleBackend;
  private readonly needleBackendFactory: typeof createNeedleBackend;
  private readonly descriptors = new Map<string, EquipmentDescriptor>();
  private readonly activeBySlot = new Map<string, ActiveEquipmentEntry>();
  private readonly slotGuardQueues = new Map<string, Array<(release: () => void) => void>>();
  private readonly slotGuardLocked = new Set<string>();
  private readonly transientStates = new Map<string, Extract<EquipmentLifecycleStatus, 'equipping'>>();
  private readonly selectStateStmt: BetterSqlite3.Statement<[string], EquipmentStateRow>;
  private readonly upsertStateStmt: BetterSqlite3.Statement<[string, DurableEquipmentState, string | null, string | null, string | null]>;
  private readonly deleteStateStmt: BetterSqlite3.Statement<[string]>;
  private readonly readCursorStmt: BetterSqlite3.Statement<[string], EquipmentCursorRow>;
  private readonly deleteCursorStmt: BetterSqlite3.Statement<[string]>;

  constructor(private readonly options: EquipmentLifecycleServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.closeNeedleBackendFn = options.closeNeedleBackend ?? closeNeedleBackend;
    this.needleBackendFactory = options.createNeedleBackend ?? createNeedleBackend;
    this.selectStateStmt = options.db.prepare<[string], EquipmentStateRow>(
      `
        SELECT name, state, installed_at, last_error_code, last_error_message
          FROM equipment_state
         WHERE name = ?
      `,
    );
    this.upsertStateStmt = options.db.prepare<
      [string, DurableEquipmentState, string | null, string | null, string | null]
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

    const needleDescriptor: EquipmentDescriptor = {
      name: 'needle',
      slotId: 'kb.vector',
      consumerId: NEEDLE_CONSUMER_ID,
      addonPath: (pathOptions) => equipmentAddonPath('needle', pathOptions),
      createBackend: (runtime, backendOptions) => this.needleBackendFactory(runtime, backendOptions),
    };

    this.descriptors.set(needleDescriptor.name, needleDescriptor);
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

  async register(request: RegisterEquipmentRequest): Promise<RegisterEquipmentResult> {
    const release = await this.acquireSlotGuard(request.name);
    try {
      return await this.registerGuarded(request.name);
    } finally {
      release();
    }
  }

  async unregister(request: UnregisterEquipmentRequest): Promise<UnregisterEquipmentResult> {
    const release = await this.acquireSlotGuard(request.name);
    try {
      return await this.unregisterGuarded(request.name);
    } finally {
      release();
    }
  }

  async list(): Promise<EquipmentView[]> {
    return [...this.descriptors.keys()].map((name) => this.describeEquipment(name));
  }

  getRuntimeActivation(slotId: string): RuntimeActivationSnapshot | null {
    const active = this.activeBySlot.get(slotId);
    if (!active) {
      return null;
    }

    return runtimeActivationFromHandle(active.backend, active.handle);
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

  private async registerGuarded(name: string): Promise<RegisterEquipmentResult> {
    const descriptor = this.requireDescriptor(name);
    const active = this.activeBySlot.get(descriptor.slotId);
    if (active?.name === name) {
      return {
        status: 'already_equipped',
        equipment: this.describeEquipment(name),
      };
    }
    if (active) {
      throw documentedCoralSetupError('slot_already_equipped', {
        slotId: descriptor.slotId,
        equippedBy: active.name,
      });
    }

    const runtime = this.requireKbRuntime();
    if (resolveEmbeddingProviderConfig() === null) {
      throw documentedCoralSetupError('equipment_embedding_provider_missing', { name: 'Needle' });
    }

    const addonPath = descriptor.addonPath(this.options.pathOptions);
    if (!this.isAddonFileReadable(addonPath)) {
      throw documentedCoralSetupError('equipment_binary_corrupt', { name });
    }

    this.transientStates.set(name, 'equipping');
    let handle: ConsumerHandle | null = null;
    let backend: NeedleBackend | null = null;

    try {
      backend = descriptor.createBackend(runtime, {
        consumerId: descriptor.consumerId,
        addonPath,
        ...(this.options.needleBackendOptions ?? {}),
      });
      (backend as NeedleBackend & { onApplyFailure?: (error: ConsumerApplyError) => void }).onApplyFailure = (error) => {
        void this.handleApplyFailure(name, error);
      };

      const registerTxn = this.options.db.transaction(() => {
        handle = this.options.consumerDriver.register(backend as NeedleBackend & { onApplyFailure?: (error: ConsumerApplyError) => void });
        this.writeStateRow(name, 'equipped');
      });
      registerTxn.immediate();

      if (handle === null) {
        throw new Error(`Equipment registration did not produce a handle for ${name}.`);
      }

      this.activeBySlot.set(descriptor.slotId, {
        name,
        slotId: descriptor.slotId,
        backend,
        handle,
      });
      this.transientStates.delete(name);
      this.options.consumerDriver.notifyCorpus(runtime.getCorpusStateSnapshot());

      const equipment = this.describeEquipment(name);
      return {
        status: equipment.status === 'equipped' ? 'equipped' : 'catching_up',
        equipment,
      };
    } catch (error) {
      this.transientStates.delete(name);
      if (descriptor.slotId && this.activeBySlot.get(descriptor.slotId)?.name === name) {
        this.activeBySlot.delete(descriptor.slotId);
      }
      const capturedHandle = handle as ConsumerHandle | null;
      if (capturedHandle !== null) {
        await capturedHandle.stop().catch(() => {});
        try {
          this.options.consumerDriver.unregisterStoppedConsumer(capturedHandle.id);
        } catch {
          // Best-effort rollback. The SQLite transaction already rolled back row writes.
        }
      }
      await this.closeRuntimeBackend(runtime);

      if (this.isBinaryLoadFailure(error)) {
        this.writeStateRow(name, 'disabled_pending_reinstall', {
          lastErrorCode: 'equipment_binary_corrupt',
          lastErrorMessage: errorMessage(error),
        });
        throw documentedCoralSetupError('equipment_binary_corrupt', { name });
      }

      throw error;
    } finally {
      this.transientStates.delete(name);
    }
  }

  private async unregisterGuarded(name: string): Promise<UnregisterEquipmentResult> {
    const descriptor = this.requireDescriptor(name);
    const active = this.activeBySlot.get(descriptor.slotId);
    const durableState = this.readStateRow(name);
    if (!active && durableState === null) {
      return {
        status: 'not_equipped',
        equipment: this.describeEquipment(name),
      };
    }

    if (active?.name === name) {
      this.activeBySlot.delete(descriptor.slotId);
      await active.handle.stop().catch(() => {});
      await this.closeRuntimeBackend(this.options.resolveKbRuntime());

      const unregisterTxn = this.options.db.transaction(() => {
        this.options.consumerDriver.unregisterStoppedConsumer(active.handle.id);
        this.deleteStateStmt.run(name);
      });
      unregisterTxn.immediate();
    } else {
      const unregisterTxn = this.options.db.transaction(() => {
        this.deleteCursorStmt.run(descriptor.consumerId);
        this.deleteStateStmt.run(name);
      });
      unregisterTxn.immediate();
    }

    return {
      status: 'uninstalled',
      equipment: this.describeEquipment(name),
    };
  }

  private async handleApplyFailure(name: string, applyError: ConsumerApplyError): Promise<void> {
    if (this.isTransientFailure(applyError.cause)) {
      return;
    }

    const release = await this.acquireSlotGuard(name);
    try {
      const descriptor = this.requireDescriptor(name);
      const active = this.activeBySlot.get(descriptor.slotId);
      if (active?.name === name) {
        this.activeBySlot.delete(descriptor.slotId);
        await active.handle.stop().catch(() => {});
        try {
          this.options.consumerDriver.unregisterStoppedConsumer(active.handle.id, { preserveCursor: true });
        } catch {
          // If the consumer already detached, keep advancing the durable failure state.
        }
      }

      await this.closeRuntimeBackend(this.options.resolveKbRuntime());
      this.writeStateRow(name, 'disabled_pending_reinstall', {
        lastErrorCode: this.isBinaryLoadFailure(applyError.cause) ? 'equipment_binary_corrupt' : null,
        lastErrorMessage: applyError.message,
      });
    } finally {
      release();
    }
  }

  private describeEquipment(name: string): EquipmentView {
    const descriptor = this.requireDescriptor(name);
    const durableState = this.readStateRow(name);
    const active = this.activeBySlot.get(descriptor.slotId);
    const installedName = durableState?.state === 'unequipped' || durableState === null ? null : name;
    const activeName = active?.name === name ? name : null;

    let status: EquipmentLifecycleStatus = durableState?.state ?? 'unequipped';
    const transient = this.transientStates.get(name);
    if (transient) {
      status = transient;
    } else if (this.isInstallLockPresent(name)) {
      status = 'installing';
    } else if (durableState?.state === 'disabled_pending_reinstall') {
      status = 'disabled_pending_reinstall';
    } else if (activeName !== null) {
      status = this.isCursorFresh(descriptor.consumerId) ? 'equipped' : 'catching_up';
    } else if (installedName !== null && !this.isAddonFileReadable(descriptor.addonPath(this.options.pathOptions))) {
      status = 'unavailable';
    }

    return {
      slot: descriptor.slotId,
      installedName,
      activeName,
      status,
    };
  }

  private writeStateRow(
    name: string,
    state: Exclude<DurableEquipmentState, 'unequipped'>,
    options: { lastErrorCode?: string | null; lastErrorMessage?: string | null } = {},
  ): void {
    const existing = this.readStateRow(name);
    this.upsertStateStmt.run(
      name,
      state,
      existing?.installed_at ?? this.now().toISOString(),
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
      throw new CoralSetupError({
        code: 'unknown_equipment',
        userMessage: `Unknown equipment '${name}'.`,
        remediation: 'Choose an equipment name from the supported catalog before retrying /equip.',
        context: { name },
      });
    }
    return descriptor;
  }

  private requireKbRuntime(): KbRuntime {
    const runtime = this.options.resolveKbRuntime();
    if (!runtime) {
      throw new CoralSetupError({
        code: 'equipment_runtime_unavailable',
        userMessage: 'Equipment activation is unavailable before the KB runtime is ready.',
        remediation: 'Wait for coordinator startup to finish, then retry /equip.',
      });
    }
    return runtime;
  }

  private async closeRuntimeBackend(runtime: KbRuntime | null): Promise<void> {
    if (!runtime) {
      return;
    }

    await this.closeNeedleBackendFn(runtime).catch(() => {});
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
      return existsSync(path) && statSync(path).isFile();
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
