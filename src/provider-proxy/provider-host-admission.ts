import type { HostAdmissionCollection } from '../providers/host-admission.js';
import { createBuiltInProviderHostAdmission } from '../providers/serviceability.js';

export function createProxyProviderHostAdmission(): HostAdmissionCollection {
  return createBuiltInProviderHostAdmission();
}
