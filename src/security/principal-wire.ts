import { z } from 'zod';

import { CAPABILITIES, type Capability } from './capability.js';
import type { Credential, Principal, ResourceBinding, Subject } from './principal.js';

export type PrincipalWire = {
  readonly subject: Subject;
  readonly binding: ResourceBinding;
  readonly attenuatedCaps?: Capability[];
};

export type PrincipalWireContext = {
  readonly transport?: string;
  readonly credential?: Credential;
};

const subjectSchema = z.enum(['operator', 'agent', 'system']);
const capabilitySchema = z.enum(CAPABILITIES);

const resourceBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unbound') }).strict(),
  z.object({ kind: z.literal('project'), root: z.string().min(1) }).strict(),
]);

export const principalWireSchema = z
  .object({
    subject: subjectSchema,
    binding: resourceBindingSchema,
    attenuatedCaps: z.array(capabilitySchema).optional(),
  })
  .strict();

const DEFAULT_WIRE_CONTEXT: Required<PrincipalWireContext> = {
  transport: 'wire',
  credential: { kind: 'wire', id: 'principal-wire' },
};

export function principalFromWire(wire: PrincipalWire, context: PrincipalWireContext = {}): Principal {
  return {
    subject: wire.subject,
    transport: context.transport ?? DEFAULT_WIRE_CONTEXT.transport,
    credential: context.credential ?? DEFAULT_WIRE_CONTEXT.credential,
    binding: wire.binding,
    attenuatedCaps: wire.attenuatedCaps ? new Set(wire.attenuatedCaps) : undefined,
  };
}

export function principalToWire(principal: Principal): PrincipalWire {
  return {
    subject: principal.subject,
    binding: principal.binding,
    attenuatedCaps: principal.attenuatedCaps ? [...principal.attenuatedCaps] : undefined,
  };
}

export function parsePrincipalWire(value: unknown, context: PrincipalWireContext = {}): Principal | null {
  const parsed = principalWireSchema.safeParse(value);
  return parsed.success ? principalFromWire(parsed.data, context) : null;
}
