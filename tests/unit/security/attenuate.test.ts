import { describe, expect, it } from 'vitest';

import { attenuate } from '../../../src/security/attenuate.js';
import { type Capability } from '../../../src/security/capability.js';
import type { Principal, ResourceBinding, Subject } from '../../../src/security/principal.js';
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

describe('attenuate', () => {
  it('returns only the requested subset of the principal effective capabilities', () => {
    const parent = principal('operator', { kind: 'unbound' });
    const child = attenuate(parent, ['kb:read', 'jobs:read']);

    expect(child).toMatchObject({
      subject: 'operator',
      transport: 'test',
      credential: { kind: 'test', id: 'operator' },
      binding: { kind: 'unbound' },
    });
    expect(child.attenuatedCaps).toEqual(new Set(['kb:read', 'jobs:read']));
  });

  it('intersects with existing attenuation instead of regranting removed capabilities', () => {
    const parent = principal('operator', { kind: 'unbound' }, ['kb:read', 'jobs:read']);
    const child = attenuate(parent, ['jobs:read', 'system:shutdown']);

    expect(child.attenuatedCaps).toEqual(new Set(['jobs:read']));
  });

  it('does not carry capabilities outside the subject baseline into the attenuation ceiling', () => {
    const parent = principal('agent', { kind: 'project', root: fixtureCanonicalWorkDir('/workspace/project') });
    const child = attenuate(parent, ['kb:read', 'system:shutdown']);

    expect(child.attenuatedCaps).toEqual(new Set(['kb:read']));
  });
});
