import { Server, Socket } from 'node:net';

export function closeHandle(handle: unknown): void {
  if (handle instanceof Server) handle.close();
  else if (handle instanceof Socket) handle.destroy();
}
