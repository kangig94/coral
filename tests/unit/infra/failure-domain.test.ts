import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireFailureDomainRoot,
  createFailureDomain,
  enterFailureDomain,
  enterPayloadDomain,
  inheritedFailureDomainRoot,
  removeFailureDomain,
  readRecentFailureDomainRefusals,
  retainFailureDomainRefusals,
} from '#src/infra/failure-domain.js';

const io = vi.hoisted(() => ({
  read: vi.fn(),
  realpath: vi.fn(),
  mkdir: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  busctl: vi.fn(),
  calls: [] as string[],
  group: '/terminal.scope',
  controllers: 'memory pids',
}));
vi.mock('node:fs', () => ({
  readFileSync: io.read,
  realpathSync: io.realpath,
  mkdirSync: io.mkdir,
  writeFileSync: io.write,
  rmdirSync: io.remove,
}));
vi.mock('node:child_process', () => ({ spawnSync: io.busctl }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const rootPath = '/sys/fs/cgroup/app.slice/app-coral-test.scope';
const root = { kind: 'placed', root: rootPath } as const;
const leaf = `${rootPath}/host-test`;
const unit = 'app-coral-test.scope';
const supervisor = 'supervisor-test';
const result = (status: number | null = 0, stdout = '', stderr = '', signal: string | null = null) => ({
  status,
  stdout,
  stderr,
  signal,
});

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  io.group = '/terminal.scope';
  io.controllers = 'memory pids';
  io.calls.length = 0;
  io.realpath.mockImplementation((path: string) => path);
  io.read.mockImplementation((path: string) => {
    if (path === '/proc/self/cgroup') return `0::${io.group}\n`;
    if (path.endsWith('/cgroup.controllers')) return 'memory pids';
    if (path.endsWith('/cgroup.subtree_control')) return io.controllers;
    if (path === '/proc/self/oom_score_adj') return '0';
    throw Object.assign(new Error(path), { code: 'ENOENT' });
  });
  io.mkdir.mockImplementation((path: string) => io.calls.push(`mkdir ${path}`));
  io.write.mockImplementation((path: string, value: string) => {
    io.calls.push(`write ${path} ${value}`);
    if (path.endsWith('/cgroup.procs')) io.group = path.slice('/sys/fs/cgroup'.length, -'/cgroup.procs'.length);
  });
  io.busctl.mockImplementation(() => {
    io.group = '/app.slice/app-coral-test.scope';
    return result();
  });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks();
});

describe('failure-domain root disposition', () => {
  it.each(['darwin', 'win32'])('reports %s unavailable without attempting placement', async (value) => {
    Object.defineProperty(process, 'platform', { ...platform, value });
    await expect(acquireFailureDomainRoot(unit, supervisor)).resolves.toEqual({
      kind: 'unavailable',
      reason: `unsupported-platform:${value}:requires-linux-cgroup-v2`,
    });
    expect(io.busctl).not.toHaveBeenCalled();
    expect(inheritedFailureDomainRoot({})).toEqual({
      kind: 'unavailable',
      reason: `unsupported-platform:${value}:requires-linux-cgroup-v2`,
    });
  });

  it('reports cgroup v1 unavailable', async () => {
    io.read.mockReturnValue('2:memory:/terminal.scope\n');
    await expect(acquireFailureDomainRoot(unit, supervisor)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'cgroup-v2-unavailable',
    });
    expect(io.busctl).not.toHaveBeenCalled();
  });

  it('reports missing v2 controls unavailable', async () => {
    io.read.mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'ENOENT' });
    });
    await expect(acquireFailureDomainRoot(unit, supervisor)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'cgroup-v2-unavailable',
    });
  });

  it.each([
    ['ENOENT', 'unavailable'],
    ['ETIMEDOUT', 'unknown'],
  ])('classifies busctl %s as %s', async (code, kind) => {
    io.busctl.mockReturnValue({ ...result(null), error: Object.assign(new Error(), { code }) });
    await expect(acquireFailureDomainRoot(unit, supervisor)).resolves.toEqual({
      kind,
      reason: code === 'ENOENT' ? 'busctl-not-found' : `busctl-failed:${code}`,
    });
    expect(io.busctl.mock.calls[0]?.[2]).toMatchObject({ timeout: expect.any(Number), killSignal: 'SIGKILL' });
    expect(io.busctl.mock.calls[0]?.[2].timeout).toBeLessThanOrEqual(2000);
  });

  it('reports nonzero busctl unavailable', async () => {
    io.busctl.mockReturnValue(result(1, '', 'connection refused'));
    await expect(acquireFailureDomainRoot(unit, supervisor)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'busctl-nonzero',
    });
  });

  it('reports signalled busctl unknown', async () => {
    io.busctl.mockReturnValue(result(null, '', '', 'SIGKILL'));
    await expect(acquireFailureDomainRoot(unit, supervisor)).resolves.toEqual({
      kind: 'unknown',
      reason: 'busctl-signalled',
    });
  });

  it('requires observed placement after successful busctl', async () => {
    io.busctl.mockReturnValue(result());
    await expect(acquireFailureDomainRoot(unit, supervisor)).resolves.toEqual({
      kind: 'unknown',
      reason: 'placement-unobserved',
    });
  });

  it.each(['mkdir', 'enter'] as const)('classifies failed supervisor %s as placement failure', async (stage) => {
    if (stage === 'mkdir')
      io.mkdir.mockImplementation(() => {
        throw Object.assign(new Error(), { code: 'EACCES' });
      });
    else
      io.write.mockImplementation(() => {
        throw Object.assign(new Error(), { code: 'EPERM' });
      });
    await expect(acquireFailureDomainRoot(unit, supervisor)).resolves.toEqual({
      kind: 'unknown',
      reason: `supervisor-placement-failed:${stage === 'mkdir' ? 'EACCES' : 'EPERM'}`,
    });
    expect(io.write.mock.calls.some(([path]) => String(path).endsWith('/cgroup.subtree_control'))).toBe(false);
  });

  it('enters the supervisor leaf before enabling controllers', async () => {
    await expect(acquireFailureDomainRoot(unit, supervisor)).resolves.toEqual(root);
    expect(io.busctl.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['Slice', 's', 'app.slice']));
    expect(io.calls).toEqual([
      `mkdir ${rootPath}/${supervisor}`,
      `write ${rootPath}/${supervisor}/cgroup.procs ${process.pid}`,
      `write ${rootPath}/cgroup.subtree_control +memory +pids`,
    ]);
  });

  it('retries attachment controller enabling after the concurrent creator leaves the root', async () => {
    let creatorInRoot = true;
    const events: string[] = [];
    io.controllers = '';
    io.busctl
      .mockReturnValueOnce(result(1, '', 'Unit already exists'))
      .mockReturnValueOnce(result(0, 'o "/unit/path"'))
      .mockReturnValueOnce(result(0, 's "/app.slice/app-coral-test.scope"'))
      .mockImplementationOnce(() => {
        io.group = `/app.slice/${unit}/supervisor-b`;
        return result();
      });
    io.write.mockImplementation((path: string) => {
      if (path !== `${rootPath}/cgroup.subtree_control`) throw new Error(`Unexpected write: ${path}`);
      if (creatorInRoot) {
        events.push('B:controller-write-busy');
        queueMicrotask(() => {
          creatorInRoot = false;
          events.push('A:left-root');
        });
        throw Object.assign(new Error('Creator A still occupies root'), { code: 'EBUSY' });
      }
      events.push('B:controllers-enabled');
      io.controllers = 'memory pids';
    });
    await expect(acquireFailureDomainRoot(unit, 'supervisor-b')).resolves.toEqual(root);
    expect(events).toEqual(['B:controller-write-busy', 'A:left-root', 'B:controllers-enabled']);
  });

  it('exhausts the original acquisition deadline when controller enabling stays busy', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    io.busctl.mockImplementation(() => {
      io.group = `/app.slice/${unit}`;
      now = 1_990;
      return result();
    });
    io.write.mockImplementation((path: string) => {
      if (path.endsWith('/cgroup.procs')) io.group = `/app.slice/${unit}/${supervisor}`;
      else {
        queueMicrotask(() => {
          now = 2_000;
        });
        throw Object.assign(new Error('Root remains occupied'), { code: 'EBUSY' });
      }
    });
    await expect(acquireFailureDomainRoot(unit, supervisor)).resolves.toEqual({
      kind: 'unknown',
      reason: 'controllers-not-enabled',
    });
    expect(now).toBe(2_000);
    expect(io.busctl).toHaveBeenCalledTimes(1);
  });

  it('requires both controllers to report placed', async () => {
    io.controllers = 'memory';
    await expect(acquireFailureDomainRoot(unit, supervisor)).resolves.toEqual({
      kind: 'unknown',
      reason: 'controllers-not-enabled',
    });
  });

  it.each(['Unit already exists', 'Unit was already loaded or has a fragment file.'])(
    'attaches to an existing unit: %s',
    async (message) => {
      io.busctl
        .mockReturnValueOnce(result(1, '', message))
        .mockReturnValueOnce(result(0, 'o "/unit/path"'))
        .mockReturnValueOnce(result(0, 's "/app.slice/app-coral-test.scope"'))
        .mockImplementationOnce(() => {
          io.group = `/app.slice/${unit}/${supervisor}`;
          return result();
        });
      await expect(acquireFailureDomainRoot(unit, supervisor)).resolves.toEqual(root);
      expect(io.busctl.mock.calls[2]?.[1]).toContain('org.freedesktop.systemd1.Scope');
      expect(io.busctl.mock.calls[3]?.[1]).toContain('AttachProcessesToUnit');
      expect(io.busctl.mock.calls[3]?.[1]).toContain(`/${supervisor}`);
    },
  );

  it.each([
    ['nonzero', result(1), 'unavailable'],
    ['signalled', result(null, '', '', 'SIGKILL'), 'unknown'],
    ['timed out', { ...result(null), error: Object.assign(new Error(), { code: 'ETIMEDOUT' }) }, 'unknown'],
  ])('classifies an attachment that is %s', async (_label, attachment, kind) => {
    io.busctl
      .mockReturnValueOnce(result(1, '', 'Unit already exists'))
      .mockReturnValueOnce(result(0, 'o "/unit/path"'))
      .mockReturnValueOnce(result(0, 's "/app.slice/app-coral-test.scope"'))
      .mockReturnValueOnce(attachment);
    await expect(acquireFailureDomainRoot(unit, supervisor)).resolves.toEqual({ kind, reason: 'attach-failed' });
  });

  it.each([
    ['GetUnit', result(1), 'unavailable', 'busctl-get-unit-failed'],
    ['GetUnit', result(null, '', '', 'SIGKILL'), 'unknown', 'busctl-get-unit-failed'],
    ['ControlGroup', result(1), 'unavailable', 'busctl-control-group-failed'],
    ['ControlGroup', result(null, '', '', 'SIGKILL'), 'unknown', 'busctl-control-group-failed'],
  ])('classifies failed %s evidence', async (step, response, kind, reason) => {
    io.busctl.mockReturnValueOnce(result(1, '', 'Unit already exists'));
    if (step === 'ControlGroup') io.busctl.mockReturnValueOnce(result(0, 'o "/unit/path"'));
    io.busctl.mockReturnValueOnce(response);
    await expect(acquireFailureDomainRoot(unit, supervisor)).resolves.toEqual({ kind, reason });
  });

  it('preserves inherited unknown diagnostics', () => {
    expect(
      inheritedFailureDomainRoot({
        CORAL_FAILURE_DOMAIN_DISPOSITION: 'unknown',
        CORAL_FAILURE_DOMAIN_REASON: 'ETIMEDOUT',
      }),
    ).toEqual({ kind: 'unknown', reason: 'ETIMEDOUT' });
    expect(inheritedFailureDomainRoot({})).toMatchObject({ kind: 'unavailable' });
  });

  it('verifies inherited placement and controllers', () => {
    const env = { CORAL_FAILURE_DOMAIN_ROOT: rootPath };
    expect(inheritedFailureDomainRoot(env)).toEqual({ kind: 'unknown', reason: 'placement-unobserved' });
    io.group = '/app.slice/app-coral-test.scope/coordinator-test';
    expect(inheritedFailureDomainRoot(env)).toEqual(root);
    io.controllers = 'pids';
    expect(inheritedFailureDomainRoot(env)).toEqual({ kind: 'unknown', reason: 'controllers-not-enabled' });
  });
});

describe('failure-domain leaf authorization', () => {
  beforeEach(() => {
    io.group = '/app.slice/app-coral-test.scope/coordinator-test';
  });

  it.each([
    rootPath,
    '/sys/fs/cgroup/foreign.scope/host',
    `${rootPath}/../foreign.scope/host`,
    `${rootPath}-sibling/host`,
  ])('refuses entry and removal outside the inherited root: %s', (path) => {
    expect(enterFailureDomain(root, path)).toEqual({ kind: 'refused', errno: 'EPERM' });
    expect(removeFailureDomain(root, path)).toEqual({ kind: 'refused', errno: 'EPERM' });
    expect(io.write).not.toHaveBeenCalled();
    expect(io.remove).not.toHaveBeenCalled();
  });

  it.each(['../foreign', 'set/../../foreign', '/absolute', '.', 'set//host'])(
    'refuses invalid leaf name %s',
    (name) => {
      expect(createFailureDomain(root, name)).toEqual({ kind: 'refused', errno: 'EPERM' });
      expect(io.mkdir).not.toHaveBeenCalled();
      expect(io.write).not.toHaveBeenCalled();
    },
  );

  it('refuses a symlink into another unit', () => {
    io.realpath.mockImplementation((path: string) => (path === leaf ? '/sys/fs/cgroup/foreign.scope/host' : path));
    expect(enterFailureDomain(root, leaf)).toEqual({ kind: 'refused', errno: 'EPERM' });
    expect(io.write).not.toHaveBeenCalled();
  });

  it('refuses a root not inherited by this process', () => {
    io.group = '/foreign.scope/leaf';
    expect(createFailureDomain(root, 'host')).toEqual({ kind: 'refused', errno: 'EPERM' });
    expect(io.mkdir).not.toHaveBeenCalled();
    expect(io.write).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'unknown'] as const)('refuses leaf writes when the root is %s', (kind) => {
    const unavailableRoot = { kind, reason: 'not-placed' };
    expect(createFailureDomain(unavailableRoot, 'host')).toEqual({ kind: 'refused', errno: 'EPERM' });
    expect(enterFailureDomain(unavailableRoot, leaf)).toEqual({ kind: 'refused', errno: 'EPERM' });
    expect(removeFailureDomain(unavailableRoot, leaf)).toEqual({ kind: 'refused', errno: 'EPERM' });
    expect(io.mkdir).not.toHaveBeenCalled();
    expect(io.write).not.toHaveBeenCalled();
    expect(io.remove).not.toHaveBeenCalled();
  });

  it('enables controllers on every internal node before creating its children', () => {
    expect(createFailureDomain(root, 'set-test/containment/host-test', true)).toEqual({
      kind: 'created',
      path: `${rootPath}/set-test/containment/host-test`,
    });
    expect(io.calls).toEqual([
      `write ${rootPath}/cgroup.subtree_control +memory +pids`,
      `mkdir ${rootPath}/set-test`,
      `write ${rootPath}/set-test/cgroup.subtree_control +memory +pids`,
      `mkdir ${rootPath}/set-test/containment`,
      `write ${rootPath}/set-test/containment/cgroup.subtree_control +memory +pids`,
      `mkdir ${rootPath}/set-test/containment/host-test`,
      `write ${rootPath}/set-test/containment/host-test/memory.oom.group 1`,
    ]);
  });

  it('retains refusal observation times with their exact subjects and errno', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_123);
    io.mkdir.mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'EACCES' });
    });
    expect(createFailureDomain(root, 'coordinator-refused')).toEqual({ kind: 'refused', errno: 'EACCES' });
    io.write.mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'EPERM' });
    });
    now.mockReturnValue(1_700_000_000_456);
    expect(enterFailureDomain(root, leaf)).toEqual({ kind: 'refused', errno: 'EPERM' });
    expect(readRecentFailureDomainRefusals()).toEqual(
      expect.arrayContaining([
        { operation: 'create', subject: 'coordinator-refused', errno: 'EACCES', observedAt: 1_700_000_000_123 },
        { operation: 'enter', subject: leaf, errno: 'EPERM', observedAt: 1_700_000_000_456 },
      ]),
    );
    const before = readRecentFailureDomainRefusals();
    createFailureDomain({ kind: 'unavailable', reason: 'busctl-not-found' }, 'unplaced');
    expect(readRecentFailureDomainRefusals()).toEqual(before);
  });

  it('keeps diagnostic evidence bounded and deduplicated by operation and subject', () => {
    const refusals = Array.from({ length: 25 }, (_, n) => ({
      operation: 'create' as const,
      subject: `job-${n}`,
      errno: 'EACCES',
      observedAt: 100 + n,
    }));
    retainFailureDomainRefusals(refusals);
    expect(readRecentFailureDomainRefusals()).toEqual(refusals.slice(-20));
    retainFailureDomainRefusals([{ operation: 'create', subject: 'job-24', errno: 'EPERM', observedAt: 125 }]);
    expect(readRecentFailureDomainRefusals()).toHaveLength(20);
    expect(readRecentFailureDomainRefusals().at(-1)).toEqual({
      operation: 'create',
      subject: 'job-24',
      errno: 'EPERM',
      observedAt: 125,
    });
  });

  it('does not claim OOM marking succeeded when entry succeeded', () => {
    io.write.mockImplementation((path: string) => {
      if (path.endsWith('/memory.oom.group') || path.endsWith('/oom_score_adj'))
        throw Object.assign(new Error(), { code: 'EPERM' });
    });
    expect(enterPayloadDomain(root, leaf)).toEqual({ kind: 'entered' });
  });

  it('enters before marking the payload', () => {
    expect(enterPayloadDomain(root, leaf)).toEqual({ kind: 'entered' });
    expect(io.calls.slice(0, 2)).toEqual([
      `write ${leaf}/cgroup.procs ${process.pid}`,
      `write ${leaf}/memory.oom.group 1`,
    ]);
  });

  it.each([true, false])('raises a low Linux payload score when placement is available: %s', (placed) => {
    let score = 0;
    const read = io.read.getMockImplementation()!;
    io.read.mockImplementation((path: string) => (path === '/proc/self/oom_score_adj' ? String(score) : read(path)));
    const write = io.write.getMockImplementation()!;
    io.write.mockImplementation((path: string, value: string) => {
      if (path === '/proc/self/oom_score_adj') score = Number(value);
      else write(path, value);
    });
    const placement = placed ? root : { kind: 'unavailable' as const, reason: 'busctl-not-found' };
    enterPayloadDomain(placement, placed ? leaf : null);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeGreaterThanOrEqual(100);
  });

  it('preserves an already-higher Linux payload score', () => {
    io.read.mockReturnValue('800');
    enterPayloadDomain({ kind: 'unavailable', reason: 'busctl-not-found' }, null);
    expect(io.calls).toEqual(['write /proc/self/oom_score_adj 800']);
  });
});
