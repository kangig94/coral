import { describe, expect, it } from 'vitest';

import {
  formatProviderHostInspect,
  formatProviderHostList,
  parseProviderHostSelector,
} from '#src/cli/commands/backend.js';
import { encodeHostRef } from '#src/providers/host-ref-codec.js';
import type { HostRef } from '#src/providers/contract.js';

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
    cwd: '/workspace',
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
});
