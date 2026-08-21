import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { hostKeyFromSpec } from '#src/coordinator/live/provider-hosts/state.js';
import {
  canonicalizeWorkDir,
  canonicalWorkDirWireSchema,
  containsWorkDir,
  WorkDirectoryError,
} from '#src/runtime/canonical-work-dir.js';
import type { Principal } from '#src/security/principal.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';

const tempDirs: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-canonical-work-dir-'));
  tempDirs.push(root);
  return root;
}

function catalogSpec(name: 'sessions.create' | 'workflow.run') {
  const spec = rpcCatalog.find((candidate) => candidate.name === name);
  if (spec === undefined) throw new Error(`Missing RPC spec ${name}`);
  return spec;
}

function operator(binding: Principal['binding'] = { kind: 'unbound' }): Principal {
  return {
    subject: 'operator',
    transport: 'test',
    credential: { kind: 'test', id: 'operator' },
    binding,
  };
}

function createPorts() {
  const start = vi.fn<HttpHandlerPorts['sessions']['start']>(async () => ({
    kind: 'provider-session' as const,
    status: 'running' as const,
    jobId: 'job-1',
    sessionId: 'session-1',
  }));
  const execute = vi.fn<HttpHandlerPorts['workflows']['execute']>(async () => ({
    kind: 'decision' as const,
    decision: {
      kind: 'workflow' as const,
      status: 'running' as const,
      jobId: 'workflow-1',
      workflowId: 'workflow-1',
    },
  }));
  const ports = {
    identity: { pluginRoot: '/plugin' },
    coralEnvSnapshot: {},
    admin: { isLaunchFenceActive: () => false },
    sessions: { start },
    workflows: { execute },
  } as unknown as HttpHandlerPorts;
  return { ports, start, execute };
}

afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('canonical work directory transport ingress', () => {
  it('distinguishes descendants from ancestors and separator-confusable siblings', () => {
    const root = canonicalWorkDirWireSchema.parse('/repo');
    expect(containsWorkDir(root, root)).toBe(true);
    expect(containsWorkDir(root, canonicalWorkDirWireSchema.parse('/repo/sub'))).toBe(true);
    expect(containsWorkDir(canonicalWorkDirWireSchema.parse('/repo/sub'), root)).toBe(false);
    expect(containsWorkDir(root, canonicalWorkDirWireSchema.parse('/sibling'))).toBe(false);
    expect(containsWorkDir(root, canonicalWorkDirWireSchema.parse('/repo/..cache'))).toBe(true);
  });

  if (process.platform === 'win32') {
    it('rejects a candidate on a different Windows drive', () => {
      expect(
        containsWorkDir(canonicalWorkDirWireSchema.parse('C:\\repo'), canonicalWorkDirWireSchema.parse('D:\\repo')),
      ).toBe(false);
    });
  }

  it('refuses missing paths and files with an explicit work-directory error', () => {
    const root = tempRoot();
    const file = join(root, 'file.txt');
    writeFileSync(file, 'not a directory');

    for (const workDir of ['missing', file]) {
      try {
        canonicalizeWorkDir(workDir, root);
        expect.fail(`Expected ${workDir} to be rejected`);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(WorkDirectoryError);
        expect(error).toMatchObject({ code: 'invalid_work_directory', workDir, baseDir: root });
      }
    }
  });

  it('validates canonical wire syntax without requiring another filesystem lookup', () => {
    const root = tempRoot();
    const nonexistentAbsolutePath = join(root, 'does-not-exist');

    expect(canonicalWorkDirWireSchema.parse(nonexistentAbsolutePath)).toBe(nonexistentAbsolutePath);
    expect(canonicalWorkDirWireSchema.safeParse('relative/path').success).toBe(false);
    expect(canonicalWorkDirWireSchema.safeParse(`${root}/segment/..`).success).toBe(false);
  });

  it('denies a missing capability before examining a nonexistent project root', async () => {
    const { ports, start } = createPorts();
    const principal: Principal = {
      subject: 'agent',
      transport: 'test',
      credential: { kind: 'test', id: 'agent' },
      binding: { kind: 'unbound' },
    };

    const result = await executeCatalogRequest(
      catalogSpec('sessions.create'),
      { provider: 'codex', prompt: 'hello', projectRoot: join(tempRoot(), 'does-not-exist') },
      ports,
      principal,
    );

    expect(result).toMatchObject({
      kind: 'unary',
      statusCode: 401,
      body: { code: 'missing_capability' },
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('refuses an unresolvable project root before binding authorization or catalog execution', async () => {
    const missingProjectRoot = join(tempRoot(), 'deleted-project');
    const { ports, start } = createPorts();

    const result = await executeCatalogRequest(
      catalogSpec('sessions.create'),
      { provider: 'codex', prompt: 'hello', projectRoot: missingProjectRoot },
      ports,
      operator(),
    );

    expect(
      result,
      'AC11 silent divergence at the pre-authorization catalog boundary: an unresolvable work directory was accepted',
    ).toMatchObject({
      kind: 'unary',
      statusCode: 400,
      body: {
        code: 'invalid_work_directory',
        message: expect.stringContaining(missingProjectRoot),
        detail: { workDir: missingProjectRoot, projectRoot: process.cwd() },
      },
    });
    expect((result as { body?: { message?: string } }).body?.message).toMatch(/ENOENT|no such file or directory/);
    expect(start).not.toHaveBeenCalled();
  });

  it('denies a bound credential when a requested symlink escapes its canonical authority', async () => {
    const root = tempRoot();
    const allowed = join(root, 'allowed');
    const outside = join(root, 'outside');
    const link = join(allowed, 'link');
    mkdirSync(allowed);
    mkdirSync(outside);
    symlinkSync(outside, link, 'dir');
    const boundRoot = canonicalizeWorkDir(allowed, root);
    const { ports, start } = createPorts();

    const result = await executeCatalogRequest(
      catalogSpec('sessions.create'),
      { provider: 'codex', prompt: 'hello', projectRoot: link },
      ports,
      operator({ kind: 'project', root: boundRoot }),
    );

    expect(result).toMatchObject({ kind: 'unary', statusCode: 403, body: { code: 'scope_mismatch' } });
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    ['sessions.create', { provider: 'codex', prompt: 'hello' }],
    ['workflow.run', { expression: 'architect', startPrompt: 'hello', provider: 'codex' }],
  ] as const)('denies a bound credential when %s workDir escapes through a symlink', async (route, body) => {
    const root = tempRoot();
    const allowed = join(root, 'allowed');
    const outside = join(root, 'outside');
    mkdirSync(allowed);
    mkdirSync(outside);
    symlinkSync(outside, join(allowed, 'link'), 'dir');
    const boundRoot = canonicalizeWorkDir(allowed, root);
    const { ports, start, execute } = createPorts();

    const result = await executeCatalogRequest(
      catalogSpec(route),
      { ...body, projectRoot: allowed, workDir: 'link' },
      ports,
      operator({ kind: 'project', root: boundRoot }),
    );

    expect(result).toMatchObject({ kind: 'unary', statusCode: 403, body: { code: 'scope_mismatch' } });
    expect(start).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses one canonical value for session cwd, context, and a narrowed unbound principal', async () => {
    const root = tempRoot();
    const physicalProject = join(root, 'physical-project');
    const selectedProject = join(root, 'selected-project');
    const physicalWorkDir = join(physicalProject, 'physical-work');
    const selectedWorkDir = join(physicalProject, 'selected-work');
    mkdirSync(physicalProject);
    mkdirSync(physicalWorkDir);
    symlinkSync(physicalProject, selectedProject, 'dir');
    symlinkSync(physicalWorkDir, selectedWorkDir, 'dir');
    const { ports, start } = createPorts();

    const result = await executeCatalogRequest(
      catalogSpec('sessions.create'),
      {
        provider: 'codex',
        prompt: 'hello',
        projectRoot: selectedProject,
        workDir: 'selected-work',
      },
      ports,
      operator(),
    );

    expect(result).toMatchObject({ kind: 'unary', statusCode: 201 });
    expect(start).toHaveBeenCalledTimes(1);
    const [, input, ctx] = start.mock.calls[0];
    expect(input.cwd).toBe(realpathSync(physicalWorkDir));
    expect(ctx.projectRoot).toBe(realpathSync(physicalProject));
    expect(ctx.principal.binding).toEqual({ kind: 'project', root: input.cwd });
  });

  it('canonicalizes an explicit workflow workDir relative to the canonical request root', async () => {
    const root = tempRoot();
    const project = join(root, 'project');
    const physicalWorkDir = join(project, 'physical-work');
    const selectedWorkDir = join(project, 'selected-work');
    mkdirSync(project);
    mkdirSync(physicalWorkDir);
    symlinkSync(physicalWorkDir, selectedWorkDir, 'dir');
    const { ports, execute } = createPorts();

    const result = await executeCatalogRequest(
      catalogSpec('workflow.run'),
      {
        expression: 'architect',
        startPrompt: 'hello',
        provider: 'codex',
        projectRoot: project,
        workDir: 'selected-work',
      },
      ports,
      operator(),
    );

    expect(result).toMatchObject({ kind: 'unary', statusCode: 202 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].workDir).toBe(realpathSync(physicalWorkDir));
  });

  it('gives symlink and target spellings the same provider-host identity', () => {
    const root = tempRoot();
    const physical = join(root, 'physical');
    const selected = join(root, 'selected');
    mkdirSync(physical);
    symlinkSync(physical, selected, 'dir');

    const physicalSpec = {
      provider: 'codex',
      command: 'codex',
      args: ['app-server'],
      cwd: canonicalizeWorkDir(physical, root),
      leaseMode: 'shared' as const,
      idleRetirement: 'never' as const,
    };
    const selectedSpec = {
      ...physicalSpec,
      cwd: canonicalizeWorkDir(selected, root),
    };

    expect(hostKeyFromSpec(selectedSpec)).toBe(hostKeyFromSpec(physicalSpec));
  });
});
