import {
  KB_CHILD_READY_MESSAGE,
  KB_CHILD_RESPONSE_MESSAGE,
  encodeKbChildMessage,
  isKbChildKbReadRequest,
  isKbChildRequestMessage,
  type KbChildHealthResult,
  type KbChildControlMessage,
  type KbChildRequestMessage,
} from './protocol.js';
import { createKbChildReadHandler } from './read-handler.js';
import { errorMessage } from '../../infra/error-format.js';

type KbChildMainOptions = {
  pluginRoot?: string;
};

function writeControlMessage(message: KbChildControlMessage): void {
  process.stdout.write(encodeKbChildMessage(message));
}

export async function runKbChildMain(options: KbChildMainOptions = {}): Promise<number> {
  const startedAt = Date.now();
  const pluginRoot = options.pluginRoot ?? process.cwd();
  const readKb = createKbChildReadHandler({ pluginRoot });
  let resolveShutdown!: (code: number) => void;
  let settled = false;
  const shutdown = new Promise<number>((resolve) => {
    resolveShutdown = resolve;
  });
  const stop = (code: number): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearInterval(keepalive);
    resolveShutdown(code);
  };
  const keepalive = setInterval(() => undefined, 60_000);

  const health = (): KbChildHealthResult => ({
    status: 'ready',
    pid: process.pid,
    startedAt,
    uptimeMs: Math.max(0, Date.now() - startedAt),
  });
  const handleRequest = async (request: KbChildRequestMessage): Promise<void> => {
    switch (request.method) {
      case 'health':
        writeControlMessage({ type: KB_CHILD_RESPONSE_MESSAGE, id: request.id, ok: true, result: health() });
        return;
      case 'shutdown':
        writeControlMessage({
          type: KB_CHILD_RESPONSE_MESSAGE,
          id: request.id,
          ok: true,
          result: { status: 'shutting_down' },
        });
        stop(0);
        return;
      case 'kb.read':
        writeControlMessage({
          type: KB_CHILD_RESPONSE_MESSAGE,
          id: request.id,
          ok: true,
          result: isKbChildKbReadRequest(request.params)
            ? await readKb(request.params)
            : {
                ok: false,
                code: 'invalid_request',
                message: 'Malformed KB child read request.',
              },
        });
        return;
    }
  };
  let lineBuffer = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    lineBuffer += String(chunk);
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isKbChildRequestMessage(parsed)) {
          void handleRequest(parsed).catch((error: unknown) => {
            writeControlMessage({
              type: KB_CHILD_RESPONSE_MESSAGE,
              id: parsed.id,
              ok: false,
              error: { message: errorMessage(error) },
            });
          });
          continue;
        }
      } catch {
        // Plain-text shutdown remains supported for direct smoke tests and old supervisors.
      }
      if (trimmed.includes('shutdown')) {
        stop(0);
      }
    }
  });
  process.stdin.on('end', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  process.on('SIGINT', () => stop(0));

  writeControlMessage({
    type: KB_CHILD_READY_MESSAGE,
    pid: process.pid,
    startedAt,
    readyAt: Date.now(),
  });

  return shutdown;
}
