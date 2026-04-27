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
      consumerDriver: { register: vi.fn() } as unknown as ConsumerDriverPort,
    });
    const binding = createRuntimeBinding<string>('kb.vector', 'orama');

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
        registrationKind: 'base' as const,
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
      consumerDriver,
    });
    const reg: ConsumerRegistration = {
      id: 'consumer-a',
      authority: 'journal',
      async apply() {},
    };

    host.registerConsumer(reg, scope);
    scope[Symbol.dispose]();
    await Promise.resolve();
    await Promise.resolve();

    expect(consumerDriver.register).toHaveBeenCalledWith(reg);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});
