import type { ServerResponse } from 'node:http';

import { nowIsoString } from '../../infra/time.js';
import type { Runtime } from '../../runtime/ports.js';
import type { EventStreamHandlers, HttpHandlerPorts } from '../../transport/server-ports.js';
import { sendJson } from '../../transport/http/handler.js';
import { subscribeAll } from '../../transport/http/sse-subscribe.js';
import { type createCoordinatorWorld } from './world.js';

const EVENT_STREAM_CAPACITY_RESPONSE = {
  code: 'too_many_event_streams',
  message: 'Too many event stream connections',
};

export function createCoordinatorEventStreamPorts({
  runtime,
  world,
  streamResponses,
  eventStreamSubscriptions,
  maxConnections,
}: {
  runtime: Runtime;
  world: ReturnType<typeof createCoordinatorWorld>;
  streamResponses: Set<ServerResponse>;
  eventStreamSubscriptions: WeakMap<EventStreamHandlers, () => void>;
  maxConnections: number;
}): HttpHandlerPorts['events'] {
  return {
    addResponse: (res) => {
      if (streamResponses.has(res)) {
        return;
      }
      if (streamResponses.size >= maxConnections) {
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          sendJson(res, 503, EVENT_STREAM_CAPACITY_RESPONSE);
          return;
        }
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
        return;
      }
      streamResponses.add(res);
    },
    removeResponse: (res) => {
      streamResponses.delete(res);
    },
    bus: world.eventBus,
    createStreamId: () => runtime.ids.uuid(),
    nowIsoString: () => nowIsoString(runtime.time),
    subscribe: (handlers: EventStreamHandlers) => {
      eventStreamSubscriptions.get(handlers)?.();
      eventStreamSubscriptions.set(
        handlers,
        subscribeAll(world.eventBus, {
          'job:created': handlers.onJobCreated,
          'job:phase_changed': handlers.onPhaseChanged,
          'job:progress': handlers.onProgress,
          'job:completed': handlers.onCompleted,
          'discuss:updated': handlers.onDiscussUpdated,
        }),
      );
    },
    unsubscribe: (handlers: EventStreamHandlers) => {
      const cleanup = eventStreamSubscriptions.get(handlers);
      if (!cleanup) {
        return;
      }
      eventStreamSubscriptions.delete(handlers);
      cleanup();
    },
  };
}
