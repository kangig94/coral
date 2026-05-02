import { describe, expect, it } from 'vitest';

import {
  decode,
  encode,
  type JsonRpcErrorEnvelope,
  type JsonRpcNotificationEnvelope,
  type JsonRpcRequestEnvelope,
  type JsonRpcResponseEnvelope,
} from '#src/transport/ipc/json-rpc.js';

describe('transport/json-rpc codec', () => {
  it('round-trips requests', () => {
    const request: JsonRpcRequestEnvelope<{ projectRoot: string; all: boolean }> = {
      kind: 'request',
      id: 'req-1',
      method: 'jobs.list',
      params: {
        projectRoot: '/repo/project',
        all: true,
      },
    };

    expect(decode(encode(request))).toEqual(request);
  });

  it('round-trips responses', () => {
    const response: JsonRpcResponseEnvelope<{ jobs: Array<{ jobId: string; status: string }> }> = {
      kind: 'response',
      id: 'req-1',
      result: {
        jobs: [{ jobId: 'job-1', status: 'running' }],
      },
    };

    expect(decode(encode(response))).toEqual(response);
  });

  it('round-trips notifications', () => {
    const notification: JsonRpcNotificationEnvelope<{ jobId: string; message: string }> = {
      kind: 'notification',
      method: 'jobs.wait.progress',
      params: {
        jobId: 'job-1',
        message: 'running',
      },
    };

    expect(decode(encode(notification))).toEqual(notification);
  });

  it('round-trips errors', () => {
    const error: JsonRpcErrorEnvelope = {
      kind: 'error',
      id: 'req-2',
      error: {
        code: -32_000,
        message: 'coordinator unavailable',
        data: {
          retryMs: 500,
        },
      },
    };

    expect(decode(encode(error))).toEqual(error);
  });

  it('rejects unknown envelope fields during decode', () => {
    const wire = JSON.stringify({
      kind: 'request',
      id: 'req-1',
      method: 'jobs.list',
      params: {
        projectRoot: '/repo/project',
      },
      unexpected: true,
    });

    expect(() => decode(wire)).toThrow();
  });
});
