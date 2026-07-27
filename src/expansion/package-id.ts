import { isKbRuntimeAuthority } from '../kb/runtime-authority.js';

const PACKAGE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u;

export type ExpansionPackageIdValidation =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: 'unsafe' | 'reserved' };

export function validateCanonicalExpansionPackageId(id: string): ExpansionPackageIdValidation {
  if (!PACKAGE_ID_PATTERN.test(id) || WINDOWS_DEVICE_NAME_PATTERN.test(id)) {
    return { ok: false, reason: 'unsafe' };
  }
  return { ok: true, id };
}

export function validateExpansionPackageId(id: string): ExpansionPackageIdValidation {
  const canonical = validateCanonicalExpansionPackageId(id);
  if (!canonical.ok) {
    return canonical;
  }
  if (isKbRuntimeAuthority(id) || isKbRuntimeAuthority(`${id}-staging`)) {
    return { ok: false, reason: 'reserved' };
  }
  return { ok: true, id };
}

export function assertExpansionPackageId(id: string): string {
  const result = validateExpansionPackageId(id);
  if (!result.ok) {
    throw new Error(`Expansion package id '${id}' is ${result.reason}`);
  }
  return result.id;
}
