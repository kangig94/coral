import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { proxyOperationSendResultSchema, type ProxyOperationSendResult } from '#src/provider-proxy/protocol.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';
import type { Principal } from '#src/security/principal.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { createIpcServer } from '#src/transport/ipc/server.js';
import { jobsSendRpcSpec, rpcCatalog } from '#src/transport/rpc/catalog.js';
import { JOB_SEND_MAX_INPUT_LENGTH, jobSendSchema, jobSendResponseSchema } from '#src/transport/rpc/jobs.js';
import {
  ipcRouteLifecycleAdmission,
  ipcRouteRefusalDisposition,
  readIpcOperationalSpec,
} from '#src/transport/rpc/operational-catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';

const projectRoot = canonicalizeWorkDir(process.cwd(), process.cwd());
const request = {
  projectRoot,
  jobId: 'job-1',
  input: 'Keep the public API unchanged.',
  clientMessageId: '11111111-1111-4111-8111-111111111111',
};
const operator: Principal = {
  subject: 'operator',
  transport: 'test',
  credential: { kind: 'test', id: 'operator' },
  binding: { kind: 'unbound' },
};
const tempDirs: string[] = [];

afterEach(() => {
  for (const root of tempDirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const send = vi.fn<HttpHandlerPorts['jobs']['send']>(async () => ({
    state: 'delivered',
    providerTurnId: 'turn-1',
  }));
  const ports = {
    identity: {
      pluginRoot: '/plugin',
      bootToken: 'boot-token',
      now: () => 0,
      log: vi.fn(),
    },
    coralEnvSnapshot: {},
    admin: {
      isLifecycleRunning: () => true,
      isDrainRequested: () => false,
      isLaunchFenceActive: () => false,
      beginRequest: vi.fn(),
      endRequest: vi.fn(),
    },
    jobs: { send },
  } as unknown as HttpHandlerPorts;
  return { ports, send };
}

async function issue(ports: HttpHandlerPorts, params: unknown) {
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    resume: vi.fn(),
    write: vi.fn((_frame: string) => true),
    end() {
      socket.writableEnded = true;
      socket.emit('finish');
      socket.destroy();
    },
    destroy() {
      if (socket.destroyed) return;
      socket.destroyed = true;
      socket.emit('close');
    },
  });
  const closed = new Promise<void>((resolve) => socket.once('close', resolve));
  const listener = createIpcServer(ports);
  listener.acceptSocket!(socket as unknown as Socket);
  try {
    socket.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          kind: 'request',
          id: 1,
          method: 'jobs.send',
          params,
          auth: { kind: 'boot', token: 'boot-token' },
        })}\n`,
      ),
    );
    await closed;
    expect(socket.write).toHaveBeenCalledOnce();
    return JSON.parse(String(vi.mocked(socket.write).mock.calls[0][0]));
  } finally {
    socket.destroy();
  }
}

describe('jobs.send', () => {
  it('should reject a proxy delivered response that leaks the provider turn id at the public boundary', () => {
    const proxyResponse = { state: 'delivered', providerTurnId: 'turn-private' };
    expect(proxyOperationSendResultSchema.safeParse(proxyResponse).success).toBe(true);
    expect(jobSendResponseSchema.safeParse(proxyResponse).success).toBe(false);
    expect(jobSendResponseSchema.parse({ state: 'delivered' })).toEqual({ state: 'delivered' });
  });

  it.each([
    ['empty input', { input: '' }],
    ['whitespace-only input', { input: ' \n\t' }],
    ['oversized input', { input: 'x'.repeat(JOB_SEND_MAX_INPUT_LENGTH + 1) }],
    ['non-UUID client message ID', { clientMessageId: 'message-1' }],
    ['missing project root', { projectRoot: undefined }],
    ['empty project root', { projectRoot: '' }],
    ['empty job ID', { jobId: '' }],
  ] as const)('should reject %s before issuing a send', async (_defect, invalid) => {
    const { ports, send } = fixture();
    const params = { ...request, ...invalid };

    expect(jobSendSchema.safeParse(params).success).toBe(false);
    expect(await issue(ports, params)).toMatchObject({ kind: 'error', error: { code: -32602 } });
    expect(send).not.toHaveBeenCalled();
  });

  it('should accept the exact UTF-16 input bound and preserve whitespace around text', () => {
    const input = '😀'.repeat(JOB_SEND_MAX_INPUT_LENGTH / 2);
    expect(jobSendSchema.parse({ ...request, input }).input).toBe(input);
    expect(jobSendSchema.parse({ ...request, input: '  keep this\n' }).input).toBe('  keep this\n');
  });

  it('should require jobs:control before examining scope or issuing a send', async () => {
    const { ports, send } = fixture();
    const result = await executeCatalogRequest(
      jobsSendRpcSpec,
      { ...request, projectRoot: '/missing-jobs-send-project' },
      ports,
      { ...operator, attenuatedCaps: new Set(['jobs:read']) },
    );

    expect(result).toMatchObject({ kind: 'unary', statusCode: 401, body: { code: 'missing_capability' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('should pass the canonical caller root through the request and execution context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-jobs-send-'));
    tempDirs.push(root);
    const target = join(root, 'project');
    const alias = join(root, 'alias');
    mkdirSync(target);
    symlinkSync(target, alias);
    const { ports, send } = fixture();

    expect(await issue(ports, { ...request, projectRoot: alias })).toEqual({
      kind: 'response',
      id: 1,
      result: { state: 'delivered' },
    });
    const canonicalRoot = canonicalizeWorkDir(target, root);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { ...request, projectRoot: canonicalRoot },
      expect.objectContaining({ projectRoot: canonicalRoot }),
    );
  });

  it('should deny a caller binding outside its authorized project before issuing a send', async () => {
    const { ports, send } = fixture();
    const result = await executeCatalogRequest(jobsSendRpcSpec, request, ports, {
      ...operator,
      binding: { kind: 'project', root: canonicalizeWorkDir(tmpdir(), process.cwd()) },
    });

    expect(result).toMatchObject({ kind: 'unary', statusCode: 403, body: { code: 'scope_mismatch' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('should register one send route with control authorization and pre-effect successor handling', () => {
    expect(rpcCatalog.filter((spec) => spec.name === 'jobs.send')).toEqual([jobsSendRpcSpec]);
    expect(readIpcOperationalSpec('jobs.send')).toMatchObject({
      requires: 'jobs:control',
      requiresRunningLifecycle: true,
      dispatch: { kind: 'catalog', onRefusal: 'spawn-successor' },
    });
    expect(ipcRouteLifecycleAdmission('jobs.send')).toBe('running');
    expect(ipcRouteRefusalDisposition('jobs.send')).toBe('spawn-successor');
  });

  it('should refuse a draining lifecycle before the send can take effect', async () => {
    const { ports, send } = fixture();
    ports.admin.isDrainRequested = () => true;

    expect(await issue(ports, request)).toMatchObject({
      kind: 'response',
      result: { code: 'backend_shutting_down' },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    [{ state: 'delivered', providerTurnId: 'turn-1' }, { state: 'delivered' }],
    [
      { state: 'refused', code: 'turn_ended', reason: 'The turn has ended.' },
      { state: 'refused', code: 'turn_ended', reason: 'The turn has ended.' },
    ],
    [
      { state: 'refused', code: 'unsupported_by_running_build', reason: 'Method not found.' },
      { state: 'refused', code: 'unsupported_by_running_build', reason: 'Method not found.' },
    ],
    [
      { state: 'refused', code: 'scope_mismatch', reason: 'The job belongs to another project.' },
      { state: 'refused', code: 'scope_mismatch', reason: 'The job belongs to another project.' },
    ],
    [
      { state: 'unknown', reason: 'No provider answer.' },
      { state: 'unknown', reason: 'No provider answer.' },
    ],
  ] satisfies [ProxyOperationSendResult, unknown][])(
    'should round-trip %j as a result value with the exact public shape',
    async (outcome, expected) => {
      const { ports, send } = fixture();
      send.mockResolvedValueOnce(outcome);

      const response = await issue(ports, request);
      expect(response).toEqual({ kind: 'response', id: 1, result: expected });
      expect(jobsSendRpcSpec.responseSchema.parse(response.result)).toEqual(expected);
      expect(send).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { state: 'delivered', reason: 'unexpected' },
    { state: 'refused', code: 'turn_ended' },
    { state: 'refused', code: 'invented', reason: 'No.' },
    { state: 'unknown' },
    { state: 'unknown', reason: 'No answer.', code: 'turn_ended' },
    { state: 'indeterminate', reason: 'No answer.' },
  ])('should reject malformed or overlapping response variants: %j', (outcome) => {
    expect(jobsSendRpcSpec.responseSchema.safeParse(outcome).success).toBe(false);
  });

  it('should answer unknown rather than an error envelope when send throws after issue', async () => {
    const { ports, send } = fixture();
    send.mockImplementationOnce(async () => {
      throw new Error('Proxy reply lost after issue');
    });

    expect(await issue(ports, request)).toEqual({
      kind: 'response',
      id: 1,
      result: { state: 'unknown', reason: 'The send may have been delivered: Proxy reply lost after issue' },
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it('should answer unknown rather than a transport error for a malformed post-issue answer', async () => {
    const { ports, send } = fixture();
    send.mockResolvedValueOnce({ state: 'delivered' } as ProxyOperationSendResult);

    expect(await issue(ports, request)).toMatchObject({
      kind: 'response',
      id: 1,
      result: { state: 'unknown', reason: expect.any(String) },
    });
    expect(send).toHaveBeenCalledOnce();
  });
});
