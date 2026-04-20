import { describe, expect, it } from 'vitest';

import {
  decode,
  encode,
  type JsonRpcError,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '../json-rpc.js';

describe('transport/json-rpc codec', () => {
  it('round-trips requests', () => {
    const request: JsonRpcRequest<{ projectRoot: string; all: boolean }> = {
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
    const response: JsonRpcResponse<{ jobs: Array<{ jobId: string; status: string }> }> = {
      kind: 'response',
      id: 'req-1',
      result: {
        jobs: [{ jobId: 'job-1', status: 'running' }],
      },
    };

    expect(decode(encode(response))).toEqual(response);
  });

  it('round-trips notifications', () => {
    const notification: JsonRpcNotification<{ jobId: string; message: string }> = {
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
    const error: JsonRpcError = {
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

  it('rejects reserved subscriptionId slot collisions during encode and decode', () => {
    const envelope = {
      kind: 'notification',
      method: 'jobs.wait.progress',
      params: {
        jobId: 'job-1',
      },
      subscriptionId: 'sub-1',
    } satisfies JsonRpcNotification<{ jobId: string }> & { subscriptionId: string };

    expect(() => encode(envelope)).toThrow();
    expect(() => decode(JSON.stringify(envelope))).toThrow();
  });
});
