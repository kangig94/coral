import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import {
  formatProviderHostInspect,
  formatProviderHostList,
  parseProviderHostSelector,
  registerBackendCommands,
} from '#src/cli/commands/backend.js';
import { encodeHostRef } from '#src/providers/host-ref-codec.js';
import type { HostRef } from '#src/providers/contract.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

const ref: HostRef = {
  provider: 'codex',
  fingerprint: 'a'.repeat(64),
  instanceId: 'host-instance',
  leaseMode: 'shared',
};

const host = {
  ownerId: 'coordinator:test-instance',
  ref,
  status: 'retired-blocked' as const,
  spec: {
    provider: 'codex',
    command: 'codex',
    args: ['app-server'],
    cwd: fixtureCanonicalWorkDir('/workspace'),
    leaseMode: 'shared' as const,
    idleRetirement: 'none' as const,
  },
  host: { owner: 'coordinator' },
  diagnostics: {
    hostLog: { entries: [], retainedBytes: 0, truncatedBeforeSeq: 0 },
    completedObservations: [],
    factsTruncatedBeforeSeq: 0,
  },
  diagnosticsRetention: { ownerBudgetTruncated: false },
};

function findCommand(root: Command, ...path: string[]): Command {
  let current = root;
  for (const name of path) {
    const next = current.commands.find((command) => command.name() === name);
    if (next === undefined) throw new Error(`Missing command: ${path.join(' ')}`);
    current = next;
  }
  return current;
}

describe('provider-host CLI contracts', () => {
  it('requires exactly one selector', () => {
    expect(() => parseProviderHostSelector(undefined, undefined)).toThrow('Provide exactly one selector');
    expect(() => parseProviderHostSelector(encodeHostRef(ref), '/workspace')).toThrow('Provide exactly one selector');
  });

  it('decodes a positional token and preserves a raw work-directory selector', () => {
    expect(parseProviderHostSelector(encodeHostRef(ref), undefined)).toEqual({ hostRef: ref });
    expect(parseProviderHostSelector(undefined, './relative-workspace')).toEqual({
      workDir: './relative-workspace',
      projectRoot: process.cwd(),
    });
  });

  it('formats copyable canonical tokens and distinguishes retained blocked hosts', () => {
    const token = encodeHostRef(ref);
    expect(formatProviderHostList({ hosts: [host] })).toContain(`${token}\tretired-blocked`);
    expect(formatProviderHostInspect({ host })).toContain(`"hostRef": "${token}"`);
  });

  it('warns about selector safety and attached work in evict help', () => {
    const program = new Command().name('coral-cli');
    registerBackendCommands(program);

    const help = findCommand(program, 'backend', 'provider-host', 'evict').helpInformation().replace(/\s+/g, ' ');

    expect(help).toContain('copied from `coral-cli backend provider-host list`');
    expect(help).toContain('relative to the current directory');
    expect(help).toContain('refuses on ambiguity');
    expect(help).toContain('may end work already attached to that host');
  });
});
