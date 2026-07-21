import type { CauseRef, CauseRefToken } from '#src/causality/cause-ref.js';
import type { commit, CommitContext } from '#src/store/append.js';
import type { ResolvableCoralEventInput } from '#src/store/envelope.js';
import type { WorkflowCompletedInputBody } from '#src/workflow/events.js';

type AssertAssignable<_T extends U, U> = true;
type CommitCallback = Parameters<typeof commit>[1];
type CommitAppendInput<Scope> = Parameters<CommitContext<Scope>['append']>[0];
type WorkflowInput<Scope> = ResolvableCoralEventInput<Scope, WorkflowCompletedInputBody<Scope>>;
declare const OUTER_SCOPE: unique symbol;
declare const INNER_SCOPE: unique symbol;
type OuterScope = { readonly [OUTER_SCOPE]: 'outer' };
type InnerScope = { readonly [INNER_SCOPE]: 'inner' };

declare const _returnsToken: <Scope>(c: CommitContext<Scope>) => CauseRefToken<Scope>;
declare const _innerContext: CommitContext<InnerScope>;
declare const _outerToken: CauseRefToken<OuterScope>;
declare const _unknownBody: unknown;
declare const _anyBody: any;

// @ts-expect-error commit callbacks must return undefined, not tokens.
type _ReturningTokenFromClosureIsRejected = AssertAssignable<typeof _returnsToken, CommitCallback>;

// @ts-expect-error a closure-scoped token cannot be assigned to an outer token slot.
type _AssigningTokenToOuterVariableIsRejected<Scope> = AssertAssignable<CauseRefToken<Scope>, CauseRefToken<unknown>>;

type _PassingTokenToAnotherCommitClosureIsRejected<OuterScope, InnerScope> = AssertAssignable<
  // @ts-expect-error a token-bearing input from one commit scope cannot be appended in another.
  WorkflowInput<OuterScope>,
  CommitAppendInput<InnerScope>
>;

// @ts-expect-error persisted/read CauseRef surfaces require resolved refs, never tokens.
type _PassingTokenWherePersistedCauseRefIsRequired = AssertAssignable<CauseRefToken<unknown>, CauseRef>;

_innerContext.append({
  type: 'job.terminal.recorded',
  stream: { kind: 'job', id: 'job-raw-reintro' },
  refs: { jobId: 'job-raw-reintro' },
  bodyVersion: 1,
  // @ts-expect-error raw object literals cannot reintroduce a token from another commit scope.
  body: {
    terminal: {
      content: '',
      outcome: { kind: 'failed', causeRef: _outerToken },
      durationMs: 0,
    },
  },
});

_innerContext.append({
  type: 'job.progress.emitted',
  stream: { kind: 'job', id: 'job-unknown-body' },
  refs: { jobId: 'job-unknown-body' },
  bodyVersion: 1,
  // @ts-expect-error whole-body unknown payloads cannot enter the token-accepting append boundary.
  body: _unknownBody,
});

_innerContext.append({
  type: 'job.progress.emitted',
  stream: { kind: 'job', id: 'job-any-body' },
  refs: { jobId: 'job-any-body' },
  bodyVersion: 1,
  body: _anyBody,
});
