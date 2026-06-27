import { describe, expect, it } from 'vitest';

import {
  KB_DAEMON_PARENT_REQUEST_MESSAGE,
  KB_DAEMON_PARENT_RESPONSE_MESSAGE,
  KB_DAEMON_REQUEST_MESSAGE,
  isKbDaemonCurateAssistantCancelRequest,
  isKbDaemonCurateAssistantCompleteRequest,
  isKbDaemonJobsResult,
  isKbDaemonKbReadHealth,
  isKbDaemonParentRequestMessage,
  isKbDaemonParentResponseMessage,
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

  it('accepts daemon-to-parent curate assistant requests and responses', () => {
    expect(
      isKbDaemonParentRequestMessage({
        type: KB_DAEMON_PARENT_REQUEST_MESSAGE,
        id: 'parent:1',
        method: 'curate.assistant.complete',
        params: {
          prompt: 'classify this',
          purpose: 'classification',
          model: 'sonnet',
          permissionMode: 'auto',
        },
      }),
    ).toBe(true);
    expect(
      isKbDaemonCurateAssistantCompleteRequest({
        prompt: 'classify this',
        purpose: 'classification',
        model: 'sonnet',
        permissionMode: 'auto',
      }),
    ).toBe(true);
    expect(isKbDaemonCurateAssistantCompleteRequest({ prompt: 'x', purpose: 'unknown' })).toBe(false);

    expect(
      isKbDaemonParentResponseMessage({
        type: KB_DAEMON_PARENT_RESPONSE_MESSAGE,
        id: 'parent:1',
        ok: true,
        result: 'done',
      }),
    ).toBe(true);
    expect(
      isKbDaemonParentResponseMessage({
        type: KB_DAEMON_PARENT_RESPONSE_MESSAGE,
        id: 'parent:1',
        ok: false,
        error: { message: 'failed' },
      }),
    ).toBe(true);
  });

  it('accepts daemon-to-parent curate assistant cancel requests', () => {
    expect(
      isKbDaemonParentRequestMessage({
        type: KB_DAEMON_PARENT_REQUEST_MESSAGE,
        id: 'parent:2',
        method: 'curate.assistant.cancel',
        params: { requestId: 'parent:1', reason: 'stopping' },
      }),
    ).toBe(true);
    expect(isKbDaemonCurateAssistantCancelRequest({ requestId: 'parent:1', reason: 'stopping' })).toBe(true);
    expect(isKbDaemonCurateAssistantCancelRequest({ requestId: '' })).toBe(false);
  });
});
