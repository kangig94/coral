import { afterEach, describe, expect, it } from 'vitest';
import { getDiscussMaxWorkers, getMaxWorkers, parsePositiveInt } from '#src/coordinator/live/worker-limits.js';
import { getMaxQueueSize } from '#src/coordinator/live/admission.js';

const ORIGINAL_MAX_CHILDREN = process.env.CORAL_MAX_WORKERS;
const ORIGINAL_DISCUSS_MAX_CHILDREN = process.env.CORAL_DISCUSS_MAX_WORKERS;
const ORIGINAL_MAX_QUEUE_SIZE = process.env.CORAL_MAX_QUEUE_SIZE;

function restoreEnv(
  name: 'CORAL_MAX_WORKERS' | 'CORAL_DISCUSS_MAX_WORKERS' | 'CORAL_MAX_QUEUE_SIZE',
  value: string | undefined,
): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv('CORAL_MAX_WORKERS', ORIGINAL_MAX_CHILDREN);
  restoreEnv('CORAL_DISCUSS_MAX_WORKERS', ORIGINAL_DISCUSS_MAX_CHILDREN);
  restoreEnv('CORAL_MAX_QUEUE_SIZE', ORIGINAL_MAX_QUEUE_SIZE);
});

describe('worker limits', () => {
  it('parses positive integers and falls back for invalid values', () => {
    expect(parsePositiveInt(undefined, 5)).toBe(5);
    expect(parsePositiveInt('4', 5)).toBe(4);
    expect(parsePositiveInt('0', 5)).toBe(5);
    expect(parsePositiveInt('-1', 5)).toBe(5);
    expect(parsePositiveInt('abc', 5)).toBe(5);
  });

  it('bounds CORAL_MAX_WORKERS to the supported range', () => {
    const env = { get: (name: string) => process.env[name] };
    process.env.CORAL_MAX_WORKERS = '1';
    expect(getMaxWorkers(env)).toBe(1);
    process.env.CORAL_MAX_WORKERS = '99';
    expect(getMaxWorkers(env)).toBe(10);
  });

  it('bounds CORAL_DISCUSS_MAX_WORKERS to the supported range', () => {
    const env = { get: (name: string) => process.env[name] };
    process.env.CORAL_DISCUSS_MAX_WORKERS = '1';
    expect(getDiscussMaxWorkers(env)).toBe(1);
    process.env.CORAL_DISCUSS_MAX_WORKERS = '99';
    expect(getDiscussMaxWorkers(env)).toBe(10);
  });
});

describe('admission queue size', () => {
  const env = { get: (name: string) => process.env[name] };

  it('falls back to default 20 when CORAL_MAX_QUEUE_SIZE is unset', () => {
    delete process.env.CORAL_MAX_QUEUE_SIZE;
    expect(getMaxQueueSize(env)).toBe(20);
  });

  it('honours CORAL_MAX_QUEUE_SIZE when set to a positive integer', () => {
    process.env.CORAL_MAX_QUEUE_SIZE = '50';
    expect(getMaxQueueSize(env)).toBe(50);
  });

  it('falls back to default for invalid values', () => {
    process.env.CORAL_MAX_QUEUE_SIZE = 'abc';
    expect(getMaxQueueSize(env)).toBe(20);
    process.env.CORAL_MAX_QUEUE_SIZE = '0';
    expect(getMaxQueueSize(env)).toBe(20);
    process.env.CORAL_MAX_QUEUE_SIZE = '-5';
    expect(getMaxQueueSize(env)).toBe(20);
  });

  it('clamps to the [1, 1000] range', () => {
    process.env.CORAL_MAX_QUEUE_SIZE = '5000';
    expect(getMaxQueueSize(env)).toBe(1000);
  });
});
