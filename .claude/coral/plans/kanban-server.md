# coral-reef: Kanban Board with AI Agent Orchestration

## Requirements Summary

별도 리포지토리 `coral-reef`로 구현하는 웹 기반 칸반 보드. coral의 AI 에이전트 파이프라인(preplan → plan → implement)을 시각적으로 관리하고, 각 카드의 상태 전이에 따라 Claude/Codex 세션을 자동 트리거한다.

**Core flow**:
1. 카드 생성 → 즉시 Claude preplan 세션 시작
2. 웹 UI에서 Claude와 대화형 preplan 진행
3. 모든 `unconfirmed` 해소 후에만 Plan 승격 가능
4. Plan 단계: plan 파일 실시간 열람 + phase/round 진행도 표시
5. 사용자 승인 → ralph 자동 실행

**Automation boundary (reconstructed)**:
- 수동 CLI(`/coral:preplan` → `/coral:plan` → `/coral:ralph`)를 웹 액션으로 대체한다.
- coral-reef가 단계 전이의 오케스트레이터다. 승격/승인은 서버 API에서 가드 검증 후 SDK 호출로 이어진다.
- coral 본체 변경은 SessionStart hook 추가만 허용한다. 전이 로직은 coral-reef 내부에서 완결한다.

| UI action | Server guard | Agent action |
|-----------|--------------|--------------|
| 카드 생성 | 필수 필드 검증 | Claude preplan prompt 전송 |
| Plan 승격 | `unconfirmed_count`가 정수 `0`인지 확인 | 새 Claude plan 세션 시작 |
| Implement 승인 | plan 단계 완료/승인 확인 | Codex ralph 실행 후 성공 시 `done`, 실패 시 `failed` |

**Why separate repo (reconstructed)**:
- Agent SDK/Codex SDK 의존성을 coral 번들에서 분리해 릴리즈 결합도를 낮춘다.
- coral-reef는 독립 `npm install`/`npm build`/배포 단위를 가진다.
- coral 플러그인 캐시를 읽는 hard dependency는 유지하되, 경로 탐색/버전 호환 전략은 coral-reef에서 책임진다.

## Acceptance Criteria (testable, verifiable)

1. `npm start` 실행 시 HTTP 서버가 `0.0.0.0:<port>`로 bind되고, `localhost`/`<host-ip>` 모두에서 health check 가능
2. 카드 생성 즉시 Claude preplan 세션이 열리고 preplan 프롬프트 자동 전송
3. 웹 UI 채팅 입력 시 Claude 응답이 스트리밍 표시
4. Plan 승격 API는 `unconfirmed_count`가 정수 `0`이 아니면 거부한다 (`>0`은 409, 음수/비정수/null은 400)
5. Plan 실행 중 `.claude/coral/plans/{name}.md` 변경이 파일 watcher를 통해 `plan_update`로 즉시 방송
6. Plan 카드에서 현재 phase/round가 parser 결과로 표시
7. Plan 승인 시 ralph 세션 자동 시작
8. 6시간 무활동 + 활성 세션 0건일 때만 graceful shutdown을 시작하고, 시작 후 신규 HTTP/WS 요청은 차단한다
9. coral 미설치/플러그인 미탐지 시 `npm start`에서 탐색 경로 포함한 명확한 에러 출력
10. SessionStart hook은 health URL이 유효하지 않더라도 항상 JSON(`hookSpecificOutput.additionalContext`)을 stdout으로 출력한다
11. 서버 미기동이면 SessionStart 컨텍스트가 Claude에게 AskUserQuestion 수행을 지시
12. 세션 시작 실패/런타임 크래시 발생 시 카드 상태가 `failed`로 전이되고 retry API로 복구 가능
13. Linux/macOS/Windows에서 coral 플러그인 탐색 경로가 동작하거나, 불가 시 안내 메시지 출력
14. 동시 카드 10개 이상 요청 시 `MAX_ACTIVE_SESSIONS` 상한을 넘는 요청은 큐잉되어 단일 admission control 경로로 실행된다

## Implementation Phases (with file:line references)

### Phase 0: SDK Contract Validation

**Goal**: 두 SDK의 실제 API 형상을 검증하고 TypeScript 인터페이스로 고정

**Steps**:
1. `npm install @anthropic-ai/claude-agent-sdk @openai/codex-sdk` 후 실제 export 확인
2. Claude Agent SDK smoke test:
   - V1 `query()` + `AsyncIterable<SDKUserMessage>` 패턴과 V2 `createSession()` + `send()`/`stream()` 패턴 중 실제 사용 가능한 API 확인. **V2 stable이면 V2 채택** (event 기반으로 WS 브리징이 단순). V2 unstable/미존재면 V1 input generator 패턴을 채택하고 generator→WebSocket 브리징 설계를 `sdk-contracts.ts`에 기록
   - custom `systemPrompt` 주입 방법 확인 (agent-level `query()`에서 system prompt 설정이 가능한지, 아니면 별도 설정이 필요한지)
   - `resumeSession(sessionId)` 지원 여부 확인. 미지원 시 rehydrate 전략을 "항상 새 세션 + 기존 agreement 파일 기반 복구"로 변경
   - 세션에서 tool 접근 가능 여부 확인 (Read, Glob, Grep 등 — preplan에 필요). 미지원 시 system prompt에 "사용자에게 코드 내용을 요청하라" fallback 지시 포함
   - **Agent 도구/MCP 접근 확인**: SDK 세션에서 Claude Code의 `Agent` 도구와 coral MCP 서버 접근이 가능한지 확인. 결과에 따라:
     - 가능: plan/ralph도 SDK로 실행 가능 (단, 이 경우는 극히 드묾)
     - **불가 (예상 기본값)**: plan/ralph는 CLI spawn으로 실행 확정. SDK는 preplan 대화 전용으로 한정. 이는 `sdk-contracts.ts`에 명시적으로 기록
   - 세션 종료/완료/에러 이벤트 형상 확인: `AsyncIterable` 종료가 정상 완료인지, 에러 종료인지, 연결 끊김인지 구분 가능한지 검증. 구분 불가하면 timeout + heartbeat 기반 liveness 검출 전략 설계
   - streaming partial text chunk 가용 여부 확인 (WS `assistant` chunk 이벤트에 필요)
3. Codex SDK smoke test:
   - `new Codex()` → `startThread()` → `run()` 패턴 확인
   - `resumeThread(threadId)` 지원 여부 확인
   - `runStreamed()` 이벤트 형상 확인. 미존재 시 implement 단계 진행도를 polling 기반으로 변경하고 WS `assistant` 타입을 주기적 상태 업데이트로 대체
4. 검증된 API 형상을 `src/sessions/sdk-contracts.ts`에 TypeScript interface로 고정. 선택된 SDK 버전(V1/V2)과 fallback 결정 사항을 함께 기록
5. 만약 API가 preplan 가정과 다르면: 차이점을 기록하고 Phase 3 세션 래퍼를 실제 API에 맞게 재설계

**Exit criteria**: 두 SDK의 핵심 메서드가 동작하는 최소 스크립트가 실행되고, TypeScript interface가 확정되며, MCP 접근/세션 종료 감지/스트리밍 가용성에 대한 결정이 `sdk-contracts.ts`에 문서화됨

### Phase 1: Project Scaffolding

**Goal**: 빌드 가능한 빈 프로젝트 + `node:http` 기반 서버 골격

```
coral-reef/
├── package.json
├── package-lock.json
├── tsconfig.json
├── src/
│   ├── server.ts
│   ├── config.ts
│   ├── coral-bridge.ts
│   ├── db/
│   │   └── store.ts
│   ├── sessions/
│   │   ├── claude-session.ts
│   │   ├── cli-session.ts
│   │   ├── codex-session.ts
│   │   ├── sdk-contracts.ts
│   │   └── session-manager.ts
│   ├── plan/
│   │   ├── progress-parser.ts
│   │   └── unconfirmed-parser.ts
│   ├── watchers/
│   │   └── plan-watch.ts
│   ├── api/
│   │   ├── cards.ts
│   │   └── ws.ts
│   └── ui/
│       └── (정적 파일)
├── .gitignore
└── README.md
```

**Steps**:
1. `mkdir ../coral-reef && cd ../coral-reef && npm init -y`
2. `package.json`/`package-lock.json` 생성 후 exact version 고정 (`latest` 금지)
3. `tsconfig.json` strict ESM 설정
4. `src/config.ts` 정의: `PORT`, `HOST`, `PLAN_ROOT`, `IDLE_TIMEOUT_MS`, `SHUTDOWN_GRACE_MS`, `CORAL_CACHE_PATHS`, `MAX_ACTIVE_SESSIONS`, `RETRY_BASE_DELAY_MS`, `RETRY_MAX_ATTEMPTS`
5. `src/server.ts`에서 `node:http` + health endpoint 구성
6. 빌드 확인: `npm run build && npm start`

**Dependencies policy**:
```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "<exact-tested-version>",
    "@openai/codex-sdk": "<exact-tested-version>",
    "better-sqlite3": "<exact-tested-version>",
    "ws": "<exact-tested-version>"
  },
  "devDependencies": {
    "typescript": "<exact-tested-version>",
    "@types/better-sqlite3": "<exact-tested-version>",
    "@types/ws": "<exact-tested-version>"
  }
}
```
- `<exact-tested-version>`은 Phase 1에서 lockfile 기준으로 확정한다.
- SDK 업그레이드는 별도 브랜치에서 contract test 통과 후 반영한다.

### Phase 2: Coral Bridge + SQLite Store

**Goal**: coral 플러그인 탐색을 결정론적으로 만들고 카드/세션 상태를 영속화

`src/coral-bridge.ts`:
- 탐색 순서:
  1. `CORAL_PLUGIN_ROOT` (명시 설정)
  2. `CLAUDE_PLUGIN_ROOT` (Claude Code가 플러그인 로드 시 자동 설정하는 내부 변수. 사용자 설정 불가. coral 플러그인 버전 디렉토리를 직접 가리킨다 — 예: `~/.claude/plugins/cache/coral/0.4.3/`. 값 자체를 coral 루트 후보로 사용한다. semver 순회 없이 필수 파일만 검증. `CORAL_PLUGIN_ROOT`가 우선)
  3. `${homedir()}/.claude/plugins/cache/coral` (Linux/macOS)
  4. `${USERPROFILE}\\.claude\\plugins\\cache\\coral` (Windows 기본)
  5. `${LOCALAPPDATA}\\.claude\\plugins\\cache\\coral` (Windows 대체)
  6. `${LOCALAPPDATA}\\Claude\\plugins\\cache\\coral` (Windows 대체)
- 버전 디렉토리를 semver 내림차순으로 순회
- 각 버전에서 필수 파일 검증:
  - `skills/preplan/SKILL.md`
  - `skills/plan/SKILL.md`
  - `skills/ralph/SKILL.md`
  - `agents/*.md` 최소 1개
- 첫 번째 유효 버전을 채택하고 버전/경로를 로그에 기록
- 유효 버전이 없으면 시도한 전체 탐색 경로(순서 포함)/누락 파일 목록을 포함한 에러로 fail-fast

`src/db/store.ts`:
- SQLite 스키마:
  ```sql
  CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'backlog',
    -- backlog | preplan | plan | implement | done | failed
    session_id TEXT,
    session_state TEXT NOT NULL DEFAULT 'idle',
    unconfirmed_count INTEGER NOT NULL DEFAULT 0,
    plan_file TEXT,
    transition_token TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    retry_attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER,
    retry_exhausted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  ```
- 필수 함수:
  - `setUnconfirmedCount(cardId, count)`
  - `setSessionState(cardId, state, lastError?)`
  - `setPlanFile(cardId, planFile)`
  - `tryBeginTransition(cardId, transitionToken)` / `endTransition(cardId, transitionToken)`
  - `updateCardCAS(cardId, expectedVersion, patch)`
  - `setRetryState(cardId, { attempts, nextRetryAt, exhausted })`
  - `listRecoverableCards()`
  - `flush()`

### Phase 3: Session Management (Claude + Codex)

**Goal**: SDK 래퍼 + 실패 복구 가능한 카드-세션 상태머신

**Preplan Integration Contract**:
- `startPreplan`은 `coral-bridge.ts`에서 `skills/preplan/SKILL.md`를 읽어 `<Preplan_Protocol>` 블록을 추출하고, 이를 Agent SDK 세션의 system prompt로 주입한다.
- Agent SDK 세션은 tool 접근이 가능해야 한다 (Read, Glob, Grep 등 — preplan 프로토콜이 코드 분석을 요구함). Phase 0에서 tool 접근 가능 여부를 검증하고, 불가하면 system prompt에 "사용자에게 코드 내용을 요청하라"는 fallback 지시를 포함한다.
- `unconfirmed_count` 추출:
  - 파싱 대상: agreement 파일(`.claude/coral/plans/pre-{topic}.md`)의 5개 필수 항목 섹션 헤딩에서 `[unconfirmed]` 마커를 카운트한다. 화이트리스트: `Problem Statement`, `Success Criteria`, `Scope`, `Assumptions`, `Affected Systems`. 정규식: `/^## (Problem Statement|Success Criteria|Scope|Assumptions|Affected Systems) \[unconfirmed\]/gm`. 서브 아이템이나 optional 섹션(`Constraints`, `Approach Direction`)의 마커는 카운트하지 않는다.
  - 업데이트 타이밍: promote 요청 시 on-demand로 파싱한다 (별도 file watcher 불필요). UI의 실시간 `unconfirmed_count` 표시는 preplan 세션의 assistant 메시지 이벤트에 피기백해 파일을 re-parse하고 WS로 업데이트를 전송한다.
  - 파싱 모듈: `src/plan/unconfirmed-parser.ts`에 독립 구현.

**Plan/Ralph Execution Model (CLI spawn 기반)**:
- Plan/ralph 단계는 Agent SDK가 아닌 **CLI spawn** (`claude -p --output-format stream-json`) 방식으로 실행한다. 이유:
  - plan skill 프로토콜이 Claude Code의 `Agent` 도구(subagent 생성)에 의존하며, Agent SDK 세션에서는 이 도구가 사용 불가
  - plan skill의 `--codex` 모드는 coral MCP 도구(`mcp__plugin_coral_ax__codex`)에 의존하며, SDK 세션에서 MCP 서버 접근이 보장되지 않음
  - CLI spawn은 coral의 기존 아키텍처(ax MCP의 `claude-executor.ts`)와 동일한 패턴
- `promoteToPlan`은 `claude -p --output-format stream-json` 프로세스를 spawn하고 prompt를 stdin으로 전달한다 (coral의 `spawnCli` 패턴과 동일). JSONL 이벤트를 파싱해 진행도를 추적한다
- `promoteToImpl`은 동일 패턴으로 ralph prompt를 stdin 전달하여 실행
- 서버의 역할은 **관찰자**: plan 파일 watcher가 `plan_file` 변경을 감지하고, progress-parser가 phase/round를 추출해 WS로 브로드캐스트한다
- CLI 프로세스 종료 시 exit code + 최종 출력으로 성공/실패를 판단. 사용자가 UI에서 승인 버튼을 눌러야 implement로 진행된다

**SDK vs CLI 사용 결정 트리**:
| 단계 | 방식 | 이유 |
|------|------|------|
| Preplan | Agent SDK (interactive) | 실시간 대화가 핵심 — SDK의 send/stream이 필요 |
| Plan | CLI spawn | `Agent` 도구 + coral MCP 접근 필요 — Claude Code 환경에서만 가능 |
| Ralph (implement) | CLI spawn | plan과 동일한 이유 + 코드 실행 도구 접근 필요 |

`src/sessions/claude-session.ts` (SDK 기반 — preplan 대화 전용):
- `createInteractiveSession(systemPrompt, options?: { tools?: boolean })`
- `resumeSession(sessionId)` / `sendMessage(text)` / `onEvent(callback)` / `close()`
- 시작 실패 시 분류 가능한 에러 코드 반환 (`auth`, `timeout`, `rate_limit`, `unknown`)

`src/sessions/cli-session.ts` (CLI spawn 기반 — plan/ralph 실행):
- `spawnPlan(prompt, planFilePath)` / `spawnRalph(prompt)`
- `onJsonlEvent(callback)` / `kill()` / `exitCode(): Promise<number>`
- `claude -p "<prompt>" --output-format stream-json` 프로세스 관리
- JSONL 파싱으로 `assistant` 텍스트, tool 사용, 에러 이벤트 추출

`src/sessions/codex-session.ts`:
- `createThread()` / `sendMessage(text)` / `resumeThread(threadId)` / `close()`

**Transition state lifecycle** (전이 카운터 범위 정의):
```
idle ──[request]──→ validating ──[CAS ok]──→ queued ──[dequeue]──→ starting ──→ active ──→ completed
                                                                                    └──→ failed
```
- `activeCount()`: `starting` + `active` 상태의 세션 수
- `pendingCount()`: `queued` 상태의 항목 수 (FIFO 큐 길이)
- `validating` 구간은 전이 락이 점유되는 짧은 동기 구간이므로 카운터에 포함하지 않는다

`src/sessions/session-manager.ts`:
- 공통 제약:
  - `MAX_ACTIVE_SESSIONS` 상한을 넘는 전이(`startPreplan`/`promoteToPlan`/`promoteToImpl`/`retryFailedSession`/`rehydrateOnBoot`)는 `queued`로 저장하고 FIFO 큐에 적재 (`202 Accepted`)
  - 카드별 전이 락(`transition_token`)은 요청 검증 + 큐 적재 CAS까지의 짧은 구간에서만 점유한다. 큐 대기 중에는 락을 해제하고, dequeue 시 새 토큰으로 재획득 + `updateCardCAS` 재검증 후 실행한다. 재검증 실패(버전 변경) 항목은 stale로 폐기한다.
  - 카드별 전이 락으로 `promote`/`approve`/`retry` 동시 요청을 직렬화한다. 이미 전이 중이면 `409 transition_in_progress`
  - retry는 `RETRY_BASE_DELAY_MS * 2^attempt + jitter` 백오프, 최대 `RETRY_MAX_ATTEMPTS`를 적용하고 `retry_attempts`/`next_retry_at`/`retry_exhausted`를 영속화한다
  - `activeCount()`/`pendingCount()`/`pauseDequeues()`/`cancelQueuedTransitions(reason)`/`on("heartbeat")`를 노출해 idle timeout, admission control, shutdown이 동일 지표/제어 경로를 사용한다
  - `pauseDequeues()` 호출 시점부터 dequeue worker는 즉시 정지되며, 큐 항목이 새로 실행 상태로 진입하지 않는다.
  - `cancelQueuedTransitions(reason)`는 모든 queued 항목을 cancel/fail 처리하고 `transition_token` 해제 및 DB 반영이 끝난 뒤에만 resolve된다.
- `startPreplan(cardId, description)`:
  - 카드 상태 `preplan`, 세션 상태 `starting` → `active`
  - 실패 시 `failed` + `last_error`
- `promoteToPlan(cardId)`:
  - `unconfirmed_count`가 정수 `0`인지 검증 (`>0`은 409, 음수/비정수/null은 400)
  - 새 Claude plan 세션 시작
  - `plan_file` 경로 저장
- `promoteToImpl(cardId)`:
  - plan 승인 후 Codex ralph 실행 (`MAX_ACTIVE_SESSIONS` 초과 시 동일 admission queue 경로로 `202 queued`)
  - ralph 성공 종료 시 카드 상태 `done`, 세션 상태 `completed`로 CAS 업데이트
  - ralph 실패/크래시 시 카드 상태 `failed` + `last_error` 저장, retry 정책 경로로 연결
  - 중복 완료 이벤트는 `updateCardCAS` 기준 no-op 처리(멱등성 보장)
- `retryFailedSession(cardId)`:
  - 마지막 실패 지점 기준 재시도(큐/백오프 정책 적용)
  - 최대 시도 초과 시 `retry_exhausted=1`로 고정하고 non-retryable `failed` 상태 유지
- `rehydrateOnBoot()`:
  - Claude는 `resumeSession(sessionId)`가 가능할 때만 재개, 불가능하면 즉시 `failed` + `orphaned session`
  - Codex는 `resumeThread(threadId)`로 재개
  - 재개 작업도 `MAX_ACTIVE_SESSIONS` 상한 아래에서 큐를 통해 순차 반영
  - 재개 불가하면 카드 `failed` + "orphaned session" 오류 저장. WS `error` 이벤트에 "서버 재시작으로 세션이 유실되었습니다. retry 시 새 세션으로 시작됩니다." 등 사용자 설명 포함. preplan 카드의 경우 retry 시 기존 agreement 파일 상태를 기반으로 새 세션을 시작하므로 대화 히스토리는 유실되지만 합의 내용은 보존됨을 안내

### Phase 4: REST + WebSocket + Plan Watcher

**Goal**: 웹 UI와 서버 사이의 실시간/복구 가능한 통신

`src/api/cards.ts` (REST):
- `GET /api/cards`
- `POST /api/cards`
- `PATCH /api/cards/:id` (`title`, `description`만 수정 가능; `plan_file`/`session_id`/`session_state`는 서버 전용)
- `POST /api/cards/:id/unconfirmed` (`unconfirmed_count` 갱신)
- `POST /api/cards/:id/promote` (가드 + 전이 락 + CAS 큐 적재, 큐 대기 시 락 해제 후 `202`)
- `POST /api/cards/:id/approve` (전이 락 + `promoteToImpl` 호출; 큐 정책 동일 적용)
- `POST /api/cards/:id/retry` (전이 락 + CAS 큐 적재, 큐 대기 시 락 해제 후 `202`)
- `GET /api/cards/:id/plan` (현재 plan markdown; `plan_file`는 서버가 저장한 경로만 사용하고 `realpath`가 `PLAN_ROOT` 하위인지 검증, symlink 우회 차단)
- `DELETE /api/cards/:id` (전이 락 획득 후 `session_state`가 `starting|active|queued`이거나 전이 진행 중이면 `409 session_in_progress`; `idle|completed|failed` 상태에서만 삭제 가능. DB 삭제를 먼저 수행하고 watcher subscriber 해제는 후처리 — 크래시 시 rehydrate가 삭제된 카드를 무시하므로 안전)

`src/watchers/plan-watch.ts`:
- `plan_file`별 단일 watcher + debounce (`Map<plan_file, {watcher, pollTimer, subscribers: Set<cardId>}>`). subscriber는 카드 ID 기준 (연결이 아닌 카드 단위 관리 — 동일 plan_file을 참조하는 복수 카드가 있을 때 refcount 정확성 보장)
- watcher 미지원/누락 이벤트 대비 2초 polling fallback
- 파일 변경 시 markdown 본문 + parsed progress를 WS 브로드캐스트
- 카드가 Plan을 벗어나거나 `plan_file`이 바뀌거나 카드가 삭제되면 subscriber 해제, refcount 0이면 watcher/pollTimer 정리
- watcher `error`/`rename`로 파일 접근이 깨지면 기존 handle/timer를 즉시 닫고 bounded backoff로 재등록 시도
- 서버 shutdown 시 `disposeAll()`을 호출해 모든 watcher/pollTimer를 정리

`src/plan/progress-parser.ts`:
- `Phase N`, `Round N` 패턴 파싱
- 파싱 실패 시 마지막 정상값 유지 + 경고 이벤트 발행

`src/api/ws.ts` (WebSocket):
- 연결 시 `cardId` 바인딩
- `Client -> Server`: `{ type: "message", content: "..." }`
- `Server -> Client`:
  - `{ type: "assistant", content: "...", done?: boolean }` (chunk streaming; 마지막 chunk에서 `done=true`)
  - `{ type: "status", status: "preplan" | "plan" | "implement" | "done" | "failed" }`
  - `{ type: "plan_update", content: "..." }`
  - `{ type: "progress", phase: number, round: number }`
  - `{ type: "error", code: "...", retryable: boolean }`

### Phase 5: Frontend (Kanban UI)

**Goal**: 상태 가드/실패 복구가 드러나는 UI

**Technology**: vanilla HTML + CSS + JS (빌드 스텝 없음). `src/ui/` 디렉토리를 `node:http`에서 정적 파일로 서빙. 프레임워크 도입은 복잡도가 정당화될 때 별도 결정.

- 6개 컬럼: Backlog, Preplan, Plan, Implement, Done, Failed
- 카드 상세:
  - Preplan: 채팅 + `unconfirmed_count` 표시
  - Plan: markdown 실시간 뷰 + phase/round
  - Implement: 실행 로그 + 실패 시 retry 버튼
- 승격 버튼 동작:
  - Preplan -> Plan: `unconfirmed_count`가 정수 `0`이고 카드 전이 락이 비어 있을 때만 활성화
  - Plan -> Implement: 승인 완료 시 활성화
- 세션 오류 표시:
  - `failed` 상태에서 마지막 에러 코드/메시지 노출
  - retry API 호출 버튼 제공

### Phase 6: Idle Timeout + Coral Hook

**Goal**: graceful idle shutdown + SessionStart 컨텍스트 연동

`src/server.ts` idle timeout (`node:http` 일관성 유지):
```typescript
let lastIngressActivity = Date.now();
let shuttingDown = false;
const IDLE_TIMEOUT_MS = config.idleTimeoutMs;
const SHUTDOWN_GRACE_MS = config.shutdownGraceMs;

const touchActivity = () => { lastIngressActivity = Date.now(); };
const idleTimer = setInterval(() => void checkIdle(), 60_000);

server.on("request", (req, res) => {
  if (shuttingDown) {
    res.statusCode = 503;
    res.end("server-shutting-down");
    return;
  }
  touchActivity();
  routeHttp(req, res);
});

wss.on("connection", (ws) => {
  if (shuttingDown) {
    ws.close(1012, "server-shutting-down");
    return;
  }
  touchActivity();
  ws.on("message", touchActivity);
});

sessionManager.on("heartbeat", touchActivity);

async function gracefulShutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(idleTimer);

  sessionManager.pauseDequeues();
  await sessionManager.cancelQueuedTransitions("server-shutdown");
  broadcast({ type: "server_shutdown", reason });
  wss.clients.forEach((client) => client.close(1001, "server-shutdown"));
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await sessionManager.closeAll({ timeoutMs: SHUTDOWN_GRACE_MS });
  await planWatch.disposeAll();
  await store.flush();
  process.exitCode = 0;
}

async function checkIdle() {
  if (shuttingDown) return;
  if (sessionManager.activeCount() > 0) return;
  if (sessionManager.pendingCount() > 0) return;
  if (Date.now() - lastIngressActivity <= IDLE_TIMEOUT_MS) return;
  await gracefulShutdown("idle-timeout");
}
```

`hooks/reef-detect.mjs` (coral 리포지토리에 위치. 업데이트 시 coral 버전 릴리즈 필요, coral-reef 배포와 무관. JSON output 보장):
```javascript
#!/usr/bin/env node
import { readFileSync } from "node:fs";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

const parsedPort = Number.parseInt(process.env.CORAL_REEF_PORT ?? "4317", 10);
const defaultHealthUrl = Number.isFinite(parsedPort)
  ? `http://127.0.0.1:${parsedPort}/health`
  : "http://127.0.0.1:4317/health";
const healthUrl = process.env.CORAL_REEF_HEALTH_URL ?? defaultHealthUrl;
let additionalContext =
  `Coral Reef status check unavailable (${healthUrl}). Use AskUserQuestion to ask whether to start it now.`;

try {
  const rawInput = await readStdin();
  if (rawInput.trim().length > 0) JSON.parse(rawInput);
  const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
  const isUp = res.ok;

  additionalContext = isUp
    ? `Coral Reef server is running (${healthUrl}).`
    : "Coral Reef server is not running. Use AskUserQuestion to ask whether to start it now.";
} catch {
}

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }) + "\n"
);
```

`hooks/hooks.json` patch 위치 (`hooks.SessionStart`의 `matcher: "*"` 항목 안):
```json
{
  "type": "command",
  "command": "test -d \"${CLAUDE_PLUGIN_ROOT}\" || exit 0; node \"${CLAUDE_PLUGIN_ROOT}/hooks/reef-detect.mjs\"",
  "timeout": 5
}
```

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| SDK API 형상이 preplan 가정과 다름 | HIGH | Phase 0에서 smoke test로 사전 검증 + TypeScript interface 고정 |
| Agent/Codex SDK API 변경 | HIGH | exact version pin + wrapper + contract tests + staged upgrade |
| Claude/Codex 세션 시작 실패/런타임 크래시 | HIGH | 카드 `failed` 상태, retry API, 에러 코드 표준화 |
| plan 파일 watcher 누락/드롭 이벤트 | HIGH | `fs.watch` + polling fallback + `error` 재등록 + shutdown `disposeAll()` |
| 상태 전이 경합으로 인한 중복 세션 시작 | HIGH | 카드별 전이 락(검증 구간 한정) + 큐 대기 중 락 해제 + dequeue 시 CAS 재검증 + 409/202 응답 규약 |
| coral 플러그인 버전/레이아웃 불일치 | HIGH | 다중 경로 탐색 + 버전/필수 파일 검증 + fail-fast 메시지 |
| WebSocket 연결 끊김 | MEDIUM | 자동 재연결 + 서버 상태 authoritative 유지 |
| 동시 카드 실행 시 메모리 압박 | MEDIUM | `MAX_ACTIVE_SESSIONS` 상한 + FIFO 큐 + watcher refcount 정리 + shutdown 시 dequeue 중단/queued 취소 |
| 재시작 후 retry 한도 유실 | MEDIUM | `retry_attempts`/`next_retry_at`/`retry_exhausted` 영속화 + 재시작 시 재계산 |
| 포트 충돌 | LOW | 환경변수 포트 설정 + 명확한 부팅 에러 |
| SQLite 잠금/쓰기 지연 | LOW | 단일 프로세스 유지 + 트랜잭션 범위 최소화 |
| `plan_file` 경로 오염/임의 파일 조회 | LOW | `PATCH` allowlist + `PLAN_ROOT` + `realpath` 하위경로 검증 |

## Verification Steps

1. **SDK contract validation**: Phase 0 smoke test가 두 SDK의 핵심 메서드를 실행하고, `src/sessions/sdk-contracts.ts` 인터페이스가 실제 API와 일치하는지 확인
2. **Build reproducibility**: `npm ci && npm run build`를 2회 반복해 동일 lockfile/성공 확인
3. **Bind host check**: `npm start` 후 `curl http://127.0.0.1:PORT/health` + 다른 기기에서 `http://<host-ip>:PORT/health` 확인
4. **coral dependency error**: 플러그인 경로를 의도적으로 비워 `npm start` 시 탐색 경로 포함 에러 확인
5. **Card create + chat streaming**: `POST /api/cards` 후 즉시 preplan 세션 시작 확인, 이어서 WS `message` 전송 시 `assistant` chunk 스트리밍(`done` 종료 포함)이 순서대로 수신되는지 확인
6. **Promotion gate validation**: `unconfirmed_count`가 `3`이면 409, `-1/null/"1"`이면 400, `0`이면 승격 확인
7. **Transition race**: 동일 카드에 `promote`/`approve`/`retry`를 동시 호출해 1개만 실행되고 나머지는 `409 transition_in_progress` 또는 `202 queued`인지 확인, 큐 대기 중 락이 해제되어 재시도 요청이 stale CAS로 안전하게 거절되는지 확인
8. **Admission control (10+ cards)**: 카드 10개 이상 동시 시작 시 `MAX_ACTIVE_SESSIONS`를 넘는 요청이 큐에 들어가고 `promoteToImpl` 포함 모든 세션 시작 전이가 동일 admission queue로 순차 실행되는지 확인
9. **Plan file realtime + teardown**: plan 파일 편집 시 `plan_update`/`progress` 수신, 카드 삭제/상태 이탈 시 watcher refcount가 0에서 정리되는지 확인, `DELETE /api/cards/:id`가 `starting|active|queued` 상태에서 `409 session_in_progress`를 반환하는지 확인, watcher `error`/서버 shutdown에서도 handle/timer가 남지 않는지 확인
10. **Implement trigger**: Plan 승인 시 ralph 세션 자동 시작 확인
11. **Failure recovery**: 세션 시작 실패 주입 후 카드 `failed` 전이 + `POST /api/cards/:id/retry` 백오프 재시도 확인, 재시작 후에도 `retry_attempts`/`next_retry_at`/`retry_exhausted`가 유지되어 최대 시도 초과 시 재시도가 막히는지 확인
12. **Idle timeout safety**: `IDLE_TIMEOUT_MS=30000`에서 활성 세션/대기 큐가 있으면 종료되지 않고, 활성 0 + 대기 큐 0 + 무활동일 때만 shutdown이 시작되며 신규 요청은 503/WS close되고 queued 항목이 취소되는지 확인, 특히 queued `promoteToImpl`가 shutdown 중 취소되고 재시작 후 자동 실행되지 않는지 확인
13. **Session rehydrate**: 서버 재시작 후 Claude/Codex 재개 가능 케이스는 재개되고 불가 케이스는 `orphaned session` 실패 전이 확인
14. **Cross-platform discovery**: Linux/macOS/Windows 경로와 env override(`CORAL_PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, `%LOCALAPPDATA%`) 조합에서 bridge가 정상 탐색하는지 확인하고, `CLAUDE_PLUGIN_ROOT` 직접 지정/상대 환산 케이스를 모두 검증하며, 실패 시 시도한 경로 목록이 에러에 모두 출력되는지 확인
15. **Hook contract**: SessionStart 시 `reef-detect.mjs`가 env 미설정/서버 down/up 각각에서 항상 JSON stdout을 내보내고 AskUserQuestion 지시 context가 전달되는지 확인 (`CORAL_REEF_HEALTH_URL` > `CORAL_REEF_PORT` > `4317`, 일반 `PORT` 미사용)
16. **Plan file path safety**: `PATCH /api/cards/:id`에 `plan_file`을 보내면 거부되고, `GET /api/cards/:id/plan`은 symlink 포함 `PLAN_ROOT` 밖 경로를 읽지 않는지 확인
