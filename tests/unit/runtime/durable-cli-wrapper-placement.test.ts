import { z } from 'zod';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { EventEmitter } from 'node:events';
import { closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

const placement = vi.hoisted(() => ({
  order: [] as string[],
  spawn: vi.fn(),
  entered: true,
  incarnation: 'test-incarnation' as string | null,
  expectedLeaf: '/inherited/host-test' as string | null,
  rootKind: 'placed' as 'placed' | 'unknown',
  recordEntry: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: placement.spawn }));
vi.mock('#src/infra/failure-domain.js', () => ({
  inheritedFailureDomainRoot: () =>
    placement.rootKind === 'placed'
      ? { kind: 'placed', root: '/inherited' }
      : { kind: 'unknown', reason: 'unavailable' },
  enterPayloadDomain: (root: unknown, leaf: string | null) => {
    expect(root).toEqual(
      placement.rootKind === 'placed'
        ? { kind: 'placed', root: '/inherited' }
        : { kind: 'unknown', reason: 'unavailable' },
    );
    expect(leaf).toBe(placement.expectedLeaf);
    placement.order.push('enter-payload');
    return placement.entered && placement.rootKind === 'placed'
      ? { kind: 'entered' }
      : { kind: 'refused', errno: 'EACCES' };
  },
}));
vi.mock('#src/infra/custody-process-ticket.js', () => ({
  CUSTODY_PROCESS_TICKET_ENV: 'CORAL_CUSTODY_PROCESS_TICKET',
  parseCustodyProcessTicket: () => ({ processToken: 'token' }),
  custodyProcessArgument: () => '--token',
  bindCustodyProcessTicket: () => placement.order.push('bind'),
  recordCustodyPayloadEntry: placement.recordEntry,
}));
vi.mock('#src/infra/node-process.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  probeProcessIncarnation: () => placement.incarnation,
  observeProcessLiveness: () => 'alive',
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  placement.incarnation = 'test-incarnation';
  placement.rootKind = 'placed';
  placement.recordEntry.mockReset();
});

it('binds custody and enters the payload domain before spawning with placement removed from the provider env', async () => {
  placement.expectedLeaf = '/inherited/host-test';
  const argv = process.argv;
  const send = process.send;
  const connected = Object.getOwnPropertyDescriptor(process, 'connected');
  Object.defineProperty(process, 'connected', { configurable: true, value: true });
  const sent: unknown[] = [];
  process.send = ((message: unknown, callback?: (error: Error | null) => void) => {
    sent.push(message);
    callback?.(null);
    return true;
  }) as typeof process.send;
  vi.stubEnv('CORAL_CUSTODY_PROCESS_TICKET', 'ticket');
  vi.stubEnv('CORAL_FAILURE_DOMAIN_ROOT', '/inherited');
  vi.stubEnv('CORAL_FAILURE_DOMAIN', '/inherited/host-test');
  vi.spyOn(process, 'on').mockReturnValue(process);
  vi.spyOn(process, 'once').mockReturnValue(process);
  placement.order.length = 0;
  placement.incarnation = testIncarnation(3);
  const provider = Object.assign(new EventEmitter(), { pid: 42 });
  placement.spawn.mockImplementation((_command, _args, options: { env: NodeJS.ProcessEnv }) => {
    placement.order.push('spawn');
    expect(options.env.CORAL_FAILURE_DOMAIN).toBeUndefined();
    expect(options.env.CORAL_FAILURE_DOMAIN_ROOT).toBeUndefined();
    expect(options.env.CORAL_CUSTODY_PROCESS_TICKET).toBeUndefined();
    return provider;
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
    provider.emit('spawn');
    const started = sent.find((message) => (message as { kind: string }).kind === 'provider-host-started');
    expect(
      z
        .object({
          kind: z.literal('provider-host-started'),
          processToken: z.string(),
          pid: z.number(),
          incarnation: z.string().nullable(),
        })
        .strict()
        .safeParse(started).success,
    ).toBe(true);
  } finally {
    process.argv = argv;
    process.send = send;
    if (connected === undefined) Reflect.deleteProperty(process, 'connected');
    else Object.defineProperty(process, 'connected', connected);
  }
});

it.each([
  { placed: true, entered: true },
  { placed: true, entered: false },
  { placed: false, entered: false },
])(
  'uses explicit publication placement $placed and entry $entered before spawning the CLI child',
  async ({ placed, entered }) => {
    placement.entered = entered;
    placement.expectedLeaf = placed ? '/inherited/host-test' : null;
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
    const publication = vi.fn<(message: unknown) => boolean>(() => true);
    process.send = publication;
    process.disconnect = () => undefined;
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'message')
        queueMicrotask(() => {
          placement.order.push('published');
          listener({
            kind: 'runtime-start-published',
            failureDomain: placed ? { root: '/inherited', path: '/inherited/host-test' } : null,
          });
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
      expect(
        publication.mock.calls.some(([message]) => (message as { kind: string }).kind === 'durable-payload-entered'),
      ).toBe(placed && entered);
    } finally {
      process.argv = argv;
      process.send = send;
      process.disconnect = disconnect;
      for (const descriptor of outputDescriptors) closeSync(descriptor);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.each([
  { entered: true, sendFails: false, identityUnavailable: false, disconnected: false },
  { entered: false, sendFails: false, identityUnavailable: false, disconnected: false },
  { entered: false, sendFails: false, identityUnavailable: false, disconnected: false, rootUnknown: true },
  { entered: true, sendFails: true, identityUnavailable: false, disconnected: false },
  { entered: true, sendFails: false, identityUnavailable: true, disconnected: false },
  { entered: true, sendFails: false, identityUnavailable: false, disconnected: true },
  { entered: true, sendFails: false, identityUnavailable: false, disconnected: false, entryRecordFails: true },
])(
  'keeps unplaced startup available and fences entered payload publication ($entered, $sendFails, $identityUnavailable, $disconnected)',
  async ({ entered, sendFails, identityUnavailable, disconnected, rootUnknown, entryRecordFails }) => {
    if (entryRecordFails === true)
      placement.recordEntry.mockImplementationOnce(() => {
        throw new Error('entry receipt write failed');
      });
    placement.rootKind = rootUnknown === true ? 'unknown' : 'placed';
    const argv = process.argv;
    const send = process.send;
    const disconnect = process.disconnect;
    const exitCode = process.exitCode;
    const connected = Object.getOwnPropertyDescriptor(process, 'connected');
    let publish!: (error: Error | null) => void;
    placement.entered = entered;
    placement.incarnation = identityUnavailable ? null : 'test-incarnation';
    placement.expectedLeaf = '/inherited/host-test';
    placement.order.length = 0;
    vi.stubEnv('CORAL_CUSTODY_PROCESS_TICKET', 'ticket');
    vi.stubEnv('CORAL_FAILURE_DOMAIN_ROOT', '/inherited');
    vi.stubEnv('CORAL_FAILURE_DOMAIN', '/inherited/host-test');
    vi.spyOn(process, 'on').mockReturnValue(process);
    vi.spyOn(process, 'once').mockReturnValue(process);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    Object.defineProperty(process, 'connected', { configurable: true, value: true });
    process.disconnect = () => undefined;
    process.send = ((message: unknown, callback: (error: Error | null) => void) => {
      if ((message as { kind: string }).kind === 'provider-host-placed') {
        expect(message).toEqual({ kind: 'provider-host-placed', processToken: 'token' });
        placement.order.push('placement-reported');
        publish = callback;
      } else {
        expect(message).toEqual({ kind: 'provider-host-absent', processToken: 'token' });
        placement.order.push('provider-absent');
        callback(null);
      }
      return true;
    }) as typeof process.send;
    placement.spawn.mockImplementation(() => {
      placement.order.push('spawn');
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
      expect(placement.order).toEqual(
        identityUnavailable
          ? ['provider-absent']
          : entered
            ? ['bind', 'enter-payload', 'placement-reported']
            : ['bind', 'enter-payload', 'spawn'],
      );
      if (entered || identityUnavailable) expect(placement.order).not.toContain('spawn');
      expect(placement.recordEntry).toHaveBeenCalledTimes(entered && !identityUnavailable ? 1 : 0);
      if (entered && !identityUnavailable) {
        if (disconnected) Object.defineProperty(process, 'connected', { configurable: true, value: false });
        publish(sendFails ? new Error('IPC write failed') : null);
        if (disconnected) {
          expect(placement.order).not.toContain('spawn');
          expect(process.exitCode).toBe(1);
        } else expect(placement.order.at(-1)).toBe(sendFails ? 'provider-absent' : 'spawn');
      }
    } finally {
      process.argv = argv;
      process.send = send;
      process.disconnect = disconnect;
      process.exitCode = exitCode;
      if (connected === undefined) Reflect.deleteProperty(process, 'connected');
      else Object.defineProperty(process, 'connected', connected);
      placement.entered = true;
    }
  },
);
