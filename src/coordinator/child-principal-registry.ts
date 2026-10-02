import { attenuate } from '../security/attenuate.js';
import type { Capability } from '../security/capability.js';
import {
  childProofSubject,
  mintChildCredentialKeyPair,
  verifyChildProof,
  type ChildAuthChallenge,
  type ChildPrincipalAuthentication,
  type ChildProvenRequest,
} from '../security/child-credential.js';
import type { Principal } from '../security/principal.js';
import {
  canonicalizePrincipalWire,
  principalFromWire,
  principalToWire,
  type PrincipalWire,
  type RawPrincipalWire,
} from '../security/principal-wire.js';
import type { IdPort } from '../runtime/ports.js';
import type { ChildPrincipalCredentialStore } from './child-principal-credentials.js';

const CHILD_PRINCIPAL_TTL_MS = 24 * 60 * 60 * 1000;
export const CHILD_PRINCIPAL_CAPABILITIES = [
  'liveness',
  'kb:read',
  'jobs:read',
  'discuss:participate',
] as const satisfies readonly Capability[];

/** `privateKey` exists only here and in the child's environment; the store keeps the public half. */
export type ChildPrincipalCredential = {
  readonly credentialId: string;
  readonly privateKey: string;
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

type ChildProofClaim = Readonly<{
  kind: 'child-proof';
  credentialId: string;
  jobId: string;
  sessionId: string;
  proof: string;
}>;

export class ChildPrincipalRegistry {
  private readonly ids: Pick<IdPort, 'randomBytes'>;
  private readonly credentials: ChildPrincipalCredentialStore;
  private readonly namespace: string;
  private readonly activeJobOrigin: (jobId: string) => string | null;
  private readonly incarnation: string;
  private readonly reportedUnreadable = new Set<string>();
  private readonly log: (message: string) => void;

  constructor(
    ids: Pick<IdPort, 'randomBytes'>,
    credentials: ChildPrincipalCredentialStore,
    options: {
      namespace: string;

      activeJobOrigin: (jobId: string) => string | null;
      log?: (message: string) => void;
    },
  ) {
    this.ids = ids;
    this.credentials = credentials;
    this.namespace = options.namespace;
    this.activeJobOrigin = options.activeJobOrigin;
    this.log = options.log ?? (() => undefined);
    this.incarnation = ids.randomBytes(16).toString('hex');
  }

  issueChallenge(): ChildAuthChallenge {
    return {
      challenge: this.ids.randomBytes(32).toString('base64url'),
      incarnation: this.incarnation,
      namespace: this.namespace,
    };
  }

  register(registration: ChildPrincipalRegistration): ChildPrincipalCredential {
    const ttlMs = registration.ttlMs ?? CHILD_PRINCIPAL_TTL_MS;
    const childPrincipal = attenuate(
      registration.parentPrincipal,
      registration.childCaps ?? CHILD_PRINCIPAL_CAPABILITIES,
    );
    return this.issue({
      issuer: registration.issuer,
      authorization: {
        principalWire: principalToWire(childPrincipal),
        namespace: registration.namespace,
        expiresAtMs: registration.nowMs + ttlMs,
      },
      parentJobId: registration.parentJobId,
      parentSessionId: registration.parentSessionId,
      nowMs: registration.nowMs,
    });
  }

  registerPersistedAuthorization(registration: PersistedChildPrincipalRegistration): ChildPrincipalCredential {
    if (registration.authorization.expiresAtMs <= registration.nowMs) {
      throw new Error('Provider operation child authorization has expired.');
    }
    return this.issue({
      ...registration,
      authorization: {
        ...registration.authorization,
        principalWire: canonicalizePrincipalWire(registration.authorization.principalWire),
      },
    });
  }

  private issue(
    registration: Omit<PersistedChildPrincipalRegistration, 'authorization'> & {
      authorization: ChildPrincipalAuthorization;
    },
  ): ChildPrincipalCredential {
    this.pruneExpired(registration.nowMs);
    const keys = mintChildCredentialKeyPair();
    const credentialId = this.ids.randomBytes(16).toString('hex');
    this.credentials.write({
      credentialId,
      issuer: registration.issuer,
      parentJobId: registration.parentJobId,
      parentSessionId: registration.parentSessionId,
      namespace: registration.authorization.namespace,
      principalWire: registration.authorization.principalWire,
      expiresAtMs: registration.authorization.expiresAtMs,
      publicKey: keys.publicKey,
    });
    return {
      credentialId,
      privateKey: keys.privateKey,
      parentJobId: registration.parentJobId,
      parentSessionId: registration.parentSessionId,
      expiresAt: registration.authorization.expiresAtMs,
      authorization: registration.authorization,
    };
  }

  authenticate(
    claim: ChildProofClaim,
    challenge: ChildAuthChallenge | null,
    request: ChildProvenRequest,
    nowMs: number,
  ): ChildPrincipalAuthentication {
    if (challenge === null || challenge.incarnation !== this.incarnation || challenge.namespace !== this.namespace) {
      return { kind: 'refused' };
    }
    const read = this.credentials.read(claim.credentialId);
    if (read.kind === 'absent') return { kind: 'refused' };
    if (read.kind === 'unreadable') return this.unreadable(claim.credentialId);
    const record = read.record;
    if (
      record.expiresAtMs <= nowMs ||
      record.parentJobId !== claim.jobId ||
      record.parentSessionId !== claim.sessionId ||
      this.readActiveJobOrigin(record.parentJobId) !== record.namespace ||
      !verifyChildProof(record.publicKey, childProofSubject(challenge, claim, request), claim.proof)
    ) {
      return { kind: 'refused' };
    }
    let wire: PrincipalWire;
    try {
      wire = canonicalizePrincipalWire(record.principalWire);
    } catch {
      return { kind: 'refused' };
    }
    return {
      kind: 'authenticated',
      principal: principalFromWire(wire, {
        transport: 'ipc',
        credential: {
          kind: 'child-principal',
          id: `${record.parentJobId}:${record.parentSessionId}`,
        },
      }),
    };
  }

  private unreadable(credentialId: string): ChildPrincipalAuthentication {
    if (!this.reportedUnreadable.has(credentialId)) {
      this.reportedUnreadable.add(credentialId);
      this.log(`Child credential ${credentialId} has an unreadable authorization record; it is refused.\n`);
    }
    return { kind: 'credential-unreadable', credentialId };
  }

  private readActiveJobOrigin(jobId: string): string | null {
    try {
      return this.activeJobOrigin(jobId);
    } catch {
      return null;
    }
  }

  revokeParentJob(parentJobId: string): void {
    this.forget((record) => record.parentJobId === parentJobId);
  }

  revokeParentSession(parentSessionId: string): void {
    this.forget((record) => record.parentSessionId === parentSessionId);
  }

  pruneExpired(nowMs: number): void {
    this.forget((record) => record.expiresAtMs <= nowMs);
  }

  /**
   * A record that could not be removed stays refusable: authentication also requires the parent job to be active
   * and the record unexpired, so a missed removal authorizes nothing.
   */
  private forget(matches: Parameters<ChildPrincipalCredentialStore['deleteWhere']>[0]): void {
    try {
      this.credentials.deleteWhere(matches);
    } catch (error: unknown) {
      this.log(
        `Child credential records could not be removed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}
