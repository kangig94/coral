import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChildPrincipalRegistry, type ChildPrincipalCredential } from '#src/coordinator/child-principal-registry.js';
import { createStoreChildPrincipalCredentials } from '#src/coordinator/child-principal-credentials.js';
import { authorize } from '#src/security/policy/authorize.js';
import type { Capability } from '#src/security/capability.js';
import type { ChildAuthChallenge, ChildProvenRequest } from '#src/security/child-credential.js';
import type { Principal } from '#src/security/principal.js';
import { childPrincipalAuthFromEnv } from '#src/transport/ipc/child-principal-auth.js';
import { testPrincipal, testProjectPrincipal } from '#tests/helpers/principal.js';
import { childCredentialDatabase, testChildPrincipalRegistry } from '#tests/helpers/child-principal-registry.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';

function ids() {
  let counter = 0;
  return {
    randomBytes(length: number): Buffer {
      counter += 1;
      return Buffer.alloc(length, counter);
    },
  };
}

function register(
  registry: ChildPrincipalRegistry,
  parentPrincipal: Principal,
  options: {
    jobId?: string;
    sessionId?: string;
    nowMs?: number;
    ttlMs?: number;
    childCaps?: readonly Capability[];
  } = {},
): ChildPrincipalCredential {
  return registry.register({
    issuer: 'test-launch',
    parentPrincipal,
    namespace: 'ns-a',
    parentJobId: options.jobId ?? 'job-a',
    parentSessionId: options.sessionId ?? 'session-a',
    nowMs: options.nowMs ?? 1_000,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.childCaps === undefined ? {} : { childCaps: options.childCaps }),
  });
}

const REQUEST: ChildProvenRequest = { method: 'jobs.list', id: 7, params: { projectRoot: '/p' } };

/** Proves exactly as the CLI does, from the environment the child was launched with. */
function prove(
  credential: ChildPrincipalCredential,
  challenge: ChildAuthChallenge,
  request: ChildProvenRequest = REQUEST,
  claim: { jobId?: string; sessionId?: string } = {},
) {
  const auth = childPrincipalAuthFromEnv({
    CORAL_CHILD_CREDENTIAL_ID: credential.credentialId,
    CORAL_CHILD_CREDENTIAL_KEY: credential.privateKey,
    CORAL_JOB_ID: claim.jobId ?? credential.parentJobId,
    CORAL_SESSION_ID: claim.sessionId ?? credential.parentSessionId,
  });
  if (auth === null || auth === undefined || typeof auth === 'function') throw new Error('Expected challenged auth.');
  const proof = auth.prove(challenge, request);
  if (proof.kind !== 'child-proof') throw new Error('Expected a child proof.');
  return proof;
}

function authenticated(registry: ChildPrincipalRegistry, credential: ChildPrincipalCredential, nowMs = 1_001) {
  const challenge = registry.issueChallenge();
  const result = registry.authenticate(prove(credential, challenge), challenge, REQUEST, nowMs);
  return result.kind === 'authenticated' ? result.principal : null;
}

describe('ChildPrincipalRegistry', () => {
  it('should refuse a proof bound to another challenge, request, or coordinator incarnation', () => {
    const db = childCredentialDatabase();
    const incumbent = testChildPrincipalRegistry(ids(), { db });
    const successor = testChildPrincipalRegistry({ randomBytes: (length) => Buffer.alloc(length, 99) }, { db });
    const credential = register(incumbent, testPrincipal());
    const first = incumbent.issueChallenge();
    const second = incumbent.issueChallenge();
    const proof = prove(credential, first);

    expect(incumbent.authenticate(proof, first, REQUEST, 1_001)).toMatchObject({ kind: 'authenticated' });
    expect(incumbent.authenticate(proof, second, REQUEST, 1_001)).toEqual({ kind: 'refused' });
    expect(incumbent.authenticate(proof, null, REQUEST, 1_001)).toEqual({ kind: 'refused' });
    expect(incumbent.authenticate(proof, first, { ...REQUEST, params: { projectRoot: '/q' } }, 1_001)).toEqual({
      kind: 'refused',
    });
    expect(incumbent.authenticate(proof, first, { ...REQUEST, method: 'kb.entries.search' }, 1_001)).toEqual({
      kind: 'refused',
    });
    expect(successor.authenticate(proof, first, REQUEST, 1_001)).toEqual({ kind: 'refused' });
  });

  it('should verify a credential issued before a coordinator was replaced from the store alone', () => {
    const db = childCredentialDatabase();
    const incumbent = testChildPrincipalRegistry(ids(), { db });
    const credential = register(incumbent, testPrincipal());
    const successor = testChildPrincipalRegistry(
      { randomBytes: (length) => Buffer.alloc(length, 99) },
      { db, namespace: 'ns-successor', activeJobOrigin: () => 'ns-a' },
    );
    const foreignOrigin = testChildPrincipalRegistry(
      { randomBytes: (length) => Buffer.alloc(length, 98) },
      { db, namespace: 'ns-successor', activeJobOrigin: () => 'ns-other' },
    );

    expect(authenticated(successor, credential)).not.toBeNull();
    expect(authenticated(foreignOrigin, credential)).toBeNull();
  });

  it('persists only authorization and the public key before returning a child credential', () => {
    const db = childCredentialDatabase();
    const credential = register(testChildPrincipalRegistry(ids(), { db }), testPrincipal());
    const row = db
      .prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
      .get(`child_principal_credential.v1:${credential.credentialId}`);
    expect(row).toBeDefined();
    expect(JSON.parse(row?.value ?? '{}')).toMatchObject({
      credentialId: credential.credentialId,
      namespace: 'ns-a',
      publicKey: expect.any(String),
      parentJobId: 'job-a',
      parentSessionId: 'session-a',
    });
    expect(row?.value).not.toContain(credential.privateKey);
    expect(row?.value).not.toContain('privateKey');
  });

  it('denies a child after its parent job becomes terminal', () => {
    const db = childCredentialDatabase();
    let origin: string | null = 'ns-a';
    const registry = testChildPrincipalRegistry(ids(), { db, activeJobOrigin: () => origin });
    const credential = register(registry, testPrincipal());
    expect(authenticated(registry, credential)).not.toBeNull();
    origin = null;
    expect(authenticated(registry, credential)).toBeNull();
  });

  it('should refuse a proof that claims another job or session', () => {
    const registry = testChildPrincipalRegistry(ids());
    const credential = register(registry, testPrincipal());
    const challenge = registry.issueChallenge();

    for (const claim of [{ jobId: 'job-b' }, { sessionId: 'session-b' }]) {
      expect(registry.authenticate(prove(credential, challenge, REQUEST, claim), challenge, REQUEST, 1_001)).toEqual({
        kind: 'refused',
      });
    }
  });

  it('should refuse an expired credential, a revoked job or session, and a job no longer active', () => {
    let active = true;
    const registry = testChildPrincipalRegistry(ids(), { activeJobOrigin: () => (active ? 'ns-a' : null) });
    const parent = testPrincipal();
    const expiring = register(registry, parent, { jobId: 'job-expiring', ttlMs: 10 });
    const revokedJob = register(registry, parent, { jobId: 'job-terminal' });
    const revokedSession = register(registry, parent, { jobId: 'job-live', sessionId: 'session-terminal' });
    const settled = register(registry, parent, { jobId: 'job-settled' });

    expect(authenticated(registry, expiring, 1_010)).toBeNull();
    registry.revokeParentJob('job-terminal');
    registry.revokeParentSession('session-terminal');
    expect(authenticated(registry, revokedJob)).toBeNull();
    expect(authenticated(registry, revokedSession)).toBeNull();
    expect(authenticated(registry, settled)).not.toBeNull();
    active = false;
    expect(authenticated(registry, settled)).toBeNull();
  });

  it('should deny only the credential whose record is unreadable, and name it', () => {
    const db = childCredentialDatabase();
    const logged: string[] = [];
    const issuer = testChildPrincipalRegistry(ids(), { db });
    const parent = testPrincipal();
    const damaged = register(issuer, parent, { jobId: 'job-damaged' });
    const intact = register(issuer, parent, { jobId: 'job-intact' });
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(
      '{"credentialId":',
      `child_principal_credential.v1:${damaged.credentialId}`,
    );

    const booted = new ChildPrincipalRegistry(
      { randomBytes: (length) => Buffer.alloc(length, 42) },
      createStoreChildPrincipalCredentials(() => db),
      { namespace: 'ns-a', activeJobOrigin: () => 'ns-a', log: (message) => logged.push(message) },
    );
    const challenge = booted.issueChallenge();

    expect(booted.authenticate(prove(damaged, challenge), challenge, REQUEST, 1_001)).toEqual({
      kind: 'credential-unreadable',
      credentialId: damaged.credentialId,
    });
    expect(booted.authenticate(prove(damaged, challenge), challenge, REQUEST, 1_001)).toMatchObject({
      kind: 'credential-unreadable',
    });
    expect(authenticated(booted, intact)).not.toBeNull();
    expect(logged).toEqual([expect.stringContaining(damaged.credentialId)]);
  });

  it('keeps a nested canonical descendant authorized while denying a symlink target outside the parent root', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-child-principal-canonical-'));
    const allowed = join(root, 'allowed');
    const nested = join(allowed, 'nested');
    const outside = join(root, 'outside');
    const escape = join(allowed, 'escape');
    mkdirSync(allowed);
    mkdirSync(nested);
    mkdirSync(outside);
    symlinkSync(outside, escape, 'dir');

    try {
      const registry = testChildPrincipalRegistry(ids());
      const parentRoot = canonicalizeWorkDir(allowed, root);
      const parent = testProjectPrincipal(parentRoot, { subject: 'agent' });
      const child = authenticated(registry, register(registry, parent, { childCaps: ['kb:read'] }));
      if (child === null) throw new Error('Expected child authentication to succeed.');

      expect(
        authorize(child, 'kb:read', {
          kind: 'project',
          root: canonicalizeWorkDir(nested, parentRoot),
        }),
      ).toEqual({ ok: true });
      expect(
        authorize(child, 'kb:read', {
          kind: 'project',
          root: canonicalizeWorkDir(escape, parentRoot),
        }),
      ).toMatchObject({ ok: false, reason: 'resource_unbound' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('authenticates an attenuated child principal whose effective caps stay within the parent', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-child-principal-attenuated-'));
    try {
      const projectRoot = canonicalizeWorkDir(root, root);
      const registry = testChildPrincipalRegistry(ids());
      const parent = testProjectPrincipal(projectRoot, { subject: 'agent' });
      const child = authenticated(registry, register(registry, parent, { childCaps: ['kb:read', 'kb:write'] }));

      expect(child).not.toBeNull();
      expect(authorize(child, 'kb:read', { kind: 'project', root: projectRoot })).toEqual({ ok: true });
      expect(authorize(child, 'kb:write', { kind: 'project', root: projectRoot })).toMatchObject({
        ok: false,
        reason: 'missing_capability',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
