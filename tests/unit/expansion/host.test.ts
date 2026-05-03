import { describe, expect, it, vi } from 'vitest';

import type { EngineManifest } from '#src/expansion/contract.js';
import type { ConsumerRegistration } from '#src/store/consumer-contract.js';
import { createExpansionHost, type ConsumerDriverPort } from '#src/expansion/host.js';
import { KB_EMBEDDING_CAPABILITY, KB_VECTOR_CAPABILITY } from '#src/kb/capability/constants.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import type { Disposable } from '#src/runtime/ports.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';

describe('createExpansionHost', () => {
  function manifest(
    id: string,
    tier: EngineManifest['tier'] = 'installed',
    overrides: Partial<EngineManifest> = {},
  ): EngineManifest {
    return {
      id,
      version: '0.0.0',
      specifier: `#tests/${id}/expansion.js`,
      tier,
      description: id,
      ...overrides,
    };
  }

  function createConsumerDriver(register: ConsumerDriverPort['register']): ConsumerDriverPort {
    return {
      register,
      getJournalReader: () => ({
        readCursor: () => 0,
      }),
      getCorpusStateReader: () => ({
        readConsumerCursor: () => ({
          snapshotId: '',
          contentSeq: 0,
          metadataSeq: 0,
          contentManifestHash: '',
          metadataManifestHash: '',
        }),
        readCurrentSnapshot: () => ({
          snapshotId: '',
          contentSeq: 0,
          metadataSeq: 0,
          contentManifestHash: '',
          metadataManifestHash: '',
        }),
      }),
    };
  }

  it('binds through the host scope and holder id', () => {
    const { runtime, kb } = createTestRuntime();
    const scope: Disposable = { [Symbol.dispose]() {} };
    const host = createExpansionHost({
      runtime,
      kb,
      scope,
      roleRegistry: kb.roleRegistry,
      manifest: manifest('needle', 'installed', { fills: [KB_VECTOR_CAPABILITY] }),
      consumerDriver: createConsumerDriver(vi.fn()),
    });

    host.bind(KB_VECTOR_CAPABILITY, 'needle');

    expect(kb.capabilityRegistry.runtimeView().read<string>(KB_VECTOR_CAPABILITY)).toBe('needle');
    expect(kb.capabilityRegistry.runtimeView().status(KB_VECTOR_CAPABILITY)?.heldBy).toBe('needle');
  });

  it('rewraps binding-empty as binding-required', () => {
    const { runtime, kb } = createTestRuntime();
    const host = createExpansionHost({
      runtime,
      kb,
      scope: { [Symbol.dispose]() {} },
      roleRegistry: kb.roleRegistry,
      manifest: manifest('needle', 'installed', {
        onboarding: [{ kind: 'require-binding', binding: KB_EMBEDDING_CAPABILITY }],
      }),
      consumerDriver: createConsumerDriver(vi.fn()),
    });

    expect(() => host.require(KB_EMBEDDING_CAPABILITY)).toThrowError(CoralSetupError);
    try {
      host.require(KB_EMBEDDING_CAPABILITY);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'binding_required',
        context: { binding: 'kb.embedding', requiredBy: 'needle' },
      });
    }
  });

  it('ties registered consumer cleanup to the supplied scope', async () => {
    const { runtime, kb } = createTestRuntime();
    const stop = vi.fn(async () => {});
    const unregister = vi.fn(async () => {});
    const scope: Disposable = { [Symbol.dispose]() {} };
    const consumerDriver = createConsumerDriver(
      vi.fn(() => ({
        id: 'consumer-a',
        registrationKind: 'expansion' as const,
        lastApplyError: null,
        stop,
        unregister,
        status: () => ({ authority: 'journal' as const, cursor: 0, pending: false, lastApplyError: null }),
      })),
    );
    const host = createExpansionHost({
      runtime,
      kb,
      scope,
      roleRegistry: kb.roleRegistry,
      manifest: manifest('needle'),
      consumerDriver,
    });
    const reg = {
      id: 'consumer-a',
      authority: 'journal' as const,
      kind: 'apply' as const,
      async apply() {},
    };

    host.registerConsumer(reg, scope);
    scope[Symbol.dispose]();
    await Promise.resolve();
    await Promise.resolve();

    expect(consumerDriver.register).toHaveBeenCalledWith({ ...reg, registrationKind: 'expansion' });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('derives registrationKind from (tier, kind) — bundled→base, installed apply→expansion, stateless→stateless', () => {
    const { runtime, kb } = createTestRuntime();
    const captured: ConsumerRegistration[] = [];
    const consumerDriver = createConsumerDriver(
      vi.fn((reg: ConsumerRegistration) => {
        captured.push(reg);
        return {
          id: reg.id,
          registrationKind: reg.registrationKind ?? 'base',
          lastApplyError: null,
          stop: async () => {},
          unregister: async () => {},
          status: () => ({ authority: 'journal' as const, cursor: 0, pending: false, lastApplyError: null }),
        };
      }),
    );

    const bundledHost = createExpansionHost({
      runtime,
      kb,
      scope: { [Symbol.dispose]() {} },
      roleRegistry: kb.roleRegistry,
      manifest: manifest('orama', 'bundled'),
      consumerDriver,
    });
    bundledHost.registerConsumer(
      {
        id: 'orama-base',
        authority: 'corpus',
        kind: 'apply',
        corpusInterest: 'content',
        async apply() {},
      },
      bundledHost.scope,
    );

    const installedApplyHost = createExpansionHost({
      runtime,
      kb,
      scope: { [Symbol.dispose]() {} },
      roleRegistry: kb.roleRegistry,
      manifest: manifest('needle'),
      consumerDriver,
    });
    installedApplyHost.registerConsumer(
      {
        id: 'needle',
        authority: 'corpus',
        kind: 'apply',
        corpusInterest: 'content',
        async apply() {},
      },
      installedApplyHost.scope,
    );

    const installedStatelessHost = createExpansionHost({
      runtime,
      kb,
      scope: { [Symbol.dispose]() {} },
      roleRegistry: kb.roleRegistry,
      manifest: manifest('gemini'),
      consumerDriver,
    });
    installedStatelessHost.registerConsumer({ id: 'gemini', kind: 'stateless' }, installedStatelessHost.scope);

    expect(captured.map((reg) => reg.registrationKind)).toEqual(['base', 'expansion', 'stateless']);
  });
});
