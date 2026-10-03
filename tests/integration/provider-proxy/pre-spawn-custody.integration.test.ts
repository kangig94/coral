import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it, vi } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import { createProxyAppServerHostAuthority } from '#src/provider-proxy/provider-root-authority.js';
import { readCustodyLedger } from '#src/store/custody-ledger.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';

it.each(['expired-binding', 'token-mismatch'])(
  'releases the only root slot after %s and acquires again on the same pool',
  async (failure) => {
    const root = mkdtempSync(join(tmpdir(), 'coral-pre-spawn-custody-'));
    const wrapperPath = join(root, 'coral-durable-wrapper.cjs');
    await build({
      entryPoints: ['src/runtime/durable-cli-wrapper.ts'],
      outfile: wrapperPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['node:*', '@lydell/node-pty'],
      banner: { js: 'var __importMetaUrl=require("url").pathToFileURL(__filename).href;' },
      define: { 'import.meta.url': '__importMetaUrl' },
    });
    const runtime = createRealRuntime('prod', { baseDir: root });
    const get = runtime.env.get.bind(runtime.env);
    const epochKey = '00000000-0000-4000-8000-000000000001:1';
    vi.spyOn(runtime.env, 'get').mockImplementation((key) =>
      key === 'CORAL_CUSTODY_EPOCH' ? '1' : key === 'CORAL_CUSTODY_EPOCH_KEY' ? epochKey : get(key),
    );
    const now = vi
      .spyOn(runtime.time, 'now')
      .mockImplementation(() => Date.now() - (failure === 'expired-binding' ? 20_000 : 0));
    const spawn = runtime.process.spawn.bind(runtime.process);
    const children: ChildProcessLike[] = [];
    let failToken = failure === 'token-mismatch';
    vi.spyOn(runtime.process, 'spawn').mockImplementation((options) => {
      const args = [wrapperPath, ...options.args.slice(1)];
      if (failToken) args[args.length - 1] = '--coral-custody-token=00000000-0000-4000-8000-000000000099';
      const child = spawn({ ...options, args });
      children.push(child);
      return child;
    });
    const authority = createProxyAppServerHostAuthority(runtime);
    const scope = authority.beginOperation({ jobId: 'job', operationId: 'operation' });
    scope.selectCancellationMode('shared-acknowledged-interrupt');
    const marker = join(root, 'provider.pid');
    const spec = {
      provider: 'codex' as const,
      initializeRequest: { method: 'initialize', params: {} },
      command: process.execPath,
      args: [fileURLToPath(new URL('../../fixtures/stubborn-provider.mjs', import.meta.url)), marker],
      cwd: fixtureCanonicalWorkDir(process.cwd()),
      leaseMode: 'shared' as const,
      idleRetirement: 'unleased' as const,
    };
    let close = () => {};
    try {
      await expect(scope.openSession(spec)).rejects.toThrow();
      expect(existsSync(marker)).toBe(false);
      expect(readCustodyLedger(runtime, runtime.paths.coral.coordinator.runDir)).toMatchObject([
        { kind: 'bound', intent: { epochKey } },
      ]);
      await vi.waitFor(() => expect(authority.listProviderHosts()).toHaveLength(0), { timeout: 3_000 });
      now.mockRestore();
      failToken = false;
      const session = await scope.openSession(spec);
      close = session.close;
      expect(existsSync(marker)).toBe(true);
      await expect(session.session.rpc('initialize', {})).resolves.toEqual({});
      close();
      await vi.waitFor(() => expect(authority.listProviderHosts()).toHaveLength(0), { timeout: 8_000 });
    } finally {
      close();
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
