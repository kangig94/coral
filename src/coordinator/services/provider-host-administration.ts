import { z } from 'zod';

import type { HostRef } from '../../providers/contract.js';
import {
  exactHostRefsMatch,
  type ProviderHostCanonicalOwnerMetadata,
  type ProviderHostCanonicalSpecMetadata,
} from '../../providers/host-admission.js';
import { hostRefSchema } from '../../providers/host-ref-schema.js';
import type { CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';

export type ProviderHostInventoryRecord = Readonly<{
  ref: HostRef;
  status: 'live' | 'retired-blocked';
  spec: ProviderHostCanonicalSpecMetadata;
  host: ProviderHostCanonicalOwnerMetadata;
  diagnostics: ProviderHostDiagnosticsWire;
  diagnosticsRetention: Readonly<{ ownerBudgetTruncated: boolean }>;
}>;

type ProviderHostLogEntryWire = Readonly<{
  seq: number;
  observedAt: number;
  stream: 'stderr';
  text: string;
  startTruncated?: true;
}>;

export type ProviderHostDiagnosticsWire = Readonly<{
  hostLog: Readonly<{
    entries: readonly ProviderHostLogEntryWire[];
    retainedBytes: number;
    truncatedBeforeSeq: number;
  }>;
  completedObservations: readonly Readonly<{
    factSeq: number;
    generation: number;
    requestId: number;
    method: string;
    response:
      | Readonly<{ kind: 'success' }>
      | Readonly<{
          kind: 'failure';
          rpcCode?: number;
          providerMessage?: string;
          providerData?: unknown;
        }>;
    hostLog: Readonly<{
      startSeq: number;
      endSeq: number;
      truncated: boolean;
      historical: readonly ProviderHostLogEntryWire[];
      during: readonly ProviderHostLogEntryWire[];
      after: readonly ProviderHostLogEntryWire[];
    }>;
  }>[];
  factsTruncatedBeforeSeq: number;
}>;

export type ProviderHostInventoryRow = ProviderHostInventoryRecord & Readonly<{ ownerId: string }>;

export type ProviderHostSelector = Readonly<{ hostRef: HostRef }> | Readonly<{ workDir: CanonicalWorkDir }>;

export type ProviderHostAdministrationOwner = Readonly<{
  ownerId: string;
  listProviderHosts(): Promise<readonly ProviderHostInventoryRecord[]> | readonly ProviderHostInventoryRecord[];
  inspectProviderHost(ref: HostRef): Promise<ProviderHostInventoryRecord | null> | ProviderHostInventoryRecord | null;
  evictProviderHost(ref: HostRef): Promise<boolean>;
}>;

export type ProviderHostAdministrationErrorCode =
  | 'provider_host_inventory_unavailable'
  | 'provider_host_not_found'
  | 'provider_host_ambiguous'
  | 'provider_host_identity_integrity'
  | 'provider_host_stale';

export class ProviderHostAdministrationError extends Error {
  readonly code: ProviderHostAdministrationErrorCode;
  readonly ownerIds: readonly string[];
  readonly matches: readonly HostRef[];

  constructor(
    code: ProviderHostAdministrationErrorCode,
    options: Readonly<{ ownerIds?: readonly string[]; matches?: readonly HostRef[] }> = {},
  ) {
    const ownerIds = Object.freeze([...(options.ownerIds ?? [])]);
    const matches = Object.freeze([...(options.matches ?? [])]);
    const detail = ownerIds.length === 0 ? '' : ` (${ownerIds.join(', ')})`;
    super(`${code}${detail}`);
    this.name = 'ProviderHostAdministrationError';
    this.code = code;
    this.ownerIds = ownerIds;
    this.matches = matches;
    Object.setPrototypeOf(this, ProviderHostAdministrationError.prototype);
  }
}

export class ProviderHostAdministrationService {
  private readonly owners: () => readonly ProviderHostAdministrationOwner[];

  constructor(options: { owners: () => readonly ProviderHostAdministrationOwner[] }) {
    this.owners = options.owners;
  }

  async list(): Promise<readonly ProviderHostInventoryRow[]> {
    return (await this.captureInventory()).rows;
  }

  async inspect(selector: ProviderHostSelector): Promise<ProviderHostInventoryRow> {
    const inventory = await this.captureInventory();
    const selected = resolveOne(inventory.owners, inventory.rows, selector);
    let inspected: ProviderHostInventoryRecord | null;
    try {
      inspected = providerHostInventoryRecordSchema
        .nullable()
        .parse(await selected.owner.inspectProviderHost(selected.row.ref));
    } catch {
      throw new ProviderHostAdministrationError('provider_host_inventory_unavailable', {
        ownerIds: [selected.owner.ownerId],
      });
    }
    if (inspected === null || !exactHostRefsMatch(inspected.ref, selected.row.ref)) {
      throw new ProviderHostAdministrationError('provider_host_stale', {
        ownerIds: [selected.owner.ownerId],
        matches: [selected.row.ref],
      });
    }
    return freezeRow(selected.owner.ownerId, inspected);
  }

  async evict(selector: ProviderHostSelector): Promise<Readonly<{ ownerId: string; hostRef: HostRef }>> {
    const inventory = await this.captureInventory();
    const selected = resolveOne(inventory.owners, inventory.rows, selector);
    let evicted: boolean;
    try {
      evicted = await selected.owner.evictProviderHost(selected.row.ref);
    } catch {
      throw new ProviderHostAdministrationError('provider_host_inventory_unavailable', {
        ownerIds: [selected.owner.ownerId],
      });
    }
    if (!evicted) {
      throw new ProviderHostAdministrationError('provider_host_stale', {
        ownerIds: [selected.owner.ownerId],
        matches: [selected.row.ref],
      });
    }
    return Object.freeze({ ownerId: selected.owner.ownerId, hostRef: selected.row.ref });
  }

  private async captureInventory(): Promise<
    Readonly<{
      owners: readonly ProviderHostAdministrationOwner[];
      rows: readonly ProviderHostInventoryRow[];
    }>
  > {
    const owners = Object.freeze([...this.owners()]);
    const duplicateOwnerIds = duplicateValues(owners.map((owner) => owner.ownerId));
    if (duplicateOwnerIds.length > 0) {
      throw new ProviderHostAdministrationError('provider_host_identity_integrity', {
        ownerIds: duplicateOwnerIds,
      });
    }

    const responses = await Promise.allSettled(owners.map(async (owner) => owner.listProviderHosts()));
    const unavailableOwnerIds: string[] = [];
    const rows: ProviderHostInventoryRow[] = [];
    for (const [index, response] of responses.entries()) {
      const owner = owners[index] as ProviderHostAdministrationOwner;
      if (response.status === 'rejected') {
        unavailableOwnerIds.push(owner.ownerId);
        continue;
      }
      const parsed = providerHostInventorySchema.safeParse(response.value);
      if (!parsed.success) {
        unavailableOwnerIds.push(owner.ownerId);
        continue;
      }
      rows.push(...parsed.data.map((record) => freezeRow(owner.ownerId, record)));
    }
    if (unavailableOwnerIds.length > 0) {
      throw new ProviderHostAdministrationError('provider_host_inventory_unavailable', {
        ownerIds: unavailableOwnerIds,
      });
    }

    rows.sort(compareRows);
    return Object.freeze({ owners, rows: Object.freeze(rows) });
  }
}

const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const hostLogEntrySchema = z
  .object({
    seq: nonNegativeSafeIntegerSchema,
    observedAt: z.number(),
    stream: z.literal('stderr'),
    text: z.string(),
    startTruncated: z.literal(true).optional(),
  })
  .strict();
const inspectedHostLogSpanSchema = z
  .object({
    startSeq: nonNegativeSafeIntegerSchema,
    endSeq: nonNegativeSafeIntegerSchema,
    truncated: z.boolean(),
    historical: z.array(hostLogEntrySchema),
    during: z.array(hostLogEntrySchema),
    after: z.array(hostLogEntrySchema),
  })
  .strict();
const providerResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('success') }).strict(),
  z
    .object({
      kind: z.literal('failure'),
      rpcCode: z.number().optional(),
      providerMessage: z.string().optional(),
      providerData: z.unknown().optional(),
    })
    .strict(),
]);
const inspectedFactSchema = z
  .object({
    factSeq: nonNegativeSafeIntegerSchema,
    generation: nonNegativeSafeIntegerSchema,
    requestId: nonNegativeSafeIntegerSchema,
    method: z.string(),
    response: providerResponseSchema,
    hostLog: inspectedHostLogSpanSchema,
  })
  .strict();
const diagnosticsSchema = z
  .object({
    hostLog: z
      .object({
        entries: z.array(hostLogEntrySchema),
        retainedBytes: nonNegativeSafeIntegerSchema,
        truncatedBeforeSeq: nonNegativeSafeIntegerSchema,
      })
      .strict(),
    completedObservations: z.array(inspectedFactSchema),
    factsTruncatedBeforeSeq: nonNegativeSafeIntegerSchema,
  })
  .strict();
const specSchema = z
  .object({
    provider: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().nullable(),
    leaseMode: z.enum(['shared', 'job-exclusive']),
    idleRetirement: z.enum(['host-reported', 'none']).nullable(),
  })
  .strict();
const hostMetadataValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const providerHostInventoryRecordSchema = z
  .object({
    ref: hostRefSchema,
    status: z.enum(['live', 'retired-blocked']),
    spec: specSchema,
    host: z.record(hostMetadataValueSchema),
    diagnostics: diagnosticsSchema,
    diagnosticsRetention: z.object({ ownerBudgetTruncated: z.boolean() }).strict(),
  })
  .strict();
const providerHostInventorySchema = z.array(providerHostInventoryRecordSchema);

function resolveOne(
  owners: readonly ProviderHostAdministrationOwner[],
  rows: readonly ProviderHostInventoryRow[],
  selector: ProviderHostSelector,
): Readonly<{ row: ProviderHostInventoryRow; owner: ProviderHostAdministrationOwner }> {
  const matches = rows.filter((row) =>
    'hostRef' in selector ? exactHostRefsMatch(row.ref, selector.hostRef) : row.spec.cwd === selector.workDir,
  );
  if (matches.length === 0) {
    throw new ProviderHostAdministrationError('provider_host_not_found');
  }
  if (matches.length > 1) {
    throw new ProviderHostAdministrationError(
      'hostRef' in selector ? 'provider_host_identity_integrity' : 'provider_host_ambiguous',
      {
        ownerIds: matches.map((row) => row.ownerId),
        matches: matches.map((row) => row.ref),
      },
    );
  }
  const row = matches[0] as ProviderHostInventoryRow;
  const owner = owners.find((candidate) => candidate.ownerId === row.ownerId);
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
