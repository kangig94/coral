import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendLog } from '../../shared/backend-log.js';
import { TypedEventBus } from '../event-bus.js';

describe('TypedEventBus', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs throwing listeners without propagating from emit', () => {
    const eventBus = new TypedEventBus();
    const errorSpy = vi.spyOn(backendLog, 'error').mockImplementation(() => {});
    const delivered = vi.fn();

    eventBus.on('job:progress', () => {
      throw new Error('listener failed');
    });
    eventBus.on('job:progress', delivered);

    let emitted = false;
    const emit = (): void => {
      emitted = eventBus.emit('job:progress', {
        jobId: 'job-1',
        eventId: 1,
        message: 'working',
      });
    };

    expect(emit).not.toThrow();
    expect(emitted).toBe(true);
    expect(delivered).toHaveBeenCalledWith({
      jobId: 'job-1',
      eventId: 1,
      message: 'working',
    });
    expect(errorSpy).toHaveBeenCalledWith(
      'EventBus listener for job:progress failed',
      expect.any(Error),
    );
  });
});
