import { describe, expect, it } from 'vitest';

import { SOCKET_FALLBACK_HASH_LENGTH, socketFallbackDir, socketPathByteLimit } from '#src/infra/path/coordinator.js';

/**
 * Both socket resolvers relocate to `socketFallbackDir` when the path beside the run directory exceeds
 * `sun_path`. That fallback is the last address available: there is nowhere shorter to go, and returning a
 * path nothing can bind produces `listen EINVAL` naming no limit, no byte count and no variable to change.
 *
 * Nothing at runtime checks it. The name schemes and the platform limits are numbers set independently in
 * files that reference each other for the limit and not for the length, which is the shape that put a
 * ten-mebibyte cap under a ten-mebibyte budget elsewhere in this tree. So the check lives here, and it
 * demands a margin rather than an ordering: a name that merely fits is a name that breaks the first time a
 * field is added to what it encodes.
 *
 * The uid is the only unbounded input. It is typed `number`, so the worst case is not the largest plausible
 * uid but the longest string any `number` produces — the assertions below use that, so the guarantee holds
 * for every value the parameter can hold rather than every value an operating system is likely to hand it.
 */
describe('a relocated socket path fits AF_UNIX on every platform', () => {
  const HEADROOM_RATIO = 0.75;
  // `Number.MAX_VALUE` stringifies longer than any integer uid, `Number.isSafeInteger` guard or not.
  const WIDEST_UID = Number.MAX_VALUE;
  const PLATFORMS = ['darwin', 'linux'] as const;

  // `coral-<flavor>-<hash>.sock`, with the longest flavor.
  const coordinatorFilename = `coral-prod-${'f'.repeat(SOCKET_FALLBACK_HASH_LENGTH)}.sock`;
  // `provider-<role prefix><hash>.sock`; the prefix is one character.
  const providerFilename = `provider-${'f'.repeat(24)}.sock`;

  it.each(PLATFORMS)('keeps the coordinator fallback well under the %s limit', (platform) => {
    const worst = `${socketFallbackDir(WIDEST_UID)}/${coordinatorFilename}`;
    expect(Buffer.byteLength(worst, 'utf8')).toBeLessThan(socketPathByteLimit(platform) * HEADROOM_RATIO);
  });

  it.each(PLATFORMS)('keeps a provider endpoint fallback well under the %s limit', (platform) => {
    const worst = `${socketFallbackDir(WIDEST_UID)}/${providerFilename}`;
    expect(Buffer.byteLength(worst, 'utf8')).toBeLessThan(socketPathByteLimit(platform) * HEADROOM_RATIO);
  });

  it('leaves the fallback directory itself far short of the limit, so a longer name is what would break', () => {
    expect(Buffer.byteLength(socketFallbackDir(WIDEST_UID), 'utf8')).toBeLessThan(socketPathByteLimit('darwin') * 0.4);
  });
});
