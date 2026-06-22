import { describe, expect, it } from 'vitest';

import { buildControllerEnv } from '#src/transport/invocation-context.js';

const snapshot = Object.freeze({ CORAL_NAMESPACE: 'default' });

describe('buildControllerEnv networkEnv overlay', () => {
  it('overlays recognized proxy/CA vars from the body onto the snapshot', () => {
    const env = buildControllerEnv(
      { networkEnv: { HTTP_PROXY: 'http://proxy:8080', NODE_EXTRA_CA_CERTS: '/c.pem' } },
      snapshot,
    );

    expect(env.CORAL_NAMESPACE).toBe('default');
    expect(env.HTTP_PROXY).toBe('http://proxy:8080');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/c.pem');
  });

  it('ignores unrecognized keys and non-string values in the body', () => {
    const env = buildControllerEnv(
      { networkEnv: { PATH: '/usr/bin', HTTPS_PROXY: 42, NO_PROXY: 'localhost' } },
      snapshot,
    );

    expect(env.PATH).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBe('localhost');
  });

  it('drops empty-string values so they do not shadow the daemon setting', () => {
    const env = buildControllerEnv({ networkEnv: { HTTP_PROXY: '', NO_PROXY: 'localhost' } }, snapshot);

    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBe('localhost');
  });

  it('still applies transport context identity fields alongside networkEnv', () => {
    const env = buildControllerEnv({ owner: 'sess-1', networkEnv: { HTTP_PROXY: 'http://p:1' } }, snapshot);

    expect(env.CORAL_OWNER).toBe('sess-1');
    expect(env.HTTP_PROXY).toBe('http://p:1');
  });

  it('leaves the env untouched when no networkEnv is present', () => {
    const env = buildControllerEnv({}, snapshot);
    expect(env).toEqual({ CORAL_NAMESPACE: 'default' });
  });
});
