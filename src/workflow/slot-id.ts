/** Parsed components of the durable `<workflow-id>:<step-index>:<atom-index>` slot-id grammar. */
export type WorkflowSlotIdParts = {
  workflowId: string;
  stepIndex: number;
  atomIndex: number;
};

function parseNonnegativeIntegerComponent(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Constructs the canonical durable workflow slot id. */
export function workflowSlotId(workflowId: string, stepIndex: number, atomIndex: number): string {
  return `${workflowId}:${stepIndex}:${atomIndex}`;
}

/** Parses the canonical durable workflow slot-id grammar without accepting partial components. */
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

/** Orders canonical slot ids by step and atom, falling back to lexical order for invalid persisted values. */
export function compareWorkflowSlotIds(left: string, right: string): number {
  const leftSlot = parseWorkflowSlotId(left);
  const rightSlot = parseWorkflowSlotId(right);
  if (leftSlot === null || rightSlot === null) {
    return left.localeCompare(right);
  }
  return leftSlot.stepIndex - rightSlot.stepIndex || leftSlot.atomIndex - rightSlot.atomIndex;
}
