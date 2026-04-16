# Pre-plan: cli-jobs-surface-redesign

## Problem Statement
- Current state:
  - `coral-cli list`는 session 핸들만 노출하고, 대다수 엔트리는 종료된 workflow의 묘지. 활성 job을 보여주지 않음.
  - 활성 job을 찾으려면 `/tmp/coral-jobs/*/status.json`을 수동 탐색해야 함 (KB note `coral-jobs-tmp-no-auto-cleanup` 참조).
  - `coral-cli abort --jobs <ids>`는 ID를 알고 있어야만 사용 가능하지만, ID 발견 경로가 CLI에 없음.
  - 결과적으로 멈춘 job을 정리하려면 SIGKILL by PID까지 내려감. dev 루프가 망가지는 실질적 운영 gap.
- Desired state:
  - CLI 단에서 "지금 무엇이 돌고 있는가"를 발견하고 한 번에 abort할 수 있다.
  - session은 CLI surface에서 퇴장하고 resume은 launch 응답의 sessionId만으로 수행한다.

## Success Criteria
- [ ] `coral-cli jobs` 커맨드가 기본적으로 현재 프로젝트의 active job(running/launching/queued)을 방출한다. json/text 둘 다 지원.
- [ ] `coral-cli jobs --phase <phase>` 플래그로 단일 phase 필터가 가능하다 (running, launching, queued, completed, error, aborted).
- [ ] `coral-cli jobs --all`로 종료된 job까지 포함한 전체 목록을 본다 (최신순).
- [ ] `coral-cli jobs --provider <name>` 필터가 동작한다.
- [ ] `jobs` 기본 출력은 job-native 필드만 노출한다 (`jobId`, `phase`, `provider`, `cwd`/`projectRoot`, `launch.updatedAt` 기반 age). Backend가 CLI-facing `JobSummary` DTO를 새로 반환해 raw `PersistedStatusRecord` 누출을 차단한다. `sessionId`/`agent`는 기본 출력에 포함하지 않는다.
- [ ] `abort`는 `jobs`와 동일한 selector를 수용한다: `--all`, `--phase`, `--provider`, `--jobs <ids>`. 상호 모순 조합(예: `--all`+`--jobs`)은 Zod validation으로 거절한다.
- [ ] `coral-cli list` 커맨드가 제거된다 (호환 경로 없음).
- [ ] 모든 의존 문서·스킬·에이전트가 `jobs`/`abort`로 업데이트된다: `docs/skills.md`, `skills/codex/SKILL.md`, `.claude/agents/ux-critic.md`.
- [ ] Session browsing surface를 완전히 철거한다: `coral-cli list`, HTTP `GET /api/sessions`, `client.listSessions()`, 관련 DTO/응답 스키마/테스트까지 일괄 제거. Session은 launch 응답으로 받아 resume/fork에 되돌려주는 토큰으로만 존재한다.
- [ ] 기존 테스트 통과 + `npm run build` clean + lint clean.

## Scope
- Included:
  - 신규 `coral-cli jobs` 서브커맨드 (Commander 등록, `client.listJobs`/`listLiveJobs` 경유).
  - `coral-cli abort --all` 플래그 (내부적으로 active phase jobs → 기존 `abort --jobs`와 합류).
  - `coral-cli list` 삭제 및 관련 테스트 제거/전환.
  - 문서·스킬·에이전트 참조 일괄 업데이트 (`docs/skills.md`, `skills/codex/SKILL.md`, `.claude/agents/ux-critic.md`).
  - `jobs` 출력 포맷 결정 (provider, agent, phase, jobId, sessionId, projectRoot, cwd, startedAt).
- Excluded:
  - `/tmp/coral-jobs/` orphan 자동 정리 (별도 P1 작업).
  - Scope mismatch 탈출구/cross-project abort (별도 P2 작업).
  - `/api/jobs` 엔드포인트 자체의 response shape 변경 (이미 안정 contract).
  - UI/Reef dashboard 변경.
- Legacy: `list`, HTTP `GET /api/sessions`, `client.listSessions()`를 동시에 철거해 단일 primitive(jobs)로 일원화한다. Deprecation alias 없음. CHANGELOG에 마이그레이션 노트 기재. 버전 bump는 별도 사용자 지시 시에만.

## Assumptions
- `/api/jobs[?phase]` HTTP 엔드포인트가 이미 namespace 필터링을 수행하며, `server.test.ts`의 `/api/jobs phase filter` 테스트가 계약을 보장한다.
- `client.listJobs(phase?)`가 이미 존재하므로 CLI 레이어만 추가하면 됨 (`src/client/http-client.ts:277`).
- `list`는 CLI 사용자(스킬/에이전트/문서)만 의존하며, 외부 스크립트가 참조한다는 증거 없음.
- Session resume 경로는 launch 응답의 sessionId만으로 충분하다 — 사용자가 session 목록을 브라우징해야 하는 실제 워크플로 없음.
- 현재 `backend status`가 보여주는 "Active jobs: N"은 `listLiveJobs` 결과와 일치하며, 동일 원천을 재사용할 수 있다.

## Affected Systems
- `src/cli/main.ts` — `list` 제거, `jobs` 등록, `abort` 확장 (--all 플래그).
- `src/cli/__tests__/main-routing.test.ts` — list 관련 테스트 전환/삭제, jobs/abort--all 테스트 추가.
- `src/client/http-client.ts` — 이미 `listJobs`/`abort` 존재. 변경 없음 또는 type-only (확인 필요).
- `src/shared/schemas.ts` — jobs 출력 formatting용 타입이 필요하면 추가 (`JobSummary` 등).
- `skills/codex/SKILL.md` — `session list` 매핑을 `jobs` 기반으로 교체.
- `docs/skills.md` — 동일.
- `.claude/agents/ux-critic.md` — 예시 스니펫 교체.
- `docs/` (아키텍처/CLI 섹션) — 전체 grep 확인 필요.

## Constraints
- Zod schema 검증: CLI 입력(`--phase`, `--provider`, `--all`) 모두 whitelist 검증.
- Commander 옵션 네이밍: 기존 `--provider`/`--jobs` 컨벤션 유지.
- `npm version`은 사용자 명시 요청 전에는 변경 금지 (CLAUDE.md).
- Bridge 번들(`bridge/*.cjs`)은 빌드 산물. 직접 수정 금지, `npm run build` 결과로만 갱신.
- `test-critic`/`code-critic` tier-review 게이트: 구현 완료 후 실행.

## Approach Direction
- 사용자 명시: "session이라는 정보는 정말 무의미", "list 자체를 제거하고 jobs로 재설계".
- 우선순위 P0: `jobs` 도입, `abort --all`, `list` 제거 — 한 PR에 묶음.
- 숨겨진 session 접근은 `jobs --sessions`가 아니라, 정말 필요하면 `/api/sessions` HTTP만 유지하는 쪽이 깔끔 (elegant 후보).
- Orphan job cleanup / scope 탈출구는 별도 P1·P2로 분리.

## Additional Context
- 이미 backend에 `GET /api/jobs`, `GET /api/jobs/<jobId>`, `?phase=` 필터가 존재. `server.test.ts:2956-3123`이 contract 보증.
- `listLiveJobs(progressStore, namespace)` 헬퍼가 `lifecycle.ts:567`에 있고 `/health`·idle drain에서 이미 활용.
- 기존 프리플랜 `active-jobs-bundle-hash-filter.md`가 `/health`의 namespace 필터 문제를 다룸 — 본 작업과는 별개지만 backend가 namespace 경계로 job을 이미 잘 구분한다는 증거.
- G6 PR(`5094b1c0`) 직후 G1 진행 전 단계. 이 작업은 G1이 다룰 `backend-core.ts` 조합 루트의 command dispatch 주변을 깨끗하게 만들어 준다.

### Pioneer (Codex, job `c62f14ee`) 관찰
1. **One Browsing Primitive** — `list`/session 중심 browsing이 `wait`/`abort`의 job 중심과 분기되어 있음. `jobs`를 유일한 browse surface로 통일해야 발견과 조작이 같은 언어를 씀.
2. **Shared Selection Model** — `abort`가 `jobs`와 selector를 공유해야 사용자 모델이 "select → act"로 자연스러워짐. `--jobs <ids>`는 exact targeting용으로만.
3. **Session Is a Token, Not a Surface** — `list` 제거만으로는 부족. `GET /api/sessions`도 browse 목적이 아님을 드러내야 함. 연속성은 launch 응답의 sessionId로 충분.
4. **Keep Jobs Job-Native** — `jobs` 출력에 `sessionId`/`agent`/`startedAt`을 함부로 넣으면 session 개념을 재수입하는 셈. `launch.updatedAt`이 안정 필드이고, backend가 projection DTO를 반환해야 raw `PersistedStatusRecord` 누출 방지.
