import { describe, expect, it } from 'vitest';

import {
  currentEventMetadata,
  getInvocationScope,
  requireInvocationScope,
  withInvocationScope,
  type CoordinatorInvocationScope,
} from '#src/coordinator/invocation-scope.js';

function scope(suffix: string): CoordinatorInvocationScope {
  return {
    namespace: `ns-${suffix}`,
    project: `project-${suffix}`,
    correlationId: `corr-${suffix}`,
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('coordinator invocation-scope', () => {
  it('should return the run callback result', () => {
    expect(withInvocationScope(scope('a'), () => 42)).toBe(42);
  });

  it('should expose the scope inside the run callback', () => {
    const active = scope('a');
    withInvocationScope(active, () => {
      expect(getInvocationScope()).toBe(active);
      expect(requireInvocationScope()).toBe(active);
    });
  });

  it('should return null from getInvocationScope outside any scope', () => {
    expect(getInvocationScope()).toBeNull();
  });

  it('should throw from requireInvocationScope outside any scope', () => {
    expect(() => requireInvocationScope()).toThrow('Coordinator invocation scope is not active');
  });

  it('should propagate the scope across await boundaries and nested async calls', async () => {
    const active = scope('async');

    async function nestedRead(): Promise<CoordinatorInvocationScope> {
      await nextTick();
      return requireInvocationScope();
    }

    await withInvocationScope(active, async () => {
      await nextTick();
      expect(getInvocationScope()).toBe(active);
      await expect(nestedRead()).resolves.toBe(active);
    });
  });

  it('should shadow the outer scope inside a nested invocation and restore it after exit', async () => {
    const outer = scope('outer');
    const inner = scope('inner');

    await withInvocationScope(outer, async () => {
      expect(getInvocationScope()).toBe(outer);

      await withInvocationScope(inner, async () => {
        expect(getInvocationScope()).toBe(inner);
        await nextTick();
        expect(getInvocationScope()).toBe(inner);
      });

      expect(getInvocationScope()).toBe(outer);
    });

    expect(getInvocationScope()).toBeNull();
  });

  it('should not leak the scope after the synchronous run returns', () => {
    withInvocationScope(scope('sync'), () => undefined);
    expect(getInvocationScope()).toBeNull();
  });

  it('should keep concurrent async invocations isolated', async () => {
    const left = scope('left');
    const right = scope('right');

    async function observe(expected: CoordinatorInvocationScope): Promise<void> {
      expect(getInvocationScope()).toBe(expected);
      await nextTick();
      expect(getInvocationScope()).toBe(expected);
      await nextTick();
      expect(requireInvocationScope()).toBe(expected);
    }

    await Promise.all([
      withInvocationScope(left, () => observe(left)),
      withInvocationScope(right, () => observe(right)),
    ]);
  });

  it('should derive event metadata from the active scope', () => {
    const active = scope('meta');
    const metadata = withInvocationScope(active, () => currentEventMetadata());

    expect(metadata).toEqual({
      namespace: active.namespace,
      project: active.project,
      correlationId: active.correlationId,
    });
  });

  it('should throw from currentEventMetadata outside any scope', () => {
    expect(() => currentEventMetadata()).toThrow('Coordinator invocation scope is not active');
  });
});
