export type LineFramer = {
  push(chunk: Buffer | string): string[];
  flush(): string;
};

export function createLineFramer(): LineFramer {
  let buffer = '';

  return {
    push(chunk): string[] {
      buffer += chunk.toString('utf-8');
      const frames = buffer.split('\n');
      buffer = frames.pop() ?? '';
      return frames;
    },
    flush(): string {
      return buffer;
    },
  };
}
