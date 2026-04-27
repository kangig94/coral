// Canonical port-shape vocabulary. Domains and runtime alias these via
// `runtime/ports.ts`; infra-tier helpers reach here directly because infra
// is the lowest layer (cannot import upward from runtime/).

export interface TimerHandle {
  unref?(): void;
}

export interface TimePort {
  now(): number;
  sleep(ms: number, options?: { signal?: AbortSignal }): Promise<void>;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | null): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle | null): void;
}

export interface DirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export type StorageData = string | Uint8Array;

export interface StoragePort {
  readFileSync(path: string, encoding: 'utf-8'): string;
  writeFileSync(path: string, data: StorageData, options?: { encoding?: BufferEncoding; mode?: number }): void;
  renameSync(oldPath: string, newPath: string): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  readdirSync(path: string, options: { withFileTypes: true }): DirentLike[];
  statSync(path: string): { size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean };
  statSync(path: string, options: { bigint: true }): { size: bigint; mtimeNs: bigint; isDirectory(): boolean; isFile(): boolean };
  existsSync(path: string): boolean;
  openSync(path: string, flags: string): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  closeSync(fd: number): void;
  appendFileSync(path: string, data: string): void;
  appendFileDurableSync(path: string, data: string): boolean;
  unlinkSync(path: string): void;
  tryExclusiveWriteSync(path: string, data: StorageData, options?: { encoding?: BufferEncoding; mode?: number }): boolean;
  writeAtomicSync(path: string, data: StorageData, options?: { encoding?: BufferEncoding; mode?: number }): boolean;
  writeAtomicDurableSync(path: string, data: StorageData, options?: { encoding?: BufferEncoding; mode?: number }): boolean;
  chmodSync(path: string, mode: number): void;
}

export interface EnvPort {
  get(key: string): string | undefined;
  homedir(): string;
  pid(): number;
  platform(): string;
  cwd(): string;
  fullSnapshot(): Readonly<Record<string, string>>;
  coralSnapshot(): Readonly<Record<string, string>>;
}

export interface ChildStdinLike {
  readonly destroyed: boolean;
  write(chunk: string | Uint8Array): boolean;
  end(chunk?: string | Uint8Array): void;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface ChildReadableLike {
  setEncoding(encoding: BufferEncoding): this;
  on(event: 'data', listener: (chunk: string | Buffer) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  [Symbol.asyncIterator]?(): AsyncIterableIterator<string | Buffer>;
}

export interface ChildProcessLike {
  readonly pid: number | undefined;
  readonly stdin: ChildStdinLike | null;
  readonly stdout: ChildReadableLike | null;
  readonly stderr: ChildReadableLike | null;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
  unref?(): void;
}
