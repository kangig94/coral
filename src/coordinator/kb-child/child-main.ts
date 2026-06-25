const READY_MESSAGE_TYPE = 'coral.kb_child.ready';

function writeControlMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export async function runKbChildMain(): Promise<number> {
  const startedAt = Date.now();
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

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    if (String(chunk).includes('shutdown')) {
      stop(0);
    }
  });
  process.stdin.on('end', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  process.on('SIGINT', () => stop(0));

  writeControlMessage({
    type: READY_MESSAGE_TYPE,
    pid: process.pid,
    startedAt,
    readyAt: Date.now(),
  });

  return shutdown;
}
