import { spawn } from 'node:child_process';
import { createRealRuntime } from '#src/runtime/real.js';
import { join } from 'node:path';
import { launchStandaloneJob } from '#tests/fixtures/failure-domain/standalone-job.js';
import { acquireFailureDomainRoot, createFailureDomain, failureDomainContainment } from '#src/infra/failure-domain.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { reapRecordedContainment, observeRecordedContainment } from '#src/infra/process-containment.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { spawnProviderServerTransport } from '#src/providers/app-server-transport.js';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CUSTODY_PROCESS_TICKET_ENV,
  custodyProcessArgument,
  recordChildRoleCustodyIntent,
} from '#src/infra/custody-process-ticket.js';

async function run(): Promise<void> {
  const [unit, workDir, wrapper, provider, mode] = process.argv.slice(2);
  if (unit === undefined || workDir === undefined || wrapper === undefined || provider === undefined) {
    throw new Error('Missing failure-domain fixture arguments');
  }
  const root = await acquireFailureDomainRoot(unit, mode === 'attach' ? 'supervisor-attach' : 'supervisor-test');
  if (root.kind !== 'placed') throw new Error(`Test scope placement failed: ${JSON.stringify(root)}`);
  if (mode === 'attach') {
    process.send?.({ kind: 'attached', pid: process.pid, root: root.root });
    process.on('disconnect', () => process.exit(0));
    return;
  }
  process.send?.({ kind: 'root', root: root.root });
  const attached = spawn(process.execPath, [process.argv[1], unit, workDir, wrapper, provider, 'attach'], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  attached.on('message', (message) => process.send?.(message));
  attached.on('error', (error) => {
    throw error;
  });
  process.env.CORAL_FAILURE_DOMAIN_ROOT = root.root;
  const runtime = createRealRuntime('prod', { baseDir: join(workDir, 'runtime') });
  const durable = await launchStandaloneJob(runtime, workDir);
  process.send?.({
    kind: 'durable',
    ...durable,
    leaf: join(root.root, `job-${durable.jobId}-${durable.execution}`),
  });
  const launch = (name: string, command: string, args: string[]) => {
    const ticket = recordChildRoleCustodyIntent({
      runDir: join(workDir, 'run'),
      epoch: '1',
      owner: 'provider-host',
      operationId: name,
      capsule: null,
      nowMs: Date.now(),
      bindWithinMs: 30_000,
      processGroupId: null,
    });
    const nameFromToken = `host-${ticket.processToken}`;
    const leaf = createFailureDomain(root, nameFromToken, true);
    if (leaf.kind !== 'created') throw new Error('Test leaf was refused');
    const child = spawn(
      process.execPath,
      [wrapper, '--provider-host', command, ...args, custodyProcessArgument(ticket.processToken)],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
        env: {
          ...process.env,
          CORAL_FAILURE_DOMAIN_ROOT: root.root,
          CORAL_FAILURE_DOMAIN: leaf.path,
          [CUSTODY_PROCESS_TICKET_ENV]: JSON.stringify(ticket),
        },
      },
    );
    return { child, leaf: leaf.path, name: nameFromToken };
  };
  const sibling = launch('sibling', process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const other = sibling.child;
  other.on('message', (message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'kind' in message &&
      message.kind === 'provider-host-started'
    ) {
      process.send?.({ kind: 'sibling', pid: other.pid, leaf: sibling.leaf });
    }
  });
  const host = launch('host', 'python3', [provider]);
  const child = host.child;
  if (child.pid === undefined) throw new Error('Test host pid missing');
  const incarnation = probeProcessIncarnation(child.pid, 'linux');
  if (incarnation === null) throw new Error('Test host incarnation missing');
  const containment = { pid: child.pid, incarnation, processGroupId: child.pid };
  const clock = createMonotonicClock(Symbol('test-leaf-reap'));
  const environment = {
    failureDomain: failureDomainContainment(root, host.name),
    process: runtime.process,
    platform: 'linux' as const,
    maxRecordedRoots: 0,
    clock,
  };
  process.on('message', (message) => {
    if (message !== 'reap-host') return;
    void reapRecordedContainment(containment, [], clock.shiftMilliseconds(clock.now(), 3000), environment)
      .then((outcome) => {
        process.send?.({
          kind: 'host-reaped',
          outcome: outcome.kind,
          observation: observeRecordedContainment({ ...containment, childRoot: null }, environment).kind,
        });
      })
      .catch((error: unknown) => {
        throw error;
      });
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes('\n'))
      process.send?.({ kind: 'host', pid: child.pid, leaf: host.leaf, ...(JSON.parse(output.trim()) as object) });
  });
  child.on('exit', (code, signal) => process.send?.({ kind: 'host-exit', code, signal }));
  child.on('error', (error) => {
    throw error;
  });
  other.on('error', (error) => {
    throw error;
  });
  const closeTicket = recordChildRoleCustodyIntent({
    runDir: join(workDir, 'run'),
    epoch: '1',
    owner: 'provider-host',
    operationId: 'transport-close',
    capsule: null,
    nowMs: Date.now(),
    bindWithinMs: 30000,
    processGroupId: null,
  });
  const closeName = `host-${closeTicket.processToken}`;
  const closeLeaf = createFailureDomain(root, closeName, true);
  if (closeLeaf.kind !== 'created') throw new Error('Close-test leaf was refused');
  const transportParams = {
    observeProviderResponse: () => {},
    runtime,
    generation: 1,
    options: {
      provider: 'codex',
      command: 'python3',
      args: [provider, '--jsonrpc'],
      custodyTicket: JSON.stringify(closeTicket),
      failureDomainName: closeName,
      extraEnv: { CORAL_FAILURE_DOMAIN_ROOT: root.root, CORAL_FAILURE_DOMAIN: closeLeaf.path },
    },
    acceptFailedSpawnCleanup: () => {
      throw new Error('Close-test host spawn failed');
    },
  };
  const transport =
    mode === 'proxy'
      ? await spawnProviderServerTransport(transportParams)
      : await spawnProviderServerTransport({ ...transportParams, detached: true });
  if ('error' in transport) throw transport.error;
  process.on('message', (message) => {
    if (message !== 'reuse-host-ticket') return;
    void (async () => {
      const duplicate =
        mode === 'proxy'
          ? await spawnProviderServerTransport({ ...transportParams, generation: 2 })
          : await spawnProviderServerTransport({ ...transportParams, generation: 2, detached: true });
      if ('error' in duplicate) throw duplicate.error;
      await new Promise<void>((resolve) => duplicate.child.on('exit', () => resolve()));
      process.send?.({ kind: 'ticket-reuse-refused', pid: duplicate.pid });
    })().catch((error: unknown) => {
      throw error;
    });
  });
  let closeOutput = '';
  transport.child.stdout?.on('data', (chunk: string | Buffer) => {
    closeOutput += chunk.toString();
    if (closeOutput.includes('\n'))
      process.send?.({
        kind: 'close-host',
        pid: transport.pid,
        leaf: closeLeaf.path,
        ...(JSON.parse(closeOutput.trim()) as { params: object }).params,
      });
  });
  process.on('message', (message) => {
    if (message !== 'close-host') return;
    void (async () => {
      if (mode === 'wrapper-exit') {
        transport.child.kill('SIGKILL');
        await transport.processCessation;
        process.send?.({ kind: 'host-closed', outcome: 'cessation-proven' });
        return;
      }
      const deadline = Date.now() + 10000;
      let disposition = await transport.close((hold) => ({
        kind: 'accepted',
        owner: 'provider-host-manager',
        settlement: hold.settled,
      }));
      while (disposition.kind === 'held-alive' || disposition.kind === 'held-unobservable') {
        if (Date.now() > deadline) throw new Error(`Host close remained ${disposition.kind}`);
        await sleep(25);
        disposition = await transport.close((hold) => ({
          kind: 'accepted',
          owner: 'provider-host-manager',
          settlement: hold.settled,
        }));
      }
      process.send?.({ kind: 'host-closed', outcome: disposition.kind });
    })().catch((error: unknown) => {
      throw error;
    });
  });
  process.on('disconnect', () => process.exit(0));
}
void run().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
