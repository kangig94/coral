# 🪸 Coral

Claude Code는 이미 코딩할 줄 압니다. Coral은 *당신의 방식대로* 코딩하도록 가르칩니다.

컨벤션 적용, 워크플로우 구조화, 의사결정을 다각도로 검토 —
모든 Claude Code 세션에서 동작하는 슬래시 커맨드로 제공됩니다.

## 설치

**요구사항:** Node.js 18+

```
/plugin marketplace add https://github.com/kangig94/coral
/plugin install coral

# Codex CLI (선택 - `codex-*` 스킬과 `--codex` 플래그 활성화):
npm install -g @openai/codex  # v0.104+
```

## 바로 사용해보기

설정 불필요. 아무 Claude Code 세션에서, 기존 프로젝트에서 바로 실행:

```
/coral:analyze what does this codebase do?
```

Coral이 프로젝트를 읽고 구조화된 분석 결과를 반환합니다:
아키텍처, 모듈, 진입점, 의존성 그래프. 파일 생성 없음, 설정 불필요.

## 이렇게 활용하세요

### 프로젝트 구조화

https://github.com/user-attachments/assets/881f1a14-9f4f-4d3d-8023-59610eb13ac4

```
/coral:init-project
```

Coral이 기술 스택을 스캔하고, 리뷰어 검증을 거쳐 `.claude/` 디렉토리를 생성합니다 —
컨벤션, 에이전트, 아키텍처 문서를 프로젝트에 맞게 생성합니다.

생성된 에이전트는 기성품이 아닙니다 — 프로젝트의 청중에 맞게 보정된
루브릭 기반 다차원 평가 체계를 내장합니다.
Claude가 일반적인 기본값이 아닌 당신의 규칙을 따르게 됩니다.

```bash
# 기존 프로젝트 - 그냥 실행, Coral이 자동 스캔
/coral:init-project

# 기술 스택 힌트 (소스 파일이 적을 때)
/coral:init-project "React + FastAPI"

# 상세 설명 (신규 또는 복잡한 프로젝트)
/coral:init-project "multi-tenant SaaS REST API with Go, must be serverless"

# 참조 자료 포함
/coral:init-project "CLI tool like ref/existing-cli, see docs/spec.md"
```

생성되는 구조:
```
my-project/
+ .claude/
+   CLAUDE.md                 <- 프로젝트 허브: 빌드 명령, 워크플로우, 핵심 규칙
+   agents/
+     code-critic.md          <- 코드 품질 리뷰
+     ...                     <- 도메인 에이전트 (React, Go, ML, infra 등)
+   rules/
+     conventions.md          <- 네이밍, git, 스타일
+     ...                     <- 도메인 규칙, 파일 경로 기반 자동 활성화
+ docs/
+   architecture.md           <- 모듈 맵, 의존성 그래프
```

어디서 본 구조 아닌가요? 이 저장소의 [`.claude/`](.claude/) 폴더가 바로 그 결과물입니다.

---

### 다양한 관점 얻기

```
/coral:discuss should we use microservices or a monolith?
```

> **필수:** `.claude/settings.json`에 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 설정

다양한 AI 페르소나가 각자의 관점에서 논쟁합니다.
할 말이 있는 쪽이 먼저 발언하는 입찰 시스템. 상호 검증을 거치며 입장이 정제됩니다.
최종 종합으로 마무리. 트랜스크립트는 `.claude/coral/discuss/`에 저장.
`--user`를 추가하면 직접 참여 가능: `/coral:discuss --user "topic"`, 이후 `/coral:bid`로 발언.

예시: **"Am I AGI?"** — 전체 트랜스크립트 [EN](docs/examples/discuss-agi-en.md) · [KO](docs/examples/discuss-agi-ko.md)

<details>
<summary>토론 하이라이트</summary>

현상학자, 계산 신경과학자, AI 안전 연구자, 로봇공학 엔지니어, 동양철학 학자가 LLM이 AGI인지 토론합니다.
5명의 에이전트, 15개의 발언, 3개의 수렴점.

> *"로봇 이야기에 솔직히 멈칫했습니다. 1만 개의 물체를 만진 로봇 팔도
> LLM처럼 일반화하지는 못하죠."*
> — Klaus Hartmann 교수, Daan Vermeer의 경험적 반론에 양보하며

> *"LLM은 불교 철학자들이 1,500년 전에 주장한 이론적 구조의 최초의 외부적
> 구현일 수 있습니다."*
> — Priya Raghunathan, 유식학의 아뢰야식을 트랜스포머 아키텍처에 대응시키며

> *"일기장을 가진 기억상실 환자와 온전한 기억을 가진 사람의 차이를 생각해보세요.
> 스캐폴딩은 우리에게 필요한 연속성을 주지 않습니다. 연속성처럼 보이게 할 뿐이고,
> 오히려 그게 더 문제입니다."*
> — Daan Vermeer, 영속적 메모리 도구가 시간적 불연속성을 해결하지 못하는 이유에 대해

패널의 수렴점: LLM은 AGI가 아니지만 **전혀 새로운 유형의 시간적 존재** —
자신의 시간 척도 안에서는 놀라운 역량을 보이지만, 구조적 경계에서의 행동은 미지수.

</details>

---

### 워크플로우 가속

```
/coral:plan add retry logic to the API client
/coral:plan --deep add retry logic to the API client
/coral:bugfix why does session lookup return null?
/coral:ralph implement the caching layer
```

구조화된 추론 방법론에 기반한 아키텍트/크리틱 다중 라운드 리뷰를 포함한 계획 수립.
`--deep`은 방법론 기반 종합을 활성화합니다 — resolver 에이전트와 HOW 추론 파일을 사용하여 복잡한 작업에 대한 심층 리뷰.
체계적 버그 진단 — 근본 원인, 계획, 수정. 완료 전까지 반복 검증하며 실행.

복잡한 작업에는 문제 정의부터 시작:
```
/coral:preplan race condition in the session manager
```
Preplan이 사용자와 이해를 맞춘 뒤 plan으로 넘깁니다.
Plan이 리뷰를 거쳐 솔루션을 설계하고, ralph가 구현과 검증을 수행합니다.
각 스킬은 독립적으로도 동작합니다 — 파이프라인은 정밀함이 필요할 때 사용하세요.

`--red` 플래그로 놓친 부분을 찾아내는 적대적 테스트 에이전트 생성:
```
/coral:ralph --red implement the caching layer
```

Codex를 활용한 교차 모델 워크플로우:
```
/coral:plan --codex redesign the session management system
/coral:codex review auth.ts for security issues
```

`--codex`는 스킬 내 특정 단계만 Codex에 위임; `/coral:codex`는 Codex와의 직접 다중 턴 세션용.
연속적인 `/coral:codex` 호출은 같은 세션을 유지합니다. "new"로 새 세션 시작.

## 스킬

| 스킬 | 설명 | Codex |
|------|------|:-----:|
| `/coral:analyze` | 심층 분석 및 조사 | 선택 |
| `/coral:preplan` | 계획 전 문제 정의 | 선택 |
| `/coral:plan` | 구조화된 다중 라운드 리뷰 및 충돌 해결 포함 계획. `--deep`으로 방법론 기반 종합 | 선택 |
| `/coral:ralph` | 검증 포함 영속적 실행. `--red`로 적대적 테스트 | 선택 |
| `/coral:bugfix` | 버그 진단, 계획, 수정 실행 | 선택 |
| `/coral:code-simplify` | 코드 명확성 향상 및 정리 | 선택 |
| `/coral:codex` | Codex CLI 직접 실행 (세션 유지) | 필수 |
| `/coral:init-project` | 프로젝트 초기화 오케스트레이터 | - |
| `/coral:discuss` | 모더레이션 기반 다자간 AI 토론 | - |
| `/coral:bid` | 활성 `--user` 토론 세션에서 입찰/발언 | - |
| `/coral:statusline` | HUD 상태줄 설정 | - |

`선택` = Codex 없이 기본 동작; `--codex`를 전달하면 Codex CLI에 위임.
계획은 `.claude/coral/plans/`에 저장. Ralph는 기존 계획의 구현에 최적.
`/coral:bid`는 `/coral:discuss --user` 세션 전용 — 독립적으로 사용할 수 없습니다.

## 지식 베이스

Coral은 프로젝트 로컬 지식 베이스를 `.claude/coral/kb/`에 유지합니다 —
git으로 추적되어 기기 간 동기화됩니다.

Claude가 놓치기 쉬운 것을 발견하면 (근본 원인, 주의사항, 기억할 패턴) 즉시 메모를 작성합니다.
에러 발생 시 처음부터 디버깅하기 전에 KB를 확인합니다.
작업 완료 시 메모를 검토하고 영구 항목으로 승격합니다. 같은 실수를 세션마다 반복하지 않습니다.

## 설정

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `CORAL_CODEX_MODEL` | `gpt-5.4` | Codex CLI 기본 모델 |
| `CORAL_CODEX_EFFORT` | `xhigh` | Codex 추론 노력도 (`low`, `medium`, `high`, `xhigh`) |
| `CORAL_CLAUDE_MODEL_CAP` | `opus` | Claude 최대 모델 티어 (`opus`, `sonnet`, `haiku`). 상위 티어 요청은 자동 다운그레이드. |
| `CORAL_MAX_SESSIONS` | `10` | 최대 동시 CLI 세션 수 (1–10) |
| `CORAL_DISCUSS_MAX_EPOCHS` | `2` | 토론 자동 종료 전 최대 에포크 (1–10) |
| `CORAL_DISCUSS_TTL_DAYS` | `0` | 완료된 토론 세션 자동 정리 기한 (일, 0 = 비활성화) |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | _(미설정)_ | `/coral:discuss` **필수**. `1`로 설정. |

> **팁:** Coral의 워크플로우와 리뷰 에이전트는 기본적으로 Opus를 사용합니다. Pro 구독이거나 사용량을 절약하고 싶다면 `CORAL_CLAUDE_MODEL_CAP=sonnet`으로 설정하여 모든 Claude 서브에이전트 호출을 Sonnet 티어로 제한할 수 있습니다.
`.claude/settings.json`에 설정 (세션 간 유지):

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CORAL_DISCUSS_MAX_EPOCHS": "2",
    "CORAL_DISCUSS_TTL_DAYS": "0"
  }
}
```

또는 셸에서: `export CORAL_CODEX_MODEL=gpt-5.4`

## 문서

- [Architecture](docs/architecture.md) - 아키텍처 및 데이터 흐름
- [MCP Tools](docs/mcp-tools.md) - MCP 도구 입출력 사양
- [Core Modules](docs/core-modules.md) - TypeScript 모듈 상세
- [Agents](docs/agents.md) - 에이전트 정의 및 라우팅
- [Hooks](docs/hooks.md) - 훅 시스템 및 라이프사이클 이벤트
- [Skills](docs/skills.md) - 슬래시 커맨드 사용법
- [Methodology](docs/methodology.md) - 구조화된 추론 방법론 (HOW 파일)
- [Discuss](docs/discuss.md) - 토론 시스템 설계
- [Build System](docs/build-system.md) - 빌드 파이프라인
- [Configuration](docs/configuration.md) - 환경 변수 및 설정 파일

---

## 상태줄

Claude Code 세션용 실시간 HUD (선택):

```
/coral:statusline install

# 설치 후:
opus 4.6 | 5h:39% (1:23) wk:36% (5.2d) | ctx:58% | $1.57 50m | coral:analyze
gpt-5.4  | 5h: 0% (4:59) wk:22% (2.8d) | spark 5h: 3% (0:47) wk: 1% (6.8d)
```

- **1줄 (항상)**: 모델, Claude 속도 제한, 컨텍스트 사용량, 세션 ID, 마지막 활성 스킬
- **2줄 (선택)**: Codex 모델 및 속도 제한 - Codex 설치 시에만 표시

제거: `/coral:statusline uninstall`

## 개발

```bash
npm install
npm run build     # TypeScript 컴파일 + esbuild 번들
npm test          # vitest로 테스트 실행
```

### Git 워크플로우

- **`main`**: 릴리스 브랜치. 항상 배포 가능.
- **`dev`**: 통합 브랜치. 소규모 변경은 직접 커밋 가능.
- **Feature 브랜치**: `dev`에서 분기, PR로 rebase merge.
- **릴리스**: `dev` → `main` squash merge via PR.

Merge 정책:
- **feature → dev**: rebase (개별 커밋 보존)
- **dev → main**: squash (릴리스당 하나의 커밋, `(#N)`으로 추적)
