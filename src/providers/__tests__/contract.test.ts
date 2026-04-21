import { describe, expect, it } from 'vitest';

import {
  compose,
  type Provider,
  type ProviderEventBody,
  type ProviderMiddleware,
  type ProviderRequest,
  type ProviderRuntime,
} from '../contract.js';

const BASE_REQUEST: ProviderRequest = {
  action: 'exec',
  sessionId: 'job-contract',
  prompt: 'hello',
  cwd: process.cwd(),
  bypassPermissions: false,
  coralEnv: {},
};

const BASE_RUNTIME: ProviderRuntime = {
  signal: new AbortController().signal,
  runCli: async () => ({ stdout: '', stderr: '', code: 0, aborted: false }),
  acquireServer: async () => {
    throw new Error('not used in contract tests');
  },
  continuityBridge: {
    checkpoint: () => {},
    transportClosed: () => {},
  },
};

function terminal(content: string): ProviderEventBody {
  return {
    kind: 'terminal',
    terminal: {
      content,
      outcome: { kind: 'completed' },
    },
    diagnostics: {},
  };
}

async function collect(stream: AsyncIterable<ProviderEventBody>): Promise<ProviderEventBody[]> {
  const events: ProviderEventBody[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('compose', () => {
  it('wraps middleware outermost-first and preserves next() semantics', async () => {
    const calls: string[] = [];
    const provider: Provider = async function* leaf() {
      calls.push('leaf');
      yield { kind: 'progress', message: 'leaf-progress' };
      yield terminal('leaf-terminal');
    };
    const outer: ProviderMiddleware = (next) =>
      async function* outerLayer(request, runtime) {
        calls.push(`outer:before:${request.sessionId}`);
        for await (const event of next(request, runtime)) {
          calls.push(`outer:event:${event.kind}`);
          yield event;
        }
        calls.push('outer:after');
      };
    const inner: ProviderMiddleware = (next) =>
      async function* innerLayer(request, runtime) {
        calls.push(`inner:before:${request.sessionId}`);
        for await (const event of next(request, runtime)) {
          calls.push(`inner:event:${event.kind}`);
          yield event;
        }
        calls.push('inner:after');
      };

    const events = await collect(compose(outer, inner, provider)(BASE_REQUEST, BASE_RUNTIME));

    expect(events).toEqual([
      { kind: 'progress', message: 'leaf-progress' },
      terminal('leaf-terminal'),
    ]);
    expect(calls).toEqual([
      'outer:before:job-contract',
      'inner:before:job-contract',
      'leaf',
      'inner:event:progress',
      'outer:event:progress',
      'inner:event:terminal',
      'outer:event:terminal',
      'inner:after',
      'outer:after',
    ]);
  });

  it('supports short-circuit middleware that never calls next()', async () => {
    const leaf = async function* (): AsyncIterable<ProviderEventBody> {
      throw new Error('leaf should not run');
    };
    const shortCircuit: ProviderMiddleware = (_next) =>
      async function* shortCircuitLayer() {
        yield terminal('short-circuit');
      };

    const events = await collect(compose(shortCircuit, leaf)(BASE_REQUEST, BASE_RUNTIME));

    expect(events).toEqual([terminal('short-circuit')]);
  });

  it('type-checks the array and variadic compose forms and narrows by event kind', async () => {
    const provider: Provider = async function* typedLeaf() {
      yield { kind: 'continuity', conversationRef: 'conversation-1', resumable: true, providerContinuity: {} };
      yield terminal('typed');
    };
    const passthrough: ProviderMiddleware = (next) => next;

    const fromArray = compose([], provider);
    const fromVariadic = compose(passthrough, provider);
    const events = await collect(fromVariadic(BASE_REQUEST, BASE_RUNTIME));

    const rendered = events.map((event) => {
      switch (event.kind) {
        case 'progress':
          return event.message;
        case 'continuity':
          return event.conversationRef ?? 'none';
        case 'terminal':
          return event.terminal.content;
      }
    });

    expect(typeof fromArray).toBe('function');
    expect(rendered).toEqual(['conversation-1', 'typed']);
  });
});
