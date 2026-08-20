/**
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
  pendingBytes(): number;
};

/**
 * Accumulates raw bytes (never a decoded string) so a multi-byte UTF-8
 * character split across two chunks is never decoded half at a time — each
 * half would independently become U+FFFD and destroy the character. Callers
 * never call `setEncoding` on the underlying socket, so `push` normally
 * receives `Buffer`; a `string` chunk (e.g. a caller that did set an
 * encoding, or a test pushing literals) is re-encoded to UTF-8 bytes before
 * joining the buffer so both input shapes stay byte-exact.
 */
export function createLineFramer(): LineFramer {
  let buffer = Buffer.alloc(0);

  const toBuffer = (chunk: Buffer | string): Buffer =>
    typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk;

  return {
    push(chunk): string[] {
      buffer = Buffer.concat([buffer, toBuffer(chunk)]);
      const frames: string[] = [];
      let newlineIndex = buffer.indexOf(0x0a);
      while (newlineIndex !== -1) {
        frames.push(buffer.subarray(0, newlineIndex).toString('utf-8'));
        buffer = buffer.subarray(newlineIndex + 1);
        newlineIndex = buffer.indexOf(0x0a);
      }
      if (buffer.length > MAX_FRAME_BYTES) {
        throw new FrameTooLargeError(buffer.length, MAX_FRAME_BYTES);
      }
      return frames;
    },
    flush(): string {
      return buffer.toString('utf-8');
    },
    pendingBytes(): number {
      return buffer.length;
    },
  };
}
