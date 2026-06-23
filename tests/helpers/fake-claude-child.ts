import type { ChildExit, ClaudeBrokerChild } from '#src/providers/claude/appserver/session-contract.js';

export class FakeClaudeChild implements ClaudeBrokerChild {
  readonly writes: string[] = [];
  readonly killSignals: Array<NodeJS.Signals | undefined> = [];
  exitOnKill = true;
  dataUnsubscribes = 0;
  exitUnsubscribes = 0;
  private readonly dataHandlers = new Set<(chunk: string) => void>();
  private readonly exitHandlers = new Set<(event: ChildExit) => void>();
  private readonly autoReady: boolean;
  private exited = false;

  constructor(autoReady = true) {
    this.autoReady = autoReady;
  }

  get disposed(): boolean {
    return this.dataUnsubscribes > 0 && this.exitUnsubscribes > 0;
  }

  write(data: string): void {
    this.writes.push(data);
    if (data === '/exit\r') {
      this.emitExit({ code: 0, signal: null });
    }
  }

  kill(signal?: NodeJS.Signals): void {
    this.killSignals.push(signal);
    if (this.exitOnKill) {
      this.emitExit({ code: null, signal: signal ?? null });
    }
  }

  onData(handler: (chunk: string) => void): () => void {
    this.dataHandlers.add(handler);
    if (this.autoReady) {
      queueMicrotask(() => {
        if (this.dataHandlers.has(handler)) {
          handler('\x1b[?2004h');
        }
      });
    }
    return () => {
      this.dataHandlers.delete(handler);
      this.dataUnsubscribes += 1;
    };
  }

  onExit(handler: (event: ChildExit) => void): () => void {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
      this.exitUnsubscribes += 1;
    };
  }

  emitData(chunk: string): void {
    for (const handler of this.dataHandlers) {
      handler(chunk);
    }
  }

  emitExit(event: ChildExit): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    for (const handler of this.exitHandlers) {
      handler(event);
    }
  }
}
