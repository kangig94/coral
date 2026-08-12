import { createHostAdmissionCollection, type HostAdmissionCollection } from '../providers/host-admission.js';
import { classifyProviderResponseServiceability } from '../providers/serviceability.js';

export function createProxyProviderHostAdmission(): HostAdmissionCollection {
  return createHostAdmissionCollection({ classify: classifyProviderResponseServiceability });
}
