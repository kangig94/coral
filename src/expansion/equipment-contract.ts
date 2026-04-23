import { z } from 'zod';

const equipmentNameSchema = z.string().min(1, 'Equipment name is required');

/** Distinguishes durable ownership from live registration so CLI surfaces restart and reinstall states accurately. */
export const equipmentStatusSchema = z
  .enum([
    'equipped',
    'catching_up',
    'inactive',
    'unavailable',
    'disabled_pending_reinstall',
    'installing',
    'not_equipped',
  ]);
/** Reuses the shared equipment status union across RPC and CLI codepaths. */
export type EquipmentStatus = z.infer<typeof equipmentStatusSchema>;

/** Carries the slot-local coordinator view the CLI renders directly. */
export const equipmentViewSchema = z
  .object({
    slot: z.string().min(1),
    name: equipmentNameSchema,
    status: equipmentStatusSchema,
  })
  .strict();
/** Keeps equipment inventory reads aligned with the coordinator-owned slot model. */
export type EquipmentView = z.infer<typeof equipmentViewSchema>;

/** Normalizes registration requests so equipment RPC can validate the catalog name once. */
export const registerEquipmentRequestSchema = z
  .object({
    name: equipmentNameSchema,
  })
  .strict();
/** Encodes whether activation did work or found a live registration already in place. */
export type RegisterEquipmentRequest = z.infer<typeof registerEquipmentRequestSchema>;

/** Lets callers distinguish new activation, catchup, and already-live registrations without client rewrites. */
export const registerEquipmentStatusSchema = z.enum(['equipped', 'catching_up', 'already_equipped']);
/** Mirrors the coordinator activation outcomes the CLI reports to users. */
export type RegisterEquipmentStatus = z.infer<typeof registerEquipmentStatusSchema>;

/** Returns the post-register equipment view so callers can render catchup and restart states directly. */
export const registerEquipmentResultSchema = z
  .object({
    status: registerEquipmentStatusSchema,
    equipment: equipmentViewSchema,
  })
  .strict();
/** Binds the activation outcome to the authoritative coordinator view of the slot. */
export type RegisterEquipmentResult = z.infer<typeof registerEquipmentResultSchema>;

/** Keeps uninstall requests symmetric with register requests for transport validation. */
export const unregisterEquipmentRequestSchema = z
  .object({
    name: equipmentNameSchema,
  })
  .strict();
/** Preserves uninstall idempotence while still distinguishing a real detach from an already-clear slot. */
export type UnregisterEquipmentRequest = z.infer<typeof unregisterEquipmentRequestSchema>;

/** Exposes the only two uninstall outcomes the coordinator promises. */
export const unregisterResultStatusSchema = z.enum(['uninstalled', 'not_equipped']);
/** Lets callers branch on idempotent uninstall without reinterpreting transport errors. */
export type UnregisterResultStatus = z.infer<typeof unregisterResultStatusSchema>;

/** Models uninstall as an explicit tagged union so the transport contract matches the public API. */
export const unregisterResultSchema = z.union([
  z.object({ status: z.literal('uninstalled') }).strict(),
  z.object({ status: z.literal('not_equipped') }).strict(),
]);
/** Keeps the uninstall result aligned with its tagged union schema. */
export type UnregisterResult = z.infer<typeof unregisterResultSchema>;

/** Leaves room for list options without changing the RPC shape later. */
export const listEquipmentRequestSchema = z.object({}).strict();
/** Documents the empty input object used by equipment list RPCs. */
export type ListEquipmentRequest = z.infer<typeof listEquipmentRequestSchema>;

/** Wraps list output so transport framing can evolve without changing item semantics. */
export const listEquipmentResultSchema = z
  .object({
    equipment: z.array(equipmentViewSchema),
  })
  .strict();
/** Reuses the coordinator-owned view items for list responses. */
export type ListEquipmentResult = z.infer<typeof listEquipmentResultSchema>;
