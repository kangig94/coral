import { z } from 'zod';

export const identPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export const providerIdentPattern = /^[a-z][a-z0-9-]*$/;
export const AGENT_IDENT_RE = /^(?:[a-z0-9][a-z0-9-]*:)?[a-z0-9][a-z0-9-]*$/;
export const nonEmptyStringSchema = z.string().min(1);

export type WorkflowSlotIdParts = {
  workflowId: string;
  stepIndex: number;
  atomIndex: number;
};

export function readNonEmptyString(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function isOwnerId(value: unknown): value is string {
  return typeof value === 'string' && identPattern.test(value);
}

export function assertOwnerId(value: unknown, label = 'owner'): string {
  if (!isOwnerId(value)) {
    throw new Error(
      `${label} must be a non-empty token-safe identifier (alphanumeric, '.', '_', '-'; must start with alphanumeric)`,
    );
  }
  return value;
}

function parseNonnegativeIntegerComponent(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function parseWorkflowSlotId(slotId: string): WorkflowSlotIdParts | null {
  const atomSeparator = slotId.lastIndexOf(':');
  if (atomSeparator <= 0 || atomSeparator === slotId.length - 1) {
    return null;
  }

  const stepSeparator = slotId.lastIndexOf(':', atomSeparator - 1);
  if (stepSeparator <= 0 || stepSeparator === atomSeparator - 1) {
    return null;
  }

  const workflowId = slotId.slice(0, stepSeparator);
  const stepIndex = parseNonnegativeIntegerComponent(slotId.slice(stepSeparator + 1, atomSeparator));
  const atomIndex = parseNonnegativeIntegerComponent(slotId.slice(atomSeparator + 1));
  if (workflowId.length === 0 || stepIndex === null || atomIndex === null) {
    return null;
  }

  return { workflowId, stepIndex, atomIndex };
}

export function compareWorkflowSlotIds(left: string, right: string): number {
  const leftSlot = parseWorkflowSlotId(left);
  const rightSlot = parseWorkflowSlotId(right);
  if (leftSlot === null || rightSlot === null) {
    return left.localeCompare(right);
  }
  return leftSlot.stepIndex - rightSlot.stepIndex || leftSlot.atomIndex - rightSlot.atomIndex;
}
