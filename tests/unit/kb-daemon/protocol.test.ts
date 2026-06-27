import { describe, expect, it } from 'vitest';

import {
  KB_DAEMON_REQUEST_MESSAGE,
  isKbDaemonJobsResult,
  isKbDaemonKbReadHealth,
  isKbDaemonRequestMessage,
} from '#src/kb-daemon/protocol.js';

describe('KB daemon protocol', () => {
  it('accepts active KB job list requests', () => {
    expect(
      isKbDaemonRequestMessage({
        type: KB_DAEMON_REQUEST_MESSAGE,
        id: '1',
        method: 'kb.jobs',
      }),
    ).toBe(true);
  });

  it('validates active KB job list results', () => {
    expect(isKbDaemonJobsResult({ active: ['job-a', 'job-b'] })).toBe(true);
    expect(isKbDaemonJobsResult({ active: ['job-a', 42] })).toBe(false);
    expect(isKbDaemonJobsResult({ active: 'job-a' })).toBe(false);
  });

  it('accepts daemon runtime health with curate scheduler state', () => {
    expect(
      isKbDaemonKbReadHealth({
        phase: 'ready',
        initializedAt: 123,
        curateRunning: true,
        mutationBlocked: { owner: 'reindex', ageMs: 5000, signaledAtMs: 123456 },
      }),
    ).toBe(true);
    expect(isKbDaemonKbReadHealth({ phase: 'ready', curateRunning: 'yes' })).toBe(false);
    expect(isKbDaemonKbReadHealth({ phase: 'ready', mutationBlocked: { owner: 'reindex' } })).toBe(false);
  });
});
