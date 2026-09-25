import { attenuate } from '../security/attenuate.js';
import type { Capability } from '../security/capability.js';
import type { Principal } from '../security/principal.js';
import {
  canonicalizePrincipalWire,
  principalFromWire,
  principalToWire,
  type PrincipalWire,
  type RawPrincipalWire,
} from '../security/principal-wire.js';
import type { IdPort } from '../runtime/ports.js';
import type { ChildPrincipalNonceLedger } from '../infra/child-principal-nonce-ledger.js';

const CHILD_PRINCIPAL_TTL_MS = 24 * 60 * 60 * 1000;
export const CHILD_PRINCIPAL_CAPABILITIES = [
  'liveness',
  'kb:read',
  'jobs:read',
  'discuss:participate',
] as const satisfies readonly Capability[];

export type ChildPrincipalCredential = {
  readonly handle: string;
  readonly parentJobId: string;
  readonly parentSessionId: string;
  readonly expiresAt: number;
  readonly authorization: ChildPrincipalAuthorization;
};

export type ChildPrincipalAuthorization = Readonly<{
  principalWire: PrincipalWire;
  namespace: string;
  expiresAtMs: number;
}>;

type PersistedChildPrincipalAuthorization = Readonly<{
  principalWire: RawPrincipalWire;
  namespace: string;
  expiresAtMs: number;
}>;

export type ChildPrincipalRegistration = {
  readonly issuer: string;
  readonly parentPrincipal: Principal;
  readonly namespace: string;
  readonly parentJobId: string;
  readonly parentSessionId: string;
  readonly nowMs: number;
  readonly ttlMs?: number;
  readonly childCaps?: readonly Capability[];
};

export type PersistedChildPrincipalRegistration = Readonly<{
  issuer: string;
  authorization: PersistedChildPrincipalAuthorization;
  parentJobId: string;
  parentSessionId: string;
  nowMs: number;
}>;

type ChildPrincipalEntry = {
  readonly issuer: string;
  readonly wire: PrincipalWire;
  readonly namespace: string;
  readonly parentJobId: string;
  readonly parentSessionId: string;
  readonly expiresAt: number;
  readonly usedNonces: Set<string>;
};

export type TransferredChildPrincipal = Readonly<{
  handle: string;
  issuer: string;
  authorization: ChildPrincipalAuthorization;
  parentJobId: string;
  parentSessionId: string;
}>;

export type ChildPrincipalSnapshot = Readonly<{
  entries: readonly TransferredChildPrincipal[];
  consumedNonceCheckpoint: number;
}>;

export type ChildPrincipalTransfer = ChildPrincipalSnapshot & Readonly<{ recoveryGrantId: string }>;

type ChildAuthMetadata = {
  readonly kind: 'child';
  readonly handle: string;
  readonly token: string;
  readonly jobId: string;
  readonly sessionId: string;
};

export class ChildPrincipalRegistry {
  private readonly entries = new Map<string, ChildPrincipalEntry>();
  private readonly ids: Pick<IdPort, 'randomBytes'>;
  private readonly ledger: ChildPrincipalNonceLedger | null;
  private readonly originNamespace: ((jobId: string) => string | null) | null;
  private generation: number;
  private fenced = false;

  constructor(
    ids: Pick<IdPort, 'randomBytes'>,
    options: {
      ledger?: ChildPrincipalNonceLedger;
      originNamespace?: (jobId: string) => string | null;
    } = {},
  ) {
    this.ids = ids;
    this.ledger = options.ledger ?? null;
    this.originNamespace = options.originNamespace ?? null;
    this.generation = this.ledger?.generation() ?? 1;
  }

  transferSnapshot(nowMs: number): ChildPrincipalSnapshot {
    this.pruneExpired(nowMs);
    return {
      entries: [...this.entries].map(([handle, entry]) => ({
        handle,
        issuer: entry.issuer,
        authorization: {
          principalWire: entry.wire,
          namespace: entry.namespace,
          expiresAtMs: entry.expiresAt,
        },
        parentJobId: entry.parentJobId,
        parentSessionId: entry.parentSessionId,
      })),
      consumedNonceCheckpoint: this.ledger?.checkpoint() ?? 0,
    };
  }

  prepareTransfer(attemptId: string, nowMs: number): ChildPrincipalTransfer | null {
    if (this.ledger === null) return null;
    const grant = this.ledger.prepareGrant(attemptId, this.generation);
    if (grant === null) return null;
    return {
      ...this.transferSnapshot(nowMs),
      consumedNonceCheckpoint: grant.checkpoint,
      recoveryGrantId: grant.grantId,
    };
  }

  adoptTransfer(
    transfer: ChildPrincipalTransfer,
    acceptedJobIds: ReadonlySet<string>,
    generation: number,
    nowMs: number,
  ): boolean {
    if (this.ledger === null) return false;
    try {
      if (this.ledger.generation() !== generation ||
        this.ledger.checkpoint() < transfer.consumedNonceCheckpoint) return false;
    } catch {
      return false;
    }
    if (!this.ledger.hasGrant(transfer.recoveryGrantId, generation, transfer.consumedNonceCheckpoint)) {
      return false;
    }
    if (this.originNamespace === null) return false;
    if (new Set(transfer.entries.map((entry) => entry.handle)).size !== transfer.entries.length) return false;
    const adopted = new Map<string, ChildPrincipalEntry>();
    for (const entry of transfer.entries) {
      if (
        entry.authorization.expiresAtMs <= nowMs ||
        !acceptedJobIds.has(entry.parentJobId) ||
        !this.matchesOrigin(entry.parentJobId, entry.authorization.namespace)
      ) {
        return false;
      }
      try {
        adopted.set(entry.handle, {
          issuer: entry.issuer,
          wire: canonicalizePrincipalWire(entry.authorization.principalWire),
          namespace: entry.authorization.namespace,
          parentJobId: entry.parentJobId,
          parentSessionId: entry.parentSessionId,
          expiresAt: entry.authorization.expiresAtMs,
          usedNonces: new Set(this.ledger.consumedTokens(entry.handle)),
        });
      } catch {
        return false;
      }
    }
    try {
      if (this.ledger.generation() !== generation) return false;
    } catch {
      return false;
    }
    for (const [handle, entry] of adopted) {
      this.entries.set(handle, entry);
    }
    this.generation = generation;
    this.fenced = false;
    return true;
  }

  fenceAuthentication(): void {
    this.fenced = true;
  }

  reclaimAuthentication(generation: number): boolean {
    if (this.ledger === null) return false;
    try {
      if (this.ledger.generation() !== generation) return false;
    } catch {
      return false;
    }
    try {
      for (const [handle, entry] of this.entries) {
        entry.usedNonces.clear();
        for (const token of this.ledger.consumedTokens(handle)) entry.usedNonces.add(token);
      }
    } catch {
      return false;
    }
    try {
      if (this.ledger.generation() !== generation) return false;
    } catch {
      return false;
    }
    this.generation = generation;
    this.fenced = false;
    return true;
  }

  register(registration: ChildPrincipalRegistration): ChildPrincipalCredential {
    this.pruneExpired(registration.nowMs);

    const ttlMs = registration.ttlMs ?? CHILD_PRINCIPAL_TTL_MS;
    const expiresAt = registration.nowMs + ttlMs;
    const childPrincipal = attenuate(
      registration.parentPrincipal,
      registration.childCaps ?? CHILD_PRINCIPAL_CAPABILITIES,
    );

    return this.storeAuthorization({
      issuer: registration.issuer,
      authorization: {
        principalWire: principalToWire(childPrincipal),
        namespace: registration.namespace,
        expiresAtMs: expiresAt,
      },
      parentJobId: registration.parentJobId,
      parentSessionId: registration.parentSessionId,
      nowMs: registration.nowMs,
    });
  }

  registerPersistedAuthorization(registration: PersistedChildPrincipalRegistration): ChildPrincipalCredential {
    this.pruneExpired(registration.nowMs);
    if (registration.authorization.expiresAtMs <= registration.nowMs) {
      throw new Error('Provider operation child authorization has expired.');
    }

    return this.storeAuthorization({
      ...registration,
      authorization: {
        ...registration.authorization,
        principalWire: canonicalizePrincipalWire(registration.authorization.principalWire),
      },
    });
  }

  private storeAuthorization(
    registration: Omit<PersistedChildPrincipalRegistration, 'authorization'> & {
      authorization: ChildPrincipalAuthorization;
    },
  ): ChildPrincipalCredential {
    const authorization: ChildPrincipalAuthorization = {
      principalWire: registration.authorization.principalWire,
      namespace: registration.authorization.namespace,
      expiresAtMs: registration.authorization.expiresAtMs,
    };
    const handle = this.ids.randomBytes(32).toString('hex');

    this.entries.set(handle, {
      issuer: registration.issuer,
      wire: authorization.principalWire,
      namespace: authorization.namespace,
      parentJobId: registration.parentJobId,
      parentSessionId: registration.parentSessionId,
      expiresAt: authorization.expiresAtMs,
      usedNonces: new Set(),
    });

    return {
      handle,
      parentJobId: registration.parentJobId,
      parentSessionId: registration.parentSessionId,
      expiresAt: authorization.expiresAtMs,
      authorization,
    };
  }

  authenticate(auth: ChildAuthMetadata, namespace: string | null, nowMs: number): Principal | null {
    const entry = this.entries.get(auth.handle);
    if (entry === undefined || this.fenced || (this.originNamespace !== null && this.ledger === null)) {
      return null;
    }
    if (entry.expiresAt <= nowMs) {
      this.entries.delete(auth.handle);
      return null;
    }
    if (
      (namespace !== null && entry.namespace !== namespace) ||
      (this.originNamespace !== null && !this.matchesOrigin(entry.parentJobId, entry.namespace)) ||
      entry.parentJobId !== auth.jobId ||
      entry.parentSessionId !== auth.sessionId ||
      entry.usedNonces.has(auth.token)
    ) {
      return null;
    }

    if (this.ledger !== null && !this.ledger.consume(auth.handle, auth.token, this.generation)) return null;
    entry.usedNonces.add(auth.token);
    return principalFromWire(entry.wire, {
      transport: 'ipc',
      credential: {
        kind: 'child-principal',
        id: `${entry.parentJobId}:${entry.parentSessionId}`,
      },
    });
  }

  private matchesOrigin(jobId: string, namespace: string): boolean {
    try {
      return this.originNamespace?.(jobId) === namespace;
    } catch {
      return false;
    }
  }

  revokeParentJob(parentJobId: string): void {
    for (const [handle, entry] of this.entries) {
      if (entry.parentJobId === parentJobId) {
        this.entries.delete(handle);
      }
    }
  }

  revokeParentSession(parentSessionId: string): void {
    for (const [handle, entry] of this.entries) {
      if (entry.parentSessionId === parentSessionId) {
        this.entries.delete(handle);
      }
    }
  }

  pruneExpired(nowMs: number): void {
    for (const [handle, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) {
        this.entries.delete(handle);
      }
    }
  }

  size(): number {
    return this.entries.size;
  }
}
