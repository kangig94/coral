import { describe, expect, it } from 'vitest';

import { validateManifestCompleteness } from '#src/expansion/manifest/completeness.js';
import type { EngineManifest } from '#src/expansion/contract.js';
import { createScope } from '#src/expansion/scope.js';
import type { RetrievalRole, RetrievalRoleDescriptor } from '#src/kb/search/contract.js';
import { createRoleRegistry } from '#src/kb/search/role-registry.js';
import { KB_FTS_CAPABILITY, KB_VECTOR_CAPABILITY } from '#src/kb/capability/constants.js';
import { CoralSetupError } from '#src/runtime/errors.js';

const baseDescriptor = {
  id: 'drift-role',
  label: 'Drift Role',
  tags: ['lexical'],
  phase: 'retrieval-source',
  supportsScopes: ['notes', 'sources', 'all'],
  requires: [KB_FTS_CAPABILITY],
  provides: 'retrieval-source',
} as const satisfies RetrievalRoleDescriptor;

function manifestWith(descriptor: RetrievalRoleDescriptor = baseDescriptor): EngineManifest {
  return {
    id: 'drift-engine',
    version: '0.0.0',
    specifier: '#tests/drift-engine/expansion.js',
    tier: 'installed',
    description: 'drift engine',
    provides: { retrievalRoles: [descriptor] },
  };
}

function roleWith(descriptor: RetrievalRoleDescriptor, id: string = baseDescriptor.id): RetrievalRole {
  return {
    id,
    descriptor,
    async search() {
      return { hits: [] };
    },
  };
}

function expectDescriptorMismatch(liveDescriptor: RetrievalRoleDescriptor, roleId: string = baseDescriptor.id): void {
  const { makeHost } = createTestRuntime();
  const scope = createScope();
  const host = makeHost(manifestWith(), scope);

  expect(() => host.registerRetrievalRole(roleWith(liveDescriptor, roleId), scope)).toThrowError(CoralSetupError);
  try {
    host.registerRetrievalRole(roleWith(liveDescriptor, roleId), scope);
  } catch (error) {
    expect(error).toMatchObject({
      code: 'role_descriptor_mismatch',
      context: { expansion: 'drift-engine', roleId },
    });
  }
}

describe('manifest descriptor drift validation', () => {
  it.each([
    ['id', { ...baseDescriptor, id: 'live-id' }],
    ['label', { ...baseDescriptor, label: 'Live Label' }],
    ['tags', { ...baseDescriptor, tags: ['semantic'] }],
    ['phase', { ...baseDescriptor, phase: 'reranker' }],
    ['supportsScopes', { ...baseDescriptor, supportsScopes: ['notes'] }],
    ['requires', { ...baseDescriptor, requires: [KB_VECTOR_CAPABILITY] }],
    ['provides', { ...baseDescriptor, provides: 'reranker' }],
  ] as const)('rejects %s drift as role_descriptor_mismatch', (_field, liveDescriptor) => {
    expectDescriptorMismatch(liveDescriptor as unknown as RetrievalRoleDescriptor);
  });

  it('rejects a role id declared by the live role but absent from manifest.provides', () => {
    expectDescriptorMismatch({ ...baseDescriptor, id: 'unregistered-live-role' }, 'unregistered-live-role');
  });

  it('throws role_descriptor_unregistered when a manifest descriptor is declared but not registered', () => {
    const registry = createRoleRegistry();
    const scope = createScope();
    const registeredDescriptor = { ...baseDescriptor, id: 'registered-role' } satisfies RetrievalRoleDescriptor;
    const missingDescriptor = { ...baseDescriptor, id: 'missing-role' } satisfies RetrievalRoleDescriptor;

    registry.registerScoped(roleWith(registeredDescriptor, registeredDescriptor.id), scope);

    expect(() =>
      validateManifestCompleteness(
        {
          ...manifestWith(registeredDescriptor),
          provides: { retrievalRoles: [registeredDescriptor, missingDescriptor] },
        },
        registry,
      ),
    ).toThrowError(CoralSetupError);
    try {
      validateManifestCompleteness(
        {
          ...manifestWith(registeredDescriptor),
          provides: { retrievalRoles: [registeredDescriptor, missingDescriptor] },
        },
        registry,
      );
    } catch (error) {
      expect(error).toMatchObject({
        code: 'role_descriptor_unregistered',
        context: {
          expansion: 'drift-engine',
          missing: 'missing-role',
        },
      });
    }
  });

  it('reports every manifest descriptor id that was not registered', () => {
    const registry = createRoleRegistry();
    const roleA = { ...baseDescriptor, id: 'role-a' } satisfies RetrievalRoleDescriptor;
    const roleB = { ...baseDescriptor, id: 'role-b' } satisfies RetrievalRoleDescriptor;
    const roleC = { ...baseDescriptor, id: 'role-c' } satisfies RetrievalRoleDescriptor;

    try {
      validateManifestCompleteness(
        {
          ...manifestWith(roleA),
          provides: { retrievalRoles: [roleA, roleB, roleC] },
        },
        registry,
      );
      throw new Error('expected validateManifestCompleteness to throw');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'role_descriptor_unregistered',
        context: {
          expansion: 'drift-engine',
          missing: 'role-a, role-b, role-c',
        },
      });
    }
  });
});
