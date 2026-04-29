import { describe, expect, it, vi } from 'vitest';

import type { ConsumerRegistration } from '#src/store/consumer-contract.js';
import { createExpansionHost, type ConsumerDriverPort } from '#src/expansion/host.js';
import { createRuntimeBinding } from '#src/runtime/binding.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import type { Disposable } from '#src/runtime/ports.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';

describe('createExpansionHost', () => {
  it('binds through the host scope and holder id', () => {
    const { runtime, kb } = createTestRuntime();
    const scope: Disposable = { [Symbol.dispose]() {} };
    const host = createExpansionHost({
      runtime,
      kb,
      scope,
      id: 'needle',
      tier: 'installed',
      consumerDriver: { register: vi.fn() } as unknown as ConsumerDriverPort,
    });
    const binding = createRuntimeBinding<string>('kb.vector');

    host.bind(binding, 'needle');

    expect(binding.read()).toBe('needle');
    expect(binding.heldBy).toBe('needle');
  });

  it('rewraps binding-empty as binding-required', () => {
    const { runtime, kb } = createTestRuntime();
    const host = createExpansionHost({
      runtime,
      kb,
      scope: { [Symbol.dispose]() {} },
      id: 'needle',
      tier: 'installed',
      consumerDriver: { register: vi.fn() } as unknown as ConsumerDriverPort,
    });
    const binding = createRuntimeBinding<string>('kb.embedding');

    expect(() => host.require(binding)).toThrowError(CoralSetupError);
    try {
      host.require(binding);
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
    const consumerDriver = {
      register: vi.fn(() => ({
        id: 'consumer-a',
        registrationKind: 'expansion' as const,
        lastApplyError: null,
        stop,
        unregister,
        status: () => ({ authority: 'journal' as const, cursor: 0, pending: false, lastApplyError: null }),
      })),
    } as unknown as ConsumerDriverPort;
    const host = createExpansionHost({
      runtime,
      kb,
      scope,
      id: 'needle',
      tier: 'installed',
      consumerDriver,
    });
    const reg: ConsumerRegistration = {
      id: 'consumer-a',
      authority: 'journal',
      kind: 'apply',
      registrationKind: 'expansion',
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
    const consumerDriver = {
      register: vi.fn((reg: ConsumerRegistration) => {
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
    } as unknown as ConsumerDriverPort;

    const bundledHost = createExpansionHost({
      runtime,
      kb,
      scope: { [Symbol.dispose]() {} },
      id: 'orama',
      tier: 'bundled',
      consumerDriver,
    });
    bundledHost.registerConsumer(
      {
        id: 'orama-base',
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'base',
        corpusInterest: 'content',
        async apply() {},
      },
      bundledHost.scope,
    );

    const installedApplyHost = createExpansionHost({
      runtime,
      kb,
      scope: { [Symbol.dispose]() {} },
      id: 'needle',
      tier: 'installed',
      consumerDriver,
    });
    installedApplyHost.registerConsumer(
      {
        id: 'needle',
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'expansion',
        corpusInterest: 'content',
        async apply() {},
      },
      installedApplyHost.scope,
    );

    const installedStatelessHost = createExpansionHost({
      runtime,
      kb,
      scope: { [Symbol.dispose]() {} },
      id: 'gemini',
      tier: 'installed',
      consumerDriver,
    });
    installedStatelessHost.registerConsumer(
      { id: 'gemini', kind: 'stateless', registrationKind: 'stateless' },
      installedStatelessHost.scope,
    );

    expect(captured.map((reg) => reg.registrationKind)).toEqual(['base', 'expansion', 'stateless']);
  });
});
