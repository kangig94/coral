import { createServer, createConnection } from 'node:net';

/**
 * A TCP port on loopback that this host has confirmed refuses connections.
 *
 * Binding a port, closing it, and dialling is not enough: `close()`'s callback fires once the JS handle is
 * released, which runs ahead of the kernel's own socket teardown, so a dial landing in that window reaches the
 * old listener or gets `ECONNRESET` off a socket still coming down — neither of which is the `ECONNREFUSED` a
 * caller asking for a refused port wants. Waiting a fixed interval assumes the teardown fits in it; under a
 * loaded machine it does not, and the test that asked for a refusal silently exercises a different errno.
 *
 * So the refusal is observed rather than waited for: dial until the host answers `ECONNREFUSED`, and return
 * the port only once it has. `attempts` bounds it so a host that never refuses fails here, naming the reason,
 * instead of inside whatever was going to use the port.
 */
export async function reserveRefusedPort(attempts = 100): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const address = probe.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await dialRefuses(port)) return port;
  }
  throw new Error(`127.0.0.1:${port} did not start refusing connections within ${attempts} dials`);
}

function dialRefuses(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(error.code === 'ECONNREFUSED');
    });
  });
}
