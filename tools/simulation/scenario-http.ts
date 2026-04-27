import { EventEmitter } from 'node:events';

export class ScenarioHttpRequest extends EventEmitter {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  private readonly bodyText: string | null;
  private started = false;
  destroyed = false;

  constructor(method: string, url: string, token: string, body: unknown) {
    super();
    this.method = method;
    this.url = url;
    this.bodyText = body === undefined ? null : JSON.stringify(body);
    this.headers = {
      'x-coral-coordinator-token': token,
      ...(this.bodyText !== null ? { 'content-type': 'application/json' } : {}),
    };
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    queueMicrotask(() => {
      if (this.destroyed) {
        return;
      }
      if (this.bodyText !== null) {
        this.emit('data', Buffer.from(this.bodyText, 'utf-8'));
      }
      this.emit('end');
    });
  }

  resume(): void {}

  destroy(): void {
    this.destroyed = true;
  }
}

export class ScenarioHttpResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  readonly headers = new Map<string, string | number | string[]>();
  body = '';

  setHeader(name: string, value: string | number | string[]): void {
    this.headers.set(name, value);
  }

  writeHead(statusCode: number): void {
    this.statusCode = statusCode;
    this.headersSent = true;
  }

  write(chunk: string | Buffer): boolean {
    this.headersSent = true;
    this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk;
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) {
      this.write(chunk);
    }
    this.headersSent = true;
    this.writableEnded = true;
    this.emit('finish');
    this.emit('close');
    return this;
  }
}
