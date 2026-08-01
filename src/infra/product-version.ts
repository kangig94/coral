declare const __VERSION__: string;

import semver from 'semver';

const DEVELOPMENT_PRODUCT_VERSION = '0.0.0';

export function validateProductVersion(version: string): string | null {
  return semver.valid(version);
}

/**
 * Compares SemVer precedence as `left` versus `right`: negative means `left`
 * is older, zero means equal precedence, and positive means newer. Build
 * metadata is ignored as required by SemVer 2.0.
 */
export function compareProductVersions(left: string, right: string): number {
  return semver.compare(left, right);
}

export function currentProductVersion(): string {
  const version = typeof __VERSION__ === 'string' ? __VERSION__ : DEVELOPMENT_PRODUCT_VERSION;
  const validVersion = validateProductVersion(version);
  if (validVersion === null) {
    throw new Error(`Invalid Coral product version: ${version}`);
  }
  return validVersion;
}
