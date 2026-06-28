import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { writeSseEvent } from '#src/transport/http/handler.js';

describe('writeSseEvent', () => {
  it('destroys the response when Node reports write backpressure', () => {
    const response = {
      destroyed: false,
      writableEnded: false,
      write: vi.fn(() => false),
      destroy: vi.fn(function destroy(this: { destroyed: boolean }) {
        this.destroyed = true;
      }),
    } as unknown as ServerResponse;

    expect(writeSseEvent(response, 'progress', { ok: true })).toBe(false);
    expect(response.write).toHaveBeenCalledWith('event: progress\ndata: {"ok":true}\n\n');
    expect(response.destroy).toHaveBeenCalledWith(expect.any(Error));
  });
});
