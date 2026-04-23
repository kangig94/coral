/**
 * Centralized backend logger.
 *
 * Every line is prefixed with ISO timestamp and optional identity tag.
 * Output goes to stderr so backend logs stay separate from stdout responses.
 *
 * Usage:
 *   import { backendLog } from '../infra/backend-log.js';
 *   backendLog.init({ version: '0.4.12', bundleHash: 'abc123' });
 *   backendLog.info('Server started');
 *   backendLog.warn('Session file corrupt, skipping');
 *   backendLog.error('Fatal startup error', error);
 */

let _tag = '';

function ts(): string {
  return new Date().toISOString();
}

function write(level: string, message: string): void {
  process.stderr.write(`${ts()} ${level}${_tag} ${message}\n`);
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

  /** Raw write without prefix — for startup banner, fatal exit, etc. */
  raw(message: string): void {
    process.stderr.write(message);
  },
};
