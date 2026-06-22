import { describe, expect, it } from 'vitest';

import { kbMemoDeleteRequestSchema, kbNoteCreateRequestSchema } from '#src/kb/tool-contracts.js';

// Regression: KB mutation commands route through the same buildTransportContextBody
// as provider launches, so it attaches `networkEnv` whenever the caller shell has a
// proxy/CA var set. The shared transport-context mixin must accept that field, or
// every KB write hard-fails schema validation on any machine behind a proxy.
describe('kb transport-context schema networkEnv', () => {
  const base = {
    memo: 'm',
    title: 't',
    content: 'body',
    domain: 'd',
    topic: 'tp',
    projectRoot: '/tmp/project',
  };

  it('accepts a forwarded networkEnv map on a KB mutation request', () => {
    const parsed = kbNoteCreateRequestSchema.parse({
      ...base,
      networkEnv: { HTTPS_PROXY: 'http://proxy:8443', NODE_EXTRA_CA_CERTS: '/c.pem' },
    });

    expect(parsed.networkEnv).toEqual({
      HTTPS_PROXY: 'http://proxy:8443',
      NODE_EXTRA_CA_CERTS: '/c.pem',
    });
  });

  it('still rejects unknown keys inside networkEnv', () => {
    expect(() => kbNoteCreateRequestSchema.parse({ ...base, networkEnv: { PATH: '/usr/bin' } })).toThrow();
  });

  it('accepts transport context on a memo delete request', () => {
    const parsed = kbMemoDeleteRequestSchema.parse({
      projectRoot: '/tmp/project',
      pattern: '2026-*',
      effort: 'high',
      claudeModelCap: 'sonnet',
      jobId: 'job-1',
      sessionId: 'session-1',
      networkEnv: { HTTPS_PROXY: 'http://proxy:8443' },
    });

    expect(parsed).toEqual({
      projectRoot: '/tmp/project',
      pattern: '2026-*',
      effort: 'high',
      claudeModelCap: 'sonnet',
      jobId: 'job-1',
      sessionId: 'session-1',
      networkEnv: { HTTPS_PROXY: 'http://proxy:8443' },
    });
  });
});
