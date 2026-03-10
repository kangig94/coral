# Pre-plan: kanban-server

## Problem Statement [confirmed]
Coral의 AI 에이전트 파이프라인(preplan → plan → ralph)은 강력하지만, 현재는 CLI에서 수동으로 하나씩 호출해야 한다. 프로젝트 단위로 여러 작업을 관리하고, 각 작업의 상태 전이에 따라 자동으로 Claude 세션을 트리거하는 시각적 인터페이스가 없다.

**현재**: CLI에서 `/coral:preplan` → 승인 → `/coral:plan` → 승인 → `/coral:ralph`를 수동 실행
**원하는 상태**: 칸반 보드 UI에서 카드를 관리하고, 상태 승격 시 자동으로 Claude 세션이 열려 계획/구현이 진행됨

## Success Criteria [confirmed]
- [ ] HTTP 서버가 칸반 보드 UI를 서빙한다 (localhost + 외부 접속 가능)
- [ ] 카드 생성 시 즉시 Claude 세션이 열리고 preplan skill이 자동 호출된다
- [ ] 웹 UI와 해당 Claude 세션이 연결되어 대화가 이뤄진다 (대화형 preplan)
- [ ] 모든 unconfirmed 항목이 해소되면 preplan 카드 완료, 사용자가 Plan 승격 버튼으로 결정
- [ ] Plan 단계에서 plan 파일을 보드에서 읽기 전용으로 실시간 열람 가능
- [ ] Plan 카드에서 phase 진행도를 볼 수 있다
- [ ] 승인 시 coral:ralph가 자동 실행되어 구현을 수행한다
- [ ] 6시간 무활동 시 서버가 자동 종료된다
- [ ] coral의 SessionStart hook으로 서버 상태를 감지하고, 안 떠있으면 사용자에게 시작 여부를 묻는다

## Scope [confirmed]
**Included**:
- 별도 리포지토리 `coral-reef` (`../coral-reef`) — `npm install && npm build` 필요
- HTTP 서버 (Node.js, 단일 프로세스, 외부 접속 지원)
- 칸반 보드 웹 UI (Backlog → Preplan → Plan → Implement → Done)
- 카드 CRUD REST API
- 웹 UI ↔ Claude 세션 간 실시간 대화 인터페이스 (Agent SDK)
- plan 파일 실시간 읽기 전용 뷰어
- plan phase 진행도 표시
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) — interactive 대화
- Codex SDK (`@openai/codex-sdk`) — codex 기반 작업
- Idle timeout 자동 종료
- SQLite 스토리지

**Excluded**:
- 인증/권한 관리
- 멀티 프로젝트 지원 (단일 프로젝트 디렉토리 기준)
- coral 리포지토리 자체의 변경 (SessionStart hook 추가 제외)

**coral 측 변경 (최소)**:
- `hooks/hooks.json` — SessionStart hook 추가 (reef-detect.mjs)
- `hooks/reef-detect.mjs` — coral-reef 서버 상태 감지 스크립트

## Assumptions [confirmed]
- coral-reef는 별도 리포지토리로, `npm install && npm build`로 설치한다 [confirmed] — Agent SDK(~80MB)와 Codex SDK(~70KB)를 node_modules로 관리, 번들 커밋 불필요
- Claude Agent SDK의 `query()` + `AsyncIterable<SDKUserMessage>`로 진짜 interactive 대화를 구현한다 [confirmed] — 단일 프로세스가 유지되며 yield로 메시지 전달, 턴 간 지연 0ms
- Codex SDK의 `startThread()` + `run()`으로 codex 기반 multi-turn을 구현한다 [confirmed]
- coral의 skill/agent 정의를 참조할 때는 coral 플러그인 캐시 경로(`~/.claude/plugins/cache/coral/`)에서 읽는다 [confirmed] — coral 미설치 시 coral-reef도 동작하지 않아야 함 (hard dependency)
- 하나의 카드가 하나의 독립 세션에 매핑된다 [confirmed] — 세션 간 상태 공유 없음
- 여러 카드가 동시에 plan/implement 상태일 수 있다 [confirmed] — 각각 독립 세션

## Affected Systems [confirmed]
- `../coral-reef/` — 신규 리포지토리 전체
- `coral/hooks/hooks.json` — SessionStart hook 추가
- `coral/hooks/reef-detect.mjs` — 서버 감지 스크립트

## Constraints
- coral 리포지토리 변경은 hook 추가만 — 기존 코드 수정 없음
- Hook 스크립트는 Node.js ESM, fail-open, timeout 5초 이내
- coral-reef는 독립 빌드/배포 — coral의 번들 전략에 영향 없음

## Approach Direction
- **별도 리포지토리** `coral-reef` — 무거운 SDK 의존성을 coral에서 분리
- **Claude Agent SDK** — `query()` + `AsyncIterable`로 interactive preplan 대화
- **Codex SDK** — `startThread()` + `run()`으로 codex 작업
- **WebSocket** — 웹 UI ↔ 서버 간 실시간 스트리밍 (SDK의 AsyncGenerator → WebSocket 중계)
- **Idle timeout (6시간)** — 서버 자체 자가 종료, 외부 시그널 불필요
- **coral SessionStart hook** — 서버 health check 후 AskUserQuestion으로 시작 여부 확인
- coral의 skill/agent 파일 참조 방식은 추가 논의 필요

## Additional Context
- 대화 중 Context7 MCP의 용도에서 시작하여, coral에 로컬 서버를 추가하는 아이디어로 발전
- Stop hook은 Ctrl+C에 발동 안 되지만, SessionEnd hook은 `prompt_input_exit` reason으로 발동됨을 확인
- 서버 수명 관리는 SessionEnd에 의존하지 않고, 서버 자체 idle timeout이 가장 견고
- 초기에는 ax MCP 재사용(방식 B)을 검토했으나, Agent SDK 번들 크기(~80MB) 문제로 coral 내부 번들링 불가
- coral-reef 별도 리포지토리로 분리하여 npm의 node_modules로 SDK 관리하는 것으로 결정
- ax MCP 경유 대신 SDK 직접 사용으로 전환 — interactive 대화 가능 + 턴 간 지연 제거
- 향후 coral ax MCP 자체를 SDK 기반으로 전환하는 것은 별도 preplan(ax-sdk-migration)으로 분리
