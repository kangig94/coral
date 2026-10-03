import { expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRealRuntime } from '#src/runtime/real.js';
import { createProxyAppServerHostAuthority } from '#src/provider-proxy/provider-root-authority.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it.each([
  { wrapped: false, loseWrapper: false },
  { wrapped: true, loseWrapper: false },
  { wrapped: true, loseWrapper: true },
])('reclaims only its own resistant provider: %j', async ({ wrapped, loseWrapper }) => {
  const root = mkdtempSync('/tmp/coral-provider-retirement-');
  const base = createRealRuntime('prod', { baseDir: root });
  const runtime = {
    ...base,
    env: {
      ...base.env,
      get: (key: string) => (key === 'CORAL_CUSTODY_EPOCH' ? (wrapped ? '1' : undefined) : base.env.get(key)),
    },
  };
  const kill = vi.spyOn(runtime.process, 'kill');
  const authority = createProxyAppServerHostAuthority(runtime);
  const siblingAuthority = createProxyAppServerHostAuthority(runtime);
  const hosts: { providerPid: number; wrapperPid: number; close(): void }[] = [];
  const openHost = async (id: string, owner: typeof authority) => {
    const pidFile = join(root, `${id}.pid`);
    const scope = owner.beginOperation({ jobId: id, operationId: `operation-${id}` });
    scope.selectCancellationMode('shared-acknowledged-interrupt');
    const session = await scope.openSession(
      {
        provider: 'codex',
        initializeRequest: { method: 'initialize', params: { clientInfo: { name: 'coral', version: 'unknown' } } },
        command: process.execPath,
        args: [fileURLToPath(new URL('../../fixtures/stubborn-provider.mjs', import.meta.url)), pidFile],
        cwd: fixtureCanonicalWorkDir(process.cwd()),
        leaseMode: 'shared',
        idleRetirement: 'unleased',
      },
      { jobId: id },
    );
    const host = {
      providerPid: Number(readFileSync(pidFile, 'utf8')),
      wrapperPid: owner.rootIdentity(session.hostRef)!.pid,
      close: session.close,
    };
    hosts.push(host);
    return { ...host, session };
  };
  try {
    const retiring = await openHost('retiring', authority);
    const sibling = await openHost('sibling', siblingAuthority);
    if (loseWrapper) {
      process.kill(retiring.wrapperPid, 'SIGKILL');
      await delay(100);
      expect(alive(retiring.providerPid)).toBe(true);
      expect(authority.listProviderHosts()).toHaveLength(1);
      expect(siblingAuthority.listProviderHosts()).toHaveLength(1);
    }
    retiring.close();
    await vi.waitFor(
      () => {
        expect(alive(retiring.providerPid)).toBe(false);
        expect(authority.listProviderHosts()).toHaveLength(0);
      },
      { timeout: loseWrapper ? 12_000 : 8_000, interval: 100 },
    );
    expect(siblingAuthority.listProviderHosts()).toHaveLength(1);
    expect(alive(sibling.providerPid)).toBe(true);
    expect(alive(sibling.wrapperPid)).toBe(true);
    await expect(sibling.session.session.rpc('initialize', {})).resolves.toEqual({});
    expect(kill.mock.calls.every(([pid]) => pid > 0)).toBe(true);
  } finally {
    for (const host of hosts) {
      host.close();
      if (alive(host.providerPid)) process.kill(host.providerPid, 'SIGKILL');
    }
    await delay(100);
    for (const host of hosts) if (alive(host.wrapperPid)) process.kill(host.wrapperPid, 'SIGKILL');
    kill.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
