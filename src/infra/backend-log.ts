/**
 * Output goes to stderr so backend logs stay separate from stdout responses.
 */

let _tag = '';

const _lastByPrefix = new Map<string, string>();

function ts(): string {
  return new Date().toISOString();
}

function captureBracketPrefix(message: string, renderedLine: string): void {
  if (message.length === 0 || message.charCodeAt(0) !== 91 /* '[' */) return;
  const close = message.indexOf(']');
  if (close <= 1) return;
  // Slot stores the rendered line (timestamp + level + tag + message) so
  // the consumer reads the same shape that hit stderr.
  _lastByPrefix.set(message.slice(1, close), renderedLine);
}

function write(level: string, message: string): void {
  const renderedLine = `${ts()} ${level}${_tag} ${message}`;
  process.stderr.write(`${renderedLine}\n`);
  captureBracketPrefix(message, renderedLine);
}

export const backendLog = {
  /** Call once at startup with version + bundleHash. */
  init(identity: { version: string; bundleHash: string }): void {
    _tag = ` [${identity.version}/${identity.bundleHash.slice(0, 8)}]`;
  },

  info(message: string): void {
    write('INFO', message);
  },

  warn(message: string): void {
    write('WARN', message);
  },

  error(message: string, cause?: unknown): void {
    let suffix = '';
    if (cause instanceof Error) suffix = `: ${cause.message}`;
    else if (typeof cause === 'string') suffix = `: ${cause}`;
    else if (typeof cause === 'number' || typeof cause === 'boolean') suffix = `: ${String(cause)}`;
    else if (cause !== undefined && cause !== null) suffix = `: [object]`;
    write('ERROR', `${message}${suffix}`);
  },

  raw(message: string): void {
    process.stderr.write(message);
  },

  /**
   * Last rendered log line whose message started with `[<prefix>...]`, or
   * `undefined` if no such line has been emitted. One slot per prefix; a
   * later matching emission overwrites the previous slot value.
   */
  lastLineFor(prefix: string): string | undefined {
    return _lastByPrefix.get(prefix);
  },
};
