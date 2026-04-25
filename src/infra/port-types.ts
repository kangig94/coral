export interface InfraTimerHandle {
  unref?(): void;
}

export interface InfraTimePort {
  now(): number;
  sleep(ms: number, options?: { signal?: AbortSignal }): Promise<void>;
  setTimeout(fn: () => void, ms: number): InfraTimerHandle;
  clearTimeout(handle: InfraTimerHandle | null): void;
  setInterval(fn: () => void, ms: number): InfraTimerHandle;
  clearInterval(handle: InfraTimerHandle | null): void;
}

export interface InfraDirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export type InfraStorageData = string | Uint8Array;

export interface InfraStoragePort {
  readFileSync(path: string, encoding: 'utf-8'): string;
  writeFileSync(path: string, data: InfraStorageData, options?: { encoding?: BufferEncoding; mode?: number }): void;
  renameSync(oldPath: string, newPath: string): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  readdirSync(path: string, options: { withFileTypes: true }): InfraDirentLike[];
  statSync(path: string): { size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean };
  existsSync(path: string): boolean;
  openSync(path: string, flags: string): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  closeSync(fd: number): void;
  appendFileSync(path: string, data: string): void;
  appendFileDurableSync(path: string, data: string): boolean;
  unlinkSync(path: string): void;
  tryExclusiveWriteSync(path: string, data: InfraStorageData, options?: { encoding?: BufferEncoding; mode?: number }): boolean;
  writeAtomicSync(path: string, data: InfraStorageData, options?: { encoding?: BufferEncoding; mode?: number }): boolean;
  writeAtomicDurableSync(path: string, data: InfraStorageData, options?: { encoding?: BufferEncoding; mode?: number }): boolean;
  chmodSync(path: string, mode: number): void;
}

export interface InfraEnvPort {
  get(key: string): string | undefined;
  homedir(): string;
  pid(): number;
  platform(): string;
  cwd(): string;
  fullSnapshot(): Readonly<Record<string, string>>;
  coralSnapshot(): Readonly<Record<string, string>>;
}

export interface InfraRuntimePaths {
  projectSource(projectRoot: string): string;
  readonly coral: unknown;
}

export interface InfraChildStdinLike {
  readonly destroyed: boolean;
  write(chunk: string | Uint8Array): boolean;
  end(chunk?: string | Uint8Array): void;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface InfraChildReadableLike {
  setEncoding(encoding: BufferEncoding): this;
  on(event: 'data', listener: (chunk: string | Buffer) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  [Symbol.asyncIterator]?(): AsyncIterableIterator<string | Buffer>;
}

export interface InfraChildProcessLike {
  readonly pid: number | undefined;
  readonly stdin: InfraChildStdinLike | null;
  readonly stdout: InfraChildReadableLike | null;
  readonly stderr: InfraChildReadableLike | null;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
  unref?(): void;
}
