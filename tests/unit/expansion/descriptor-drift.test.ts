import { describe, expect, it } from 'vitest';
import type { EngineManifest } from '#src/expansion/contract.js';
import { validateManifestCompleteness } from '#src/expansion/manifest/completeness.js';
import { createScope } from '#src/infra/disposable-scope.js';
import type { RetrievalRole, RetrievalRoleDescriptor } from '#src/kb/search/contract.js';
import { createRoleRegistry } from '#src/kb/search/role-registry.js';
import { KB_FTS_CAPABILITY } from '#src/kb/capability/constants.js';
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

describe('manifest descriptor drift validation', () => {
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
});
