import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

import { RecoveryQuarantineClearError } from '#src/recovery/source-registry.js';
import { buildTransportErrorResponse } from '#src/transport/error-response.js';
import { createIpcServer } from '#src/transport/ipc/server.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';

describe('recovery quarantine refusal transport', () => {
  it.each([
    ['retry-in-progress', 'recovery_quarantine_retry_in_progress'],
    ['continuation-not-active', 'recovery_quarantine_continuation_pending'],
    ['retention-not-admitted', 'recovery_quarantine_retention_not_admitted'],
  ] as const)('maps %s to a public HTTP conflict and IPC diagnostic', async (code, publicCode) => {
    const failure = new RecoveryQuarantineClearError(code, 'private domain diagnostic');
    const http = buildTransportErrorResponse(failure);
    expect(http.statusCode).toBe(409);
    expect(http.body).toMatchObject({
      code: publicCode,
      message: http.message,
      userMessage: http.message,
      remediation: expect.any(String),
    });
    expect(http.message).not.toContain(failure.message);
    if (code === 'retention-not-admitted') {
      expect(http.body).toMatchObject({
        message: 'Session retention recovery is not admitted while the coordinator is starting.',
        remediation:
          'Retention recovery is admitted automatically once the coordinator is serving. Retry the same clear after startup finishes.',
      });
    }

    const clear = vi.fn(async () => {
      throw failure;
    });
    const ports = {
      identity: { bootToken: 'boot-token', log: vi.fn() },
      coralEnvSnapshot: {},
      admin: {
        isLifecycleRunning: () => true,
        isDrainRequested: () => false,
        isLaunchFenceActive: () => false,
        beginRequest: vi.fn(),
        endRequest: vi.fn(),
      },
      recoveryQuarantine: { clear },
    } as unknown as HttpHandlerPorts;
    let receive!: (frame: string) => void;
    const response = new Promise<string>((resolve) => {
      receive = resolve;
    });
    const socket = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      resume: vi.fn(),
      write: (frame: string) => {
        receive(frame);
        return true;
      },
      end: vi.fn(),
      destroy() {
        if (socket.destroyed) return;
        socket.destroyed = true;
        socket.emit('close');
      },
    });
    const listener = createIpcServer(ports);
    listener.acceptSocket!(socket as unknown as Socket);
    const request = { boundary: 'session-retention-work', key: 'session:job', revision: 'revision' };
    try {
      socket.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            kind: 'request',
            id: 1,
            method: 'coordinator.recovery_quarantine.clear',
            params: request,
            auth: { kind: 'boot', token: 'boot-token' },
          })}\n`,
        ),
      );
      expect(JSON.parse(await response)).toMatchObject({
        kind: 'error',
        id: 1,
        error: { code: -32603, message: http.message, data: http.data },
      });
      expect(clear).toHaveBeenCalledExactlyOnceWith(request, expect.any(AbortSignal));
    } finally {
      socket.destroy();
    }
  });
});
