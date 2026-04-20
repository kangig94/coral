import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  request: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock('../../transport/ipc/ensure.js', () => ({
  ensure: vi.fn(async () => ({
    request: mockState.request,
    subscribe: mockState.subscribe,
  })),
}));

import { makeClient } from '../command-helpers.js';

function findCommand(root: Command, ...path: string[]): Command {
  let current = root;

  for (const name of path) {
    const next = current.commands.find((command) => command.name() === name);
    if (!next) {
      throw new Error(`Expected command path ${path.join(' ')} to exist`);
    }
    current = next;
  }

  return current;
}

function buildProgram(): Command {
  const program = new Command();
  const kb = program.command('kb');
  kb.command('reindex');
  return program;
}

describe('command helpers client routing', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('forwards kb search mode through non-read transport dispatchers', async () => {
    mockState.request.mockResolvedValueOnce({ results: [], mode: 'vector' });
    const program = buildProgram();
    const client = makeClient('/tmp/project', findCommand(program, 'kb', 'reindex'));

    await client.kbSearch({
      query: 'contracts',
      top_k: 5,
      scope: 'notes',
      mode: 'vector',
    });

    expect(mockState.request).toHaveBeenCalledWith(
      'kb.entries.search',
      {
        q: 'contracts',
        scope: 'notes',
        top_k: 5,
        mode: 'vector',
      },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it('dispatches kb diagnose over the transport surface for non-read clients', async () => {
    mockState.request.mockResolvedValueOnce({ incidents: [] });
    const program = buildProgram();
    const client = makeClient('/tmp/project', findCommand(program, 'kb', 'reindex'));

    await client.kbDiagnose({});

    expect(mockState.request).toHaveBeenCalledWith(
      'kb.diagnose',
      {},
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });
});
