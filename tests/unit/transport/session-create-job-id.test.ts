import { describe, expect, it } from 'vitest';

import { launchToHttp } from '#src/transport/response.js';

const jobId = '10000000-0000-4000-8000-000000000001';

describe('sessions.create job identity', () => {
  it.each(['running', 'queued'] as const)('returns only the job identity for a %s launch', status => {
    expect(launchToHttp({ kind: 'provider-session', status, jobId }, 201)).toEqual({
      statusCode: 201,
      body: { kind: 'provider-session', jobId, launchState: status },
    });
  });
});
