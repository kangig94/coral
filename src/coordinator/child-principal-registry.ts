import { attenuate } from '../security/attenuate.js';
import type { Capability } from '../security/capability.js';
import type { Principal } from '../security/principal.js';
import {
  principalFromWire,
  principalToWire,
  principalWireSchema,
  type PrincipalWire,
} from '../security/principal-wire.js';
import type { IdPort } from '../runtime/ports.js';

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
  authorization: ChildPrincipalAuthorization;
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

  constructor(ids: Pick<IdPort, 'randomBytes'>) {
    this.ids = ids;
  }

  register(registration: ChildPrincipalRegistration): ChildPrincipalCredential {
    this.pruneExpired(registration.nowMs);

    const ttlMs = registration.ttlMs ?? CHILD_PRINCIPAL_TTL_MS;
    const expiresAt = registration.nowMs + ttlMs;
    const childPrincipal = attenuate(
      registration.parentPrincipal,
      registration.childCaps ?? CHILD_PRINCIPAL_CAPABILITIES,
    );

    return this.registerPersistedAuthorization({
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

    const authorization: ChildPrincipalAuthorization = {
      principalWire: principalWireSchema.parse(registration.authorization.principalWire),
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

  authenticate(auth: ChildAuthMetadata, namespace: string, nowMs: number): Principal | null {
    const entry = this.entries.get(auth.handle);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= nowMs) {
      this.entries.delete(auth.handle);
      return null;
    }
    if (
      entry.namespace !== namespace ||
      entry.parentJobId !== auth.jobId ||
      entry.parentSessionId !== auth.sessionId ||
      entry.usedNonces.has(auth.token)
    ) {
      return null;
    }

    entry.usedNonces.add(auth.token);
    return principalFromWire(entry.wire, {
      transport: 'ipc',
      credential: {
        kind: 'child-principal',
        id: `${entry.parentJobId}:${entry.parentSessionId}`,
      },
    });
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
