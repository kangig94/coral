import { EventEmitter } from 'node:events';
import { closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

const placement = vi.hoisted(() => ({ order: [] as string[], spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: placement.spawn }));
vi.mock('#src/infra/failure-domain.js', () => ({
  inheritedFailureDomainRoot: () => ({ kind: 'placed', root: '/inherited' }),
  enterPayloadDomain: (root: unknown, leaf: string | null) => {
    expect(root).toEqual({ kind: 'placed', root: '/inherited' });
    expect(leaf).toBe('/inherited/host-test');
    placement.order.push('enter-payload');
    return { kind: 'entered' };
  },
}));
vi.mock('#src/infra/custody-process-ticket.js', () => ({
  CUSTODY_PROCESS_TICKET_ENV: 'CORAL_CUSTODY_PROCESS_TICKET',
  parseCustodyProcessTicket: () => ({ processToken: 'token' }),
  custodyProcessArgument: () => '--token',
  bindCustodyProcessTicket: () => placement.order.push('bind'),
}));
vi.mock('#src/infra/node-process.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  probeProcessIncarnation: () => 'test-incarnation',
  observeProcessLiveness: () => 'alive',
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

it('binds custody and enters the payload domain before spawning with placement removed from the provider env', async () => {
  const argv = process.argv;
  vi.stubEnv('CORAL_CUSTODY_PROCESS_TICKET', 'ticket');
  vi.stubEnv('CORAL_FAILURE_DOMAIN_ROOT', '/inherited');
  vi.stubEnv('CORAL_FAILURE_DOMAIN', '/inherited/host-test');
  vi.spyOn(process, 'on').mockReturnValue(process);
  vi.spyOn(process, 'once').mockReturnValue(process);
  placement.order.length = 0;
  placement.spawn.mockImplementation((_command, _args, options: { env: NodeJS.ProcessEnv }) => {
    placement.order.push('spawn');
    expect(options.env.CORAL_FAILURE_DOMAIN).toBeUndefined();
    expect(options.env.CORAL_FAILURE_DOMAIN_ROOT).toBeUndefined();
    expect(options.env.CORAL_CUSTODY_PROCESS_TICKET).toBeUndefined();
    return new EventEmitter();
  });
  try {
    process.argv = [
      process.execPath,
      fileURLToPath(new URL('../../../src/runtime/durable-cli-wrapper.ts', import.meta.url)),
      '--provider-host',
      'fake-provider',
      '--token',
    ];
    await import('#src/runtime/durable-cli-wrapper.js');
    expect(placement.order).toEqual(['bind', 'enter-payload', 'spawn']);
  } finally {
    process.argv = argv;
  }
});

it('enters the durable payload after publication and before spawning the CLI child', async () => {
  const argv = process.argv;
  const send = process.send;
  const disconnect = process.disconnect;
  const directory = mkdtempSync(join(tmpdir(), 'coral-wrapper-placement-'));
  const payloadPath = join(directory, 'launch.json');
  const outputDescriptors: number[] = [];
  writeFileSync(
    payloadPath,
    JSON.stringify({ version: 1, command: 'fake-cli', args: [], cwd: null, prompt: '', startTime: 'now' }),
  );
  writeFileSync(
    join(directory, 'env.json'),
    JSON.stringify({ CORAL_FAILURE_DOMAIN: '/inherited/host-test', CORAL_FAILURE_DOMAIN_ROOT: '/inherited' }),
  );
  vi.stubEnv('CORAL_CUSTODY_PROCESS_TICKET', 'ticket');
  vi.stubEnv('CORAL_FAILURE_DOMAIN_ROOT', '/inherited');
  vi.stubEnv('CORAL_FAILURE_DOMAIN', '/inherited/host-test');
  process.send = () => true;
  process.disconnect = () => undefined;
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    if (event === 'message')
      queueMicrotask(() => {
        placement.order.push('published');
        listener('runtime-start-published');
      });
    return process;
  });
  vi.spyOn(process, 'once').mockReturnValue(process);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  placement.order.length = 0;
  placement.spawn.mockImplementation(
    (_command, _args, options: { env: NodeJS.ProcessEnv; stdio: [string, number, number] }) => {
      placement.order.push('spawn');
      outputDescriptors.push(options.stdio[1], options.stdio[2]);
      expect(options.env.CORAL_FAILURE_DOMAIN).toBeUndefined();
      expect(options.env.CORAL_FAILURE_DOMAIN_ROOT).toBeUndefined();
      return Object.assign(new EventEmitter(), { pid: 42, stdin: new PassThrough() });
    },
  );
  try {
    process.argv = [
      process.execPath,
      fileURLToPath(new URL('../../../src/runtime/durable-cli-wrapper.ts', import.meta.url)),
      payloadPath,
      '--token',
    ];
    await import('#src/runtime/durable-cli-wrapper.js');
    await vi.waitFor(() => expect(placement.order).toEqual(['bind', 'published', 'enter-payload', 'spawn']));
  } finally {
    process.argv = argv;
    process.send = send;
    process.disconnect = disconnect;
    for (const descriptor of outputDescriptors) closeSync(descriptor);
    rmSync(directory, { recursive: true, force: true });
  }
});
