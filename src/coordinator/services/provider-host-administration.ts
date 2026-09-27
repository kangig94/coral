import type {
  HostRef,
  ProviderHostEvictionDisposition,
  ProviderHostTerminalEvictionDisposition,
} from '../../providers/contract.js';
import type { ProviderHostAdministrationErrorCode } from '../../providers/host-administration-vocabulary.js';
import { exactHostRefIdentityKey, exactHostRefsMatch } from '../../providers/host-admission.js';
import {
  providerHostInventoryRecordSchema,
  providerHostInventorySchema,
  type ProviderHostInventoryRecordWire,
} from '../../providers/host-inventory-schema.js';
import type { CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';
import { throwIfRequestAborted } from '../../runtime/request-lease-identity.js';

export type ProviderHostInventoryRecord = ProviderHostInventoryRecordWire;

export type ProviderHostInventoryRow = ProviderHostInventoryRecord & Readonly<{ ownerId: string }>;

export type ProviderHostSelector = Readonly<{ hostRef: HostRef }> | Readonly<{ workDir: CanonicalWorkDir }>;

export type ProviderHostInventoryListing = Readonly<{
  rows: readonly ProviderHostInventoryRow[];
  tornDownOwnerIds: readonly string[];
}>;

type ProviderHostInventoryCapture = ProviderHostInventoryListing &
  Readonly<{ owners: readonly ProviderHostAdministrationOwner[] }>;

type EvictionOwnerSelection = Readonly<{
  owner: ProviderHostAdministrationOwner;
  hostRef: HostRef;
  /** Owners the selection could not ask, so a call that is never sent can say who else was released. */
  tornDownOwnerIds: readonly string[];
}>;

export type ProviderHostAdministrationOwner = Readonly<{
  ownerId: string;
  listProviderHosts(): Promise<readonly ProviderHostInventoryRecord[]> | readonly ProviderHostInventoryRecord[];
  inspectProviderHost(ref: HostRef): Promise<ProviderHostInventoryRecord | null> | ProviderHostInventoryRecord | null;
  terminalEviction(
    ref: HostRef,
  ): Promise<ProviderHostTerminalEvictionDisposition | null> | ProviderHostTerminalEvictionDisposition | null;
  evictProviderHost(ref: HostRef): Promise<ProviderHostEvictionDisposition>;
}>;

/** Raised only by an owner adapter that declined to send, because this coordinator had already released that
 *  owner's administration control. An answer, a refusal, a timeout, and a lost reply all reached a control
 *  that existed at send time; none of them is this disposition. The owner is named by the caller that
 *  invoked the adapter, so this carries no identity of its own. */
export class ProviderHostOwnerTornDown extends Error {
  constructor() {
    super('provider_host_owner_torn_down: administration control was released before the call was sent');
    this.name = 'ProviderHostOwnerTornDown';
    Object.setPrototypeOf(this, ProviderHostOwnerTornDown.prototype);
  }
}

export class ProviderHostAdministrationError extends Error {
  readonly code: ProviderHostAdministrationErrorCode;
  readonly ownerIds: readonly string[];
  readonly matches: readonly HostRef[];
  /** A work-directory selector resolves no `matches`, so operator copy has nothing to name the subject with
   *  unless the selector itself travels with the error. */
  readonly workDir: CanonicalWorkDir | null;
  readonly hold: Extract<ProviderHostEvictionDisposition, { kind: 'held' }> | null;
  readonly abandonment: Extract<ProviderHostEvictionDisposition, { kind: 'operator-abandoned' }> | null;

  constructor(
    code: ProviderHostAdministrationErrorCode,
    options: Readonly<{
      ownerIds?: readonly string[];
      matches?: readonly HostRef[];
      workDir?: CanonicalWorkDir;
      hold?: Extract<ProviderHostEvictionDisposition, { kind: 'held' }>;
      abandonment?: Extract<ProviderHostEvictionDisposition, { kind: 'operator-abandoned' }>;
    }> = {},
  ) {
    const ownerIds = Object.freeze([...(options.ownerIds ?? [])]);
    const matches = Object.freeze([...(options.matches ?? [])]);
    const detail = ownerIds.length === 0 ? '' : ` (${ownerIds.join(', ')})`;
    super(`${code}${detail}`);
    this.name = 'ProviderHostAdministrationError';
    this.code = code;
    this.ownerIds = ownerIds;
    this.matches = matches;
    this.workDir = options.workDir ?? null;
    this.hold = options.hold ?? null;
    this.abandonment = options.abandonment ?? null;
    Object.setPrototypeOf(this, ProviderHostAdministrationError.prototype);
  }
}

export class ProviderHostAdministrationService {
  private readonly owners: () => readonly ProviderHostAdministrationOwner[];
  /** An admitted eviction's owner route must remain available for exact-ref retries for the owning process's
   *  lifetime; dropping it can make a lost terminal reply unreachable. */
  private readonly evictionOwners = new Map<string, string>();

  constructor(options: { owners: () => readonly ProviderHostAdministrationOwner[] }) {
    this.owners = options.owners;
  }

  async list(): Promise<ProviderHostInventoryListing> {
    const { rows, tornDownOwnerIds } = await this.captureInventory();
    return Object.freeze({ rows, tornDownOwnerIds });
  }

  async inspect(selector: ProviderHostSelector): Promise<ProviderHostInventoryRow> {
    const inventory = await this.captureInventory();
    const selected = resolveOne(inventory, selector, inventory.tornDownOwnerIds);
    let inspected: ProviderHostInventoryRecord | null;
    try {
      inspected = providerHostInventoryRecordSchema
        .nullable()
        .parse(await selected.owner.inspectProviderHost(selected.row.ref));
    } catch (error: unknown) {
      throw ownerCallFailure(error, selected.owner.ownerId, [selected.row.ref], inventory.tornDownOwnerIds);
    }
    if (inspected === null || !exactHostRefsMatch(inspected.ref, selected.row.ref)) {
      throw new ProviderHostAdministrationError('provider_host_stale', {
        ownerIds: [selected.owner.ownerId],
        matches: [selected.row.ref],
      });
    }
    return freezeRow(selected.owner.ownerId, inspected);
  }

  async evict(
    selector: ProviderHostSelector,
    signal?: AbortSignal,
  ): Promise<Readonly<{ ownerId: string; hostRef: HostRef }>> {
    throwIfRequestAborted(signal);
    if ('workDir' in selector) {
      throw new ProviderHostAdministrationError('provider_host_eviction_requires_exact_ref');
    }
    const retainedOwnerId = this.evictionOwners.get(exactHostRefIdentityKey(selector.hostRef));
    const selected =
      retainedOwnerId === undefined
        ? await this.selectInitialEvictionOwner(selector.hostRef)
        : this.retainedEvictionOwner(this.captureOwners(), selector.hostRef);
    throwIfRequestAborted(signal);
    this.retainEvictionOwner(selected.owner.ownerId, selected.hostRef);
    let disposition: ProviderHostEvictionDisposition;
    try {
      disposition = await selected.owner.evictProviderHost(selected.hostRef);
    } catch (error: unknown) {
      throw ownerCallFailure(error, selected.owner.ownerId, [selected.hostRef], selected.tornDownOwnerIds);
    }
    if (disposition.kind === 'stale') {
      throw new ProviderHostAdministrationError('provider_host_stale', {
        ownerIds: [selected.owner.ownerId],
        matches: [selected.hostRef],
      });
    }
    if (disposition.kind === 'held') {
      throw new ProviderHostAdministrationError('provider_host_shutdown_held', {
        ownerIds: [selected.owner.ownerId],
        matches: [selected.hostRef],
        hold: disposition,
      });
    }
    if (disposition.kind === 'operator-abandoned') {
      throw new ProviderHostAdministrationError('provider_host_operator_abandoned', {
        ownerIds: [selected.owner.ownerId],
        matches: [selected.hostRef],
        abandonment: disposition,
      });
    }
    return Object.freeze({ ownerId: selected.owner.ownerId, hostRef: selected.hostRef });
  }

  private async selectInitialEvictionOwner(hostRef: HostRef): Promise<EvictionOwnerSelection> {
    const owners = this.captureOwners();
    // Absence from inventory must not override a terminal outcome retained by its owner.
    const discovery = await this.discoverRetainedEvictionOwner(owners, hostRef);
    if (discovery.retained !== null) {
      return { ...discovery.retained, tornDownOwnerIds: discovery.tornDownOwnerIds };
    }
    const inventory = await this.captureInventory();
    const tornDownOwnerIds = Object.freeze([
      ...new Set([...discovery.tornDownOwnerIds, ...inventory.tornDownOwnerIds]),
    ]);
    const resolved = resolveOne(inventory, { hostRef }, tornDownOwnerIds);
    return { owner: resolved.owner, hostRef: resolved.row.ref, tornDownOwnerIds };
  }

  private async discoverRetainedEvictionOwner(
    owners: readonly ProviderHostAdministrationOwner[],
    hostRef: HostRef,
  ): Promise<
    Readonly<{
      retained: Readonly<{ owner: ProviderHostAdministrationOwner; hostRef: HostRef }> | null;
      tornDownOwnerIds: readonly string[];
    }>
  > {
    const responses = await Promise.allSettled(owners.map(async (owner) => owner.terminalEviction(hostRef)));
    const { tornDownOwnerIds, unavailableOwnerIds } = partitionOwnerRejections(owners, responses);
    const matches: ProviderHostAdministrationOwner[] = [];
    for (const [index, response] of responses.entries()) {
      const owner = owners[index];
      if (owner === undefined || response.status === 'rejected' || response.value === null) continue;
      matches.push(owner);
    }
    if (unavailableOwnerIds.length > 0) {
      throw new ProviderHostAdministrationError('provider_host_inventory_unavailable', {
        ownerIds: unavailableOwnerIds,
      });
    }
    // An owner this coordinator can no longer ask contributes no match, so more than one match here proves a
    // duplicate identity among the owners that answered, and one match never disproves one elsewhere.
    if (matches.length > 1) {
      throw new ProviderHostAdministrationError('provider_host_identity_integrity', {
        ownerIds: matches.map((owner) => owner.ownerId),
        matches: matches.map(() => hostRef),
      });
    }
    const owner = matches[0];
    if (owner === undefined) {
      return Object.freeze({ retained: null, tornDownOwnerIds });
    }
    this.retainEvictionOwner(owner.ownerId, hostRef);
    return Object.freeze({ retained: { owner, hostRef }, tornDownOwnerIds });
  }

  private retainedEvictionOwner(
    owners: readonly ProviderHostAdministrationOwner[],
    hostRef: HostRef,
  ): EvictionOwnerSelection {
    const ownerId = this.evictionOwners.get(exactHostRefIdentityKey(hostRef));
    if (ownerId === undefined) throw new ProviderHostAdministrationError('provider_host_not_found');
    const owner = owners.find((candidate) => candidate.ownerId === ownerId);
    if (owner === undefined) {
      throw new ProviderHostAdministrationError('provider_host_inventory_unavailable', { ownerIds: [ownerId] });
    }
    return { owner, hostRef, tornDownOwnerIds: [] };
  }

  private retainEvictionOwner(ownerId: string, hostRef: HostRef): void {
    const key = exactHostRefIdentityKey(hostRef);
    const retainedOwnerId = this.evictionOwners.get(key);
    if (retainedOwnerId !== undefined && retainedOwnerId !== ownerId) {
      throw new ProviderHostAdministrationError('provider_host_identity_integrity', {
        ownerIds: [retainedOwnerId, ownerId],
        matches: [hostRef],
      });
    }
    this.evictionOwners.set(key, ownerId);
  }

  private async captureInventory(): Promise<ProviderHostInventoryCapture> {
    const owners = this.captureOwners();
    const responses = await Promise.allSettled(owners.map(async (owner) => owner.listProviderHosts()));
    const rejections = partitionOwnerRejections(owners, responses);
    const undecodableOwnerIds: string[] = [];
    const rows: ProviderHostInventoryRow[] = [];
    for (const [index, response] of responses.entries()) {
      const owner = owners[index];
      if (owner === undefined || response.status === 'rejected') continue;
      const parsed = providerHostInventorySchema.safeParse(response.value);
      if (!parsed.success) {
        undecodableOwnerIds.push(owner.ownerId);
        continue;
      }
      rows.push(...parsed.data.map((record) => freezeRow(owner.ownerId, record)));
    }
    const unavailableOwnerIds = [...rejections.unavailableOwnerIds, ...undecodableOwnerIds];
    if (unavailableOwnerIds.length > 0) {
      throw new ProviderHostAdministrationError('provider_host_inventory_unavailable', {
        ownerIds: unavailableOwnerIds,
      });
    }

    rows.sort(compareRows);
    return Object.freeze({ owners, rows: Object.freeze(rows), tornDownOwnerIds: rejections.tornDownOwnerIds });
  }

  private captureOwners(): readonly ProviderHostAdministrationOwner[] {
    const owners = Object.freeze([...this.owners()]);
    const duplicateOwnerIds = duplicateValues(owners.map((owner) => owner.ownerId));
    if (duplicateOwnerIds.length > 0) {
      throw new ProviderHostAdministrationError('provider_host_identity_integrity', {
        ownerIds: duplicateOwnerIds,
      });
    }
    return owners;
  }
}

function partitionOwnerRejections(
  owners: readonly ProviderHostAdministrationOwner[],
  responses: readonly PromiseSettledResult<unknown>[],
): Readonly<{ tornDownOwnerIds: readonly string[]; unavailableOwnerIds: readonly string[] }> {
  const tornDownOwnerIds: string[] = [];
  const unavailableOwnerIds: string[] = [];
  for (const [index, response] of responses.entries()) {
    const owner = owners[index];
    if (owner === undefined || response.status !== 'rejected') continue;
    const bucket = response.reason instanceof ProviderHostOwnerTornDown ? tornDownOwnerIds : unavailableOwnerIds;
    bucket.push(owner.ownerId);
  }
  return { tornDownOwnerIds: Object.freeze(tornDownOwnerIds), unavailableOwnerIds: Object.freeze(unavailableOwnerIds) };
}

function ownerCallFailure(
  error: unknown,
  ownerId: string,
  matches: readonly HostRef[],
  tornDownOwnerIds: readonly string[],
): ProviderHostAdministrationError {
  // The released owners join the answer only when the call itself was never sent: a real call failure names
  // the owner it reached, and folding unasked owners into it would read as owners that also failed.
  return error instanceof ProviderHostOwnerTornDown
    ? new ProviderHostAdministrationError('provider_host_owner_torn_down', {
        ownerIds: [...new Set([ownerId, ...tornDownOwnerIds])],
        matches,
      })
    : new ProviderHostAdministrationError('provider_host_inventory_unavailable', { ownerIds: [ownerId] });
}

/** A ref no observed owner holds may still live on an owner this coordinator can no longer ask, and a work
 *  directory that matched once among the owners that answered is not provably unique across the ones it
 *  could not ask — `provider_host_ambiguous` already refuses to choose a match by position, and choosing by
 *  which owner happened to answer is that same choice. So a found `hostRef` decides on an incomplete
 *  capture; an absent ref and a matched work directory decide only on a complete one. */
function resolveOne(
  inventory: ProviderHostInventoryCapture,
  selector: ProviderHostSelector,
  tornDownOwnerIds: readonly string[],
): Readonly<{ row: ProviderHostInventoryRow; owner: ProviderHostAdministrationOwner }> {
  const matches = inventory.rows.filter((row) =>
    'hostRef' in selector ? exactHostRefsMatch(row.ref, selector.hostRef) : row.spec.cwd === selector.workDir,
  );
  if (matches.length > 1) {
    throw new ProviderHostAdministrationError(
      'hostRef' in selector ? 'provider_host_identity_integrity' : 'provider_host_ambiguous',
      {
        ownerIds: matches.map((row) => row.ownerId),
        matches: matches.map((row) => row.ref),
      },
    );
  }
  if (tornDownOwnerIds.length > 0 && (matches.length === 0 || 'workDir' in selector)) {
    throw new ProviderHostAdministrationError('provider_host_owner_torn_down', {
      ownerIds: tornDownOwnerIds,
      ...('hostRef' in selector ? { matches: [selector.hostRef] } : { workDir: selector.workDir }),
    });
  }
  if (matches.length === 0) {
    throw new ProviderHostAdministrationError('provider_host_not_found');
  }
  const row = matches[0];
  const owner = inventory.owners.find((candidate) => candidate.ownerId === row.ownerId);
  if (owner === undefined) {
    throw new ProviderHostAdministrationError('provider_host_inventory_unavailable', { ownerIds: [row.ownerId] });
  }
  return Object.freeze({ row, owner });
}

function freezeRow(ownerId: string, record: ProviderHostInventoryRecord): ProviderHostInventoryRow {
  return Object.freeze({ ...record, ownerId });
}

function compareRows(left: ProviderHostInventoryRow, right: ProviderHostInventoryRow): number {
  return (
    left.ownerId.localeCompare(right.ownerId) ||
    left.ref.provider.localeCompare(right.ref.provider) ||
    left.ref.instanceId.localeCompare(right.ref.instanceId)
  );
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}
