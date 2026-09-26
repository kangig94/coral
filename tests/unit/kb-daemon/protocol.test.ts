import { describe, expect, it } from 'vitest';

import {
  KB_DAEMON_PARENT_REQUEST_MESSAGE,
  KB_DAEMON_PARENT_RESPONSE_MESSAGE,
  KB_DAEMON_REQUEST_MESSAGE,
  isKbDaemonCurateRequestCancelRequest,
  isKbDaemonCurateAssistantCompleteRequest,
  isKbDaemonExpansionRequest,
  isKbDaemonJobsResult,
  isKbDaemonKbReadHealth,
  isKbDaemonKbMutationRequest,
  isKbDaemonKbReadRequest,
  isKbDaemonParentRequestMessage,
  isKbDaemonParentResponseMessage,
  isKbDaemonRequestMessage,
  kbDaemonWriterReclaimParamsSchema,
} from '#src/kb-daemon/protocol.js';

const daemonCtx = {
  projectRoot: '/workspace/project-a',
  principal: {
    subject: 'operator',
    binding: { kind: 'project', root: '/workspace/project-a' },
    attenuatedCaps: ['kb:read', 'kb:write'],
  },
} as const;

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

  it('requires valid PrincipalWire context on read, mutation, and expansion requests', () => {
    expect(isKbDaemonKbReadRequest({ method: 'readNote', slug: 'alpha-note', ctx: daemonCtx })).toBe(true);
    expect(isKbDaemonKbMutationRequest({ method: 'createMemo', args: {}, ctx: daemonCtx })).toBe(true);
    expect(isKbDaemonExpansionRequest({ method: 'equipExpansion', args: { name: 'vector' }, ctx: daemonCtx })).toBe(
      true,
    );

    expect(isKbDaemonKbReadRequest({ method: 'readNote', slug: 'alpha-note' })).toBe(false);
    expect(
      isKbDaemonKbMutationRequest({
        method: 'createMemo',
        args: {},
        ctx: { ...daemonCtx, principal: { ...daemonCtx.principal, attenuatedCaps: 'kb:read' } },
      }),
    ).toBe(false);
    expect(
      isKbDaemonExpansionRequest({
        method: 'equipExpansion',
        args: { name: 'vector' },
        ctx: { principal: { subject: 'operator', binding: { kind: 'workspace' } } },
      }),
    ).toBe(false);
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

  it('accepts usage-budget requests and the single generic curate cancel request', () => {
    expect(
      isKbDaemonParentRequestMessage({
        type: KB_DAEMON_PARENT_REQUEST_MESSAGE,
        id: 'parent:budget',
        method: 'curate.usage-budget.exhausted',
      }),
    ).toBe(true);
    expect(
      isKbDaemonParentRequestMessage({
        type: KB_DAEMON_PARENT_REQUEST_MESSAGE,
        id: 'parent:2',
        method: 'curate.request.cancel',
        params: { requestId: 'parent:1', reason: 'stopping' },
      }),
    ).toBe(true);
    expect(
      isKbDaemonParentRequestMessage({
        type: KB_DAEMON_PARENT_REQUEST_MESSAGE,
        id: 'parent:legacy',
        method: 'curate.assistant.cancel',
        params: { requestId: 'parent:1' },
      }),
    ).toBe(false);
    expect(isKbDaemonCurateRequestCancelRequest({ requestId: 'parent:1', reason: 'stopping' })).toBe(true);
    expect(isKbDaemonCurateRequestCancelRequest({ requestId: '' })).toBe(false);
  });
});

describe('KB daemon writer reclaim params', () => {
  it('should accept only a whole writer generation with its store address', () => {
    const generation = { generation: 3, storeRoot: '/store', epoch: '2' };
    expect(kbDaemonWriterReclaimParamsSchema.safeParse(generation).success).toBe(true);
    expect(kbDaemonWriterReclaimParamsSchema.safeParse({ ...generation, generation: 3.5 }).success).toBe(false);
    expect(
      kbDaemonWriterReclaimParamsSchema.safeParse({ ...generation, generation: Number.MAX_SAFE_INTEGER + 1 }).success,
    ).toBe(false);
    expect(kbDaemonWriterReclaimParamsSchema.safeParse({ generation: 3, storeRoot: '/store' }).success).toBe(false);
    expect(kbDaemonWriterReclaimParamsSchema.safeParse(undefined).success).toBe(false);
  });
});
