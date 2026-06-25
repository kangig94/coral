import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { downloadBuffer } from '#src/runtime/download.js';
import type { Runtime, RuntimeExecOptions } from '#src/runtime/ports.js';

function runtimeWithExec(
  exec: (
    command: string,
    args: string[],
    options?: RuntimeExecOptions,
  ) => Promise<{ stdout: string; stderr: string; status: number }>,
): Runtime {
  return {
    env: {
      platform: () => 'linux',
    },
    process: {
      exec,
    },
  } as unknown as Runtime;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('downloadBuffer', () => {
  it('rejects fetch responses whose Content-Length exceeds maxBytes', async () => {
    const runtime = runtimeWithExec(async () => ({ stdout: '', stderr: '', status: 1 }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('too large', { status: 200, headers: { 'content-length': '9' } })),
    );

    await expect(downloadBuffer(runtime, 'https://example.invalid/archive.bin', { maxBytes: 8 })).rejects.toThrow(
      /Download exceeded maximum size/,
    );
  });

  it('rejects streaming fetch bodies once the read size exceeds maxBytes', async () => {
    const runtime = runtimeWithExec(async () => ({ stdout: '', stderr: '', status: 1 }));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(6));
                controller.enqueue(new Uint8Array(6));
                controller.close();
              },
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(downloadBuffer(runtime, 'https://example.invalid/archive.bin', { maxBytes: 8 })).rejects.toThrow(
      /12 bytes > 8 bytes/,
    );
  });

  it('checks command downloads before reading the temporary file into memory', async () => {
    const runtime = runtimeWithExec(async (command, args) => {
      if (command === 'which' && args[0] === 'curl') {
        return { stdout: '/usr/bin/curl\n', stderr: '', status: 0 };
      }
      if (command === '/usr/bin/curl') {
        writeFileSync(args[2] ?? '', Buffer.alloc(12));
        return { stdout: '', stderr: '', status: 0 };
      }
      return { stdout: '', stderr: '', status: 1 };
    });

    await expect(downloadBuffer(runtime, 'https://example.invalid/archive.bin', { maxBytes: 8 })).rejects.toThrow(
      /12 bytes > 8 bytes/,
    );
  });
});
