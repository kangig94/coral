import { spawn } from 'node:child_process';
import { createRealRuntime } from '#src/runtime/real.js';
import { join } from 'node:path';
import { launchStandaloneJob } from '#tests/fixtures/failure-domain/standalone-job.js';
import { acquireFailureDomainRoot, createFailureDomain } from '#src/infra/failure-domain.js';
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
  const host = createFailureDomain(root, 'host-test', true);
  const sibling = createFailureDomain(root, 'host-sibling', true);
  if (host.kind !== 'created' || sibling.kind !== 'created') throw new Error('Test leaves were refused');
  const launch = (leaf: string, command: string, args: string[]): ReturnType<typeof spawn> => {
    const ticket = recordChildRoleCustodyIntent({
      runDir: join(workDir, 'run'),
      epoch: '1',
      owner: 'provider-host',
      operationId: leaf,
      capsule: null,
      nowMs: Date.now(),
      bindWithinMs: 30_000,
      processGroupId: null,
    });
    return spawn(
      process.execPath,
      [wrapper, '--provider-host', command, ...args, custodyProcessArgument(ticket.processToken)],
      {
        stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
        env: {
          ...process.env,
          CORAL_FAILURE_DOMAIN_ROOT: root.root,
          CORAL_FAILURE_DOMAIN: leaf,
          [CUSTODY_PROCESS_TICKET_ENV]: JSON.stringify(ticket),
        },
      },
    );
  };
  const other = launch(sibling.path, process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  other.on('message', (message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'kind' in message &&
      message.kind === 'provider-host-started'
    ) {
      process.send?.({ kind: 'sibling', pid: other.pid, leaf: sibling.path });
    }
  });
  const child = launch(host.path, 'python3', [provider]);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes('\n'))
      process.send?.({ kind: 'host', pid: child.pid, leaf: host.path, ...(JSON.parse(output.trim()) as object) });
  });
  child.on('exit', (code, signal) => process.send?.({ kind: 'host-exit', code, signal }));
  child.on('error', (error) => {
    throw error;
  });
  other.on('error', (error) => {
    throw error;
  });
  process.on('disconnect', () => process.exit(0));
}
void run().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
