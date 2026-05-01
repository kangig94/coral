import { describe, expect, it } from 'vitest';

import type { Provider, ProviderEventBody, ProviderRequest, ProviderRuntime } from '#src/providers/contract.js';
import { adapterParseGuard, type ParseErrorDetail } from '#src/providers/middleware/adapter-parse-guard.js';

const BASE_REQUEST: ProviderRequest = {
  action: 'exec',
  sessionId: 'job-parse-guard',
  prompt: 'hello',
  cwd: process.cwd(),
  bypassPermissions: false,
  coralEnv: {},
};

const BASE_RUNTIME: ProviderRuntime = {
  signal: new AbortController().signal,
  runCli: async () => ({ stdout: '', stderr: '', code: 0, aborted: false }),
  time: {
    now: () => 0,
    setTimeout: () => ({ unref: () => {} }),
    clearTimeout: () => {},
  } as ProviderRuntime['time'],
  ids: { uuid: () => 'test-uuid', sha256: () => 'sha256:fake' },
  acquireServer: async () => {
    throw new Error('not used in adapter-parse-guard tests');
  },
  storage: { existsSync: () => true } as unknown as ProviderRuntime['storage'],
  continuityBridge: {
    checkpoint: () => {},
    transportClosed: () => {},
  },
  kbRoot: '/mock/kb',
};

async function collect(stream: AsyncIterable<ProviderEventBody>): Promise<ProviderEventBody[]> {
  const events: ProviderEventBody[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('adapterParseGuard', () => {
  it('routes classified parse errors to a terminal fault', async () => {
    const parseFailure: ParseErrorDetail = {
      exitCode: 7,
      stdout: 'not json',
      stderr: 'stderr',
      parseError: 'parse failed',
    };
    const parseError = new Error('parse failed');
    const provider: Provider = async function* throwingProvider() {
      throw parseError;
    };

    const events = await collect(
      adapterParseGuard('claude', (err) => (err === parseError ? parseFailure : null))(provider)(
        BASE_REQUEST,
        BASE_RUNTIME,
      ),
    );

    expect(events).toEqual([
      {
        kind: 'terminal',
        terminal: {
          content: '',
          outcome: { kind: 'failed' },
        },
        diagnostics: {},
        failureCause: {
          type: 'session.adapter_unparseable',
          body: {
            provider: 'claude',
            ...parseFailure,
          },
        },
      },
    ]);
  });

  it('re-throws non-parse errors unchanged', async () => {
    const nonParseError = new Error('non-parse failure');
    const provider: Provider = async function* throwingProvider() {
      throw nonParseError;
    };

    const result = collect(adapterParseGuard('claude', () => null)(provider)(BASE_REQUEST, BASE_RUNTIME));

    await expect(result).rejects.toThrow('non-parse failure');
    await expect(result).rejects.toBe(nonParseError);
  });
});
