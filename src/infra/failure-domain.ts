import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export type FailureDomainRoot =
  | Readonly<{ kind: 'placed'; root: string }>
  | Readonly<{ kind: 'unavailable'; reason: string }>
  | Readonly<{ kind: 'unknown'; reason: string }>;
export type DomainEntry = Readonly<{ kind: 'entered' }> | Readonly<{ kind: 'refused'; errno: string }>;
export type DomainCreation = Readonly<{ kind: 'created'; path: string }> | Readonly<{ kind: 'refused'; errno: string }>;
export type DomainRemoval = Readonly<{ kind: 'removed' }> | Readonly<{ kind: 'refused'; errno: string }>;

export const PAYLOAD_OOM_SCORE_ADJ = 500;
const CGROUP_ROOT = '/sys/fs/cgroup';
const ACQUISITION_TIMEOUT_MS = 2_000;
const MAX_RECENT_FAILURE_DOMAIN_REFUSALS = 20;

export type FailureDomainRefusal = Readonly<{
  operation: 'create' | 'enter';
  subject: string;
  errno: string;
  observedAt: number;
}>;
const recentFailureDomainRefusalHistory: FailureDomainRefusal[] = [];

/** Callers must not be able to mutate retained diagnostic evidence. */
export function readRecentFailureDomainRefusals(): readonly FailureDomainRefusal[] {
  return [...recentFailureDomainRefusalHistory];
}

/** Diagnostic evidence must remain bounded within each process. */
export function retainFailureDomainRefusals(refusals: readonly FailureDomainRefusal[]): void {
  for (const refusal of refusals) {
    const existing = recentFailureDomainRefusalHistory.findIndex(
      (entry) => entry.operation === refusal.operation && entry.subject === refusal.subject,
    );
    if (existing >= 0) recentFailureDomainRefusalHistory.splice(existing, 1);
    recentFailureDomainRefusalHistory.push(Object.freeze({ ...refusal }));
    if (recentFailureDomainRefusalHistory.length > MAX_RECENT_FAILURE_DOMAIN_REFUSALS)
      recentFailureDomainRefusalHistory.shift();
  }
}

function refuseFailureDomain(
  root: FailureDomainRoot,
  operation: FailureDomainRefusal['operation'],
  subject: string,
  code: string,
): Extract<DomainEntry, { kind: 'refused' }> {
  if (root.kind === 'placed')
    retainFailureDomainRefusals([{ operation, subject, errno: code, observedAt: Date.now() }]);
  return { kind: 'refused', errno: code };
}

function errno(error: unknown): string {
  return error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'EIO';
}

function currentGroup(): string | null {
  const entry = readFileSync('/proc/self/cgroup', 'utf8')
    .split('\n')
    .find((line) => line.startsWith('0::/'));
  return entry === undefined ? null : resolve(CGROUP_ROOT, `.${entry.slice(3)}`);
}

function below(root: string, path: string): boolean {
  const tail = relative(root, path);
  return tail !== '' && tail !== '..' && !tail.startsWith('../') && !isAbsolute(tail);
}

function verifiedPath(root: FailureDomainRoot, path: string, allowRoot = false): string {
  if (
    root.kind !== 'placed' ||
    !below(CGROUP_ROOT, root.root) ||
    (!below(root.root, resolve(path)) && !(allowRoot && path === root.root))
  ) {
    throw Object.assign(new Error('Foreign failure domain'), { code: 'EPERM' });
  }
  if (
    realpathSync(root.root) !== root.root ||
    (!below(root.root, realpathSync(path)) && !(allowRoot && path === root.root))
  ) {
    throw Object.assign(new Error('Foreign failure domain'), { code: 'EPERM' });
  }
  const current = currentGroup();
  if (current !== root.root && (current === null || !below(root.root, current))) {
    throw Object.assign(new Error('Root is not inherited'), { code: 'EPERM' });
  }
  return path;
}

/** An inherited address authorizes leaves only while membership and both controllers are observed. */
export function inheritedFailureDomainRoot(env: NodeJS.ProcessEnv = process.env): FailureDomainRoot {
  if (process.platform !== 'linux')
    return { kind: 'unavailable', reason: `unsupported-platform:${process.platform}:requires-linux-cgroup-v2` };
  const root = env.CORAL_FAILURE_DOMAIN_ROOT;
  if (root === undefined) {
    return env.CORAL_FAILURE_DOMAIN_DISPOSITION === 'unknown'
      ? { kind: 'unknown', reason: env.CORAL_FAILURE_DOMAIN_REASON ?? 'placement-unobserved' }
      : { kind: 'unavailable', reason: env.CORAL_FAILURE_DOMAIN_REASON ?? 'root-not-inherited' };
  }
  try {
    const current = currentGroup();
    if (!below(CGROUP_ROOT, root) || realpathSync(root) !== root || current === null || !below(root, current)) {
      return { kind: 'unknown', reason: 'placement-unobserved' };
    }
    const controllers = readFileSync(join(root, 'cgroup.subtree_control'), 'utf8').split(/\s+/);
    return controllers.includes('memory') && controllers.includes('pids')
      ? { kind: 'placed', root }
      : { kind: 'unknown', reason: 'controllers-not-enabled' };
  } catch {
    return { kind: 'unknown', reason: 'placement-unobserved' };
  }
}

/** Creation is confined to the inherited root; refusal never authorizes a foreign write. */
export function createFailureDomain(root: FailureDomainRoot, name: string, payload = false): DomainCreation {
  try {
    if (
      root.kind !== 'placed' ||
      isAbsolute(name) ||
      name.split('/').some((part) => part === '..' || part === '.' || part === '')
    ) {
      return refuseFailureDomain(root, 'create', name, 'EPERM');
    }
    let parent = root.root;
    const parts = name.split('/');
    for (const part of parts) {
      const path = join(parent, part);
      // Validate the parent before mkdir; delegated ownership alone does not authorize foreign paths.
      if (parent === root.root) verifiedPath(root, root.root, true);
      else verifiedPath(root, parent);
      writeFileSync(join(parent, 'cgroup.subtree_control'), '+memory +pids');
      try {
        mkdirSync(path);
      } catch (error) {
        if (errno(error) !== 'EEXIST') throw error;
      }
      verifiedPath(root, path);
      parent = path;
    }
    if (payload) writeFileSync(join(parent, 'memory.oom.group'), '1');
    return { kind: 'created', path: parent };
  } catch (error) {
    return refuseFailureDomain(root, 'create', name, errno(error));
  }
}

/** A refused entry leaves the process in its current domain. */
export function enterFailureDomain(root: FailureDomainRoot, path: string): DomainEntry {
  try {
    verifiedPath(root, path);
    writeFileSync(join(path, 'cgroup.procs'), String(process.pid));
    return { kind: 'entered' };
  } catch (error) {
    return refuseFailureDomain(root, 'enter', path, errno(error));
  }
}

/** `entered` confirms leaf entry only; it does not confirm that OOM marking succeeded. */
export function enterPayloadDomain(root: FailureDomainRoot, leaf: string | null): DomainEntry {
  const entry = leaf === null ? { kind: 'refused' as const, errno: 'ENOENT' } : enterFailureDomain(root, leaf);
  if (entry.kind === 'entered' && leaf !== null) {
    try {
      writeFileSync(join(leaf, 'memory.oom.group'), '1');
    } catch {
      /* Placement remains valid if marking is refused. */
    }
  }
  if (process.platform === 'linux') {
    try {
      const path = '/proc/self/oom_score_adj';
      const current = Number(readFileSync(path, 'utf8'));
      writeFileSync(path, String(Math.max(current, PAYLOAD_OOM_SCORE_ADJ)));
    } catch {
      return entry;
    }
  }
  return entry;
}

/** Removal may refuse populated leaves and never addresses the root itself or a foreign domain. */
export function removeFailureDomain(root: FailureDomainRoot, path: string): DomainRemoval {
  try {
    verifiedPath(root, path);
    rmdirSync(path);
    return { kind: 'removed' };
  } catch (error) {
    return { kind: 'refused', errno: errno(error) };
  }
}

type NamespaceUnitAcquisition =
  | Readonly<{ kind: 'created' }>
  | Readonly<{ kind: 'attached'; root: string }>
  | Exclude<FailureDomainRoot, { kind: 'placed' }>;

type SupervisorPlacement =
  | Readonly<{ kind: 'observed'; root: string }>
  | Extract<FailureDomainRoot, { kind: 'unknown' }>;

function acquireNamespaceUnit(unit: string, supervisorLeaf: string, deadline: number): NamespaceUnitAcquisition {
  const call = (args: string[]) => {
    if (performance.now() >= deadline)
      return {
        status: null,
        signal: 'SIGKILL',
        error: Object.assign(new Error('Acquisition timed out'), { code: 'ETIMEDOUT' }),
        stdout: '',
        stderr: '',
      };
    return spawnSync('busctl', ['--user', ...args], {
      encoding: 'utf8',
      timeout: Math.max(1, Math.floor(deadline - performance.now())),
      killSignal: 'SIGKILL',
    });
  };
  const manager = ['call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager'];
  const created = call([
    ...manager,
    'StartTransientUnit',
    'ssa(sv)a(sa(sv))',
    unit,
    'fail',
    '3',
    'Slice',
    's',
    'app.slice',
    'PIDs',
    'au',
    '1',
    String(process.pid),
    'Delegate',
    'b',
    'true',
    '0',
  ]);

  if (created.status !== 0) {
    if (created.error !== undefined)
      return errno(created.error) === 'ENOENT'
        ? { kind: 'unavailable', reason: 'busctl-not-found' }
        : { kind: 'unknown', reason: `busctl-failed:${errno(created.error)}` };
    if (created.signal !== null) return { kind: 'unknown', reason: 'busctl-signalled' };
    if (!/already exists|already loaded or has a fragment file/.test(created.stderr))
      return { kind: 'unavailable', reason: 'busctl-nonzero' };
    const found = call([...manager, 'GetUnit', 's', unit]);
    if (found.status !== 0)
      return {
        kind: found.error !== undefined || found.signal !== null ? 'unknown' : 'unavailable',
        reason: 'busctl-get-unit-failed',
      };
    const object = found.stdout.match(/"([^"]+)"/)?.[1];
    if (object === undefined) return { kind: 'unknown', reason: 'placement-unobserved' };
    const group = call([
      'get-property',
      'org.freedesktop.systemd1',
      object,
      'org.freedesktop.systemd1.Scope',
      'ControlGroup',
    ]);
    const path = group.stdout?.match(/"(\/[^"]+)"/)?.[1];
    if (group.status !== 0)
      return {
        kind: group.error !== undefined || group.signal !== null ? 'unknown' : 'unavailable',
        reason: 'busctl-control-group-failed',
      };
    if (path === undefined) return { kind: 'unknown', reason: 'placement-unobserved' };
    const root = resolve(CGROUP_ROOT, `.${path}`);
    if (!below(CGROUP_ROOT, root) || !root.endsWith('/' + unit))
      return { kind: 'unknown', reason: 'placement-unobserved' };
    try {
      mkdirSync(join(root, supervisorLeaf));
    } catch (error) {
      if (errno(error) !== 'EEXIST')
        return { kind: 'unknown', reason: `supervisor-leaf-create-failed:${errno(error)}` };
    }
    const attached = call([
      ...manager,
      'AttachProcessesToUnit',
      'ssau',
      unit,
      '/' + supervisorLeaf,
      '1',
      String(process.pid),
    ]);
    if (attached.status !== 0)
      return {
        kind: attached.error !== undefined || attached.signal !== null ? 'unknown' : 'unavailable',
        reason: 'attach-failed',
      };
    return { kind: 'attached', root };
  }
  return { kind: 'created' };
}

async function observeSupervisorPlacement(
  unit: string,
  supervisorLeaf: string,
  root: string | null,
  deadline: number,
): Promise<SupervisorPlacement> {
  try {
    let observed = currentGroup();
    while (root === null && observed !== null && !observed.endsWith('/' + unit) && performance.now() < deadline) {
      await sleep(Math.min(10, Math.max(1, deadline - performance.now())));
      observed = currentGroup();
    }
    if (root === null && observed !== null && observed.endsWith('/' + unit)) {
      root = observed;
      mkdirSync(join(root, supervisorLeaf));
      writeFileSync(join(root, supervisorLeaf, 'cgroup.procs'), String(process.pid));
    }
    if (root === null || currentGroup() !== join(root, supervisorLeaf) || performance.now() >= deadline)
      return { kind: 'unknown', reason: 'placement-unobserved' };
    return { kind: 'observed', root };
  } catch (error) {
    return { kind: 'unknown', reason: `supervisor-placement-failed:${errno(error)}` };
  }
}

async function enableRootControllers(root: string, deadline: number): Promise<FailureDomainRoot> {
  while (performance.now() < deadline) {
    try {
      writeFileSync(join(root, 'cgroup.subtree_control'), '+memory +pids');
      const controllers = readFileSync(join(root, 'cgroup.subtree_control'), 'utf8').split(/\s+/);
      if (controllers.includes('memory') && controllers.includes('pids') && performance.now() < deadline)
        return { kind: 'placed', root };
    } catch {
      // Another supervisor may still occupy the root under the no-internal-process rule.
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await sleep(Math.min(10, remaining));
  }
  return { kind: 'unknown', reason: 'controllers-not-enabled' };
}

/** Only observed placement and enabled controllers within one shared deadline authorize leaves. */
export async function acquireFailureDomainRoot(unit: string, supervisorLeaf: string): Promise<FailureDomainRoot> {
  if (process.platform !== 'linux')
    return { kind: 'unavailable', reason: `unsupported-platform:${process.platform}:requires-linux-cgroup-v2` };
  try {
    if (currentGroup() === null) return { kind: 'unavailable', reason: 'cgroup-v2-unavailable' };
    readFileSync(join(CGROUP_ROOT, 'cgroup.controllers'));
  } catch {
    return { kind: 'unavailable', reason: 'cgroup-v2-unavailable' };
  }
  if (!/^[a-zA-Z0-9_-]+\.scope$/.test(unit) || !/^[a-zA-Z0-9_-]+$/.test(supervisorLeaf)) {
    return { kind: 'unavailable', reason: 'invalid-name' };
  }
  const deadline = performance.now() + ACQUISITION_TIMEOUT_MS;
  const acquired = acquireNamespaceUnit(unit, supervisorLeaf, deadline);
  if (acquired.kind === 'unavailable' || acquired.kind === 'unknown') return acquired;
  const placement = await observeSupervisorPlacement(
    unit,
    supervisorLeaf,
    acquired.kind === 'attached' ? acquired.root : null,
    deadline,
  );
  if (placement.kind === 'unknown') return placement;
  return enableRootControllers(placement.root, deadline);
}
