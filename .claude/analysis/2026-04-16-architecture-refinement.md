# Analysis: Architecture Refinement
Date: 2026-04-16
Question: coral의 구현 상태를 매우 정밀하게 분석. 우아한 아키텍처를 달성하기 위해 리팩토링 해야할 부분 등을 찾는것이 목적.

## Scan Report

**Finding flow**: 12 initial → 10 after quality gates → 10 verified [code: 8, inference: 2]

### Verified Findings

| # | Area | Severity | Finding | Evidence |
|---|------|----------|---------|----------|
| S1 | Layer violation | **CRITICAL** | `execution/backend-core.ts` imports `client/readers.js` (execution → client). `client/backend-lifecycle.ts` imports `execution/backend-lock.js` (client → execution). Bidirectional dependency between layers that should be unidirectional. | `backend-core.ts:8`, `backend-lifecycle.ts:7` |
| S2 | Layer violation | **HIGH** | `workflow/handler.ts` imports concrete `ProviderRegistry` from `providers/`. Workflow should be a pure domain layer but is provider-aware for validation. | `workflow/handler.ts:0` |
| S3 | Interface inconsistency | **HIGH** | HTTP workflow schema uses camelCase (`startPrompt`, `workDir`), internal workflow schema uses snake_case (`start_prompt`, `work_dir`). Manual field translation in `http-handler.ts`. | `shared/schemas.ts:106`, `workflow/schemas.ts:5` |
| S4 | Complexity hotspot | **HIGH** | `createLifecycle` 760 lines/79 branches, `buildProgram` (CLI main) 630/75, `createBackendCore` 441/20, `executePersistent` (Claude adapter) 240/36. | `lifecycle.ts`, `cli/main.ts`, `backend-core.ts`, `claude/adapter.ts` |
| S5 | Dead code | **HIGH** | ESLint: 117 errors, includes unused locals in production code (client/readers.ts helpers, classification.ts imports, kb/runtime.ts imports). | Verified: `npm run lint` = 117 errors, 0 warnings |
| S6 | Runtime boundary leak | **MEDIUM** | Provider preflight and KB git-sync use direct Node process/file APIs instead of Runtime ports, weakening simulation isolation. | `codex/adapter.ts:497,517`, `kb/curate/git-sync.ts:35` |
| S7 | Shared core cycle | **MEDIUM** | `shared/` has type-level cycle: `types → schemas → utils → runtime-ports → types`. Not a runtime cycle but signals contract/utility mixing. | `shared/types.ts:4`, `shared/schemas.ts:2` |
| S8 | Provider abstraction gap | **MEDIUM** | `ProviderAppServerContract` exists but Claude and Codex adapters each own bespoke lease/interrupt/checkpoint flows. Shared lifecycle state not abstracted. | `providers/types.ts:39`, `claude/adapter.ts:196`, `codex/adapter.ts:617` |
| S9 | Pattern violation | **LOW** | Backend code has direct `process.stderr.write` despite ESLint rule requiring `backendLog`. | `kb/vector/handle-lifecycle.ts:243` |
| S10 | Unused exports | **LOW** | Dead-export candidates: `state-machine.ts:159`, `transcript.ts:165`, `tools.ts:230`, `kb/types.ts:376`, `embedding.ts:700`. Some may be intentional public API. | code trace |

### Architecture Diagram (Observed)

```
                    src/cli
                       |
                       v
                  src/client  ----x----->  src/execution/backend-lock
                       ^                    (client imports execution type)
                       |
                       x
              src/execution  --------->  src/client/readers
                       |
        +--------------+--------------+-------------+
        v              v              v             v
   src/workflow -> src/providers   src/kb      src/discuss
        |              |              |             |
        +--------------+--------------+-------------+
                       v
                 src/shared / src/infra
```

### LOC Distribution
| Module | LOC |
|--------|-----|
| execution | 20,379 |
| kb | 14,157 |
| providers | 4,926 |
| client | 3,080 |
| discuss | 2,949 |

## Gap Analysis

**Finding flow**: 8 gaps initial → 8 after quality gates → 8 verified [code: 6, inference: 2]

### Target Architecture

```
shared/value-contracts
  <- infra/runtime + persistence
    <- execution kernel
      <- features (workflow, discuss, kb)
        <- transports (http, client, cli)
          <- composition/bootstrap
```
`providers/*`는 provider SPI에만 의존, 역방향 없음.

### Missing Architectural Boundaries

| # | Gap | Current State | Target State | Evidence |
|---|-----|--------------|--------------|----------|
| G1 | Composition root 역할 혼재 | `backend-core.ts`가 runtime 구성 + feature 의존성 wiring을 동시에 수행 (441줄) | 분리된 composition root와 lightweight core | `backend-core.ts:237` |
| G2 | Workflow 계층 위치 모호 | `service.ts`가 workflow internals import, `handler.ts`가 provider registry import | Workflow는 `WorkflowExecutionPort` + `ProviderCatalog` (read-only)에만 의존 | `service.ts:32-41`, `handler.ts:0` |
| G3 | Persistence read-model 소유권 미정의 | Client readers를 execution이 import, execution lock을 client가 import | `infra/persistence`로 공통 추출 | `backend-core.ts:8`, `backend-lifecycle.ts:7` |
| G4 | Canonical command shape 부재 | HTTP camelCase, workflow snake_case, 수동 변환 | 단일 `WorkflowCommand` 타입, edge에서만 변환 | `shared/schemas.ts:106`, `workflow/schemas.ts:5` |
| G5 | Provider SPI 너무 조잡 | 하나의 `ProviderAppServerContract`에 모든 lifecycle | `ProviderCatalog`, `ProviderExecutor`, `ProviderSessionLifecycle`, `ProviderArtifactCleanup` 분리 | `providers/types.ts:39` |
| G6 | Provider 정리 로직 위치 위반 | `cleanupClaudeSessions()`이 workflow (`pipe-executor.ts:82`)에 존재 | Provider-owned cleanup 뒤로 이동 | `pipe-executor.ts:82` |
| G7 | Shared 모듈 스코프 무제한 | `types → schemas → utils → runtime-ports → types` 순환 | `shared/value`, `shared/schema`, `shared/runtime`, `shared/util`로 분리 | `shared/*.ts` imports |
| G8 | Runtime side-effect boundary 누락 | KB git-sync, provider preflight이 직접 Node API 사용 | 모든 subprocess/timer는 runtime/infra 포트 경유 | `git-sync.ts:35`, `codex/adapter.ts:497` |

### Missing Acceptance Criteria (from Gap Analysis)

1. Zero non-test imports `execution -> client` and `client -> execution`
2. `workflow/*` compiles against `WorkflowExecutionPort` + `ProviderCatalog` only
3. Exactly one canonical `WorkflowCommand` type; HTTP translation at edge only
4. Import-cycle check reports no cycle inside `src/shared`
5. Common app-server orchestration in one abstraction; adapters keep only protocol mapping
6. No provider-specific filesystem cleanup in workflow
7. All long-lived subprocesses/timers visible to runtime/lifecycle; no raw `execFile` in features
8. Provider registration in bootstrap/composition only

### External Constraints

- Codex fork blocked by missing clone/fork RPC (`codex/adapter.ts:618`)
- Codex app-server capability 제약: host 관리 메타데이터가 Claude보다 적음
- 통합 host lifecycle은 capability-based (optional `shared`, `shutdownCapability`, host-idle)

### Open Questions

1. Workflow가 feature인가 kernel 일부인가? → `ExecutionService`의 workflow job persistence 소유권 결정
2. `ProviderRegistry`는 bootstrap-only인가 runtime mutation 필요한가?
3. 내부 canonical API dialect 하나 vs transport DTO + domain command 분리?
4. Codex host policy를 Claude와 통합할 것인가, provider-specific 유지할 것인가?

### Recommended Refactoring Order

1. `infra/persistence` 추출 → execution ↔ client 순환 제거
2. Canonical `WorkflowCommand` 도입 → `http-handler` edge에서 1회 변환
3. `ProviderRegistry` → `ProviderCatalog` (read-only) in workflow
4. Workflow coordination을 `ExecutionService`에서 분리
5. `shared/` acyclic 분리 (value/schema/runtime)
6. CI에 dependency-graph check 추가

## Synthesis Review

### Finding Flow Summary
| Step | Initial | After Gates | Verified | Breakdown |
|------|---------|-------------|----------|-----------|
| Scan | 12 | 10 | 10 | code: 8, inference: 2 |
| Gap Analysis | 8 | 8 | 8 | code: 6, inference: 2 |
| **Total** | **20** | **18** | **18** | |

Step 3 (Root Cause Diagnosis) 스킵: 버그/에러 증상 없음.

### Thematic Grouping

**Theme 1: Layer Boundary Violations** (S1, S2, G2, G3, G6)
핵심 문제는 모듈 간 의존성 방향이 정의되어 있지만 강제되지 않는다는 것. execution ↔ client 양방향 import, workflow → providers 커플링, provider-specific cleanup이 workflow에 위치하는 문제가 하나의 근본 원인에서 파생됨: **import boundary enforcement 부재**. 해결은 persistence read-model 추출 + workflow의 provider 의존성을 narrow interface로 대체 + CI에서 import graph 검증.

**Theme 2: Interface/Contract Fragmentation** (S3, G4, G7, S7)
camelCase/snake_case 이중 스키마, shared 내부 순환, 여러 DTO dialect가 존재. 근본 원인: canonical command shape가 정의되지 않았고 shared module scope가 무제한. 해결은 단일 WorkflowCommand 타입 도입 + shared/ 분리.

**Theme 3: Complexity & Decomposition** (S4, G1, G5, S8)
760줄 함수, 441줄 composition root, 분리되지 않은 provider SPI. 이들은 독립적으로 보이지만 "한 모듈이 너무 많은 책임을 진다"는 공통 패턴. Lifecycle → named use-case 모듈, backend-core → composition root 분리, provider SPI → 세분화된 인터페이스로 해결.

**Theme 4: Code Hygiene** (S5, S9, S10, S6, G8)
117 lint errors, 직접 Node API 사용, dead code, unused exports. 이들은 architectural debt의 증상이지 원인은 아님. Lint를 먼저 해결하면 리팩토링 시 노이즈를 줄일 수 있지만, 구조적 리팩토링 후 자연스럽게 해결되는 부분도 있음.

### Cross-step Consistency

- **강화**: Scan의 S1(layer violation)과 Gap의 G3(persistence 소유권)은 동일 문제의 다른 면. Scan이 증상을 포착하고, Gap이 해결 방향을 제시 — 상호 일관적.
- **강화**: Scan의 S2(workflow→providers)와 Gap의 G2(workflow 계층 위치)도 동일. `ProviderCatalog` narrow interface 제안이 양쪽에서 일치.
- **강화**: Scan의 S4(complexity)와 Gap의 G1(composition root 혼재)은 `backend-core.ts` 441줄이라는 구체적 사실에서 수렴.
- **모순 없음**: 두 step 간 상충되는 finding 없음.

### Unanswered Aspects

- **테스트 아키텍처**: 사용자 질문에 포함될 수 있으나 이번 분석은 production code 구조에 집중. 테스트 구조 분석은 별도 필요.
- **실제 리팩토링 PR 전략**: 어떤 순서로 PR을 나눠야 breakage 없이 진행할 수 있는지는 planning 단계에서 다뤄야 함.
