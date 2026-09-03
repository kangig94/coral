import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { encodeProviderProxySetAddress } from '#src/provider-proxy/set-address.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import {
  readProviderProxySetHolderStatusDirect,
  formatProviderProxySetHolderStatusDirect,
} from '#src/cli/commands/backend.js';

describe('readProviderProxySetHolderStatusDirect', () => {
  it('renders no discovered sets as an explicit empty report, never a silent absence claim', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'c-hs0-'));
    const runtime = createRealRuntime('prod', { baseDir });
    runtime.storage.mkdirSync(runtime.paths.coral.coordinator.runDir, { recursive: true, mode: 0o700 });

    const readings = await readProviderProxySetHolderStatusDirect(runtime);

    expect(readings).toEqual([]);
    expect(formatProviderProxySetHolderStatusDirect(readings)).toBe('No provider proxy sets discovered on disk.');
  });

  it('names both operator exits after unattributable retry exhaustion', () => {
    const setIdentity = {
      buildSetId: randomUUID(),
      hostFingerprint: 'c'.repeat(64),
      proxyInstanceId: randomUUID(),
    };
    const rendered = formatProviderProxySetHolderStatusDirect([
      {
        ...setIdentity,
        guardian: {
          kind: 'answered',
          status: {
            disposition: 'unobservable',
            phase: 'published',
            holder: { instanceId: randomUUID(), pid: 900, incarnation: testIncarnation(900) },
            controlEpoch: 1,
            transitionSequence: 2,
            changedAtMs: 1_000,
            enforcementHold: {
              kind: 'recorded-group-unattributable',
              attempts: 5,
              roleIdentity: { role: 'guardian', pid: 901, incarnation: testIncarnation(901) },
              retry: { state: 'operator-action-required' },
            },
          },
        },
        reaper: { kind: 'unreachable', reason: 'connection refused' },
      },
    ]);

    expect(rendered).toContain(
      `coral-cli backend provider-proxy-set contain ${encodeProviderProxySetAddress(setIdentity)} --abandon-without-absence`,
    );
    expect(rendered).toContain(
      `coral-cli backend provider-proxy-set terminate-role --role guardian --pid 901 --incarnation '${testIncarnation(901)}'`,
    );
    expect(rendered).not.toContain('kill -TERM');
  });
});
