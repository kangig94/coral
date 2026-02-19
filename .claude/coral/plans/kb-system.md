# KB System — Knowledge Memoization for Coral

## Requirements Summary

coral 플러그인에 자동 지식 관리 시스템을 추가한다. 유저 개입 없이 작업 중 발견한 가치 있는 교훈을 memo로 버퍼링하고, 작업 완료 시 영구 KB로 승격한다. 이후 세션에서 에러 발생 시 KB를 자동 참조하여 같은 실수를 반복하지 않는다.

동시에 sessions 저장 방식을 프로젝트 로컬 단일 파일에서 글로벌 per-session 개별 파일로 전환한다.

**핵심 제약:**
- 유저의 프로젝트 `.claude/CLAUDE.md`를 건드리지 않음
- 플러그인 CLAUDE.md가 행동 지시를 담당
- 유저 제공 가이드라인이 CLAUDE.md의 뼈대
- 사용자가 없는 시점이므로 migration 불필요 (clean break)

## Acceptance Criteria

1. `CLAUDE.md` 생성 — 유저 가이드라인 뼈대 + KB 행동 지시 (1000 토큰 이하)
2. Sessions가 `~/.claude/coral/sessions/<project-hash>/<session-name>.json`에 개별 파일로 저장
3. 세션 이름에 Zod regex 제약 적용 (`/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/`)
4. Race condition 해소 (per-session file isolation)
5. Memo가 `~/.claude/coral/memo/<project-hash>/`에 기록 (CLAUDE.md 행동 지시)
6. KB가 `{project}/.claude/coral/kb/`에 승격 저장 (git tracked, CLAUDE.md 행동 지시)
7. Plans는 현행 `{project}/.claude/coral/plans/` 유지
8. 기존 테스트 통과, 신규 테스트 추가
9. Docs, README 반영

## Storage Structure

```
# git tracked — 멀티 디바이스 sync
{project}/.claude/coral/
├── kb/                          # 영구 지식 (승격된 것만)
│   └── <domain>-<topic>.md
└── plans/                       # 플랜 결과물 (현행 유지)

# device-local — ephemeral
~/.claude/coral/
├── sessions/
│   └── <project-hash>/          # 프로젝트별 격리
│       ├── my-review.json       # 개별 세션 파일
│       └── debug-auth.json
└── memo/
    └── <project-hash>/          # 세션 중 임시 메모
        ├── 1708300000-oauth-gotcha.md
        └── 1708300500-esbuild-external.md
```

## Implementation Phases

### Phase 1: SessionManager — per-session file 전환

**`src/mcp/schemas.ts` 수정:**
- 세션 이름 Zod 스키마에 regex 추가: `.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Session name must be alphanumeric (with . _ - allowed)')`
- `codexSessionCreateSchema`, `codexSessionForkSchema`의 `name` 필드에 적용

**`src/mcp/session-manager.ts` 전면 수정:**

```
기존: {cwd}/.claude/coral/sessions.json (단일 파일, 모든 세션)
신규: ~/.claude/coral/sessions/<project-hash>/<name>.json (개별 파일)
```

1. `import { homedir } from 'node:os'`, `import { createHash } from 'node:crypto'` 추가
2. `projectHash(dir: string): string` — `createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 12)`
3. 생성자: `workingDirectory` 필수 인자. `homedir() + '/.claude/coral/sessions/' + projectHash(workingDirectory)` 디렉토리 계산. `mkdirSync` 호출.
4. `register(name, codexThreadId, model, workingDirectory)`: `SessionEntry` 생성 → `<name>.json` atomic write (tmp+rename)
5. `get(nameOrId)`: `<nameOrId>.json` 파일 존재 확인 → 있으면 반환. 없으면 디렉토리 내 전체 파일 scan하여 `codexThreadId` 매칭. O(n) scan이지만 수십 개 수준에서 무시 가능.
6. `list()`: `readdirSync` → `.json` 파일만 필터 → 각각 parse → `SessionEntry[]` 반환
7. `updateSession(name, fields?)`: `<name>.json` 읽기 → `lastUsedAt` 갱신 + optional `model` 수정 → atomic write
8. `remove(name)`: `unlinkSync(<name>.json)`

**in-memory cache 제거**: 각 operation이 직접 파일 I/O. 단일 파일이 작으므로 성능 영향 없음. merge 로직 불필요.

**`src/types.ts` 수정:**
- `SessionRegistry` 타입 삭제 (더 이상 단일 레지스트리 없음)
- `SessionEntry`는 유지 (개별 파일 포맷)

**`src/mcp/server.ts:332` 수정:**
```typescript
sessionManager = new SessionManager(process.cwd());
```

`projectHash`는 MCP 서버의 CWD 기준. per-tool `working_directory`와 무관 (하나의 MCP 서버 = 하나의 프로젝트).

**테스트 (`src/mcp/__tests__/session-manager.test.ts`):**
- `vi.mock('node:os', () => ({ homedir: () => tmpDir }))` 로 homedir mock
- 개별 파일 생성/조회/삭제 테스트
- get() by threadId scan 테스트
- updateSession() 테스트
- corrupt 파일 핸들링 테스트
- 세션 이름 regex validation 테스트 (schemas 테스트)

### Phase 2: CLAUDE.md 생성

플러그인 루트에 `CLAUDE.md` 신규 작성. **1000 토큰 이하**.

**구조:**
```markdown
# Coral Guidelines

Behavioral guidelines to reduce common LLM coding mistakes.
Merge with project-specific instructions as needed.
Tradeoff: These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
1. [Step] → verify: [check]
2. [Step] → verify: [check]

## 5. Knowledge Base

### Memo — during work
When you discover something non-obvious (painful debugging root cause, unexpected gotcha,
"wish I knew earlier" pattern), write immediately to:
`~/.claude/coral/memo/<project-hash>/<timestamp>-<topic>.md`

Keep brief — one paragraph + context. This survives context compaction.
project-hash: SHA-256 of absolute project path, first 12 hex chars.

### Lookup — on error
Before debugging from scratch, check `{project}/.claude/coral/kb/` for relevant entries.
On plan/coplan start, review domain-related kb files.

### Promotion — on task completion
Review all memos + MEMORY.md. Promote reusable knowledge to
`{project}/.claude/coral/kb/<domain>-<topic>.md` using this format:

    # <Title>
    ## Rule
    One paragraph — state the lesson directly.
    ## Why
    What goes wrong without this knowledge.
    ## Pattern
    Right vs wrong approach — code blocks or examples.

Delete processed memos after promotion.

### Invalidation
If a kb entry contradicts current code, update or delete it immediately.
```

### Phase 3: Docs & README

**`docs/configuration.md`:**
- sessions.json 경로 → `~/.claude/coral/sessions/<hash>/<name>.json`
- memo, kb 경로 문서화
- SessionRegistry 관련 예시 → SessionEntry 개별 파일 예시로 교체

**`docs/architecture.md`:**
- 저장소 구조도 업데이트 (글로벌 홈 vs 프로젝트 로컬 분리 반영)

**`README.md`:**
- Knowledge Base 섹션 추가 (자동 지식 관리 간략 설명)

**빌드:**
- `npm run build` → 번들 재생성 (SessionManager 변경 반영)

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| CLAUDE.md 토큰 낭비 | 1000 토큰 예산 |
| KB 행동 미준수 | CLAUDE.md는 compaction 후에도 재로드. synthray에서 검증된 패턴 |
| list() 성능 | 세션 수 수십 개 수준, 무시 가능 |
| get() by threadId O(n) | 동일. 향후 필요 시 인덱스 도입 가능 |
| 세션 이름 path traversal | Zod regex 제약으로 원천 차단 |
| memo 미정리 | CLAUDE.md에 정리 지시 포함 |

## Verification Steps

1. `npm test` — 기존 + 신규 테스트 전부 통과
2. `npm run build` — 번들 정상 빌드
3. 새 프로젝트에서 세션 생성 → `~/.claude/coral/sessions/<hash>/<name>.json` 개별 파일 확인
4. 동일 프로젝트 두 Claude 세션 동시 → 서로 다른 세션 파일 독립 저장 확인
5. 유저 프로젝트 `.claude/`에 sessions.json 미생성 확인
6. CLAUDE.md 토큰 수 1000 이하 확인
7. 잘못된 세션 이름 (e.g., `../../evil`) → Zod validation 에러 확인
