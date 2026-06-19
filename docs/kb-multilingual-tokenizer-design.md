# KB 다국어 FTS 토크나이저 설계 (제안)

> **Status: PROPOSED — 미구현.** 현재 동작이 아니라 합의된 향후 설계를 기술한다.
> 작성: 2026-06-19. 근거가 된 실측은 §2 참조.

## 1. 배경 / 문제

- **현상**: Orama FTS가 영어 전용 토크나이저(`src/engines/orama/document-builder.ts`의 `ORAMA_LANGUAGE='english'` + `SPLITTERS` 정규식)를 사용한다. 영어 splitter `/[^A-Za-z…0-9_'-]+/`는 한글을 "구분자"로 취급해, **한국어/CJK 텍스트가 토큰화 시 빈 배열이 되어 인덱스에서 침묵 누락**된다. 한국어 검색은 에러 없이 0건.
- **제약**: 벡터 검색(`kb.vector`)은 기본 OFF(API 키/equip 필요). 따라서 **기본 검색 품질 = FTS 품질**이며, 다국어 FTS가 중요하다.
- **목표**: ① 어떤 언어도 침묵 누락하지 않음 ② opt-in 시 고정확 한국어 ③ 필수 비용·번들 0 ④ 의미 유사도는 비범위(벡터 담당).

## 2. 핵심 실측 (의사결정 근거)

Node 25 / 이 머신 기준 스파이크 결과:

| 항목 | 값 |
|---|---|
| Intl.Segmenter 다국어 분절 | 한·중(무공백)·일·라틴 정상 (`["한국어","검색을",…]`, `["中文","分词","测试"]`) |
| Intl 색인 처리량 / 쿼리 | 37.6 MB/s / 13 µs |
| `Intl.Segmenter` 최소 Node | 16+ (full-ICU는 Node 13+ 기본). coral 요구사항 `>=22`로 보장 |
| Kiwi WASM(kiwi-nlp) Node 구동 | ✅ (`ENVIRONMENT_IS_NODE`), WASM이라 Win/WSL/Ubuntu/Mac 자동 이식 |
| Kiwi `cong` 모델 | 다운로드 88MB / 해제 ~110MB, 모델은 Node에서 Uint8Array 주입(fetch 불필요) |
| Kiwi cong 품질 | 조사·활용·ㄹ불규칙·파생 정규화 (`검색을→검색+을`, `골라→고르+어`, `재검색→재/XPN+검색`) |
| **Kiwi 상주 메모리** | **~1.0–1.1 GB** (비양자화 신경망 + WASM 힙) |
| **Kiwi 처리량** | **~0.07–0.18 MB/s** (kiwi-nlp JSON 마샬링 병목; 모델 무관) |
| knlm/sbg | 여전히 ~640MB + 더 느림 + 품질 하락(knlm 54% < MeCab 58.55%) → **미채택**. 0.23 WASM은 cong 전용이기도 함 |
| MeCab(네이티브) | Windows 빌드/사전 관리 문제 → coral 배포모델과 충돌 → **배제** |
| 현재 Orama projection | **콘텐츠 변경 시 전체 재빌드**(증분 아님): `backend.ts`의 `apply→installLatestCoalescedSnapshot→prepareFullSnapshot→insertMultiple(전체문서)` |

결론: 다국어 기본은 `Intl.Segmenter`(0비용)가 정답. 한국어 고정확은 Kiwi `cong`이 압도적이나 ~1GB·저속이라 **opt-in + 증분 + 메모리 회수**가 전제. MeCab/knlm/sbg는 부적합.

## 3. 아키텍처

### 3.1 2층 토크나이저
- **Layer 0 — 기본 (항상, 0비용, 설정 불필요)**: 범용 `Intl.Segmenter(undefined,{granularity:'word'})` + ASCII 토큰 영어 stemming. 모든 스크립트를 단어/어절 단위로 분절. 영어=주 언어(stemming).
- **Layer 1 — 언어별 형태소 격상 (opt-in)**: `CORAL_KB_EXTRA_LANGS`로 선언한 언어를 전용 분석기로 라우팅. 현재 `ko → Kiwi cong`.

### 3.2 스크립트 라우팅 (단일 인덱스, 이중 검색 아님)
하나의 라우터가 텍스트를 스크립트 run으로 쪼개 각 run을 해당 분석기로 토큰화하고 **하나의 토큰 스트림으로 합친다**. 색인·쿼리가 동일 라우터를 통과한다.

```
색인: "코랄 검색 hello world"
  [코랄 검색](한글)→Kiwi→ 코랄/NNP, 검색/NNG
  [hello world](라틴)→Intl+stem→ hello, world
  문서 토큰 = {코랄, 검색, hello, world} → 단일 인덱스 삽입

검색: "검색 hello" → 같은 라우터 → {검색, hello} → 단일 Orama 검색 1회
```
- 인덱스 1개, 토크나이저(라우터) 1개, 검색 1회. **별도 패스/점수 aggregate 없음.**
- 한글 토큰은 한글끼리, 영어 토큰은 영어끼리 같은 인덱스 안에서 자연 매칭(BM25 통합).
- 혼합 무공백(`검색API`)은 스크립트 경계로 `검색`+`API` 분리.
- coral 검색은 이미 prefix 매칭(`exact:false`)이라, Kiwi 미활성(Intl 어절)에서도 `검색`→`검색을`이 잡힌다.

### 3.3 설정
```
CORAL_KB_EXTRA_LANGS=ko        # 기본 위에 ko를 형태소로 격상
CORAL_KB_EXTRA_LANGS=ko,ja     # 향후 확장
# 미설정 = 영어 기본 + 범용 Intl (한국어도 어절+prefix로 검색됨)
```
- 파싱: `trim().toLowerCase()` 후 콤마 분리, 빈 토큰 제거 → `ko`/`KO`/`Ko` 모두 허용.
- 전용 엔진 없는 코드 → 무시(+경고), 기본 Intl이 커버.

### 3.4 Kiwi 엔진 (Layer 1, ko)
- 모델 `cong`(`modelType:'cong-global'`), kiwi-nlp WASM. 모델 파일은 Node `fs`로 읽어 Uint8Array로 주입.
- **전달**: 설치형 아티팩트(needle/onnx 패턴). `equip` 또는 lazy 자동 fetch.
- **lazy load + idle eviction**:
  - 기본 미로드 → 검색/색인이 한글 형태소를 처음 필요로 할 때 로드(~1.5s build).
  - **검색·색인 활동이 N분(기본 5분) 없으면 dispose → ~1GB 회수.** 디스크 모델(88MB)은 유지.
  - 재로드: 디스크 캐시에서 ~1.5s(재fetch 없음). 첫 콜드 쿼리만 지연.
  - **eviction 중 검색은 Intl로 폴백 금지** — 인덱스가 Kiwi 토큰이라 폴백 시 결과 불일치. eviction = "다음 검색이 재로드를 대기".
- **사전 옵션은 끄지 않음**: `loadDefaultDict/loadMultiDict/loadTypoDict`(기본 true)를 꺼도 ~15MB만 절감(1GB는 신경망이 지배) → 정확도만 잃으므로 기본값 유지.

### 3.5 증분 projection (full-rebuild 폐기)
- 콘텐츠 변경 시 **변경/삭제 엔트리만** 재토큰화하여 영속 Orama db에 insert/update/remove 델타 적용.
- 효과: 문서 1개 수정 → 그 문서만 Kiwi 1회. Kiwi 실용화의 전제. **Intl 기본도 대형 KB에서 빨라짐**.
- (이로써 이전에 검토한 "토큰 메모이즈 캐시"는 불필요 — 증분이 정공법이라 폐기.)
- 변경: projection/consumer 계약이 현재 full `projectionInput`을 넘기므로, 설치 스냅샷 대비 엔트리별 `contentHash` 델타 산출 + 델타 적용 + 커서/freshness 전진으로 전환.

### 3.6 인덱스 정체성 / 재색인
- `ORAMA_PROJECTION_IDENTITY_HASH`(`src/engines/orama/artifact-port.ts`)에 **토크나이저 정체성 + 활성 분석기 집합(EXTRA_LANGS)** 포함.
- 토크나이저 교체 시 `ORAMA_PROJECTION_SCHEMA_VERSION` bump → identity 불일치 → `src/kb/corpus/rescan/drift.ts:375`가 drift로 판정 → **자동 재색인**. 추가 마이그레이션 코드 불필요.
- `CORAL_KB_EXTRA_LANGS` 변경(ko 추가/제거)도 identity를 바꿔 자동 재빌드.

### 3.7 Statusline 인디케이터
- 위치: 톱니바퀴 + discuss 개수 라인 **맨 오른쪽**.
- 상태: ① 한국어 모델 백그라운드 fetch 중 ② 재색인 진행 중 ③ idle(숨김).
- 데이터: projection rebuild 진행 + 모델 fetch 상태를 데몬이 이벤트/IPC로 노출 → statusline이 구독.
- 표기 예: `⬇ 한국어 모델 받는 중` / `⟳ KB 재색인 12%` / 평소 숨김.

## 4. 동작 결정 (확정)
- 다이아크리틱: **라틴 전용 폴딩**(Orama `replaceDiacritics`). 전체 NFKD 금지(한글 자모 분해됨).
- 영어 stemming: ASCII 토큰에만.
- 언더스코어/식별자: Intl이 분리 — 수용(산문 KB).
- 로케일: 중립 단일 segmenter(혼합 스크립트).
- 커스텀 `tokenize`는 `language` 인자 무시(현재 불일치 시 throw 동작 제거).
- `create()`에 `language` 미전달 유지(`NO_LANGUAGE_WITH_CUSTOM_TOKENIZER` 회피).

## 5. 비목표
- 의미 유사도 → 임베딩/벡터 담당(별개 축).
- 중/일 형태소 → Intl 사전 분절로 충분(전용 엔진 미도입).
- knlm/sbg, 네이티브 mecab.

## 6. 비용·트레이드오프 요약

| | Layer 0 (Intl) | Layer 1 (Kiwi cong, ko) |
|---|---|---|
| 의존성/번들 | 0 (Node 내장) | 설치형 88MB 모델(lazy-fetch) |
| 상주 메모리 | ~0 | ~1GB (idle 5분 후 회수) |
| 처리량 | 37.6 MB/s | ~0.18 MB/s (증분이라 변경분만) |
| 품질 | 어절+prefix | 형태소(최상) |
| 활성 | 항상 | `CORAL_KB_EXTRA_LANGS=ko` + 모델 가용 시 |

## 7. 단계 구분 (구현 순서)

### Phase 1 — 다국어 기본 (Intl 라우터)  *[독립 출하 가능, 최우선]*
- `createOramaTokenizer`를 **범용 Intl.Segmenter + 영어 stemmer(ASCII)** 커스텀 토크나이저로 교체.
- 라우터(스크립트 분할 → run별 토큰화 → 단일 스트림). 현재는 모든 run이 Intl(+라틴 stemmer).
- `KbOramaTokenizer` 타입을 `DefaultTokenizer`→최소 `Tokenizer`로.
- `ORAMA_PROJECTION_SCHEMA_VERSION` bump → 기존 사용자 자동 재색인.
- **성과**: 한국어/CJK가 즉시 검색 가능(현재 "0건" 버그 해결). 신규 의존성·메모리 0. full-rebuild projection 유지(Intl는 빨라서 무해).
- 위험: 낮음. 영어 동작은 사실상 동등(Intl 분절 + stemming).

### Phase 2 — 증분 projection  *[Phase 3의 전제]*
- full-rebuild → 델타(insert/update/remove) 적용으로 projection/consumer 계약 전환.
- 설치 스냅샷 대비 엔트리 `contentHash` 델타 산출 → 영속 Orama db에 적용 → 커서/freshness 전진.
- **성과**: 편집당 변경분만 재토큰화. Intl 대형 KB 재빌드 비용↓, 그리고 **Kiwi가 실용 가능해지는 핵심 조건**.
- 위험: 중–상. 핵심 authority(projection) 변경 → 광범위 테스트 필요. Phase 1과 독립적으로도 Intl에 이득이지만, 단독으로는 사용자 체감이 작음.

### Phase 3 — 한국어 형태소(Kiwi) opt-in  *[Phase 2 의존]*
- `CORAL_KB_EXTRA_LANGS` 파싱(소문자 정규화) + 게이트.
- Kiwi `cong`을 설치형 아티팩트로(equip 또는 ko 선언 + 한글 코퍼스 감지 시 백그라운드 fetch).
- 논블로킹 부팅: fetch 동안 Intl 서빙 → 모델 준비 → 백그라운드 (증분) 재색인 → 준비되면 한글 run을 Kiwi로 스왑.
- lazy load + 5분 idle eviction(검색·색인 활동이 타이머 리셋; eviction 중 검색은 재로드 대기, Intl 폴백 금지).
- identity 해시에 활성 분석기 집합 포함(토글 시 재색인).
- statusline fetch/재색인 인디케이터.
- **성과**: 한국어 검색 정확도/랭킹 대폭 향상(opt-in). 미설정 사용자엔 영향 0.
- 위험: 중. WASM 메모리 회수 검증, 콜드 재로드 UX, 백그라운드 재색인 진행 표시.

**의존성**: Phase 1 독립(즉시 가치). Phase 3는 Phase 2 필요(Kiwi+full-rebuild는 매 편집 분 단위라 비실용). Phase 2는 Phase 1 위에 얹는 게 자연스럽다.

## 8. 구현 시 검증/결정 남은 것
- Emscripten WASM 힙이 dispose 후 실제 GC 회수되는지(잔존 참조 제거, eviction–재로드 경합).
- coral 코퍼스에서 엔트리 단위 델타(추가/수정/삭제) 산출 API 가용성 — 증분 projection의 입력.
- Kiwi 모델 전달 정책 확정: 명시적 `equip` vs (ko 선언 + 한글 감지) 자동 fetch.
- 대형 KB 최초 Kiwi 재색인(분 단위) 진행 표시 UX.
- 테스트: 다국어 tokenize, 색인=쿼리 대칭, identity 변경 재색인, 스크립트 라우팅, 증분 델타, eviction/재로드.

## 9. 영향 코드 영역 (구현 참고, 미수정)
- `src/engines/orama/document-builder.ts` — 토크나이저/라우터.
- `src/engines/orama/schema.ts` — `KbOramaTokenizer` 타입.
- `src/engines/orama/backend.ts` — projection apply(증분 전환).
- `src/engines/orama/artifact-port.ts` — projection identity/스키마 버전.
- 코퍼스 델타/스냅샷 측(`src/kb/corpus/…`) — 증분 입력.
- coordinator/env 결선 — `CORAL_KB_EXTRA_LANGS` → 활성 분석기.
- Kiwi 엔진 모듈 + installer(설치형 아티팩트).
- statusline — fetch/재색인 인디케이터.
- 테스트(`tests/unit/…`, 통합).
