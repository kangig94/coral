import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChildPrincipalRegistry } from '#src/coordinator/child-principal-registry.js';
import { authorize } from '#src/security/policy/authorize.js';
import type { Capability } from '#src/security/capability.js';
import type { Principal } from '#src/security/principal.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

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
    namespace?: string;
    jobId?: string;
    sessionId?: string;
    nowMs?: number;
    ttlMs?: number;
    childCaps?: readonly Capability[];
  } = {},
) {
  return registry.register({
    issuer: 'test-launch',
    parentPrincipal,
    namespace: options.namespace ?? 'ns-a',
    parentJobId: options.jobId ?? 'job-a',
    parentSessionId: options.sessionId ?? 'session-a',
    nowMs: options.nowMs ?? 1_000,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.childCaps === undefined ? {} : { childCaps: options.childCaps }),
  });
}

function childAuth(
  handle: string,
  options: {
    token?: string;
    jobId?: string;
    sessionId?: string;
  } = {},
) {
  return {
    kind: 'child' as const,
    handle,
    token: options.token ?? 'nonce-1',
    jobId: options.jobId ?? 'job-a',
    sessionId: options.sessionId ?? 'session-a',
  };
}

describe('ChildPrincipalRegistry', () => {
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
      const registry = new ChildPrincipalRegistry(ids());
      const parentRoot = canonicalizeWorkDir(allowed, root);
      const parent = testProjectPrincipal(parentRoot, { subject: 'agent' });
      const credential = register(registry, parent, { childCaps: ['kb:read'] });
      const child = registry.authenticate(childAuth(credential.handle), 'ns-a', 1_001);
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
    const registry = new ChildPrincipalRegistry(ids());
    const parent = testProjectPrincipal('/workspace/project', { subject: 'agent' });
    const credential = register(registry, parent, { childCaps: ['kb:read', 'kb:write'] });

    const child = registry.authenticate(childAuth(credential.handle), 'ns-a', 1_001);

    expect(child).not.toBeNull();
    const projectRoot = fixtureCanonicalWorkDir('/workspace/project');
    expect(authorize(child, 'kb:read', { kind: 'project', root: projectRoot })).toEqual({ ok: true });
    expect(authorize(child, 'kb:write', { kind: 'project', root: projectRoot })).toMatchObject({
      ok: false,
      reason: 'missing_capability',
    });
  });

  it('rejects a job-bound handle replayed under another job', () => {
    const registry = new ChildPrincipalRegistry(ids());
    const parent = testProjectPrincipal('/workspace/project');
    const credential = register(registry, parent, { jobId: 'job-a', sessionId: 'session-a' });

    expect(
      registry.authenticate(
        childAuth(credential.handle, { token: 'nonce-1', jobId: 'job-b', sessionId: 'session-a' }),
        'ns-a',
        1_001,
      ),
    ).toBeNull();
  });

  it('rejects nonce replay but accepts a fresh nonce for the same live handle', () => {
    const registry = new ChildPrincipalRegistry(ids());
    const parent = testProjectPrincipal('/workspace/project');
    const credential = register(registry, parent);

    expect(registry.authenticate(childAuth(credential.handle, { token: 'nonce-1' }), 'ns-a', 1_001)).not.toBeNull();
    expect(registry.authenticate(childAuth(credential.handle, { token: 'nonce-1' }), 'ns-a', 1_002)).toBeNull();
    expect(registry.authenticate(childAuth(credential.handle, { token: 'nonce-2' }), 'ns-a', 1_003)).not.toBeNull();
  });

  it('rejects namespace mismatch, TTL expiry, and terminal revocation', () => {
    const registry = new ChildPrincipalRegistry(ids());
    const parent = testProjectPrincipal('/workspace/project');
    const namespaceCredential = register(registry, parent, { namespace: 'ns-a' });
    const expiringCredential = register(registry, parent, {
      jobId: 'job-expiring',
      sessionId: 'session-expiring',
      ttlMs: 10,
    });
    const jobCredential = register(registry, parent, { jobId: 'job-terminal', sessionId: 'session-live' });
    const sessionCredential = register(registry, parent, { jobId: 'job-live', sessionId: 'session-terminal' });

    expect(
      registry.authenticate(childAuth(namespaceCredential.handle, { token: 'nonce-ns' }), 'ns-b', 1_001),
    ).toBeNull();
    expect(
      registry.authenticate(
        childAuth(expiringCredential.handle, {
          token: 'nonce-expired',
          jobId: 'job-expiring',
          sessionId: 'session-expiring',
        }),
        'ns-a',
        1_010,
      ),
    ).toBeNull();

    registry.revokeParentJob('job-terminal');
    registry.revokeParentSession('session-terminal');

    expect(
      registry.authenticate(
        childAuth(jobCredential.handle, { token: 'nonce-job', jobId: 'job-terminal', sessionId: 'session-live' }),
        'ns-a',
        1_001,
      ),
    ).toBeNull();
    expect(
      registry.authenticate(
        childAuth(sessionCredential.handle, {
          token: 'nonce-session',
          jobId: 'job-live',
          sessionId: 'session-terminal',
        }),
        'ns-a',
        1_001,
      ),
    ).toBeNull();
  });
});
