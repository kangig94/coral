# 🪸 Coral

Claude Code는 이미 코딩할 줄 압니다. Coral은 *당신의 방식대로* 일하도록 가르칩니다.

Coral은 CLI 중심 플러그인이며, 오케스트레이션, 세션, 토론, 지식 베이스 워크플로우는 지속형 HTTP 데몬을 통해 처리됩니다.

## 설치

**요구사항:** Node.js 18+

```bash
# Claude Code:
/plugin marketplace add https://github.com/kangig94/coral
/plugin install coral

# Codex (--codex 교차 모델 위임도 활성화):
npm install -g @openai/codex
codex plugin marketplace add kangig94/coral
# Codex를 재시작한 뒤 /plugins를 실행하고 Coral marketplace에서 Coral을 설치하세요.

# Codex marketplace와 설치된 플러그인 캐시 업데이트:
codex plugin marketplace upgrade coral
```

## 바로 사용해보기

기존 프로젝트에서 바로 실행:

```
/coral:analyze what does this codebase do?
```

## 프로젝트 구조화

https://github.com/user-attachments/assets/881f1a14-9f4f-4d3d-8023-59610eb13ac4

```
/coral:init-project
```

Coral이 기술 스택을 스캔하고 `.claude/` 디렉토리를 생성합니다 — 컨벤션, 리뷰 에이전트, 아키텍처 문서를 프로젝트에 맞게.

생성된 에이전트는 기성품이 아닙니다 — 프로젝트의 스택과 청중에 맞게 보정된 평가 루브릭을 내장합니다. Claude가 일반적인 기본값이 아닌 당신의 규칙을 따르게 됩니다.

```bash
/coral:init-project                                          # 기존 프로젝트
/coral:init-project "React + FastAPI"                        # 기술 스택 힌트
/coral:init-project "multi-tenant SaaS REST API with Go"     # 상세 설명
```

<details>
<summary>생성되는 구조</summary>

```
my-project/
+ .claude/
+   CLAUDE.md                 ← 프로젝트 허브: 빌드 명령, 워크플로우, 핵심 규칙
+   agents/
+     code-critic.md          ← 코드 품질 리뷰
+     ...                     ← 도메인 에이전트 (React, Go, ML, infra 등)
+   rules/
+     conventions.md          ← 네이밍, git, 스타일
+     ...                     ← 도메인 규칙, 파일 경로 기반 자동 활성화
+ docs/
+   architecture.md           ← 모듈 맵, 의존성 그래프
```

이 저장소의 [`.claude/`](.claude/) 폴더가 실제 예시입니다.

</details>

## 계획, 구현, 수정

```
pathfind  →  preplan  →  plan  →  ralph
(탐색)       (정의)      (설계)    (구현 + 검증)
```

```bash
# 문제를 알고 있고, 계획이 필요할 때:
/coral:plan add retry logic to the API client

# 증상은 있지만 원인을 모를 때:
/coral:pathfind API is slow, DB hits limits, users are complaining

# 복잡한 문제, 먼저 정의가 필요할 때:
/coral:preplan race condition in the session manager

# 계획이 있고, 구현만 남았을 때:
/coral:ralph implement the caching layer

# 버그 — 진단, 계획, 수정을 한 번에:
/coral:bugfix why does session lookup return null?
```

<details>
<summary>파이프라인 상세</summary>

각 단계는 다음 단계의 입력이 되는 산출물을 생성합니다. 필요한 지점부터 시작하면 됩니다.

**pathfind** — *"문제는 있는데 뭘 만들어야 할지 모르겠다."*
증상을 클러스터링하고, 근본 원인을 조사(코드베이스 분석을 위해 scanner 생성)하며,
직교 레인을 통해 발산적 방향을 생성하고, pioneer를 생성해 우아한 대안을 탐색합니다.
점수 매트릭스와 함께 순위가 매겨진 방향 목록을 출력합니다.
선택된 방향을 preplan에 전달합니다.

**preplan** — *"방향은 알지만 범위에 대한 합의가 필요하다."*
코드베이스 분석을 통해 7개 항목(문제 정의, 성공 기준, 범위, 가정, 영향 시스템, 제약, 접근 방향)의
합의서를 자율적으로 작성한 후 사용자에게 수정을 요청합니다.
Pioneer를 생성해 불확실한 항목의 우아한 대안을 탐색하며 기본/최소/우아한 스펙트럼을 제시합니다.
`pre-{topic}.md`를 생성 — plan이 충족해야 하는 계약서입니다.

**plan** — *"구현 전에 설계가 필요하다."*
다중 라운드 리뷰 루프: architect + critic(그리고 `--deep` 모드에서는 resolver)를
워크플로우로 디스패치하고, 피드백을 종합하여 plan 파일을 편집하며, exit gate를 평가합니다.
Resolver는 findings를 분류(Adopt/Adapt/Defer/Diverge)하고 변경을 적용한 후,
finding의 심각도와 성격에 따라 추가 라운드가 필요한지 판정합니다.
수용 기준, 구현 단계, 실행 순서(의존성 그래프 + 병렬 배치)가 포함된 `{topic}.md`를 생성합니다.

**ralph** — *"계획(또는 프롬프트)이 있다. 구현만 하면 된다."*
검증 루프를 갖춘 지속적 실행기.
plan 모드에서는 실행 순서를 읽고 배치 단위로 디스패치하며 독립적인 AC들을 병렬 처리합니다.
모든 완료 선언에는 검증 증거(lint → build → test)가 필요합니다.
`--red`는 red-attacker를 병렬 생성해 사각지대를 찾는 적대적 테스트를 작성합니다.
`--team`은 Agent Teams를 사용한 병렬 AC 실행입니다.

</details>

<details>
<summary>고급 플래그</summary>

```bash
# 방법론 기반 심층 리뷰 (resolver + HOW 추론):
/coral:plan --deep add retry logic to the API client

# 적대적 테스트 — 놓친 부분을 찾는 red-attacker 생성:
/coral:ralph --red implement the caching layer

# Codex CLI에 교차 모델 위임:
/coral:plan --codex redesign the session management system

# Codex 직접 세션 (다중 턴, 세션 유지):
/coral:codex review auth.ts for security issues
```

`--codex`는 스킬 내에서 Codex에 위임; `/coral:codex`는 독립적인 Codex 세션.

</details>

## 토론

```
/coral:discuss should we use microservices or a monolith?
```

다양한 AI 페르소나가 각자의 관점에서 논쟁합니다. 입찰 기반 발언 순서, 상호 검증, 구조화된 종합으로 마무리.

직접 참여: `/coral:discuss --user "topic"`, 이후 `/coral:bid`로 발언.

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

## 상태줄

```
/coral:statusline install
```

```
opus 4.6 │ 5h:39% (1:23) wk:36% (5.2d) │ ctx:58% │ $1.57 50m │ coral:analyze
gpt-5.4  │ 5h: 0% (4:59) wk:22% (2.8d) │ spark 5h: 3% (0:47) wk: 1% (6.8d)
```

## 스킬

| 스킬 | 설명 | Codex |
|------|------|:-----:|
| `/coral:analyze` | 심층 분석 및 조사 | 선택 |
| `/coral:pathfind` | 문제 증상에서 발산적 방향 탐색 | - |
| `/coral:preplan` | 계획 전 문제 정의 | 선택 |
| `/coral:plan` | 구조화된 다중 라운드 리뷰 포함 계획. `--deep`으로 방법론 기반 종합 | 선택 |
| `/coral:ralph` | 검증 포함 영속적 실행. `--red`로 적대적 테스트 | 선택 |
| `/coral:bugfix` | 버그 진단, 계획, 수정을 한 번에 | 선택 |
| `/coral:code-simplify` | 코드 명확성 향상 및 정리 | 선택 |
| `/coral:codex` | Codex CLI 직접 실행 (세션 유지) | 필수 |
| `/coral:init-project` | 프로젝트 초기화 오케스트레이터 | - |
| `/coral:discuss` | 모더레이션 기반 다자간 AI 토론 | - |
| `/coral:bid` | 활성 `--user` 토론 세션에서 입찰/발언 | - |
| `/coral:statusline` | HUD 상태줄 설치/제거 | - |

## 지식 베이스

Coral은 매 세션에서 배웁니다. 근본 원인, 주의사항, 패턴 — 메모로 포착하고, 검토 후 `~/.coral/kb/`에 영구 지식으로 승격합니다. 다음 세션은 처음부터 디버깅하기 전에 KB를 확인합니다. 같은 실수를 반복하지 않습니다.

- **시맨틱 검색**: `/coral:equip needle`로 대규모 벡터 검색 강화 — BM25 + 임베딩 하이브리드 검색 (Gemini, OpenAI, 로컬 ONNX 모델)

## 설정

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `CORAL_KB_PATH` | `~/.coral/kb` | KB 저장 경로 |
| `CORAL_CODEX_MODEL` | `gpt-5.4` | Codex CLI 기본 모델 |
| `CORAL_CODEX_EFFORT` | `xhigh` | Codex 추론 노력도 (`low`, `medium`, `high`, `xhigh`) |
| `CORAL_CODEX_FAST` | _(없음)_ | Codex 서비스 티어 토글 (`1` = fast, `0` = flex). 미설정 시 `~/.codex/config.toml` 최상위 `service_tier`로 폴백 |
| `CORAL_CLAUDE_EFFORT` | `xhigh` | Claude 추론 노력도 (`low`, `medium`, `high`, `xhigh`, `max`). Sonnet/Haiku에는 `xhigh`가 없어 어댑터가 `max`로 clamp |
| `CORAL_CLAUDE_MODEL_CAP` | `opus` | Claude 최대 모델 티어 (`opus`, `sonnet`, `haiku`) |
| `CORAL_EFFORT` | _(없음)_ | 공통 effort 폴백. 각 `CORAL_{CLAUDE,CODEX}_EFFORT`가 미설정일 때만 적용 |
| `CORAL_DEV_ASSERTIONS` | _(없음)_ | 기여자 전용 개발 어서션. 로컬 개발이나 `npm test` 실행 시 `1`로 두면 이미 비활성화된 continuity bridge 호출과 dispatcher 손상 상태를 조용히 넘기지 않고 예외로 드러냅니다. 미설정이 기본 프로덕션 동작이며, 배포 환경에서는 절대 켜지 마세요 |
| `CORAL_MAX_WORKERS` | `10` | 최대 동시 워커 수 (1–10) |
| `CORAL_DISCUSS_MAX_EPOCHS` | `2` | 토론 자동 종료 전 최대 에포크 (1–10) |
| `CORAL_DISCUSS_TTL_DAYS` | `0` | 완료된 토론 세션 자동 정리 기한 (0 = 비활성화) |
| `CORAL_KB_GIT_SYNC` | `0` | KB git 동기화 — remote와 자동 push/pull (`1` = 활성화) |

> **팁:** `CORAL_CLAUDE_MODEL_CAP=sonnet`으로 설정하면 모든 서브에이전트 호출을 Sonnet 티어로 제한합니다. Pro 구독이거나 사용량을 절약하고 싶을 때.
>
> **⚠️ 기업 사용자:** KB git 동기화는 **기본 비활성화**입니다. KB 노트에는 사내 코드베이스에서 학습한 지식이 포함될 수 있습니다. 자동 push를 활성화하면 기업 IP가 외부 remote로 유출될 수 있습니다. KB remote가 해당 콘텐츠를 수신해도 되는 곳인지 확인한 후에만 활성화하세요.

`.claude/settings.json`에 설정 (세션 간 유지):

```json
{
  "env": {
    "CORAL_KB_PATH": "/path/to/my-obsidian-vault",
    "CORAL_CLAUDE_MODEL_CAP": "sonnet"
  }
}
```

## 문서

- [Architecture](docs/architecture.md) — 아키텍처 및 데이터 흐름
- [Core Modules](docs/core-modules.md) — TypeScript 모듈 상세
- [Agents](docs/agents.md) — 에이전트 정의 및 라우팅
- [Hooks](docs/hooks.md) — 훅 시스템 및 라이프사이클 이벤트
- [Skills](docs/skills.md) — 슬래시 커맨드 사용법
- [Methodology](docs/methodology.md) — 구조화된 추론 방법론 (HOW 파일)
- [Discuss](docs/discuss.md) — 토론 시스템 설계
- [Build System](docs/build-system.md) — 빌드 파이프라인
- [Configuration](docs/configuration.md) — 환경 변수 및 설정 파일

## [기여하기](CONTRIBUTING.md)
