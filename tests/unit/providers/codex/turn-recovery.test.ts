import { describe, expect, it } from 'vitest';

import {
  decodeCodexErrorInfo,
  decodeTurnError,
  recoverableTurnFailure,
  readErrorNotificationEvidence,
} from '#src/providers/codex/turn-recovery.js';
import type { Turn } from '#src/providers/codex/protocol.js';

describe('Codex structured error decoding', () => {
  it('preserves unknown future variants but marks malformed known variants invalid', () => {
    expect(decodeCodexErrorInfo('futureError')).toEqual({ kind: 'unknown', raw: 'futureError' });
    expect(decodeCodexErrorInfo({ futureError: { detail: 1 } })).toMatchObject({ kind: 'unknown' });
    expect(decodeCodexErrorInfo({ httpConnectionFailed: {} })).toMatchObject({ kind: 'invalid' });
    expect(decodeCodexErrorInfo({ httpConnectionFailed: { httpStatusCode: 65_536 } })).toMatchObject({
      kind: 'invalid',
    });
    expect(decodeCodexErrorInfo({ httpConnectionFailed: { httpStatusCode: 503.5 } })).toMatchObject({
      kind: 'invalid',
    });
    expect(
      decodeCodexErrorInfo({
        httpConnectionFailed: { httpStatusCode: 503 },
        responseStreamDisconnected: { httpStatusCode: null },
      }),
    ).toMatchObject({ kind: 'invalid' });
    expect(decodeCodexErrorInfo({ activeTurnNotSteerable: { turnKind: 'ordinary' } })).toMatchObject({
      kind: 'invalid',
    });
  });
});

describe('turn recovery classification', () => {
  const overloadEvidence = readErrorNotificationEvidence({
    method: 'error',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
      error: { message: 'capacity', codexErrorInfo: 'serverOverloaded' },
    },
  });

  it('uses completed Turn.error as the primary authority', () => {
    const turn = {
      id: 'turn-1',
      status: 'failed',
      error: { message: 'capacity', codexErrorInfo: 'serverOverloaded' },
    } satisfies Turn;
    expect(recoverableTurnFailure(turn, [])).toBe('serverOverloaded');

    const cyberPolicy = {
      ...turn,
      error: { message: 'policy false positive', codexErrorInfo: 'cyberPolicy' },
    } satisfies Turn;
    expect(recoverableTurnFailure(cyberPolicy, [])).toBe('cyberPolicy');

    const badRequest = {
      ...turn,
      error: { message: 'bad', codexErrorInfo: 'badRequest' },
    } satisfies Turn;
    expect(recoverableTurnFailure(badRequest, overloadEvidence ? [overloadEvidence] : [])).toBeNull();

    const conflictingEvidence = overloadEvidence
      ? [{ ...overloadEvidence, info: decodeCodexErrorInfo('badRequest'), message: 'later bad request' }]
      : [];
    expect(recoverableTurnFailure(turn, conflictingEvidence)).toBe('serverOverloaded');
  });

  it('uses only terminal matching notification evidence when Turn.error is physically absent', () => {
    const turn = { id: 'turn-1', status: 'failed' } satisfies Turn;
    expect(overloadEvidence).not.toBeNull();
    expect(recoverableTurnFailure(turn, overloadEvidence ? [overloadEvidence] : [])).toBe('serverOverloaded');

    const cyberEvidence = overloadEvidence
      ? { ...overloadEvidence, info: decodeCodexErrorInfo('cyberPolicy'), message: 'policy false positive' }
      : null;
    expect(recoverableTurnFailure(turn, cyberEvidence ? [cyberEvidence] : [])).toBe('cyberPolicy');

    const retrying = overloadEvidence ? { ...overloadEvidence, willRetry: true } : null;
    expect(recoverableTurnFailure(turn, retrying ? [retrying] : [])).toBeNull();

    const badRequest = overloadEvidence
      ? { ...overloadEvidence, info: decodeCodexErrorInfo('badRequest'), message: 'later bad request' }
      : null;
    expect(
      recoverableTurnFailure(turn, overloadEvidence && badRequest ? [overloadEvidence, badRequest] : []),
    ).toBeNull();
    expect(recoverableTurnFailure(turn, overloadEvidence && badRequest ? [badRequest, overloadEvidence] : [])).toBe(
      'serverOverloaded',
    );
  });

  it('blocks fallback when Turn.error is present but unknown, invalid, or has null info', () => {
    expect(overloadEvidence).not.toBeNull();
    const evidence = overloadEvidence ? [overloadEvidence] : [];
    for (const error of [
      { message: 'future', codexErrorInfo: 'futureError' },
      { message: 'invalid', codexErrorInfo: { httpConnectionFailed: {} } },
      { message: 'none', codexErrorInfo: null },
      { message: 'missing' },
    ]) {
      const turn = { id: 'turn-1', status: 'failed', error } as unknown as Turn;
      expect(decodeTurnError(turn).kind).not.toBe('absent');
      expect(recoverableTurnFailure(turn, evidence)).toBeNull();
    }
  });

  it('preserves malformed structured info from a valid notification envelope', () => {
    expect(
      readErrorNotificationEvidence({
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: false,
          error: { message: 'malformed', codexErrorInfo: { httpConnectionFailed: {} } },
        },
      }),
    ).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
      info: { kind: 'invalid' },
    });
  });
});
