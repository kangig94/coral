/**
 * 10 MB cap matches the HTTP body cap (`src/transport/http/handler.ts`).
 * A buggy IPC client writing without a newline would otherwise grow the
 * framer buffer until coordinator memory is exhausted.
 */
export const MAX_FRAME_BYTES = 10 * 1024 * 1024;

export class FrameTooLargeError extends Error {
  readonly code = 'frame_too_large';
  readonly maxFrameBytes: number;
  readonly observedBytes: number;

  constructor(observedBytes: number, maxFrameBytes: number) {
    super(`IPC frame exceeded ${maxFrameBytes} bytes (observed ${observedBytes}) without a newline terminator.`);
    this.name = 'FrameTooLargeError';
    this.maxFrameBytes = maxFrameBytes;
    this.observedBytes = observedBytes;
    Object.setPrototypeOf(this, FrameTooLargeError.prototype);
  }
}

export type LineFramer = {
  push(chunk: Buffer | string): string[];
  flush(): string;
};

export function createLineFramer(): LineFramer {
  let buffer = '';
  let pendingBytes = 0;

  return {
    push(chunk): string[] {
      buffer += chunk.toString('utf-8');
      pendingBytes = Buffer.byteLength(buffer, 'utf-8');
      const frames = buffer.split('\n');
      buffer = frames.pop() ?? '';
      pendingBytes = Buffer.byteLength(buffer, 'utf-8');
      if (pendingBytes > MAX_FRAME_BYTES) {
        throw new FrameTooLargeError(pendingBytes, MAX_FRAME_BYTES);
      }
      return frames;
    },
    flush(): string {
      return buffer;
    },
  };
}
