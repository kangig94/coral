const PACKAGE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u;

export type CanonicalExpansionPackageIdValidation =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: 'unsafe' };

export function validateCanonicalExpansionPackageId(id: string): CanonicalExpansionPackageIdValidation {
  if (!PACKAGE_ID_PATTERN.test(id) || WINDOWS_DEVICE_NAME_PATTERN.test(id)) {
    return { ok: false, reason: 'unsafe' };
  }
  return { ok: true, id };
}
