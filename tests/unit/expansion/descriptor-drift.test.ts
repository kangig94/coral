import { describe, expect, it, vi } from 'vitest';

import { loadBundledEngine } from '#src/expansion/bundled.js';
import type { EngineManifest, Expansion } from '#src/expansion/contract.js';
import { disposeExpansionScope } from '#src/expansion/host.js';
import { validateManifestCompleteness } from '#src/expansion/manifest/completeness.js';
import { createScope } from '#src/expansion/scope.js';
import type { RetrievalRole, RetrievalRoleDescriptor } from '#src/kb/search/contract.js';
import { createRoleRegistry } from '#src/kb/search/role-registry.js';
import { KB_FTS_CAPABILITY, KB_VECTOR_CAPABILITY } from '#src/kb/capability/constants.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';

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

  it('rethrows role_descriptor_unregistered from read-side bundled loading and disposes the partial role scope', async () => {
    const entry = {
      id: 'partial-read-side',
      version: '0.0.0',
      specifier: '#tests/partial-read-side/expansion.js',
      tier: 'bundled',
      description: 'partial read-side role expansion',
      provides: {
        retrievalRoles: [
          { ...baseDescriptor, id: 'read-side-one' },
          { ...baseDescriptor, id: 'read-side-two' },
        ],
      },
    } satisfies EngineManifest;
    const partialLoader: Expansion = vi.fn(async (host) => {
      const descriptor = { ...baseDescriptor, id: 'read-side-one' };
      host.registerRetrievalRole(
        {
          id: descriptor.id,
          descriptor,
          async search() {
            return { hits: [] };
          },
        },
        host.scope,
      );
    });
    const { kb, makeHost } = createTestRuntime();
    const scope = createScope();
    const host = makeHost(entry, scope);

    await expect(
      (async () => {
        try {
          await loadBundledEngine(entry, host, { [entry.id]: partialLoader });
          validateManifestCompleteness(entry, kb.roleRegistry, kb.capabilityRegistry);
        } catch (error) {
          await disposeExpansionScope(scope);
          throw error;
        }
      })(),
    ).rejects.toMatchObject({
      code: 'role_descriptor_unregistered',
      context: {
        expansion: 'partial-read-side',
        missing: 'read-side-two',
      },
    });
    expect(kb.roleRegistry.list().some((record) => record.descriptor.id === 'read-side-one')).toBe(false);
  });
});
