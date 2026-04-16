# CLI Jobs Surface Redesign

**Preplan**: `CORAL_PROJECT/plans/pre-cli-jobs-surface-redesign.md`

## Requirements Summary

Coral CLI는 현재 `list`로 session만 보여주고 활성 job 발견 경로가 없다. 사용자는 `/tmp/coral-jobs/` 직접 탐색이나 SIGKILL로 멈춘 job을 정리해야 한다.

핵심 도메인 구분:
- **Session** — Claude/Codex provider가 소유하는 **대화 연속성 토큰**. Coral이 직접 조작하는 primitive가 아님.
- **Job** — Coral 자체의 실행 시도 단위. launch → terminal. 사용자가 능동적으로 관찰·조작하는 primitive.

따라서 Coral의 public surface는 **job only**로 정리한다. Session은 launch 응답의 opaque 토큰으로만 남고, HTTP·CLI·SSE 전반에서 **session browsing surface는 완전 제거**한다. Provider의 실제 대화 데이터는 Claude/Codex가 자기 파일시스템·스토리지에 보관하므로 외부 대시보드(Reef 등)가 세션 인벤토리를 원하면 cold-scan으로 독립 구축한다.

`session:updated` SSE topic도 `job:terminal` 이벤트에서 파생 가능하므로 제거한다. Reef ChatUI처럼 이 이벤트에 의존하던 consumer는 `job:terminal { sessionId }`로 대체 가능하며, 그건 Reef의 책임 범위다.

핵심 방향:
1. `GET /api/jobs`에 `projectRoot`/`phase`/`all`/`provider` 쿼리 필터 추가 (raw shape 유지 — Reef의 `syncJobs`는 계속 동작).
2. `GET /sessions` HTTP 라우트 + `SessionIndex` plumbing + `session-index.ts` 전부 제거. Reef의 `safeFetch('/sessions')`는 null 받고 sync skip — Reef는 자체 cold-scan으로 session 인벤토리 구축 지속.
3. `session:updated` event bus topic + emit + SSE relay + 관련 internal listener 제거. 내부 consumer(`job-lifecycle.ts`의 waitForJob 등)는 job 이벤트 기반으로 refactor.
4. `client.listSessions`, `SessionsListResponse`, `LenientSessionEntry`의 client/index.ts 재수출 제거. `src/client/readers.ts`의 filesystem 헬퍼는 유지 (cold-scan 등 파일 소비자용).
5. `coral-cli list` 제거, `coral-cli jobs` 신설, `coral-cli abort` selector 확장.
6. Docs/skills/agents/tests 일괄 업데이트.

Reef 저장소는 본 PR scope 밖. Coral `/sessions` 제거 → Reef의 session sync는 자동으로 건너뜀 (safeFetch null). Reef가 여전히 session inventory를 원하면 cold-scan 경로가 이미 존재하므로 별도 housekeeping으로 충분.

## Acceptance Criteria (testable, verifiable — register each as a Task during implementation)

- **AC1**: `GET /api/jobs`에 쿼리 필터를 추가한다. Response shape는 기존 `{ jobs: [{ jobId, status }] }` 그대로 유지한다.
  - `?projectRoot=<path>` (선택) — `status.projectRoot === projectRoot`인 job만
  - `?phase=<phase>` (선택) — 단일 phase 필터. `JobPhase` Zod enum(`src/shared/types.ts`)으로 validation
  - `?all=1` (선택) — 없으면 기본 live(`running|launching|queued`)만, 있으면 전체 phase
  - `?provider=<name>` (선택) — 해당 provider만
  - 정렬: `updatedAt` 내림차순
  - 쿼리 없으면 기존 동작과 동일 (namespace scope, 전체 phase)
- **AC2**: `GET /sessions` 라우트(`handleSessionListRoute`), 라우트 테이블 등록, 관련 `server.test.ts` 케이스 전부 삭제한다.
- **AC3**: `SessionIndex` plumbing을 제거한다.
  - `src/execution/session-index.ts` 파일 삭제
  - `src/execution/backend-core.ts`의 SessionIndex import/construction/subscription 삭제
  - `src/execution/backend-contracts.ts`의 `sessionIndex` deps type 필드 삭제 (`HttpHandlerDeps`, `LifecycleDeps`, `BackendCoreResult`)
  - `src/execution/lifecycle.ts`의 SessionIndex hydration, discoverShard, subscribe/unsubscribe, invalidate 호출 전부 삭제
  - `src/execution/__tests__/session-index.test.ts` 삭제
  - `lifecycle-recovery.test.ts`, `agent-wire-contract.test.ts`, `server.test.ts` 등에 남아 있는 `sessionIndex` fixture·mock 정리
- **AC4**: `session:updated` event bus topic을 제거한다.
  - `src/execution/session-manager.ts`의 `session:updated` emit 제거 (기존 `:184` 일대)
  - `src/execution/http-handler.ts`의 `writeSseEvent(res, 'session:updated', …)` relay 제거 (기존 `:497-500` 일대)
  - `src/execution/backend-contracts.ts`의 `onSessionUpdated` 타입·옵션 제거
  - `src/execution/job-lifecycle.ts`의 waitForJob re-check listener(기존 `:577`)를 `job` 이벤트 기반으로 refactor — session 이벤트 의존성 제거
  - `TypedEventBus`에서 해당 topic 타입 제거
- **AC5**: Client/barrel 세션 surface 제거:
  - `src/client/http-client.ts`의 `listSessions()` 메서드 및 `SessionsListResponse` 타입 제거
  - `src/client/index.ts`에서 `SessionsListResponse`, `LenientSessionEntry` 재수출 제거
  - `src/client/readers.ts`의 `readSessionEntryLenient`/`LenientSessionEntry`는 filesystem 소비자용으로 **유지**
  - `src/client/__tests__/http-client.test.ts`의 `listSessions` 케이스 삭제
- **AC6**: `coral-cli list` 제거:
  - `src/cli/main.ts:416-449` `list` 커맨드 블록 삭제
  - `src/cli/main.ts:370-374` `coral-cli <provider> list` 레거시 안내 제거
  - `ProviderListOptions`, `SessionListResult`, `formatProviderList` 등 관련 dead symbol 정리
  - `src/cli/__tests__/main-routing.test.ts`의 list 관련 케이스 삭제
  - `src/cli/__tests__/format.test.ts`의 session-list formatter 테스트 정리
- **AC7**: `coral-cli jobs` 커맨드 신설:
  - Commander 옵션: `--phase <phase>`, `--provider <name>`, `--all`
  - Zod 검증: `--phase <specific>` + `--all` 동시 지정 거절, `--provider`는 registered provider만 허용
  - 동작: `client.listJobs({ projectRoot, phase?, all?, provider? })` (AC1의 확장된 쿼리 사용) → 결과를 display layer에서 투영
  - **Text 포맷**: `jobId`, `phase`, `provider`, `cwd`, relative age (CLI가 `status.launch.updatedAt` ISO를 변환) 5열만 표시. `sessionId`/`agent` 등 session metadata는 노출하지 않는다.
  - **JSON 포맷**: CLI가 같은 5개 필드만 담은 객체 배열을 출력 (raw status를 그대로 내보내지 않고 projection). `--verbose` 같은 플래그는 도입하지 않는다 — session 토큰을 CLI로 브라우징하지 않는 것이 원칙.
  - 매치 없으면 text는 `"No jobs match …"` 한 줄, JSON은 빈 배열 `[]`.
- **AC8**: `coral-cli abort` selector 확장:
  - `--jobs <ids>` (기존 호환, exact targeting)
  - `--all` — current-project live(`queued|launching|running`) 전체
  - `--phase <phase>` — live phase만 허용, terminal phase는 Zod validation error
  - `--provider <name>` — 해당 provider의 live job, registered provider 검증
  - Zod 스키마: at least one selector 필수. `--jobs`는 다른 query selector들과 mutually exclusive. `--all`은 standalone. `--phase` + `--provider`만 intersection 허용
  - 동작: query selector 조합은 `client.listJobs({ projectRoot, phase?, provider?, all: false })`(기본 live-only)로 jobId 수집 후 `abortJobs(ids)` 호출. Zero-match → exit 0 no-op, backend 호출 없음
  - `--jobs` exact 모드는 그대로 pass-through. Partial miss(일부 ID가 이미 terminal)는 `AbortResult.notFound`로 반환되고 exit 0
- **AC9**: CLI 테스트 업데이트:
  - `src/cli/__tests__/main-routing.test.ts`에 `jobs` parse/action 테스트 (phase/provider/all, 충돌 케이스, zero-match)
  - 같은 파일에 `abort` 새 selector 테스트 (`--all`, `--phase running`, `--phase running --provider codex`, `--phase completed`→error, selector 미지정→error, `--jobs`+`--all`→error, `--jobs`+`--phase`→error, `--jobs`+`--provider`→error, zero-match no-op, `--jobs <live,terminal>` partial miss)
- **AC10**: Backend 테스트 업데이트:
  - `src/execution/__tests__/server.test.ts`에 `GET /api/jobs` 쿼리 필터 테스트 (projectRoot scope, phase, all, provider, updatedAt sort)
  - `GET /sessions`, `session:updated` SSE 관련 케이스 전부 삭제
  - `lifecycle-recovery.test.ts`, `agent-wire-contract.test.ts`, `flavor-coexistence.test.ts`에서 SessionIndex/session:updated 관련 fixture·assertion 제거
  - `src/client/__tests__/http-client.test.ts`에서 `listSessions` 케이스 삭제
- **AC11**: Docs/skills/agents 업데이트:
  - `docs/skills.md:67` — `session list` 매핑 제거, `coral-cli jobs` 안내
  - `skills/codex/SKILL.md:20` — 동일
  - `.claude/agents/ux-critic.md:79,84` — 예시 스니펫을 `coral-cli jobs --provider codex`로 교체
  - `docs/architecture.md` — `GET /sessions`, `session:updated` SSE 설명 제거, `GET /api/jobs` 쿼리 필터 + CLI `jobs`/`abort` surface 기술
  - `docs/core-modules.md` — `session-index.ts` row 삭제, SessionManager 설명에서 `session:updated` 언급 제거
- **AC12**: `npm run lint`, `npm run build`, `npm test` 모두 clean. 특히 `src/cli/__tests__/`, `src/execution/__tests__/server.test.ts`, `src/execution/__tests__/lifecycle-recovery.test.ts`, `src/__tests__/integration/agent-wire-contract.test.ts`, `src/__tests__/integration/flavor-coexistence.test.ts`, `src/client/__tests__/http-client.test.ts`가 새 contract를 반영한다.
- **AC13**: Grep 검증:
  - `rg "coral-cli list|client\.listSessions|SessionsListResponse|Legacy \"coral-cli .* list\"" src/ docs/ skills/ .claude/` → 0 active matches
  - `rg "GET /sessions|handleSessionListRoute|pattern: /\^\\/sessions\$/|SessionIndex" src/execution docs/` → 0 active matches
  - `rg "session:updated|onSessionUpdated" src/ docs/` → 0 active matches (테스트 fixture 제외)
  - `POST /sessions`, `/discuss/sessions`, `src/client/readers.ts`의 `LenientSessionEntry`는 유지 대상이므로 grep 허용 리스트에서 제외

## Execution Order

### Dependency Graph
```
AC1 ─→ AC7 ─→ AC8 ─→ AC9
                │
 AC2 ─→ AC3 ─→ AC4 ─→ AC10
  │     │      │
  └─────┴──────┴─→ AC5 ─→ AC6 ─→ AC11 ─→ AC12 ─→ AC13
```

### Batches
| Batch | ACs | Dependencies | Parallel | Notes |
|-------|-----|--------------|----------|-------|
| 1 | AC1, AC2 | — | 2 | `/api/jobs` 쿼리 확장 + `/sessions` 삭제 (다른 route handlers) |
| 2 | AC3 | AC2 | 1 | SessionIndex plumbing 제거 (backend-core, contracts, lifecycle, file 삭제) |
| 3 | AC4 | AC3 | 1 | `session:updated` 제거 + `job-lifecycle.ts` waitForJob refactor |
| 4 | AC5 | AC2 | 1 | Client surface 정리 |
| 5 | AC6 | — | 1 | CLI `list` 삭제 (독립) |
| 6 | AC7 | AC1, AC6 | 1 | `coral-cli jobs` (cli/main.ts) |
| 7 | AC8 | AC7 | 1 | `coral-cli abort` 확장 (같은 파일, 순차) |
| 8 | AC9, AC10 | AC4, AC5, AC8 | 2 | CLI 테스트 + backend 테스트 |
| 9 | AC11 | AC8 | 1 | Docs 업데이트 |
| 10 | AC12 | 1~9 | 1 | lint/build/test gate |
| 11 | AC13 | 10 | 1 | Grep verification |

### File Mapping
| AC | Files |
|----|-------|
| AC1 | `src/execution/http-handler.ts` (handleJobListRoute 쿼리 확장), `src/shared/schemas.ts` (쿼리 schema 필요 시) |
| AC2 | `src/execution/http-handler.ts` (handleSessionListRoute + route registration 삭제) |
| AC3 | `src/execution/session-index.ts` (delete), `src/execution/backend-core.ts`, `src/execution/backend-contracts.ts`, `src/execution/lifecycle.ts` |
| AC4 | `src/execution/session-manager.ts`, `src/execution/http-handler.ts`, `src/execution/backend-contracts.ts`, `src/execution/job-lifecycle.ts`, `src/execution/event-bus.ts` (topic 타입) |
| AC5 | `src/client/http-client.ts`, `src/client/index.ts`, `src/client/__tests__/http-client.test.ts` |
| AC6 | `src/cli/main.ts`, `src/cli/format.ts`, `src/cli/__tests__/format.test.ts` |
| AC7 | `src/cli/main.ts`, `src/cli/format.ts` (formatJobsList 추가), `src/client/http-client.ts` (listJobs 쿼리 옵션 확장) |
| AC8 | `src/cli/main.ts` |
| AC9 | `src/cli/__tests__/main-routing.test.ts` |
| AC10 | `src/execution/__tests__/server.test.ts`, `src/execution/__tests__/session-index.test.ts` (delete), `src/execution/__tests__/lifecycle-recovery.test.ts`, `src/__tests__/integration/agent-wire-contract.test.ts`, `src/__tests__/integration/flavor-coexistence.test.ts`, `src/client/__tests__/http-client.test.ts` |
| AC11 | `docs/skills.md`, `skills/codex/SKILL.md`, `.claude/agents/ux-critic.md`, `docs/architecture.md`, `docs/core-modules.md` |
| AC12 | execution gate — `npm run lint && npm run build && npm test` |
| AC13 | execution gate — targeted `rg` patterns |

Every AC appears in exactly one batch; no two ACs in the same batch share a file.

## Mathematical Specification (if applicable)

N/A — CLI/HTTP surface 재설계.

## Implementation Phases (with file:line references)

### Phase A — Backend `/api/jobs` 확장 + `/sessions` 제거
1. `src/execution/http-handler.ts` `handleJobListRoute`에 `projectRoot`/`phase`/`all`/`provider` 쿼리 파싱. Zod로 `phase` validation. 기본 live-only filter(`all`이 없을 때).
2. 같은 파일 `handleSessionListRoute` + 라우트 테이블의 `GET /sessions` 삭제.
3. `src/execution/__tests__/server.test.ts`의 `/api/jobs` 쿼리 테스트 추가, `/sessions` 관련 케이스 삭제.

### Phase B — SessionIndex plumbing 제거
4. `src/execution/session-index.ts` 파일 삭제.
5. `src/execution/backend-contracts.ts`에서 `sessionIndex` deps 필드 제거.
6. `src/execution/backend-core.ts`에서 SessionIndex 생성·주입·subscribe 제거.
7. `src/execution/lifecycle.ts`에서 SessionIndex hydrate/discoverShard/invalidate/subscribeSessionIndex/unsubscribeSessionIndex 제거.
8. `src/execution/__tests__/session-index.test.ts` 삭제.
9. `lifecycle-recovery.test.ts`, `agent-wire-contract.test.ts`에서 SessionIndex fixture·mock 정리.

### Phase C — `session:updated` 이벤트 + SSE 제거
10. `src/execution/session-manager.ts`의 `session:updated` emit 호출(`:184` 일대) 삭제.
11. `src/execution/http-handler.ts`의 `writeSseEvent(res, 'session:updated', ...)`(`:497-500` 일대) 및 subscribe 제거.
12. `src/execution/backend-contracts.ts`의 `onSessionUpdated` 타입 제거.
13. `src/execution/job-lifecycle.ts` waitForJob 내 session-updated listener를 job 이벤트 기반으로 재작성.
14. `src/execution/event-bus.ts` 또는 `TypedEventBus` 타입 선언에서 `session:updated` 토픽 제거.

### Phase D — Client surface 정리
15. `src/client/http-client.ts`의 `listSessions()`, `SessionsListResponse` 제거. `listJobs` 시그니처를 `(options?: { projectRoot?; phase?; all?; provider? }, context?)`로 확장. `projectRoot`는 context에서 기본값 주입.
16. `src/client/index.ts`에서 `SessionsListResponse`, `LenientSessionEntry` 재수출 삭제. `src/client/readers.ts`의 `readSessionEntryLenient`/`LenientSessionEntry`는 유지.
17. `src/client/__tests__/http-client.test.ts`의 `listSessions` 케이스 삭제, `listJobs` 옵션 테스트 추가.

### Phase E — CLI `list` 제거
18. `src/cli/main.ts:416-449` `list` 블록 삭제.
19. `src/cli/main.ts:370-374` 레거시 안내 삭제.
20. `ProviderListOptions`, `SessionListResult`, `formatProviderList` 관련 심볼 제거. `src/cli/format.ts`에서 session-list formatter 삭제.
21. `src/cli/__tests__/format.test.ts`에서 session-list 관련 테스트 정리.

### Phase F — CLI `jobs` + `abort` 확장
22. `src/cli/main.ts`에 `jobsCommand` 등록. Commander + Zod validation. `client.listJobs({ projectRoot, phase, all, provider })` 호출. Display projection(5 columns text, JSON filtered shape).
23. `src/cli/format.ts`에 `formatJobsList` 추가 (relative age는 CLI-computed).
24. `src/cli/main.ts`의 `abortCommand` 재작성. Flags: `--jobs`, `--all`, `--phase`, `--provider`. Zod selector mutex. Zero-match no-op. Query selectors는 내부적으로 `client.listJobs`(live-only) 재사용.

### Phase G — 테스트·문서 마무리
25. `src/cli/__tests__/main-routing.test.ts`에 `jobs`/`abort` 새 동작 테스트 추가.
26. `docs/skills.md`, `skills/codex/SKILL.md`, `.claude/agents/ux-critic.md`, `docs/architecture.md`, `docs/core-modules.md` 업데이트.
27. `npm run lint`, `npm run build`, `npm test`를 실행해 clean 통과 확인.
28. AC13의 grep 명령을 모두 실행해 0 match 확인.

## Risks & Mitigations

| # | 위험 | 완화 |
|---|------|------|
| R1 | `/api/jobs` 쿼리 확장이 기존 raw consumer(Reef 포함)를 깨뜨린다. | Response shape는 고정, 쿼리는 전부 선택. 쿼리 없으면 기존 동작과 완전히 동일. `flavor-coexistence.test.ts`가 raw shape guard로 유지. |
| R2 | `/sessions` 제거가 Reef의 session sync를 깨뜨린다. | Reef의 `safeFetch`(`remote-sync.ts:246-258`)는 실패 시 null 반환 → syncSessions가 자연스럽게 skip. crash 없음. 기존 session row는 stale로 남고 Reef 자체 cold-scan이 계속 session 인벤토리를 채움. |
| R3 | `session:updated` 제거가 Reef ChatUI의 live refresh를 깨뜨린다. | ChatUI는 `job:terminal { sessionId }`에 필터링해 동등한 invalidation을 얻을 수 있음. 이는 Reef 측 adaptation이며 본 PR의 coral scope 밖. coral CHANGELOG에 removal을 명시해 consumer 측이 대응 가능하도록 한다. |
| R4 | `SessionIndex` 제거로 backend 내부 recovery/discuss 경로가 깨질 수 있다. | SessionIndex는 HTTP `/sessions` 응답용 인덱스. 확인 결과 backend-core·lifecycle의 hydration/subscription 외에 production consumer 없음. Recovery는 `SessionManager` 직접 사용. 테스트가 regression guard. |
| R5 | `--all`/`--phase`/`--provider`가 terminal job까지 끌어와 `notFound` spam. | abort selector는 기본 live(`queued|launching|running`)만 조회하도록 `client.listJobs`에 `all: false` 고정. terminal phase 명시 요청은 Zod validation으로 거절. |
| R6 | Zero-match abort가 backend 호출로 404 발생. | CLI가 jobId 수집 후 빈 배열이면 backend POST 자체를 skip, exit 0 no-op로 처리. |
| R7 | `--jobs` + `--phase` 등 모순 조합이 silent success. | Zod selector mutex로 명시적으로 거절 + 한 줄 에러 메시지 + 사용 예시. |
| R8 | `job-lifecycle.ts` waitForJob refactor에서 race condition이 생긴다. | refactor는 기존 session-updated listener가 검사하던 조건(session.conversationRef 획득 등)을 job:terminal의 `result.conversationRef`로 대체. 기존 테스트 커버리지 유지 + 필요 시 race 테스트 추가. |

## Verification Steps

1. `npm run lint` — 0 errors.
2. `npm run build` — tsc + esbuild clean.
3. `npm test` — vitest 전체 통과 (`server.test.ts`, `http-client.test.ts`, `main-routing.test.ts`, `format.test.ts`, `lifecycle-recovery.test.ts`, `agent-wire-contract.test.ts`, `flavor-coexistence.test.ts` 포함).
4. 수동 검증 (로컬 backend):
   - `coral-cli jobs` → 현재 프로젝트 live job만, 5열 출력
   - `coral-cli jobs --all` → 모든 phase
   - `coral-cli jobs --phase running --provider codex` → 필터 조합
   - `coral-cli abort --all` → live job 전부 abort, `AbortResult` 반환
   - `coral-cli abort --phase completed` → validation error
   - `coral-cli abort --jobs <none-matching>` → exit 0, no backend call
   - `coral-cli list` → "unknown command"
   - `curl "http://.../api/jobs?projectRoot=..."` → 현재 프로젝트만, shape 유지
   - `curl "http://.../api/jobs?projectRoot=...&phase=running"` → live running만
   - `curl http://.../sessions` → 404
   - SSE subscribe 시 `session:updated` event 없음, `job:*` event만 스트리밍
5. grep (AC13 전체 명령) → 0 active matches (허용 리스트 제외).
