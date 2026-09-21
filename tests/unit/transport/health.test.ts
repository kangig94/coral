import { describe, expect, it } from 'vitest';

import { HEALTH_TIMEOUT_MS } from '#src/transport/health.js';
import * as sse from '#src/transport/http/sse.js';

describe('transport health policy', () => {
  it('owns the health timeout outside the HTTP SSE module', () => {
    expect(HEALTH_TIMEOUT_MS).toBe(3_000);
    expect(sse).not.toHaveProperty('HEALTH_TIMEOUT_MS');
  });
});
