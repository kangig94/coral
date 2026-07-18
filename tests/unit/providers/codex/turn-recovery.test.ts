import { describe, expect, it } from 'vitest';

import {
  decodeCodexErrorInfo,
  decodeTurnError,
  recoverableTurnFailure,
  readErrorNotificationEvidence,
} from '#src/providers/codex/turn-recovery.js';
import type { CodexErrorInfo, Turn } from '#src/providers/codex/protocol.js';

const stringVariants = [
  'contextWindowExceeded',
  'sessionBudgetExceeded',
  'usageLimitExceeded',
  'serverOverloaded',
  'cyberPolicy',
  'internalServerError',
  'unauthorized',
  'badRequest',
  'threadRollbackFailed',
  'sandboxError',
  'other',
] satisfies CodexErrorInfo[];

describe('Codex structured error decoding', () => {
  it.each(stringVariants)('decodes known string variant %s', (variant) => {
    expect(decodeCodexErrorInfo(variant)).toEqual({ kind: 'known', value: variant });
  });

  it.each([
    'httpConnectionFailed',
    'responseStreamConnectionFailed',
    'responseStreamDisconnected',
    'responseTooManyFailedAttempts',
  ])('decodes %s with nullable u16 status', (tag) => {
    expect(decodeCodexErrorInfo({ [tag]: { httpStatusCode: null } })).toEqual({
      kind: 'known',
      value: { [tag]: { httpStatusCode: null } },
    });
    expect(decodeCodexErrorInfo({ [tag]: { httpStatusCode: 503 } })).toEqual({
      kind: 'known',
      value: { [tag]: { httpStatusCode: 503 } },
    });
  });

  it('decodes both activeTurnNotSteerable kinds', () => {
    expect(decodeCodexErrorInfo({ activeTurnNotSteerable: { turnKind: 'review' } })).toEqual({
      kind: 'known',
      value: { activeTurnNotSteerable: { turnKind: 'review' } },
    });
    expect(decodeCodexErrorInfo({ activeTurnNotSteerable: { turnKind: 'compact' } })).toEqual({
      kind: 'known',
      value: { activeTurnNotSteerable: { turnKind: 'compact' } },
    });
  });

  it('accepts u16 boundaries and rejects non-u16 HTTP statuses', () => {
    for (const status of [0, 65_535]) {
      expect(decodeCodexErrorInfo({ httpConnectionFailed: { httpStatusCode: status } })).toEqual({
        kind: 'known',
        value: { httpConnectionFailed: { httpStatusCode: status } },
      });
    }
    for (const status of [-1, 65_536, 503.5, '503', Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(decodeCodexErrorInfo({ httpConnectionFailed: { httpStatusCode: status } })).toMatchObject({
        kind: 'invalid',
      });
    }
  });

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

  it('keeps every non-recoverable structured cause outside the recovery allowlist', () => {
    const nonRecoverable: unknown[] = [
      ...stringVariants.filter((variant) => variant !== 'serverOverloaded' && variant !== 'cyberPolicy'),
      { httpConnectionFailed: { httpStatusCode: 503 } },
      { responseStreamConnectionFailed: { httpStatusCode: 502 } },
      { responseStreamDisconnected: { httpStatusCode: null } },
      { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      { activeTurnNotSteerable: { turnKind: 'review' } },
    ];
    for (const codexErrorInfo of nonRecoverable) {
      const turn = {
        id: 'turn-1',
        status: 'failed',
        error: { message: 'not capacity', codexErrorInfo },
      } as unknown as Turn;
      expect(recoverableTurnFailure(turn, [])).toBeNull();
    }
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

  it('rejects malformed notification envelopes without throwing', () => {
    expect(
      readErrorNotificationEvidence({
        method: 'error',
        params: {
          threadId: '',
          turnId: 'turn-1',
          willRetry: 'false',
          error: { codexErrorInfo: 'serverOverloaded' },
        },
      }),
    ).toBeNull();
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
