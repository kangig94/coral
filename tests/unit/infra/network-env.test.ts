import { describe, expect, it } from 'vitest';

import { collectForwardedNetworkEnv } from '#src/infra/network-env.js';

describe('collectForwardedNetworkEnv', () => {
  it.each([
    ['HTTP_PROXY', 'http://proxy:8080', true],
    ['no_proxy', 'localhost,127.0.0.1', true],
    ['NODE_EXTRA_CA_CERTS', '/etc/ssl/corp.pem', true],
    ['http_proxy', 'http://p:1', true],
    ['https_proxy', 'http://p:2', true],
    ['all_proxy', 'socks5://p:3', true],
    ['ftp_proxy', 'ftp://p:4', true],
    ['ALL_PROXY', 'socks5://proxy:1080', true],
    ['HTTPS_PROXY', '', false],
    ['HOME', '/home/dev', false],
    ['CLAUDE_CODE_SESSION_ID', 'abc', false],
  ] as const)('forwards %s only when recognized and non-empty', (key, value, forwarded) => {
    expect(collectForwardedNetworkEnv({ [key]: value })).toEqual(forwarded ? { [key]: value } : {});
  });
});
