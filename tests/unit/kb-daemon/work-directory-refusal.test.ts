import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleKbDaemonExpansionRpcRequest } from '#src/kb-daemon/daemon-main.js';
import { createKbDaemonRequestService } from '#src/kb-daemon/request-service.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const tempDirs: string[] = [];

function missingProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-kb-work-dir-refusal-'));
  tempDirs.push(root);
  return join(root, 'deleted-project');
}

afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('KB daemon work-directory context decoding', () => {
  it('maps an unresolvable request context to the explicit work-directory failure', async () => {
    const projectRoot = missingProjectRoot();
    const service = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime: new SimulationRuntime() });

    const result = await service.read({
      method: 'listPrinciples',
      ctx: {
        projectRoot,
        principal: { subject: 'operator', binding: { kind: 'unbound' } },
      },
    });

    expect(
      result,
      'AC11 silent divergence at the daemon request-context boundary: an unresolvable work directory was accepted',
    ).toMatchObject({
      ok: false,
      code: 'invalid_work_directory',
      message: expect.stringContaining(projectRoot),
      detail: { workDir: projectRoot, projectRoot: process.cwd() },
    });
    if (result.ok) throw new Error('Expected the daemon request context to be refused.');
    expect(result.message).toMatch(/ENOENT|no such file or directory/);
  });

  it('maps an unresolvable expansion context before invoking the daemon host', async () => {
    const projectRoot = missingProjectRoot();
    const expansionRpc = vi.fn(async () => ({ ok: true as const, data: { status: 'equipped' } }));

    const result = await handleKbDaemonExpansionRpcRequest(
      {
        method: 'equipExpansion',
        args: { name: 'vector' },
        ctx: {
          projectRoot,
          principal: { subject: 'operator', binding: { kind: 'unbound' } },
        },
      },
      { expansionRpc },
    );

    expect(
      result,
      'AC11 silent divergence at the daemon expansion-context boundary: an unresolvable work directory was accepted',
    ).toMatchObject({
      ok: false,
      code: 'invalid_work_directory',
      message: expect.stringContaining(projectRoot),
    });
    if (result.ok) throw new Error('Expected the daemon expansion context to be refused.');
    expect(result.message).toMatch(/ENOENT|no such file or directory/);
    expect(expansionRpc).not.toHaveBeenCalled();
  });
});
