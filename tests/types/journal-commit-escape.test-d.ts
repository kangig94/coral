import type { CauseRef, CauseRefToken } from '#src/causality/cause-ref.js';
import type { commit, CommitContext } from '#src/store/append.js';
import type { ResolvableCoralEventInput } from '#src/store/envelope.js';
import type { WorkflowCompletedInputBody } from '#src/workflow/events.js';

type AssertAssignable<_T extends U, U> = true;
type CommitCallback = Parameters<typeof commit>[1];
type CommitAppendInput<Scope> = Parameters<CommitContext<Scope>['append']>[0];
type WorkflowInput<Scope> = ResolvableCoralEventInput<Scope, WorkflowCompletedInputBody<Scope>>;

declare const _returnsToken: <Scope>(c: CommitContext<Scope>) => CauseRefToken<Scope>;

// @ts-expect-error commit callbacks must return undefined, not tokens.
type _ReturningTokenFromClosureIsRejected = AssertAssignable<typeof _returnsToken, CommitCallback>;

// @ts-expect-error a closure-scoped token cannot be assigned to an outer token slot.
type _AssigningTokenToOuterVariableIsRejected<Scope> = AssertAssignable<CauseRefToken<Scope>, CauseRefToken<unknown>>;

// @ts-expect-error a token-bearing input from one commit scope cannot be appended in another.
type _PassingTokenToAnotherCommitClosureIsRejected<OuterScope, InnerScope> = AssertAssignable<WorkflowInput<OuterScope>, CommitAppendInput<InnerScope>>;

// @ts-expect-error persisted/read CauseRef surfaces require resolved refs, never tokens.
type _PassingTokenWherePersistedCauseRefIsRequired = AssertAssignable<CauseRefToken<unknown>, CauseRef>;
