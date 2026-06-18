import { describe, expect, it } from 'vitest';

import { collectForwardedNetworkEnv, networkEnvSchema } from '#src/infra/network-env.js';

describe('collectForwardedNetworkEnv', () => {
  it('picks recognized proxy and CA keys, preserving case and value', () => {
    const result = collectForwardedNetworkEnv({
      HTTP_PROXY: 'http://proxy:8080',
      no_proxy: 'localhost,127.0.0.1',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
    });

    expect(result).toEqual({
      HTTP_PROXY: 'http://proxy:8080',
      no_proxy: 'localhost,127.0.0.1',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
    });
  });

  it('forwards lower-case proxy spellings', () => {
    const result = collectForwardedNetworkEnv({
      http_proxy: 'http://p:1',
      https_proxy: 'http://p:2',
      all_proxy: 'socks5://p:3',
      ftp_proxy: 'ftp://p:4',
    });

    expect(result).toEqual({
      http_proxy: 'http://p:1',
      https_proxy: 'http://p:2',
      all_proxy: 'socks5://p:3',
      ftp_proxy: 'ftp://p:4',
    });
  });

  it('drops empty and unrecognized variables', () => {
    const result = collectForwardedNetworkEnv({
      HTTPS_PROXY: '',
      HOME: '/home/dev',
      CLAUDE_CODE_SESSION_ID: 'abc',
      ALL_PROXY: 'socks5://proxy:1080',
    });

    expect(result).toEqual({ ALL_PROXY: 'socks5://proxy:1080' });
  });
});

describe('networkEnvSchema', () => {
  it('accepts a record limited to known keys', () => {
    expect(networkEnvSchema.parse({ HTTPS_PROXY: 'http://p:1', NO_PROXY: 'x' })).toEqual({
      HTTPS_PROXY: 'http://p:1',
      NO_PROXY: 'x',
    });
  });

  it('rejects unknown keys', () => {
    const result = networkEnvSchema.safeParse({ PATH: '/usr/bin' });
    expect(result.success).toBe(false);
  });

  it('rejects non-string values', () => {
    const result = networkEnvSchema.safeParse({ HTTP_PROXY: 123 });
    expect(result.success).toBe(false);
  });

  it('rejects empty string values', () => {
    const result = networkEnvSchema.safeParse({ HTTP_PROXY: '' });
    expect(result.success).toBe(false);
  });
});
