import type { SpawnEvent } from './ports.js';

export function cloneSpawnEvent(event: SpawnEvent): SpawnEvent {
  return {
    child: event.child,
    command: event.command,
    args: [...event.args],
    ...(event.env ? { env: { ...event.env } } : {}),
  };
}
