# Phase D — 7 Remaining Design Issues

기계적 수정 8건(`d5823f0`)은 완료. 아래 7건이 미해결 설계 이슈.

---

## Issue 1: BUG-1 — Alive-but-Unhealthy Daemon 60s Timeout

### 증상
`ensureBackend()`가 PID alive + HTTP dead인 daemon을 교체하지 못하고 60초 timeout까지 spin.

### 근본 원인
Client startup arbitration이 health와 ownership을 분리된 검사로 수행하며 둘 사이에 bridge가 없음.
- `readHealthyBackendInfo()` → healthy 아니면 null (`backend-lifecycle.ts:74-92`)
- Shutdown path → healthy backend 필요 → skip (`backend-lifecycle.ts:264-268`)
- `tryRemoveStaleLock()` → PID alive면 `'active'` 반환 (`backend-lifecycle.ts:154-173`)
- PID alive + HTTP dead = 어떤 코드 경로도 처리하지 않음 → 60s timeout

### 위치
- `src/client/backend-lifecycle.ts:74-92` (readHealthyBackendInfo)
- `src/client/backend-lifecycle.ts:154-173` (tryRemoveStaleLock)
- `src/client/backend-lifecycle.ts:241-325` (ensureBackend while loop)

### Pioneer 결정
**Observe/Reconcile/Apply convergence controller**:
- `DaemonObservation`: `absent | starting | sick | healthyCompatible | healthyIncompatible | staleLock | corruptLock` (7-variant discriminated union)
- `reconcile(observation, desired, controllerState): DaemonAction` — pure function
- Controller state: grace window (`sickSince`), replacement lock ownership, shutdown history
- `sick` 상태: PID alive + health fail → 10s grace 후 force replacement
- `ensureBackend` = `while (!converged) { observe → reconcile → apply }`

### 정석
**Reconciliation Loop** (Kubernetes controller 패턴):
- 현재 상태 관측 → 원하는 상태와 비교 → 교정 action 도출 → 적용
- Pure `reconcile()` 함수는 I/O 없이 독립 테스트 가능
- Controller state는 loop iteration 간 carry-forward (grace period 등)

---

## Issue 2: S2/G4 — Runtime이 Simulation Code를 Import

### 증상
`runtime.ts:35-40`이 `./simulation/recording.js`를 import. Production runtime이 simulation 레이어에 의존.

### 근본 원인
Recording (spawn 캡처/재생)이 Runtime의 intrinsic으로 구현됨. `createRealRuntime()` 안에서 `maybeAutoRecordSpawn()`이 recording.ts를 직접 호출. Recording의 feature scope가 불명확 (production feature? test helper?).

### 위치
- `src/execution/runtime.ts:35-40` (import)
- `src/execution/runtime.ts:262,392-451` (production path에서 호출)
- `src/execution/simulation/recording.ts:1-4,39-41` (direct node:fs + Date.now())

### Pioneer 결정
**Observable Runtime — 7th port `observe`**:
- `RuntimeObserver`: `onSpawn(listener): Disposable`, `onStorageWrite(listener): Disposable`, `onTime(listener): Disposable`, `onViolation(listener): Disposable`
- Recording = `onSpawn()` subscriber. Composition root에서 등록.
- `createRealRuntime()`은 recording을 모름 — clean runtime 반환.
- Recording model (SpawnRecording type, replay helpers) = pure module (simulation-safe)
- File-backed save/load = 별도 I/O module (sealed surface 밖)
- `InMemoryObserver`가 simulation에서 이벤트 수집

### 정석
**Observer Pattern / Event Emitter on I/O Ports**:
- I/O port에 observation hook을 제공하여 non-intrusive instrumentation 가능
- Recording, profiling, audit logging 등이 모두 observer subscriber로 구현
- Runtime core는 observer를 호출하지만, 어떤 subscriber가 등록되었는지 모름
- 의존성 방향: subscriber → Runtime (역방향 아님)

---

## Issue 3: S9 — lifecycle.ts 785줄 복잡성

### 증상
`createLifecycle()` 함수가 startup, recovery, handoff, shutdown, session subscription, idle watch, ownership check를 모두 포함하는 단일 785줄 closure.

### 근본 원인
Lifecycle phase들이 closure 변수로 implicit하게 표현됨. 6개 mutable 변수 (`shutdownPromise`, `started`, `sessionIndexSubscribed`, `recoveryRegistry`, `ownershipCheckerInterval`, `adoptedRunningPids` + `recoveryPollIntervals`)가 각각 어느 phase에 속하는지 코드를 읽어야만 알 수 있음.

### 위치
- `src/execution/lifecycle.ts:549-1334` (createLifecycle)
- Mutable state: `lifecycle.ts:586-592`

### Pioneer 결정
**Lifecycle State Machine (FC/IS — discuss 패턴 적용)**:
- `LifecyclePhaseState` discriminated union: `starting | recovering | running | draining | stopped`
- `LifecycleControlState`: cross-phase mutable (subscriptions, registry, adopted PIDs, poll handles, shutdown promise)
- `transition(phaseState, event): LifecyclePhaseState` — pure function, I/O 없음
- Imperative shell = thin driver: transition 발행 → side effect 적용
- Internal `recovering` phase는 public API에 노출하지 않음 (public은 기존 4-state 유지)

### 정석
**Functional Core / Imperative Shell** (Gary Bernhardt):
- 이미 discuss system (`src/discuss/state-machine.ts` + `src/execution/discuss/`)에서 같은 패턴 사용 중
- Pure state transition은 I/O 없이 unit test 가능
- Side effect는 shell에서 transition 결과에 따라 실행
- Codebase 내에 검증된 선례가 있으므로 일관성 확보

---

## Issue 4: G2/S7 + BUG-2/G7 — RecoveryInvariants Dead + Adoption Race

### 증상
(a) `RecoveryInvariants` 4개 필드가 정의되어 있지만 분류에 0개 영향. Dead abstraction.
(b) Cross-namespace adoption이 non-atomic read-check-write로 구현되어 두 daemon이 동시에 같은 orphan을 adopt 가능.

### 근본 원인
(a) Multi-daemon coordination을 위해 설계했지만 구현하지 않음. `lifecycle.ts:1162-1165`에서 `peerDaemonAlive: false` 하드코딩.
(b) `adoptOrphanedCrossNamespaceJobs()` at `lifecycle.ts:171-196`가 status.json을 읽고, 확인하고, 쓰는 과정에서 CAS 없음. 고정 staging path `status.json.tmp` 사용.

### 위치
- `src/execution/recovery-core.ts:42-46` (RecoveryInvariants)
- `src/execution/lifecycle.ts:154-204` (adoptOrphanedCrossNamespaceJobs)
- `src/execution/lifecycle.ts:206-269` (isForeignDaemonAlive)

### Pioneer 결정
**RecoveryEnvironment + Adoption을 Planner에 통합**:
- `RecoveryInvariants` → `RecoveryEnvironment` rename + 재설계:
  - `foreignNamespaceHealth: ReadonlyMap<string, 'alive' | 'dead' | 'unknown'>`
  - `isProcessAlive: (pid: number) => boolean`
- `adoptOrphanedCrossNamespaceJobs()` 삭제 → `CLASSIFIER_TABLE`에 adoption row 추가
- `AdoptAction = { type: 'adopt'; jobId; fromNamespace; expectedFingerprint }`
- CAS claim protocol: rename-to-claim + apply-time liveness re-verification
- `job:adopted` domain event
- `ProgressStore.ingestAdoptedJob(jobId)` — shared instance에 직접 주입

### 정석
**Table-Driven Classification + CAS Adoption**:
- Recovery planner가 이미 table-driven classifier (`CLASSIFIER_TABLE`). Adoption을 새 classifier row로 추가하면 기존 패턴과 일관.
- File-based CAS: `O_EXCL` create (tryExclusiveWriteSync) 또는 rename-to-claim으로 single-writer 보장
- Planning과 apply 분리: plan은 pure, apply는 imperative (FC/IS 패턴과 일관)

---

## Issue 5: G1 — restart vs reset 시맨틱 혼동

### 증상
`SimulationWorld.restart()`가 clean-slate reset을 수행하지만 이름은 restart. Real daemon restart는 recovery over persisted artifacts를 실행.

### 근본 원인
Simulation의 `restart()`가 새 `WorldGenerationState`를 생성하여 모든 상태를 초기화. Real restart는 기존 상태를 회복. 이름이 동작을 반영하지 않음.

### 위치
- `src/execution/simulation/world.ts:140-146` (restart)
- `src/execution/simulation/schema.ts:199-202` (restartStepSchema)
- `src/execution/simulation/runner.ts:427` (case 'restart')

### Pioneer 결정
**Generational World**:
- `restart()` → `cycle()` rename (primary)
- `restart()` = deprecated alias
- `SimulationGeneration` public type (index, backend, startedInfo, phaseTransitions)
- `world.generation()` accessor
- `generationIndex` counter — cycle마다 increment
- Schema: `cycleStepSchema` (primary) + `restartStepSchema` (deprecated alias)

### 정석
**Explicit Naming + Generation Model**:
- Method 이름이 동작을 정확히 반영: `cycle()` = "한 세대를 끝내고 다음 세대 시작"
- Generation은 불변 snapshot — cross-generation assertion이 자연스러움
- Migration 동안 old name을 deprecated alias로 유지 (breaking change 최소화)

---

## Issue 6: G3/S8/G6 — Sealed Runtime (Simulation I/O 격리)

### 증상
`noRealIO` monitor가 `fetch` + `process.kill`만 감시. Simulation이 `createBackendServer()`를 import하면서 KB/discuss/providers/workflow의 ambient I/O가 transitive closure에 유입. 52개 sealing violation.

### 근본 원인
**Hexagonal Architecture 위반**: Simulation(composition root)이 production composition root(`server.ts`)를 import.
```
simulation/core/index.ts
  └→ createBackendServer (server.ts)   ← composition root가 composition root를 import
      └→ 전체 production 의존성 53개
```
Composition root는 leaf node여야 하며, 다른 composition root가 import하면 안 됨.

### 위치
- `src/execution/simulation/core/index.ts:17-20` (createBackendServer import)
- `src/execution/server.ts` (monolithic composition root — 633줄)
- `src/execution/simulation/no-real-io.ts` (monkey-patch로 fetch/kill만 감시)
- `verify-simulation-sealing.mjs` + `sealed-inventory.json` (sealing infra, 이미 존재)

### Pioneer 결정
**Sealed Runtime via Hexagonal Architecture**:
1. **no-real-io.ts 삭제** — monkey-patch 대신 RuntimeObserver 기반 violation detection
2. **Composition root 분리**:
   - Production: `server.ts` — application modules + real adapters wire
   - Simulation: `simulation/core/index.ts` — 같은 application modules + fake adapters wire
   - 두 composition root는 서로를 모름
3. **Application modules** (lifecycle, engine, progress-store, http-handler)가 인터페이스에만 의존
4. **Lifecycle hooks** — subsystem 동작을 lifecycle에서 분리:
   - `onShutdown[]`, `onIdleCheck[]`, `onRecovery[]`
   - lifecycle.ts가 discuss/KB/provider를 import하지 않음
   - Composition root가 hooks에 subsystem 구현 주입
5. **Build-time enforcement**: `verify-simulation-sealing.mjs`가 sealed module inventory의 transitive closure에서 forbidden imports 감지

### 정석
**Hexagonal Architecture (Ports & Adapters)** — Alistair Cockburn:
```
                 ┌─────────────────────┐
                 │  Application Core   │
                 │  (lifecycle, engine, │
                 │   progress, handler) │
                 │                      │
                 │  depends on          │
                 │  INTERFACES ONLY     │
                 └───────┬──────┬───────┘
                         │      │
              ┌──────────┘      └──────────┐
              ▼                            ▼
   Production Composition Root   Simulation Composition Root
   (server.ts)                   (simulation/core/index.ts)
   ├── real KB                   ├── fake provider
   ├── real providers            ├── virtual time
   ├── real discuss              ├── in-memory storage
   ├── real workflow             └── (no KB/discuss/workflow)
   └── node:http, node:fs
```

핵심 원칙:
- **Composition root는 leaf node** — 모든 것에 의존하지만, 아무도 composition root를 import하지 않음
- **Application modules는 인터페이스에만 의존** — concrete implementation을 import하지 않음
- **Simulation은 자체 composition root** — production composition root와 application modules를 공유하지만, production root를 import하지 않음

현재 위반:
- `lifecycle.ts`가 `discuss/context-registry`, `discuss/loop`, `discuss/operations`를 value import (subsystem 구현체를 직접 import)
- `simulation/core/index.ts`가 `createBackendServer`를 import (production composition root를 import)

해결 순서:
1. lifecycle.ts에서 discuss/KB value imports → lifecycle hooks로 전환 (application module을 인터페이스-only로)
2. simulation이 server.ts 대신 application modules를 직접 wire (자체 composition root)
3. build-time sealing 활성화 (0 violations)

잔존 문제 (kernel core의 ambient I/O):
- `infra/paths.ts` — `execFileSync('git')`, `realpathSync`, `homedir()`, `tmpdir()` → split (pure builder + adapter seam)
- `shared/utils.ts`, `file-tail.ts`, `fs-lock.ts`, `session-entry.ts`, `backend-info.ts` — dual-path fallback → fallback 제거 (optional Runtime → required Runtime)
- `server-kernel.ts` (또는 server.ts) — `fetch()`, `createServer()` → DI callback
- 이것들은 hexagonal split과 별개로 진행 가능

---

## Issue 7: S4/S5 — Simulation ≠ Reality (Fidelity Gaps)

### 증상
SimulationRuntime과 RealRuntime 사이에 behavioral divergence:
- Lock ownership 미모델링 (S4)
- env.json 미작성 (S5)
- Namespace resolution 차이 (S5)
- noRealIO 범위 부족 (S8/G3)
- Write ordering 역전 허용 (G10 — BUG-5로 수정됨)
- SequentialIds restart 시 reset (G11)

### 근본 원인
Simulation이 **control-flow exerciser**로 설계되었지 **behavioral oracle**이 아님. Lock, env, namespace는 control flow에 영향을 주지 않으므로 stub으로 처리됨. 하지만 이 gap들이 production-only bug (BUG-1, BUG-2)를 simulation으로 잡을 수 없게 만듦.

### 위치
- `src/execution/simulation/core/index.ts:360-380` (lock stubs)
- `src/execution/simulation/core/mock-process.ts:342-430` (env.json 미작성)
- `src/execution/simulation/core/runtime-doubles.ts:64-83` (namespace hash 차이)

### Pioneer 결정
**Scope 선언 + 점진적 fidelity 확대**:
- SimulationWorld JSDoc에 scope 선언: "Control-flow exerciser — verifies lifecycle/recovery sequencing and job state transitions. Does not model lock contention, env inheritance, or network behavior."
- 개별 fidelity gap은 specific test need에 의해 driven (preemptive completeness 아님)
- Issue 5 (Generational World)와 Issue 6 (Sealed Runtime)이 fidelity 확대의 기반

### 정석
**Declared Scope + Incremental Fidelity**:
- Simulation의 목적을 명시적으로 선언하면, 각 gap이 "bug" vs "known limitation"으로 분류 가능
- 새 fidelity 추가는 specific test scenario에 의해 pull (push 아님)
- BUG-5 (write ordering)처럼 production에서 불가능한 상태를 허용하는 gap은 즉시 수정
- Lock contention 같은 복잡한 fidelity는 multi-daemon test가 필요할 때 추가

---

## 의존성 관계

```
Issue 6 (Sealed Runtime / Hexagonal)
  ├── requires Issue 3 (Lifecycle SM) — lifecycle에서 discuss import 제거가 전제
  ├── requires Issue 2 (Observable Runtime) — noRealIO 대체가 전제
  └── enables Issue 7 (Simulation Fidelity) — sealed simulation이 fidelity 확대의 기반

Issue 3 (Lifecycle SM) — 독립 실행 가능
Issue 2 (Observable Runtime) — 독립 실행 가능
Issue 1 (BUG-1 DaemonProbe) — 독립 실행 가능
Issue 4 (RecoveryEnvironment + Adoption) — Issue 3 후 더 쉬움
Issue 5 (Generational World) — 독립 실행 가능
Issue 7 (Simulation Fidelity) — Issue 6 후
```

## 이전 시도의 교훈

1. **7건을 한 번에 하려 하면 scope 폭발** — 각 issue가 다른 issue에 cascade
2. **Agent 병렬 실행 시 같은 파일 충돌** — lifecycle.ts, server.ts, paths.ts가 여러 AC에서 동시 수정
3. **Kernel 추출은 Hexagonal Architecture의 축소판** — 진짜 해야 할 것은 composition root 분리
4. **Dual-path fallback 제거는 scope가 크다** — paths.ts 하나만 순수화해도 수십 개 caller 수정 필요
5. **lifecycle.ts의 discuss value imports가 sealing의 핵심 blocker** — lifecycle hooks가 먼저 필요
