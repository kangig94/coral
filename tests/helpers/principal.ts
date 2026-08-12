import type { Principal, ResourceBinding, Subject } from '#src/security/principal.js';

import { fixtureCanonicalWorkDir } from './canonical-work-dir.js';

type TestPrincipalOptions = {
  readonly subject?: Subject;
  readonly transport?: string;
  readonly credentialId?: string;
  readonly binding?: ResourceBinding;
};

export function testPrincipal(options: TestPrincipalOptions = {}): Principal {
  return {
    subject: options.subject ?? 'operator',
    transport: options.transport ?? 'test',
    credential: { kind: 'test', id: options.credentialId ?? 'principal' },
    binding: options.binding ?? { kind: 'unbound' },
  };
}

export function testProjectPrincipal(
  projectRoot: string,
  options: Omit<TestPrincipalOptions, 'binding'> = {},
): Principal {
  return testPrincipal({ ...options, binding: { kind: 'project', root: fixtureCanonicalWorkDir(projectRoot) } });
}
