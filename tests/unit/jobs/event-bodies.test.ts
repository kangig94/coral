import { describe, expect, it } from 'vitest';

import { jobRuntimeStartedBodySchema } from '#src/jobs/event-bodies.js';

describe('job event body schemas', () => {
  it('rejects non-finite runtime pid and tail watermark values', () => {
    expect(
      jobRuntimeStartedBodySchema.safeParse({
        pid: 1234,
        tailWatermark: 4096,
        startedAt: '2026-06-12T00:00:00.000Z',
      }).success,
    ).toBe(true);

    expect(
      jobRuntimeStartedBodySchema.safeParse({
        pid: Infinity,
        startedAt: '2026-06-12T00:00:00.000Z',
      }).success,
    ).toBe(false);

    expect(
      jobRuntimeStartedBodySchema.safeParse({
        tailWatermark: Number.NaN,
        startedAt: '2026-06-12T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
