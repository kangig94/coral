# Provider multi-account execution: most-elegant target design

Status: B09 implementation, tier-review remediation, and full verification complete; temporary-document cleanup remains

Scope: provider multi-account execution merged by PR #275 and the provider/session/app-server/recovery boundaries it exposes

Audience: Coral maintainers implementing the provider-account refactoring

## Decision

Adopt the complete fresh-context Pioneer design as the target architecture.

Coral remains one shared, account-neutral daemon. Provider profile choice enters at an explicit invocation boundary, becomes a strict durable provider binding with whatever identity guarantee that provider can prove, and is then owned by one provider module through normal execution and recovery. Coral security authority remains independent of provider identity.

The target flow is:

```text
Coral Principal
  `- may invoke Coral

ProviderScope(origin)
  -> ProviderSelection
  -> CredentialProfile
  -> ProviderBinding(profile + provider-specific identity guarantee)
  -> BoundProvider
  -> ProviderExecutionPlan(host / session / turn)
  -> AppServerSession
  -> provider result

recovery
  -> persisted ProviderBindingEnvelope
  -> BoundProvider
  -> plan -> perform -> finalize
```

This supersedes the earlier, narrower proposal in four important ways:

1. A path-only value is not named `AccountBinding`; it is a credential profile or, when persisted without verifiable identity, a `ProfileBinding`.
2. Provider modules return a cohesive `BoundProvider`, rather than exposing account, execution, recovery, and artifact facets for generic code to coordinate separately.
3. Persisted `ProviderSession` records represent provider conversations only. Workflow and discussion aggregates own provider scope directly instead of allocating synthetic provider sessions. The discussion domain's `discuss.session.*` event names describe its own aggregate vocabulary; they are not records in the provider-session domain and do not carry provider continuity.
4. Process configuration is separated by lifetime. A per-turn callback capability cannot be part of a reusable app-server host specification.

## Architectural boundary

This is a deep refactoring, but it is not a rejection of Coral's overall architecture. The following structures remain authoritative:

- one shared daemon and one installation/state discovery boundary;
- Journal commits and projections as Coral's durable state model;
- coordinator ownership of durable finalization;
- full executable process specification as the host reuse key;
- closed, allowlisted provider environments;
- Claude's account-neutral broker and account-bound controller topology;
- destructive reset of an incompatible Coral store rather than legacy-layout migration.

The refactoring changes adjacent domains only where the new provider/account model reveals a false concept or an impossible lifetime:

- workflow and discussion stop masquerading as provider sessions;
- app-server acquisition exposes an explicit session and stable host reference;
- interrupted recovery re-enters through the same bound provider used by normal execution;
- the reset fingerprint expands from DDL to the complete persisted contract.

## Goals

- Make caller authority, credential routing, and provider account identity impossible to confuse.
- Make provider/account mismatch unrepresentable after binding.
- Ensure every provider execution starts from an explicit caller or configured-system scope.
- Give each provider one vertical owner for binding, execution, app-server behavior, recovery interpretation, and artifacts.
- Express process, provider-session, and turn lifetimes in the execution plan.
- Make reusable-host identity contain only process-static values.
- Make normal execution and recovery share binding and preparation logic.
- Make one fingerprint answer whether the current build can read the complete Coral store.
- Preserve account isolation, exact-environment isolation, and fail-closed resume/recovery behavior.

## Non-goals

- One daemon per account.
- Including account identity in the Coral state root or daemon discovery key.
- Modifying Orca or requiring an Orca-specific Coral daemon.
- Persisting provider tokens, auth files, callback credentials, or other secrets.
- Guessing provider identity from the daemon environment during resume or recovery.
- Replacing the full executable-specification host key with an account digest.
- Moving Journal/CAS/admission/terminal finalization into provider code.
- Supporting legacy store migration. Adoption intentionally resets an incompatible store.

## Baseline structural contradictions before this refactoring

This section records the pre-B01 baseline that motivated the plan. B01-B06 have corrected the store-manifest foundation, explicit scope origin, canonical profile capture, verified/profile-only binding distinctions, aggregate ownership, bound-provider execution, and lifetime-scoped execution planning. Any remaining baseline descriptions below are historical motivation or post-B06 target-state gaps, not supported alternate behavior or compatibility promises.

### A locator is described as account authority

`ProviderCredentialSourceRef` contains routing locations such as `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. Lexical path equality does not prove that two paths identify the same physical profile, nor that one directory still contains credentials for the same account after reauthentication. Calling this value account authority or directly renaming it `AccountBinding` overstates its guarantee.

### Account origin is implicit outside IPC

IPC carries caller selections, while HTTP and daemon-internal work inherit boot-captured provider defaults. The daemon is account-neutral in topology but ambient account state still affects execution policy.

### Provider knowledge escapes provider modules

A central Claude/Codex union and `ProviderExecutionContext` require runtime, transport, coordinator, recovery, and artifact code to narrow provider-specific values. Correctness depends on several generic surfaces switching in the same way.

### Session represents two unrelated concepts

Provider conversations and workflow ownership both use `SessionEntry`. A workflow synthetic session has `model: 'workflow'`, an arbitrary provider, and orchestration authority even though the workflow is the actual durable aggregate. Real provider sessions also store provider identity redundantly.

### Codex host sharing contradicts its specification

Codex advertises a shared app server, but its host specification includes the job-specific `CORAL_CHILD_PRINCIPAL_HANDLE`. Because the host key correctly covers the complete executable specification, each job produces a different host. The sharing declaration and configuration lifetime disagree.

### Live and recovered app-server lifecycles have separate owners

Runtime middleware and recovery declare related app-server behavior independently. WeakMaps hide leases and notification state. Recovery rebuilds secret-bearing specifications with newly issued credentials to try to rediscover an existing host.

### Recovery recreates provider preparation

Interrupted recovery validates binding, issues callback authority, builds execution context, probes or falls back to artifacts, performs effects, and durably finalizes inside one service. It is a second partial implementation of provider preparation.

### Store format identity has several incomplete authorities

DDL hashing cannot see incompatible TypeScript/Zod persistence changes. Local `version: 1` fields do not select decoders. Event and projection versions coexist with an empty migration story. `meta.journal_version` is not read. None alone describes the actual reset boundary.

## Target vocabulary and invariants

### Coral authority

`Principal` and callback/child-principal credentials remain Coral security concepts.

- `Principal`: who may invoke Coral.
- Callback principal: what a child provider process or turn may call back.
- Neither identifies a provider account.

### Provider selection

`ProviderSelection` is provider-owned input captured at an invocation or daemon-configuration boundary. Filesystem selectors must already be absolute; shell expansion and relative-path interpretation are caller concerns. A selection is still unsuitable for persistence until the provider resolves it to a physical canonical profile, and it is never used directly for execution.

### Credential profile

`CredentialProfile` is the provider-owned, canonical, non-secret description of where and how the provider resolves credentials.

```ts
type CredentialProfile = {
  canonicalLocation: AbsolutePath;
  routing: JsonValue;
};
```

Canonicalization resolves the physical location when possible, not merely lexical `..` segments. Provider-specific routing state records semantics such as whether an explicit Claude selector must be emitted. Derived paths such as Claude artifact roots are computed by the provider and are not redundantly persisted.

### Account subject

`AccountSubject` is stable, provider-issued, non-secret identity obtained by provider-specific introspection.

```ts
type AccountSubject = {
  issuer: string;
  subject: string;
};
```

Display names, emails, access tokens, and auth file contents are not identity keys. Logs and user messages use provider-owned safe presentation rather than dumping the subject or profile path.

### Provider binding

An account binding fixes credential routing and a verified provider identity together:

```ts
type ProviderBinding<P, S> = {
  profile: P;
  subject: S;
};

type ProfileBinding<P> = {
  profile: P;
  guarantee: 'profile-only';
};
```

Account binding succeeds only after the provider verifies the subject available through the canonical profile. Resume and recovery reverify that the profile still resolves to the persisted subject.

If a provider cannot expose a stable subject, it declares that limitation and produces `ProfileBinding<P>`. Its readiness check proves only that the same canonical profile and required routing are available; it cannot report subject mismatch. Generic code preserves the distinction and never relabels profile readiness as account readiness.

### Persisted envelope

Provider-private binding types cross Journal and registry boundaries in a provider-owned envelope:

```ts
type ProviderBindingEnvelope = {
  provider: string;
  kind: 'account' | 'profile';
  binding: JsonValue;
};
```

The envelope contains no local inert version. Its codec participates in the complete store fingerprint. Only the provider owning `provider` may decode the payload.

### Provider scope

Every launch-capable invocation carries explicit origin:

```ts
type ProviderProfileEnvelope = {
  provider: string;
  profile: JsonValue;
};

type ProviderProfileSet = ReadonlyArray<ProviderProfileEnvelope>;

type ProviderScope =
  | {
      origin: 'caller';
      profiles: ProviderProfileSet;
    }
  | {
      origin: 'system';
      name: string;
      profiles: ProviderProfileSet;
    };
```

There is no generic default provider scope.

- A scope contains at most one profile for each registered provider and is complete for the set of providers its owner may launch. Duplicate, unknown, extra-secret-bearing, or malformed profiles fail provider-owned decoding before persistence.
- The CLI captures and canonicalizes a caller scope from the invoking process; IPC only transports that already-decoded scope.
- The CLI resolves caller-default Claude and Codex profiles explicitly; the daemon does not substitute its own default.
- HTTP provider execution requires a configured named system scope or is rejected.
- The daemon parses the named system scope at boot and the registry decodes every profile through its owning provider codec before the listener becomes launch-capable.
- KB curation and other daemon-internal provider work require an explicit named system scope.
- Workflow and discussion children use the scope persisted by their parent aggregate.
- Resume compares the current caller binding with the session binding.
- Recovery reads only the persisted binding.

## Provider ownership: `BoundProvider`

### One vertical provider module

Each provider owns:

- selection codec and capture interpretation;
- profile canonicalization;
- subject introspection when supported;
- binding codec and safe presentation;
- readiness and preflight;
- process/session/turn execution-plan compilation;
- kernel execution;
- app-server acquisition and lifecycle;
- provider recovery interpretation;
- artifact location and continuity evidence.

The stable ownership boundary matters more than a proposed per-file catalog:

| Role                                                                  | Owner                                         | Stable navigation point                                      |
| --------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| Provider selection, profile, binding, readiness, and safe errors      | Each provider vertical                        | `src/providers/{provider}/`                                  |
| Registered provider orchestration and lookup                          | Provider registry                             | `src/providers/registry.ts`                                  |
| Private type erasure, parser, runtime, lease, and snapshot boundaries | Provider registry internals                   | `src/providers/internal/`, `src/providers/binding-parser.ts` |
| Generic provider contracts                                            | Provider contracts                            | `src/providers/contracts/`                                   |
| Caller/system scope transport and validation                          | Transport plus provider registry              | `src/transport/`, `src/infra/provider-scope.ts`              |
| Provider conversation continuity                                      | Provider-session domain                       | `src/sessions/`                                              |
| Workflow/discussion aggregate lifecycle and future child scope        | Owning aggregate                              | `src/workflow/`, `src/discuss/`                              |
| Generic execution-owner vocabulary                                    | Runtime contract used by jobs and coordinator | `src/runtime/execution-owner.ts`                             |
| Admission, job persistence, and durable finalization                  | Coordinator/jobs                              | `src/coordinator/`, `src/jobs/`                              |
| Store readability and persisted-codec manifest                        | Store boundary                                | `src/store/`                                                 |

Files may move as later batches collapse superseded surfaces. The invariant is that provider interpretation stays inside its provider vertical, while transport and coordinator retain only boundary policy and Coral durability.

### Binding transition

Each provider registers one private type-erased closure boundary. The public `ProviderDefinition` remains an inert, branded name token; it exposes none of these operations:

```ts
interface ProviderRegistrationBoundary<Selection, Profile, Subject, Prepared> {
  capture(input: unknown): ProviderBindingResult<Selection>;
  canonicalize(selection: Selection): Promise<ProviderBindingResult<Profile>>;
  bind(profile: Profile): Promise<ProviderBindingResult<ProviderBinding<Profile, Subject> | ProfileBinding<Profile>>>;
  rehydrate(envelope: ProviderBindingEnvelope): ProviderBindingResult<BoundProvider>;
}
```

`rehydrate()` validates the provider-owned codec and returns a closure capturing the private binding and prepared types:

```ts
interface BoundProvider {
  readonly name: string;
  readonly envelope: ProviderBindingEnvelope;

  readiness(use: 'launch' | 'resume' | 'recovery'): Promise<ProviderBindingResult<ProviderReadiness>>;
  prepare(input: ProviderExecutionInput): ProviderBindingResult<ProviderExecutionPlan>;
  preflight(plan: ProviderExecutionPlan): Promise<void>;
  execute(plan: ProviderExecutionPlan): Promise<ProviderResult>;
  recover(input: ProviderRecoveryInput): Promise<ProviderRecoveryPlan>;
  artifacts(input: ProviderArtifactInput): ProviderArtifactPlan;
}
```

The exact generic types may differ in implementation. The load-bearing invariant is that generic code cannot execute an unbound provider or inspect provider-private preparation data.

### Failure vocabulary

Expected failures remain typed values:

```ts
type ProviderBindingFailure =
  | { reason: 'missing-profile'; provider: string }
  | { reason: 'profile-unavailable'; provider: string; selector: string }
  | { reason: 'identity-unavailable'; provider: string }
  | { reason: 'profile-mismatch'; provider: string }
  | { reason: 'subject-mismatch'; provider: string }
  | { reason: 'unsupported-selection'; provider: string; selector: string }
  | { reason: 'invalid-persisted-binding'; provider: string };
```

Provider modules own selector labels and safe rendering details. Coordinator code maps typed outcomes to protocol errors but does not know `CODEX_HOME` or `CLAUDE_CONFIG_DIR` semantics.

| Failure                     | Meaning at the boundary                                               | Safe next action owned by provider rendering                   |
| --------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------- |
| `missing-profile`           | the explicit scope has no profile for the requested provider          | select that provider profile                                   |
| `profile-unavailable`       | the canonical profile cannot be resolved or read                      | restore or authenticate the selected directory                 |
| `identity-unavailable`      | an account-binding provider cannot derive a consistent stable subject | authenticate the profile so its provider identity is available |
| `profile-mismatch`          | resume selected another physical profile                              | use the original profile or start a new session                |
| `subject-mismatch`          | the same Codex profile now routes to another workspace                | restore the original workspace login or start a new session    |
| `unsupported-selection`     | an alternate override or malformed scope was used                     | remove the override and use the provider's profile selector    |
| `invalid-persisted-binding` | the strict current provider codec rejected durable data               | stop before execution and create fresh valid state             |

## Aggregate model

### Provider sessions only

`ProviderSession` represents one resumable provider conversation. The implemented persistence type contains the following load-bearing fields; operational policy, artifact, controller, path, and timestamp fields are omitted from this structural excerpt:

```ts
type ProviderSession = {
  sessionId: string;
  binding: ProviderBindingEnvelope;
  state: SessionState;
  providerContinuity: ProviderContinuityBlob | null;
  // ...retention, artifacts, active job, model, paths, controller, and timestamps
};
```

The provider is derived from `binding.provider`. A second provider field does not exist.

### Workflow and discussion own provider scope

Workflow and discussion aggregates persist the provider scope or a durable provider-profile-set envelope needed to bind future child conversations. They own their lifecycle directly and reference real child `ProviderSessionId` values when created.

They do not create:

- `model: 'workflow'` sessions;
- orchestration session authority;
- arbitrary placeholder providers;
- workflow IDs disguised as provider-session IDs.

### Execution ownership is independent

If admission, jobs, terminals, or projections need a common owner, model it explicitly:

```ts
type ExecutionOwner =
  | { kind: 'provider-session'; id: ProviderSessionId }
  | { kind: 'workflow'; id: WorkflowId }
  | { kind: 'discussion'; id: DiscussionId }
  | { kind: 'system-task'; id: SystemTaskId };
```

`ExecutionOwner` answers which aggregate owns work. It does not imply provider continuity or credential binding.

## Lifetime-scoped execution plans

### Required shape

Provider preparation compiles explicit lifetimes:

```ts
type ProviderExecutionPlan = {
  host: HostExecutionScope;
  session: SessionExecutionScope;
  turn: TurnExecutionScope;
};
```

#### Host scope

Process-static values only:

- provider executable and arguments;
- cwd;
- stable allowlisted network and CA configuration;
- credential routing required by the process;
- stable provider protocol mode;
- other values identical for every lease of that host.

#### Session scope

Provider-conversation values:

- provider thread/session identity;
- continuity state;
- session-scoped routing supported by the provider protocol;
- an account-bound app-server association.

#### Turn scope

One invocation/job/turn only:

- Coral lineage;
- callback principal handle or equivalent capability;
- request-specific provider input;
- cancellation and interruption state;
- per-turn notification routing.

### Exact environment composition

Environment values retain provenance and lifetime:

```ts
type EnvironmentLayer = {
  name: string;
  lifetime: 'host' | 'session' | 'turn';
  provenance: string;
  values: Readonly<Record<string, string>>;
  writes: readonly string[];
  protects: readonly string[];
};
```

The exact-environment compiler owns platform case folding, allowlists, collision rejection, precedence, and protected writes. `writes` and `protects` are canonical sorted arrays so the plan remains plain immutable snapshot data; mutable `Set` instances are not part of the plan contract. Provider modules own which selectors and stable settings belong to each process.

Named topologies remain explicit:

```text
Claude broker host:
  account-neutral host layers

Claude controller host:
  stable account-bound host layers
  + session/turn capability through its supported channel

Codex app-server host:
  stable account-bound host layers
  + immutable per-thread configuration carrying turn capability through protocol
```

### Codex sharing decision

Codex delivers `CORAL_CHILD_PRINCIPAL_HANDLE` and lineage through immutable thread configuration after opening a host. They never enter the reusable host specification or process environment. The verified app-server topology therefore declares:

```ts
leaseMode: 'shared';
```

Each turn snapshots one `threadConfig`. New and resumed threads reuse that captured value rather than rebuilding authority from ambient process state. Thread and turn ids filter notifications and cancellation, so concurrent turns on one host cannot observe or interrupt one another.

## App-server capability

### One provider-owned lifecycle

Each app-server provider exposes one declarative capability. Rehydration binds it once to the registry-captured host authority, producing the only operational lifecycle used by execution, curation, and recovery:

```ts
interface ProviderAppServerCapability<Plan extends ProviderExecutionPlan, Access extends ProviderAccess> {
  readonly name: string;
  planHost(input: ProviderHostPlanningInput<Access>): Plan['host'];
  compileStableHost(host: Plan['host']): ProviderServerSpec;
  interrupt?(transport: AppServerTransport, continuity: ProviderContinuityBlob): Promise<boolean>;
  probe?(
    transport: AppServerTransport,
    continuity: ProviderContinuityBlob,
    context: Readonly<{ request: Pick<ProviderRequest, 'cwd'> }>,
  ): Promise<{ resumable: boolean; updatedContinuity?: ProviderContinuityBlob }>;
  onNotification?(message: AppServerNotificationMessage): void;
}

interface AppServerTransport {
  rpc<R = unknown>(method: string, params: Record<string, unknown>): Promise<R>;
  subscribe(handler: (message: AppServerNotificationMessage) => void): () => void;
  readonly closed: Promise<Error | void>;
}

interface AppServerSession extends AppServerTransport {
  interrupt(continuity: ProviderContinuityBlob): Promise<boolean>;
}
```

The composition root connects the registry's private host authority to the host manager. Below that boundary, the bound lifecycle alone opens and attaches managed sessions, pins hosts, subscribes provider notifications, performs recovery interruption/probing/replacement, and closes every operation. Provider kernels receive only `AppServerSession`; operational coordinator execution and recovery services never receive a raw host-opening dependency.

The capability owns:

- server specification;
- lease mode;
- acquisition and attachment;
- notification subscription phase;
- live and recovered interruption;
- provider continuity probing;
- mapping from provider session/turn values to protocol messages.

Provider kernels receive `AppServerSession` explicitly. WeakMaps do not provide hidden lease or notification dependencies.

### `HostRef`

`HostRef` is an opaque, non-secret identity for one concrete managed process instance. It is distinct from the deterministic executable-specification key.

- The spec key decides whether a host may be reused.
- `HostRef` identifies the concrete host already acquired.
- Runtime durable state records only a safe host reference plus necessary provider continuity.
- Recovery attaches by `HostRef` when the host manager still owns that instance.
- If attachment is impossible, the provider compiles a replacement host plan from the durable binding.

Recovery never regenerates an ephemeral secret merely to reproduce the old spec key.

### Host identity invariant

```text
Different executable specifications never share a host.
Identical executable specifications share only when the capability's lease mode permits it.
```

Consequences:

- different Codex profiles or stable account bindings produce different account-bound host specs;
- different Claude accounts may share the account-neutral broker;
- Claude account-bound controllers remain isolated;
- proxy, CA, transport, cwd, command, arguments, and stable exact host environment remain part of identity;
- turn capabilities do not participate in reusable host identity.

## Execution flows

### New caller launch

```text
CLI captures caller ProviderSelection
  -> provider canonicalizes CredentialProfile
  -> CLI assembles complete caller ProviderScope
  -> IPC transports the decoded scope unchanged
  -> provider introspects AccountSubject when supported
  -> provider creates binding
  -> registry returns BoundProvider
  -> coordinator creates ProviderSession(binding)
  -> BoundProvider prepares host/session/turn plan
  -> preflight
  -> acquire AppServerSession or direct process
  -> execute turn
  -> coordinator durably finalizes
```

The selected binding is committed before provider side effects that require durable recovery ownership.

### Resume

```text
caller ProviderScope
  -> current provider binding
persisted ProviderSession.binding
  -> rehydrated BoundProvider + identity reverification
  -> exact binding comparison
  -> prepare next turn
```

Resume rejects missing profile, unavailable identity, subject mismatch, profile mismatch, and invalid persisted binding as distinct typed failures. A provider-name disagreement is an invalid durable binding, not a separate undocumented failure code.

### Workflow and discussion

```text
create aggregate with explicit ProviderScope
  -> aggregate schedules provider work
  -> selected profile is bound by provider
  -> create real ProviderSession child
  -> ExecutionOwner references workflow/discussion independently
```

Restart recovery reads the aggregate's persisted scope for not-yet-bound children and each child's persisted binding after provider-session creation. It never consults current daemon or caller environment.

### HTTP and daemon-internal work

```text
configured named system scope
  -> daemon boot parses JSON and provider registry decodes every profile
  -> HTTP gateway or internal service selects the required provider profile
  -> ordinary provider binding flow
```

Without a configured system scope, provider-launching HTTP and internal requests fail before session or job allocation. Read-only HTTP operations remain unaffected.

### Interrupted recovery

```text
durable snapshot + ProviderBindingEnvelope + optional HostRef
  -> provider registry rehydrate
  -> binding/subject readiness
  -> BoundProvider recovery preparation
  -> pure InterruptedRecoveryPlan
  -> provider/host performer
  -> typed ProviderRecoveryOutcome
  -> coordinator durable finalizer
```

Suggested modules:

```text
src/coordinator/services/recovery/
  interrupted-plan.ts
  interrupted-performer.ts
  interrupted-finalizer.ts
  service.ts
```

Planning contains no host, filesystem, credential, terminal, or Journal effects. Performing cannot commit Coral durable state. Finalizing cannot reinterpret provider protocol state.

## Recovery responsibilities

### Provider-owned

- decode and reverify binding;
- derive provider execution and artifact locations;
- interpret continuity;
- compile host replacement plans;
- attach/probe/interrupt through the single app-server capability;
- convert provider evidence into typed outcomes.

### Coordinator-owned

- recovery polling and launch fencing;
- registry/admission state;
- Journal commits and CAS;
- session lifecycle transitions;
- workflow/discussion lifecycle transitions;
- terminal materialization;
- adoption of Coral-owned runtime state;
- durable finalization after a typed provider outcome.

Normal launch and recovery both begin with `BoundProvider`; recovery does not maintain a parallel provider execution-plan builder.

## Complete store-format fingerprint

### Store-format authority

Build one canonical manifest from every serialization contract stored in the Coral database:

```text
StoreFormatFingerprint = SHA-256(canonical({
  ddl,
  journalEventCodecs,
  projectionCodecs,
  providerBindingCodecs,
  providerSessionCodec,
  workflowCodec,
  discussionCodec,
  jobAndExecutionOwnerCodecs,
  recoveryRuntimeCodecs
}))
```

Persisted codecs register declaratively with stable names and canonical schema representations. Coordinator composition verifies that the canonical manifest can be assembled. Registration order must not affect the fingerprint.

Startup compares the build fingerprint with the stored marker. A missing or different marker follows Coral's existing destructive policy: quarantine/remove the incompatible SQL store and create it from current codecs. It is never adopted in place, and no old layout is read or translated.

### Version removal rule

After the complete fingerprint is active and tested, remove database-local markers that do not select a real decoder:

- provider bundle/source `version: 1` fields;
- unused provider-source key and its crypto dependency;
- event `bodyVersion` fields used only as inert guards;
- projection `schemaVersion` fields used only as inert guards;
- unread `meta.journal_version`.

Retain a version or digest only when the payload is independently serialized outside the fingerprint and the value has operational meaning. Examples may include archive/quarantine manifests, native provider artifacts, or payloads consumed independently by another process/version.

### Adoption

The refactoring intentionally changes persisted session, workflow, discussion, owner, binding, and runtime shapes. Adoption produces one expected destructive store reset. There is no compatibility adapter or legacy-layout migration.

## Execution order and batch jobs

The implementation is divided into ordered batch jobs. A batch is a bounded implementation-and-review unit, not necessarily a single commit. Each batch starts from the completed output of its declared predecessor and must satisfy its exit gate before the next batch begins.

No batches are parallel. Later jobs deliberately delete the surface they replace inside the same batch, so an intermediate completed batch does not leave two active authorities for one policy.

### Order overview

```text
Foundation
  B01 complete store-fingerprint foundation
    -> B02 provider contracts and registry

Binding and durable domain
  B02 -> B03 explicit scope and verified binding
      -> B04 aggregate correction

Execution and app-server lifecycle
  B04 -> B05 BoundProvider execution cutover
      -> B06 lifetime-scoped execution plans
      -> B07 unified app-server and Codex turn capability

Recovery and adoption
  B07 -> B08 bound-provider recovery pipeline
      -> B09 superseded-surface cleanup and destructive adoption
```

| Order | Batch job                                           | Status   | Depends on   | Primary output                                                    | Semantic change                                       |
| ----: | --------------------------------------------------- | -------- | ------------ | ----------------------------------------------------------------- | ----------------------------------------------------- |
|     1 | B01 — complete store-fingerprint foundation         | complete | current main | canonical persisted-codec registry and fingerprint                | fail-closed current-codec correction                  |
|     2 | B02 — provider contracts and registry               | complete | B01          | provider-owned codecs and one type-erasure boundary               | no                                                    |
|     3 | B03 — explicit scope and verified binding           | complete | B02          | caller/system scope and durable verified binding                  | yes                                                   |
|     4 | B04 — aggregate correction                          | complete | B03          | real provider sessions and independent execution ownership        | yes                                                   |
|     5 | B05 — `BoundProvider` execution cutover             | complete | B04          | one bound execution surface                                       | internal behavior-preserving cutover                  |
|     6 | B06 — lifetime-scoped execution plans               | complete | B05          | host/session/turn plans and lifetime-safe environments            | internal behavior correction                          |
|     7 | B07 — unified app-server and Codex turn capability  | complete | B06          | explicit app-server sessions, host references, real Codex sharing | yes                                                   |
|     8 | B08 — bound-provider recovery pipeline              | complete | B07          | `plan -> perform -> finalize` recovery                            | behavior-preserving except corrected failure handling |
|     9 | B09 — superseded-surface cleanup and adoption reset | complete | B08          | one store-format authority and no superseded surfaces             | one intentional store reset                           |

### Batch execution contract

Every batch job must produce:

- one cohesive code change implementing only that batch's ownership boundary;
- focused unit tests for the newly introduced contracts;
- integration tests proving the previous batches still compose correctly;
- architecture/dependency assertions where the batch removes cross-layer knowledge;
- no disabled tests, placeholder branches, or TODO compatibility behavior needed by the following batch;
- a clean typecheck, lint, and relevant test suite at its exit gate.

Temporary dual-read persistence, legacy-layout migration, fallback decoders, compatibility adapters, aliases for the old model, and feature flags for the old model are prohibited. There is no backward-compatible execution path in any batch, and no batch may preserve an old representation by reading, translating, or rewriting it. Intermediate development and test stores are destroyed and recreated whenever persisted shapes change; B09 activates the final fingerprint and performs the single adoption reset for the finished implementation.

### Agent review verdict rule

Fresh-context agent review separates structural approval from implementation detail:

- `REVISE` is reserved for a structural defect: wrong ownership, violated domain invariant, unsafe lifetime, incomplete persistence boundary, an impossible dependency order, or any legacy/backward-compatibility path.
- Naming, local extraction, test ergonomics, diagnostics wording, small API shape improvements, and similar implementation details are recorded and improved but do not block architectural approval.
- A detail finding becomes blocking only when the reviewer demonstrates that it violates one of the structural conditions above.
- Review output must state one architecture verdict (`APPROVE` or `REVISE`) separately from its non-blocking detail findings.

### B01 — Complete store-fingerprint foundation

**Purpose**

Create the complete store-format identity before changing persisted account, session, workflow, or recovery shapes.

**Work package**

- Add a canonical persisted-codec registry with stable names.
- Register current DDL, Journal events, projections, sessions, workflows, discussions, jobs, and recovery/runtime payloads.
- Generate `StoreFormatFingerprint` from the canonical manifest.
- Make registration order irrelevant and reject duplicate stable names.
- Add a shadow startup assertion that the canonical fingerprint can be produced, but do not replace the active DDL-only reset marker until B09 knows the final persisted shape.
- Existing event/projection/local markers and the unused `kb_corpus_authority_baseline` table are construction-only debris scheduled for unconditional removal in B09. They never select an old decoder, migration, translation, or fallback path.
- Remove the executable upcaster surface now. Journal append, read, and projection rebuild fail closed when an event type has no registered current body schema; there is no raw-body route.
- Require a stable semantic identity for every persisted `ZodEffects` and `ZodCatch`, so transforms and catches participate in the fingerprint instead of disappearing behind their input schema.
- Make every SQL JSON boundary declare its codec annotation on the column definition; an unannotated JSON declaration or an annotation on a non-JSON declaration fails format assembly.

**Verification**

- Changing a registered JSON codec changes the fingerprint without editing SQL.
- Reordering codec registration does not change it.
- An unregistered persisted codec fails an architecture or manifest-coverage test.
- A pure reset-decision unit test covers missing/current/mismatch classification in B01.
- B09 adds the quarantine/recreate integration fixture when it activates the fingerprint marker.
- Automated annotation/registry parity is paired with an audited source inventory of SQL JSON serialization call sites.

**Exit gate**

Every currently persisted database boundary is represented in the manifest, and the complete fingerprint is ready to replace the DDL-only marker at final adoption.

### B02 — Provider contracts and registry

**Purpose**

Establish the load-bearing provider-owned vocabulary and the single safe type-erasure boundary before changing invocation behavior.

**Work package**

- Introduce `ProviderSelection`, provider-private `CredentialProfile`, `AccountSubject`, `ProviderBinding`, `ProfileBinding`, `ProviderBindingEnvelope`, and `ProviderScope` contracts.
- Create the typed provider definition and registry.
- Move Claude and Codex selection/profile/binding codecs behind their provider definitions.
- Register provider binding envelopes with B01's persisted-codec registry.
- Contain `JsonValue` decoding and all unsafe narrowing inside registry/provider codec boundaries.
- Add provider-owned selector labels and safe presentation.
- Keep current launch behavior connected through provider definitions; do not change HTTP/default semantics in this batch.

**Verification**

- Invalid or foreign binding envelopes fail before provider execution.
- Generic code cannot access provider-private binding values.
- Adding a fixture provider changes only its vertical provider module and registry registration.
- Durable domains no longer import the account model from `runtime`.

**Exit gate**

Claude and Codex each have one provider-owned binding definition, and one registry closure is the only type-erasure point.

### B03 — Explicit scope and verified binding

**Purpose**

Replace ambient account selection with explicit origin and turn credential locations into honest provider identity guarantees.

**Work package**

- Capture caller-default Claude and explicit Claude/Codex selections at the CLI boundary.
- Canonicalize physical credential-profile locations through the provider module.
- Implement provider-specific non-secret subject introspection where supported.
- Bind Codex to its provider-managed `tokens.account_id` workspace-routing identity, requiring agreement with the provider workspace claim when that claim is present. Treat the local profile filesystem as the trust boundary; do not claim cryptographic token verification.
- Accept a Codex workspace subject only when `auth.json` resolves to ChatGPT authentication. Pin `modelProvider: "openai"` for start, resume, and recovery, and reject unsafe effective transport, credential-store, remote-config, and config-lock overrides using Codex's own `config/read` view before a thread operation.
- Produce `ProviderBinding(profile, subject)` for Codex and the explicitly weaker `ProfileBinding(profile)` for Claude, whose supported CLI surface exposes no stable non-secret account subject.
- Reverify the subject for resume and persisted-binding readiness.
- Construct `ProviderScope` only as caller scope or a configured named system scope.
- Require named system scope for HTTP and daemon-internal provider work, including KB one-shot work.
- Derive the KB curate usage-budget check from the same verified named-system Claude binding through the daemon-to-parent control channel; the KB daemon scheduler must not inspect ambient `CLAUDE_CONFIG_DIR`.
- Compute the complete provider set of every workflow expression and discussion roster before scope capture. Reject an incomplete decoded scope before session/job allocation.
- Keep the raw named-system scope out of detailed health and caller-forwardable `coralEnv`; health exposes only its name and provider names.
- Remove `providerCredentialDefaults` and every ambient fallback path in the same batch.
- Replace provider-specific coordinator messages with typed binding failures rendered by the provider.
- At the B03 boundary, cut provider-session `SessionAuthority` directly to the strict binding envelope. The orchestration variant still existed at that historical boundary only so B04 could delete synthetic orchestration sessions atomically; B04 has now removed it. B03 did not decode, translate, or accept any earlier provider credential/source representation.

**Verification**

- Two caller scopes backed by distinct real Codex profile directories and distinct workspace subjects execute concurrently through one daemon.
- Caller-default Claude is independent of the daemon boot environment.
- Reauthentication to a different subject in the same profile rejects resume.
- HTTP/internal provider launch without a configured system scope rejects before allocation.
- A mixed Claude/Codex workflow carries both profiles and an incomplete scope rejects before allocation.
- KB quota checks read only the configured system Claude profile, independently of daemon boot selectors.
- Codex alternate auth modes and effective transport overrides fail closed; start, resume, and recovery stay pinned to the official OpenAI provider.
- Missing profile, unavailable identity, subject mismatch, and unsupported selection remain distinct.

**Exit gate**

No provider-launching path reaches session or job creation without an explicit scope origin and a provider-produced binding.

### B04 — Aggregate correction

**Purpose**

Make session, orchestration, and job ownership names match the durable concepts they represent.

**Work package**

- Replace provider `SessionEntry` with `ProviderSession` whose provider derives from `binding.provider`.
- Add `ExecutionOwner` for provider sessions, workflows, discussions, and system tasks.
- Move provider scope, lifecycle, and future child-selection ownership directly onto workflow and discussion aggregates.
- Create real `ProviderSession` children only when provider conversations begin.
- Remove `model: 'workflow'`, orchestration session authority, placeholder providers, and workflow IDs returned as provider-session IDs.
- Delete the `SessionAuthority` union after provider sessions derive their only authority from `binding`; do not retain an alias or decoder for either removed variant.
- Update Journal events, projections, APIs, job/admission/terminal ownership, recovery snapshots, and registered codecs atomically.
- Do not add a legacy session decoder. B04 changes the DDL and therefore triggers the currently active DDL-hash reset; B01's complete codec fingerprint remains a shadow coverage assertion until B09 activates it.

**Verification**

- Every persisted session is a real provider conversation.
- Provider identity cannot disagree with the session binding.
- Workflow/discussion execution survives restart using its own persisted provider scope.
- Job ownership works for all aggregate kinds without synthetic sessions.
- Projection rebuild produces the same corrected aggregates as live writes.

**Exit gate**

Provider continuity exists only on `ProviderSession`, and every unit of work has an explicit independent `ExecutionOwner`.

**Implemented invariants and evidence**

- `ProviderSession` is the only persisted session shape. Its provider is derived from the strict binding envelope; no provider field, orchestration variant, alias, or compatibility decoder remains.
- Every job persists one `ExecutionOwner`: provider session, workflow, discussion, or system task. Provider session identity remains separately nullable on non-provider root jobs.
- Workflow roots persist their own provider scope and lifecycle. Child attempts persist slot id, generation, and exact predecessor; replacement claim, continuation lease, job launch, and admission are one atomic commit.
- Discussion roots persist provider scope in `discuss.session.created`. Provider children persist a real provider session plus a discussion run descriptor; the discussion stream separately binds that session to the agent. Validation enforces provider agreement, session uniqueness across agents, and at most one outstanding child per agent.
- This child persistence is intentionally asymmetric: workflows model an ordered replacement chain per plan slot, while discussions model an agent/run linkage and finish event. Both use real `ProviderSession` children, but neither borrows the other's orchestration vocabulary.
- Workflow lifecycle transitions are monotone and validated by the same transition function during append and projection rebuild. Terminal workflows reject new child launches.
- Accepted launch contracts are discriminated: provider launches expose `jobId` and `sessionId`; workflow launches expose `jobId` and `workflowId`. Queued workflow wait events never fabricate an empty provider-session id.
- Strict provider-session decoding and rejection of removed or foreign fields are covered by [`tests/unit/sessions/provider-session-codec.test.ts`](../tests/unit/sessions/provider-session-codec.test.ts).
- Workflow lifecycle monotonicity and identical append/replay validation are covered by [`tests/unit/workflow/lifecycle-transitions.test.ts`](../tests/unit/workflow/lifecycle-transitions.test.ts); ordered child causality and replay atomicity are covered by [`tests/unit/workflow/causal-chain.test.ts`](../tests/unit/workflow/causal-chain.test.ts).
- Discussion job/session/agent linkage, uniqueness, crash-window recovery, and projection replay are covered by [`tests/unit/discuss/job-link-invariants.test.ts`](../tests/unit/discuss/job-link-invariants.test.ts), including cross-connection exclusion in [`tests/unit/discuss/cross-connection-launch.test.ts`](../tests/unit/discuss/cross-connection-launch.test.ts).
- Projection rebuild, crash-window recovery, owner/linkage append invariants, strict persisted codecs, transport parity, CLI rendering, and the broader unit/integration suites cover the remaining corrected-model surfaces.

### B05 — `BoundProvider` execution cutover

**Purpose**

Make a provider executable only after its durable binding has been decoded and captured by its owning provider module.

**Work package**

- Return `BoundProvider` from new binding and persisted-envelope rehydration.
- Move readiness, preflight, preparation, kernel dispatch, artifact planning, and recovery interpretation behind the closure.
- Route new launch and resume through the same bound-provider entry point.
- Remove central Claude/Codex switches from runtime, coordinator, job launch, and artifact lookup.
- Remove the public generic `ProviderExecutionContext` union after the last consumer moves.
- Prevent an unbound provider definition from exposing executable operations.

**Verification**

- No execution/preflight/artifact/recovery API is callable without `BoundProvider`.
- Claude and Codex retain equivalent effective behavior for the same binding and request.
- A fixture provider reaches launch without adding provider branches outside its module.
- Architecture tests reject provider-name branching in generic execution code.

**Exit gate**

The system has one provider execution story: rehydrate or create a binding, obtain `BoundProvider`, then invoke its operations.

**Implemented evidence**

- `ProviderDefinition` is inert; its private registry registration is the sole owner of binding codecs and executable capabilities.
- New binding and persisted-envelope rehydration both produce the same opaque `BoundProvider` surface used by launch, resume, recovery, artifacts, and curation.
- Provider-specific credential policy, exact CLI preparation, recovery interpretation, artifacts, and usage policy live in provider verticals; Windows launch and preflight share the same provider-owned command compiler and shell semantics.
- Provider codec factories capture immutable selection/profile parsers and the canonical persisted contract together. Registration executes no refinements, transforms, or lazy schemas, and retained schema/codec mutation cannot change later decoding.
- Public registry code owns orchestration and lookup; private internal modules own binding erasure, runtime, lease, and snapshot boundaries. Those boundaries validate receiver provenance before property access and snapshot both inbound and outbound values, including lazy events, app-server leases/RPC, continuity, recovery, artifacts, and curation.
- Recovery authority captures only the required launch and session facts (`sessionId`, `projectRoot`, `conversationRef`, `providerContinuity`, `artifactHandles`, and `version`) as a deep immutable snapshot; extra session/artifact data is excluded and later source mutation cannot alter the capture.
- Generic app-server persistence contains only provider identity, lease state, and the attachable `HostRef` when acquired. Transport selection is process-static provider planning data, never durable runtime metadata; old extra fields are rejected by the strict current codec with no compatibility decoder.
- A fixture provider traverses `JobLaunchService -> LaunchOrchestrator -> BoundProvider -> durable dispatch` without a generic provider branch.
- Missing-launch recovery records a terminal cause without fabricating a launch record or provider authority.
- Architecture invariants derive provider verticals from registered `*/definition.ts` modules and reject cross-vertical imports and provider-specific generic execution surfaces.
- Concrete verification lives in [`tests/unit/providers/registry.test.ts`](../tests/unit/providers/registry.test.ts) (parser mutation and boundary rejection), [`tests/unit/providers/execution-plan.test.ts`](../tests/unit/providers/execution-plan.test.ts) (Windows launch/preflight parity), and [`tests/unit/coordinator/service-composition.test.ts`](../tests/unit/coordinator/service-composition.test.ts) (minimal recovery authority).
- Fixture runtime evidence is covered by [`tests/unit/jobs/event-bodies.test.ts`](../tests/unit/jobs/event-bodies.test.ts) (strict waiting/acquired runtime shapes and removed-field rejection), [`tests/unit/jobs/shell/launch.test.ts`](../tests/unit/jobs/shell/launch.test.ts) (shared overlap and fresh job-exclusive acquisition metadata), and [`tests/unit/coordinator/recovery-provider-contract.test.ts`](../tests/unit/coordinator/recovery-provider-contract.test.ts) (fixture recovery metadata). [`tests/invariants/bound-provider-execution.test.ts`](../tests/invariants/bound-provider-execution.test.ts) covers the fixture launch path plus architecture and no-legacy invariants.

### B06 — Lifetime-scoped execution plans

**Purpose**

Separate process-static identity from provider-session continuity and turn-scoped Coral authority.

**Work package**

- Replace generic execution context with `ProviderExecutionPlan { host, session, turn }`.
- Add `host | session | turn` lifetime to environment layers.
- Compile exact environments from named, provenance-bearing layers.
- Keep callback-principal handles, lineage, cancellation, and notification routing out of reusable host specs.
- Express Claude broker and controller plans separately; keep broker account-neutral.
- Compile Codex with `leaseMode: 'job-exclusive'` while its turn capability still depends on process environment.
- Keep `hostKeyFromSpec` based on the complete stable executable specification.

**Verification**

- Host specs contain no turn-scoped values.
- Protected environment collisions fail deterministically on every supported platform.
- Claude broker never contains account routing; account-bound controller does.
- Codex cannot claim shared reuse while callback authority remains process-scoped.
- Normal launch and prepared recovery derive identical stable account routing.

**Exit gate**

Every process-launch value has one explicit lifetime, and only host-lifetime values contribute to reusable process identity. Provider-protocol payload fields remain governed by their typed protocol contracts rather than being forced into environment lifetimes.

**Implemented evidence**

- `ProviderExecutionPlan<Host, Session, Turn>` is the only provider preparation contract. Claude, Codex, fixture, and simulation plans expose explicit immutable `host`, `session`, and `turn` components; the former generic and provider-private execution-context files and symbols have no aliases or compatibility exports.
- Named `EnvironmentLayer` values carry lifetime, provenance, values, canonical writes, and canonical protections. One compiler applies allowlists, Linux/Win32 key identity, deterministic collision rejection, protected ownership, and exact-environment output.
- `ProviderAppServerCapability.compileStableHost(plan.host)` is the sole stable-host compiler. `prepareExecutionPlan` receives the capability-planned host as a required input and returns only the provider-private lifetime plan plus CLI projection; it cannot return a second command, cwd, account environment, initialization request, or host specification. The per-binding lifecycle compiles and opens that stable specification itself, then gives the provider kernel only `AppServerSession`.
- Curation crosses the same per-binding lifecycle as normal execution. That lifecycle plans and compiles the host, opens and subscribes the managed session, invokes the provider completion with only `AppServerSession`, and closes the session in one `finally` path. The coordinator curation service has no host-plan, launch, or low-level acquisition dependency.
- Daemon base and request layers are allowlisted before an environment layer is stored, so discarded credentials, cross-provider settings, or unrelated values never remain latent inside the plan. Exported allowlists are runtime-frozen readonly tuples, with membership lookup retained only in private sets; no exported `ReadonlySet` offers mutable `add`/`delete` methods. Process-launch settings such as proxy and CA paths are host-lifetime. `CORAL_KB_PATH` and `CORAL_KB_ENABLE` are daemon-fixed process settings: they participate in Codex host identity and the Claude controller environment, but never enter the shared Claude broker. `CORAL_OWNER`, `CORAL_EFFORT`, provider options, and Coral authority remain turn-lifetime. Collision diagnostics identify both layer names and provenance on Linux and Windows, while the host-manager boundary independently rejects case-fold duplicates inside either stable or turn environment maps.
- Claude's reusable broker compiles only filtered host-lifetime daemon values plus its normalized transport mode. Its `HOME` is always the daemon infrastructure `HOME`: two caller-default bindings retain distinct controller-routing `HOME` values while compiling the same broker environment and host key. Owner, effort, model cap, KB settings, account routing, projects root, callback principal, session id, and job authority stay in the account-bound controller/session/turn plan and never affect the shared broker specification or host key.
- Codex stable account routing remains host-lifetime. Callback and lineage authority is immutable thread configuration delivered through the app-server protocol, so it never enters process environment or host identity. Codex therefore uses a shared lease while thread and turn identifiers isolate notifications, cancellation, and settlement.
- Normal launch, recovery, and curation use the same provider-owned host-planning path and the same single per-binding lifecycle instance. The lifecycle calls `planHost`, invokes `compileStableHost`, and owns opening, attachment, subscription, interruption, probing, replacement, and close; there is no second host callback or compatibility alias. Recovery attachment consumes only persisted `HostRef`, while a stale attachment plans exactly one credential-free replacement. Tests prove custom providers and the Claude/Codex built-ins derive identical stable hosts while separately issued authority affects only provider-protocol configuration.
- `hostKeyFromSpec` covers provider, command, arguments, working directory, stable exact environment, initialization request and timeout, and shutdown capability using canonical object ordering. On first opening the manager recursively clones and freezes that complete specification, including nested initialization parameters, so caller mutation cannot change entry identity, spawn input, or shutdown lifecycle after admission. Lease policy is compared outside executable identity and a shared/exclusive conflict fails closed in either request order.
- Recovery may attach only from an `acquired` runtime record. `HostRef` carries provider, stable-spec fingerprint, manager-issued instance id, lease policy, and job owner only for exclusive hosts; attachment validates all of them against a live pinned entry and fails closed on any mismatch. Waiting records structurally cannot carry a host reference, and every transition back to waiting clears prior attachment evidence. Attach-only interruption and probing mint no new authority. A stale attachment triggers exactly one replacement open, and the temporary replacement session closes after successful, non-resumable, and throwing probe paths.
- Shared spawn and initialization are manager-owned and never receive an acquisition signal. Every caller, including the creator, independently races its signal against that one spawn. A creator-only abort leaves initialization owned by the manager; an unpinned host with no provider idle evidence remains alive until evidence or daemon drain rather than being guessed idle. Before exposing a lease the manager revalidates acquisition admission, entry registration, closing state, signal state, and handle identity, so a same-tick drain cannot return a closed lease.
- Drain begins background cleanup exactly once per entry and rejects new acquisitions immediately. Its signal cancels only that caller's wait, including the final wait over closes that began and removed their entries before the drain snapshot; cleanup remains tracked, and a later shutdown awaits the same operation. Pending spawns and already-started closes are drained to completion. Releasing a job-exclusive lease closes that process directly; later jobs cannot reuse it.
- Below the composition root, no arbitrary raw-acquisition port remains in provider execution, curation, operational coordinator dependencies, or provider-public contracts. The composition root connects the registry's private structural host authority to the host manager; below that connection only the per-binding lifecycle can open or attach a stable specification.
- B07 completed B06's lifetime boundary with opaque `HostRef` identity, explicit `AppServerSession` attachment, and protocol-only turn capability. No compatibility alias remains.
- Behavioral coverage lives in [`tests/unit/providers/execution-plan.test.ts`](../tests/unit/providers/execution-plan.test.ts), [`tests/unit/providers/claude/request-mapping.test.ts`](../tests/unit/providers/claude/request-mapping.test.ts), [`tests/unit/providers/codex-request-mapping.test.ts`](../tests/unit/providers/codex-request-mapping.test.ts), and [`tests/unit/coordinator/live/provider-hosts/pool.test.ts`](../tests/unit/coordinator/live/provider-hosts/pool.test.ts). [`tests/invariants/bound-provider-execution.test.ts`](../tests/invariants/bound-provider-execution.test.ts) rejects the removed execution API and provider-private plan access from generic execution code.
- Final B06 verification passed the broad changed unit/invariant set (41 files, 755 tests), the focused provider/host/recovery set (6 files, 138 tests), production and test TypeScript checks, lint, the default full suite (427 files, 4,017 tests), and the integration suite (18 files, 41 tests). `git diff --check` also passed, and source searches found no duplicate host callback, removed execution-context, server-builder, public raw-acquisition, mutable exported provider allowlist, or compatibility API outside the invariants that prohibit their return.

### B07 — Unified app-server and Codex turn capability

**Purpose**

Give live and recovered app-server behavior one owner and complete the real shared Codex topology.

**Work package**

- Replace live/recovery app-server definitions with one provider `AppServerCapability`.
- Extend B06's existing `ProviderAppServerCapability` and bound `appServer` capability in place with acquisition, attachment, and session lifecycle; do not introduce a parallel replacement abstraction.
- Introduce explicit `AppServerSession` and opaque non-secret `HostRef`.
- Pass `AppServerSession` to provider kernels instead of recovering leases and notifications from WeakMaps.
- Make acquisition, attachment, subscription, live/recovered interruption, probing, execution, and close operations capability-owned.
- Persist or rehydrate safe `HostRef` data needed to attach to a concrete managed process.
- Attach recovery by `HostRef`; classify a stale/missing attachment separately from a provider probe failure, and compile exactly one explicit replacement only for the stale/missing attachment outcome.
- Let the extended capability own host planning and acquisition so B06's remaining bound launch assembly/projection and coordinator low-level acquire seam disappear rather than surviving as aliases.
- Move the existing acquire-orchestration branches into that extended capability/session abstraction; do not grow the current coordinator acquisition method further or extract cosmetic helpers that leave ownership unchanged.
- Implement the secure Codex per-thread/per-turn channel for lineage and callback capability.
- Change Codex from `job-exclusive` to shared only after isolation, routing, cancellation, and callback tests prove that turn state never enters the host spec.
- Delete duplicate app-server contracts and WeakMap lifecycle bindings in the same batch.

**Verification**

- Runtime and recovery call the same app-server capability and host-plan compiler.
- No provider definition has a second host-producing callback; normal execution, recovery attachment, and Claude curation all invoke the capability-owned stable compiler.
- Recovered hosts attach without recreating an old ephemeral credential.
- A stale `HostRef` produces exactly one explicit replacement plan; a provider probe failure remains a distinct unavailable outcome and does not silently trigger another replacement.
- Provider kernels and generic execution no longer project app-server launch details or receive a low-level acquire operation after the unified capability takes ownership.
- Concurrent Codex turns receive only their own lineage, callback authority, notifications, and cancellation.
- Identical Codex host specs reuse one host; different profiles or stable host inputs do not.
- Claude broker sharing and controller isolation remain unchanged.

**Exit gate**

Each provider has one explicit app-server lifecycle, and Codex sharing is real rather than nominal.

**Implemented evidence**

- `AppServerSession` is the only provider-kernel-facing live transport. Provider lifecycle hooks retain the narrower `AppServerTransport`; Claude and Codex kernels receive `AppServerSession` directly, subscribe directly, and no longer recover leases, notifications, or interrupt routing through app-server WeakMaps. The duplicate middleware lifecycle and its public lease-shaped contract were deleted without aliases.
- The bound app-server capability owns stable-host compilation, session opening, `HostRef` attachment, notification subscription, execution, closure, interruption, probing, and the single explicit stale-host replacement. Generic shell and coordinator execution no longer receive a raw acquisition operation.
- Persisted `HostRef` is a minimal strict discriminated union with a SHA-256 stable-host fingerprint and manager-issued opaque `instanceId`. Shared references structurally forbid ownership; job-exclusive references structurally require `ownerJobId`. Attachment fails closed on provider, manager instance, fingerprint, lease policy, owner, lease state, or draining mismatch, so an otherwise identical process in another daemon can never satisfy the reference. Internal host generations remain manager-private synchronization state and are never persisted as transport identity.
- One manager-owned pin model governs both newly opened and reattached sessions. Every successful open or attach increments the entry pin count, every session close releases exactly one pin idempotently, shared idle cleanup waits for zero pins, and a job-exclusive process closes only after its final pin is released. The manager owns spawn, attachment, draining, and cleanup; the provider registry captures only the narrow structural host authority required to bind app-server capability behavior.
- Shared-host lifetime is explicit in `ProviderServerSpec`: Claude chooses `host-stats`, Codex chooses `daemon`, and job-exclusive hosts cannot declare an idle policy. The manager validates those combinations again at runtime before identity registration or spawn, so JavaScript/custom providers cannot create an implicit fallback policy. Missing Claude telemetry is unknown rather than idle; only an explicit zero-controller/zero-turn snapshot arms cleanup. Codex hosts are never idle-evicted and close only with daemon drain, preserving possibly-live suspended turns after their execution session releases its pin.
- Recovery attaches to the exact `HostRef`. A missing or stale attachment permits exactly one credential-free explicit replacement plan and one probe of that replacement; an exception from a successfully attached provider probe is classified as unavailable and never triggers another process. Merely probing or planning a stale host never registers a child principal.
- Claude continuity checkpoints preserve active broker session and turn coordinates only as a complete pair. Recovered interruption sends the exact provider RPC only when both coordinates exist and reports whether it acted. Confirmed terminal or failed settlement clears the active turn coordinate before the final checkpoint; an unconfirmed exact-turn interruption instead emits a nonterminal `suspended` disposition, preserves the coordinates and durable claim, and leaves startup recovery as the only authority allowed to settle the still-possibly-live turn. Codex applies the same ownership rule and suspends immediately when an aborted start has no exact turn id rather than pinning a session indefinitely. A failed or stale continuity/artifact CAS produces the same ownership-preserving shell disposition instead of an error terminal.
- Codex hosts are now genuinely shared per stable profile. `CODEX_HOME` and other process-stable settings remain in host identity, while Coral lineage and callback authority are carried by immutable thread configuration through `shell_environment_policy.set`; the shared app-server launch receives no per-turn process environment, and resumed turns reuse the captured thread configuration rather than rebuilding process environment.
- Two simultaneous Codex turns on one `AppServerSession` were exercised with distinct callback handles. Thread and turn filters prevent cross-settlement, and aborting one turn interrupts only its own `{threadId, turnId}`. Identical profiles produce the same host key while different profiles split hosts.
- Claude retains its shared account-neutral broker and account-bound controller isolation. Curation uses the same bound session-opening capability and always closes the managed session.
- Handoff registers every admitted app-server job before its first asynchronous boundary. The fence aborts a daemon-local execution signal, rechecks after readiness and host acquisition, closes a host that arrives after the fence without invoking provider code, suppresses post-fence stream effects, and waits for already-admitted continuity, artifact, terminal, and claim-release writes. Terminal persistence, the exact version returned by the final continuity/artifact CAS, claim release, local ownership cleanup, and admission release execute as one pre-registered fence operation. Terminal persistence or claim-CAS failure preserves admission, abort registration, pool ownership, and the durable claim. Quiesced or suspended work likewise does not terminalize or release ownership.
- Verification passed production and test TypeScript checks, lint and formatting, the broad provider/host/recovery/handoff/invariant regression set, the default full suite (427 files, 4,064 tests), the simulation suite (5 files, 60 tests), and the integration suite (18 files, 41 tests). Three fresh structural reviews produced two approvals; the remaining runtime-policy boundary finding was fixed and covered before the final validation. `git diff --check` passed.

### B08 — Bound-provider recovery pipeline

**Purpose**

Make interrupted recovery re-enter the same durable binding and preparation story as normal execution.

**Work package**

- Rehydrate `BoundProvider` from the persisted session binding.
- Extract a pure `InterruptedRecoveryPlan` from durable snapshot and typed provider evidence.
- Isolate host/provider/read-only-filesystem effects in `interrupted-performer`; result-artifact export remains a post-commit finalizer effect.
- Isolate Journal, exact session/artifact CAS, terminal materialization, and admitted ownership release in `interrupted-finalizer`.
- Keep `RecoveryService` as the narrow composition facade; keep polling, cancellation, recovery-registry state, and launch fencing in `RecoveryCoordinator`.
- Remove recovery-only binding validation, execution-context building, server-spec construction, and artifact-root switching.
- Rebuild crash-window, stale-CAS, host-loss, artifact fallback, and subject-mismatch fixtures around the three seams.

**Verification**

- Recovery planning is pure and deterministic for one snapshot.
- The performer cannot write Coral durable state.
- The finalizer cannot reinterpret raw provider protocol state.
- Normal and recovery preparation derive identical binding, account routing, and artifact roots.
- Subject mismatch, missing host, stale CAS, and repeated recovery remain fail closed and idempotent.

**Exit gate**

Normal and recovered execution both start from `BoundProvider`; within the interrupted app-server/durable pipeline, only the coordinator finalizer mutates Coral durable state.

**Implemented result**

- Persisted session bindings are rehydrated and reverified into `BoundProvider` before queued, durable CLI, or app-server recovery is admitted. Authority capture is side-effect free. A queued or already-dead durable job may then finalize a typed binding failure; a live durable job receives a stop request first and retains the recovery fence, while an app-server job whose binding cannot be restored remains fenced because Coral cannot safely stop provider work without that authority.
- App-server and durable CLI interruption use pure snapshot-derived plans in `interrupted-plan.ts`, provider/host/read-only-filesystem effects in `interrupted-performer.ts`, and exact-version artifact/session CAS plus terminal and ownership effects in `interrupted-finalizer.ts`.
- Terminal materialization, continuity checkpointing, and exact claim release are appended in one Journal commit after the final session CAS precondition succeeds. A stale CAS therefore writes no partial terminal, and a restart cannot release the claim while discarding provider-derived continuity.
- Durable artifact recovery no longer fire-and-forgets provider finalization, continues after stale artifact evidence, or releases a claim through non-CAS session mutations. A failed finalizer re-registers the dead adopted job, reactivates the launch fence, and preserves abort/admission/pool ownership for shutdown or restart recovery. A provider job whose durable PID is already dead at startup still traverses the captured `BoundProvider` pipeline rather than generic `wrapper_lost` cleanup.
- App-server recovery distinguishes waiting, artifact fallback, exact-host probing, one stale-host replacement, unsupported recovery, and unavailable probes without rebuilding provider execution context or switching artifact roots. Durable recovery distinguishes persisted terminal, artifact interpretation, abort, unsupported recovery, and wrapper loss through typed plans.
- Pre-commit recovery can be abandoned during shutdown, and an aborted operation is barred from starting a later durable commit even if provider work ignores cancellation. Once the commit fence is crossed, recovery teardown awaits the local atomic commit before daemon authority can be released.
- Focused verification covers deterministic routing, HostRef loss/replacement, artifact fallback, exact CAS version carry, stale artifact/session CAS with no partial terminal, atomic terminal/continuity/claim persistence, subject/binding failure fence retention, dead-PID BoundProvider routing, pre-commit cancellation, post-fence draining, and dynamic re-fencing. Production/test TypeScript, ESLint, formatting, and the broad recovery/service-composition suite pass.

### B09 — Superseded-surface cleanup and destructive adoption

**Purpose**

Remove every superseded old-model and execution surface after the final persisted contract is known.

**Work package**

- Register and verify all final provider-binding, session, workflow, discussion, execution-owner, app-server-runtime, and recovery codecs.
- Freeze the final canonical manifest and fingerprint coverage tests.
- Atomically replace the startup DDL-only marker with `StoreFormatFingerprint` and route mismatch through the existing quarantine/recreate path.
- Remove provider bundle/source `version: 1`, unused provider-source key machinery, unread journal epoch, inert event/projection versions, and the unused `kb_corpus_authority_baseline` table.
- Remove remaining credential/source terminology, obsolete aliases, dead central unions, duplicate runtime helpers, and recovery-only preparation code.
- Verify that every retained version selects a real decoder outside the database fingerprint boundary.
- Trigger and document the one expected destructive store reset for adoption.
- Remove these temporary design/review documents before the final product commit, as required by the implementation workflow.

**Verification**

- A full dependency search finds no superseded account, synthetic-session, generic execution-context, duplicate app-server, or recovery-preparation surface.
- Every persisted database codec appears exactly once in the fingerprint manifest.
- Store reset followed by bootstrap, projection rebuild, provider launch, workflow/discussion execution, resume, and interrupted recovery passes end to end.
- A clean checkout contains no temporary design documents in the final commit.

**Exit gate**

One store-format authority, one provider binding vocabulary, one provider execution path, and one app-server/recovery lifecycle remain.

**Implemented result**

- `src/store-format.ts` is the application composition root for one immutable format description. Every coordinator, CLI, KB-daemon, read-only, simulation, and test opener receives that complete description rather than an independently supplied marker string. The standalone `pre-compact` hook verifies the same fingerprint exported by the built backend into its bundle manifest before its direct read-only query.
- The canonical manifest contains the exact DDL executed for a fresh or reset store, including registered auxiliary DDL. It fingerprints every event's canonical `type → streamKind → body → materializer` mapping, append-validation semantics, the exact Journal envelope decoder, complete projection-job and projection-session rows, strict consumer-cursor metadata/cursors, the singleton corpus-state row, and every strict KB active-claim/scheduler/retry/quarantine/backlog SQL row decoder used outside JSON columns. Registered semantic components cover the imperative cross-column relationships those decoders enforce. Actual reads use those same contracts: event decoding always checks the canonical stream kind, projection rows are audited before indexed hot-path filtering, and inconsistent scalar/JSON relationships fail closed. The database marker is written only in the same transaction after that complete DDL succeeds; a same-directory fingerprint sidecar lets direct hooks reject an incompatible store without opening SQLite. Fresh-schema tests prove every registered corpus-baseline table exists.
- The runtime provider registry is sealed and compared with the built-in canonical manifest before it may own the production store. A registry whose private persisted contracts differ is rejected, so independently launched Coral processes cannot select divergent format authorities.
- Provider registration contributes separate canonical profile, binding, and continuity contracts. The continuity parser remains attached to the rehydrated `BoundProvider`; launch/resume and recovery authority capture admit only its decoded value, while provider stream checkpoints, probes, and recovery outputs pass through the same parser before a durable write. Claude and Codex use that registered parser for provider-local inputs and outputs; unknown, empty, or malformed payloads fail closed instead of entering the Journal or being normalized as an older shape. Sessions expose no generic raw-continuity checkpoint API: production persistence is reachable only through claim/version-checked ports after the bound provider has decoded the payload.
- `meta.store_format_fingerprint` is the sole database adoption authority. A missing or different value follows the existing authority-gated DB/WAL/SHM/format-sidecar quarantine and fresh-store path; no migration, compatibility reader, default fill, or old-format translation exists. The sidecar is a redundant hook-safety witness, never an adoption decision source.
- Provider source/bundle versions and key helpers, Journal/body/projection migration markers, the unused singular corpus-baseline table, old credential/source vocabulary, raw generic continuity writers, and superseded recovery preparation surfaces are removed. Retained versions identify external artifacts/protocols or optimistic session CAS rather than database codecs.
- Permanent architecture/configuration documentation now describes strict current-codec reads and destructive fingerprint adoption. The temporary design and Pioneer review remain only until the final cleanup commit required by this workflow.

## Required invariants and tests

### Identity and binding

- Two callers with different provider profiles use one daemon concurrently.
- Physical aliases canonicalize to the same profile where the platform supports identity resolution.
- A verified binding persists profile and non-secret subject.
- Reauthentication to a different subject in the same profile fails resume and recovery closed.
- Providers without subject introspection expose `ProfileBinding` explicitly.
- Missing profile, unavailable profile, unavailable identity, and subject mismatch remain distinct.
- No persisted value contains provider tokens or auth contents.

### Scope origin

- IPC launches always carry caller scope.
- Default Claude behavior is captured from the caller, never synthesized from daemon state.
- HTTP/internal provider execution requires a named system scope.
- Workflow/discussion children use their aggregate's persisted scope.
- Recovery never reads caller, daemon boot, or current shell provider selectors.

### Aggregate semantics

- Every `ProviderSession` has exactly one provider derived from its binding.
- No workflow/discussion creates a synthetic provider session.
- Every job's `ExecutionOwner` references a real owning aggregate.
- Provider continuity exists only on provider sessions.

### Process lifetime and isolation

- Host plans contain no turn-scoped callback or lineage capability.
- Different executable specifications never share a host.
- Identical specifications share only where lease mode allows.
- Different account-bound profiles produce distinct controller/app-server hosts.
- Different Claude accounts may share only the account-neutral broker.
- Proxy, CA, transport, cwd, command, arguments, and stable exact host environment affect host identity.
- Claude broker environment contains no account routing.
- Codex sharing is enabled only through verified immutable thread configuration; no turn capability enters process identity.

### App-server lifecycle

- Runtime and recovery use the same app-server capability and host-plan compiler.
- Kernels receive explicit `AppServerSession` values.
- Recovered live hosts attach by `HostRef` without regenerating old callback secrets.
- Missing/stale `HostRef` causes an explicit replacement plan.
- Notification, interruption, probing, and close behavior have one lifecycle owner.

### Normal/recovery parity

- The same durable binding rehydrates the same provider-private binding in launch and recovery.
- Normal and recovery preparation derive equivalent account routing and artifact roots.
- Recovery planning is pure and deterministic for one durable snapshot.
- Provider/host performer cannot commit Journal state.
- Durable finalizer cannot reinterpret provider protocol evidence.
- Crash-window and stale-CAS outcomes remain fail closed.

### Persistence

- Any incompatible registered persisted codec change changes `StoreFormatFingerprint`.
- Registration order does not change the fingerprint.
- Store mismatch triggers the established destructive reset path.
- No SQL perturbation is required merely to detect a JSON codec change.
- Every retained local version selects a real decoder outside the fingerprint boundary.

### Dependency architecture

- Durable aggregates do not import provider account types from `runtime`.
- Generic coordinator/jobs/recovery code does not switch on Claude versus Codex for environment, artifacts, or lifecycle behavior.
- Provider-private persisted values are decoded only by their provider module.
- Type erasure occurs at one registry/persistence closure boundary.
- Each provider has exactly one binding definition and one app-server capability.

## Explicitly rejected alternatives

- Renaming the current path locator directly to `AccountBinding` without subject verification.
- Treating `Principal`, provider account identity, or callback principal as one authority object.
- Keeping ambient daemon provider defaults as a generic fallback.
- Retaining synthetic orchestration sessions for workflow ownership convenience.
- Calling Codex app-server shared while its host spec contains per-job authority.
- Recovering a host by reconstructing a spec with newly minted secrets.
- Preserving separate live and recovery app-server definitions.
- Introducing central binder/factory services that retain a Claude/Codex switch.
- Adding legacy store migrations or nested inert schema versions.
- Replacing executable-spec host identity with provider/account identity.
- Moving Coral durable finalization into provider modules.

## Final architecture

The completed architecture has one domain sentence:

> An explicitly scoped invocation asks a provider to bind a credential profile to a verified provider subject; that bound provider creates lifetime-correct execution and app-server sessions, while Coral aggregates own durable lifecycle and recovery re-enters through the same binding.

The resulting ownership is:

| Concern                                                             | Owner                                                      |
| ------------------------------------------------------------------- | ---------------------------------------------------------- |
| Permission to invoke Coral                                          | `Principal` and Coral security                             |
| Origin of provider choices                                          | transport/configured `ProviderScope`                       |
| Credential routing and provider identity                            | provider module and `ProviderBinding`                      |
| Provider preparation, execution, recovery interpretation, artifacts | `BoundProvider`                                            |
| Process/session/turn placement                                      | provider `ProviderExecutionPlan`                           |
| Live and recovered app-server lifecycle                             | bound `ProviderAppServerCapability` and `AppServerSession` |
| Workflow/discussion lifecycle and future provider choices           | workflow/discussion aggregate                              |
| Provider conversation continuity                                    | `ProviderSession`                                          |
| Generic work ownership                                              | `ExecutionOwner`                                           |
| Journal, CAS, admission, terminal, durable finalization             | coordinator                                                |
| Store readability                                                   | complete `StoreFormatFingerprint`                          |

This preserves Coral's elegant core while giving provider multi-account execution the domain model it did not previously have.
