import { describe, expect, it } from 'vitest';

import type { Capability } from '../../../src/security/capability.js';
import type { Principal, ResourceBinding, Subject } from '../../../src/security/principal.js';
import { authorize } from '../../../src/security/policy/authorize.js';
import { fixtureCanonicalWorkDir } from '../../helpers/canonical-work-dir.js';

function principal(subject: Subject, binding: ResourceBinding, attenuatedCaps?: Iterable<Capability>): Principal {
  return {
    subject,
    transport: 'test',
    credential: { kind: 'test', id: subject },
    binding,
    attenuatedCaps: attenuatedCaps ? new Set(attenuatedCaps) : undefined,
  };
}

describe('authorize', () => {
  it('denies missing principals before evaluating capabilities', () => {
    expect(authorize(null, 'liveness', { kind: 'unbound' })).toEqual({
      ok: false,
      reason: 'unauthenticated',
      detail: { requires: 'liveness', requestedBinding: { kind: 'unbound' } },
    });
  });

  it('denies capabilities outside the subject baseline or attenuation ceiling', () => {
    const agent = principal('agent', { kind: 'project', root: fixtureCanonicalWorkDir('/workspace/project') });
    expect(authorize(agent, 'system:shutdown', { kind: 'unbound' })).toMatchObject({
      ok: false,
      reason: 'missing_capability',
    });

    const backendOperator = principal('operator', { kind: 'unbound' }, [
      'liveness',
      'kb:read',
      'kb:write',
      'kb:source:import',
      'jobs:read',
      'jobs:control',
      'discuss:participate',
      'expansion:manage',
    ]);
    expect(authorize(backendOperator, 'system:debug', { kind: 'unbound' })).toMatchObject({
      ok: false,
      reason: 'missing_capability',
    });
  });

  it('allows bound-project capabilities inside the principal project root', () => {
    const projectAgent = principal('agent', {
      kind: 'project',
      root: fixtureCanonicalWorkDir('/workspace/project'),
    });

    expect(
      authorize(projectAgent, 'kb:read', {
        kind: 'project',
        root: fixtureCanonicalWorkDir('/workspace/project'),
      }),
    ).toEqual({
      ok: true,
    });
    expect(
      authorize(projectAgent, 'kb:read', {
        kind: 'project',
        root: fixtureCanonicalWorkDir('/workspace/project/docs'),
      }),
    ).toEqual({ ok: true });
  });

  it('denies bound-project capabilities outside the principal project root or against unbound resources', () => {
    const projectAgent = principal('agent', {
      kind: 'project',
      root: fixtureCanonicalWorkDir('/workspace/project'),
    });

    expect(
      authorize(projectAgent, 'kb:read', { kind: 'project', root: fixtureCanonicalWorkDir('/workspace/other') }),
    ).toMatchObject({ ok: false, reason: 'resource_unbound' });
    expect(authorize(projectAgent, 'jobs:read', { kind: 'unbound' })).toMatchObject({
      ok: false,
      reason: 'resource_unbound',
    });
  });

  it('allows unbound principals to satisfy bound-project capabilities for any requested binding', () => {
    const operator = principal('operator', { kind: 'unbound' });

    expect(
      authorize(operator, 'kb:source:import', {
        kind: 'project',
        root: fixtureCanonicalWorkDir('/workspace/project'),
      }),
    ).toEqual({ ok: true });
    expect(authorize(operator, 'jobs:read', { kind: 'unbound' })).toEqual({ ok: true });
  });

  it('does not apply project binding checks to any-scoped capabilities', () => {
    const projectAgent = principal('agent', {
      kind: 'project',
      root: fixtureCanonicalWorkDir('/workspace/project'),
    });

    expect(authorize(projectAgent, 'liveness', { kind: 'unbound' })).toEqual({ ok: true });
  });
});
