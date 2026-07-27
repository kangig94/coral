import { isKbRuntimeAuthority } from '../runtime/kb-runtime-authority.js';
import {
  validateCanonicalExpansionPackageId,
  type CanonicalExpansionPackageIdValidation,
} from './canonical-package-id.js';

export { validateCanonicalExpansionPackageId };

export type ExpansionPackageIdValidation =
  | CanonicalExpansionPackageIdValidation
  | { readonly ok: false; readonly reason: 'reserved' };

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
