import type {
  AssertHandoffRefusalCodesCoverContext,
  AssertHandoffRefusalContextCoversCodes,
  HandoffRefusalCode,
  HandoffRefusalContextByCode,
  HandoffRefusalInit,
} from '../../src/runtime/errors.js';

type AssertNever<Value extends never> = Value;

type ContextCoversCodes = AssertNever<Exclude<HandoffRefusalCode, keyof HandoffRefusalContextByCode>>;
type CodesCoverContext = AssertNever<Exclude<keyof HandoffRefusalContextByCode, HandoffRefusalCode>>;
type ExportedContextCoversCodes = AssertNever<AssertHandoffRefusalContextCoversCodes>;
type ExportedCodesCoverContext = AssertNever<AssertHandoffRefusalCodesCoverContext>;

const mismatchedConstructorInit: HandoffRefusalInit = {
  code: 'handoff_manual_policy',
  // @ts-expect-error a handoff refusal code must be paired with that code's exact context.
  context: { stage: 'handoff-deadline', socketPath: '/tmp/coral.sock' },
};

void (0 as ContextCoversCodes);
void (0 as CodesCoverContext);
void (0 as ExportedContextCoversCodes);
void (0 as ExportedCodesCoverContext);
void mismatchedConstructorInit;
