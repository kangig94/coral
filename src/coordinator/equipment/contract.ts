import { z } from 'zod';

const equipmentNameSchema = z.string().min(1, 'Equipment name is required');

export const equipmentStatusSchema = z
  .enum(['equipped', 'catching_up', 'inactive', 'disabled_pending_reinstall', 'unavailable', 'installing']);
export type EquipmentStatus = z.infer<typeof equipmentStatusSchema>;

export const equipmentViewSchema = z
  .object({
    slot: z.string().min(1),
    name: equipmentNameSchema,
    status: equipmentStatusSchema,
  })
  .strict();
export type EquipmentView = z.infer<typeof equipmentViewSchema>;

export const registerEquipmentRequestSchema = z
  .object({
    name: equipmentNameSchema,
  })
  .strict();
export type RegisterEquipmentRequest = z.infer<typeof registerEquipmentRequestSchema>;

export const registerEquipmentStatusSchema = z.enum(['equipped', 'catching_up', 'already_equipped']);
export type RegisterEquipmentStatus = z.infer<typeof registerEquipmentStatusSchema>;

export const registerEquipmentResultSchema = z
  .object({
    status: registerEquipmentStatusSchema,
    equipment: equipmentViewSchema,
  })
  .strict();
export type RegisterEquipmentResult = z.infer<typeof registerEquipmentResultSchema>;

export const unregisterEquipmentRequestSchema = z
  .object({
    name: equipmentNameSchema,
  })
  .strict();
export type UnregisterEquipmentRequest = z.infer<typeof unregisterEquipmentRequestSchema>;

export const unregisterResultStatusSchema = z.enum(['uninstalled', 'not_equipped']);
export type UnregisterResultStatus = z.infer<typeof unregisterResultStatusSchema>;

export const unregisterResultSchema = z
  .object({
    status: unregisterResultStatusSchema,
  })
  .strict();
export type UnregisterResult = z.infer<typeof unregisterResultSchema>;

export const listEquipmentRequestSchema = z.object({}).strict();
export type ListEquipmentRequest = z.infer<typeof listEquipmentRequestSchema>;

export const listEquipmentResultSchema = z
  .object({
    equipment: z.array(equipmentViewSchema),
  })
  .strict();
export type ListEquipmentResult = z.infer<typeof listEquipmentResultSchema>;
