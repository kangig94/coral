# KB 다국어 FTS 토크나이저 설계

> **Status: IMPLEMENTED.** 현재 Orama FTS 구현 기준 문서다.
> 작성: 2026-06-19. 업데이트: 2026-06-20. 근거가 된 실측은 §2 참조.

## 1. 배경 / 문제

- **기존 문제**: Orama FTS가 영어 전용 토크나이저(`src/engines/orama/document-builder.ts`의 과거 `ORAMA_LANGUAGE='english'` + `SPLITTERS` 정규식)를 사용했다. 영어 splitter `/[^A-Za-z…0-9_'-]+/`는 한글을 "구분자"로 취급해, **한국어/CJK 텍스트가 토큰화 시 빈 배열이 되어 인덱스에서 침묵 누락**됐다. 한국어 검색은 에러 없이 0건이었다.
- **제약**: 벡터 검색(`kb.vector`)은 기본 OFF(API 키/equip 필요). 따라서 **기본 검색 품질 = FTS 품질**이며, 다국어 FTS가 중요하다.
- **현재 목표/동작**: ① 어떤 언어도 침묵 누락하지 않음 ② opt-in 시 고정확 한국어 ③ 필수 비용·번들 0 ④ 의미 유사도는 비범위(벡터 담당) ⑤ 토크나이저 tier 전환 중에도 검색 읽기 경로는 full rebuild로 막히지 않음.

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
| 현재 Orama projection | sidecar `entryManifest` 기반 델타(`insert/update/remove`) 적용 + full-install fallback. 토크나이저 identity가 바뀌는 tier reconcile은 스냅샷 내용이 같아도 full install로 수렴 |

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
- 콘텐츠 변경 시 **변경/삭제 엔트리만** 재토큰화하여 영속 Orama db에 insert/update/remove 델타를 적용한다. manifest가 델타 적용에 충분하지 않은 경우 full install로 fallback한다.
- 효과: 문서 1개 수정 → 그 문서만 Kiwi 1회. Kiwi 실용화의 전제. **Intl 기본도 대형 KB에서 빨라짐**.
- 설치된 artifact sidecar의 `entryManifest`가 델타 기준이다. `snapshotStore.persist`는 실제 기록한 `OramaProjectionMetadata`를 반환하고, write path는 그 metadata를 cache에 같이 설치한다.
- 이전에 검토한 "토큰 메모이즈 캐시"는 불필요하다. 엔트리 manifest 기반 증분 projection이 정공법이다.

### 3.6 인덱스 정체성 / mismatch classifier
- `ORAMA_PROJECTION_IDENTITY_HASH`(`src/engines/orama/artifact-port.ts`)에 **identity schema version + schema version/digest + Node/ICU version + 토크나이저 정체성 + 선언 분석기 집합(`declaredAnalyzers`)**을 포함한다.
- `OramaProjectionMetadata` sidecar도 같은 판별 입력(`identitySchemaVersion`, `schemaVersion`, `schemaDigest`, `nodeVersion`, `icuVersion`, `tokenizerIdentity`, `declaredAnalyzers`)을 저장한다. 새 필드는 old sidecar 파싱을 위해 optional이지만, 누락 metadata는 `classifyProjectionMismatch`에서 `incompatible`이다.
- `classifyProjectionMismatch(persistedMetadata, currentExpectedInput)` 결과:
  - `match`: identity 판별 입력이 모두 일치.
  - `tier-only-upgrade`: schema/Node/ICU는 같고 토크나이저/선언 분석기만 다르며, persisted tier가 Intl이고 expected tier가 Kiwi.
  - `incompatible`: schema/Node/ICU drift, 누락 metadata, old sidecar, persisted Kiwi tier를 Intl로 낮춰야 하는 degrade 방향, 또는 알 수 없는 tier.
- `identitySchemaVersion`은 metadata에만 쓰는 값이 아니라 hash 입력이다. old sidecar는 우연히 legacy hash가 같아도 boot repair에서 projection-artifact lag로 잡힌다.
- Orama-only old-sidecar boot repair가 `FreshnessTimeout`으로 끝나면 KB readiness는 non-fatal로 계속된다. FTS는 stale/uninitialized warning을 노출하고, 이미 시작된 background reconcile이 계속 진행한다. 비-Orama lag, 구조적 오류, apply failure는 기존 readiness 규칙대로 fatal이다.
- Lost-update guard는 freshness-safe + identity-aware다. persist 직전 현재 disk/cache metadata를 다시 보고, persisted snapshot이 Orama 관심사 기준으로 **strictly fresher**면 identity와 무관하게 skip한다. snapshot이 같거나 충분히 같은 경우에는 target `projectionIdentityHash`까지 같을 때만 idempotent skip한다. 따라서 같은 snapshot에서 Intl↔Kiwi tier identity만 바뀌는 reconcile은 skip하지 않고 수렴한다.

### 3.7 읽기 경로: pure consumer + serve-stale
- `OramaSearchPort` 읽기 경로(`ensureLoaded`, `search`, `tokenize`, `tokenizeBatch`)는 `OramaSnapshotStore`의 pure consumer다. 읽기 중 full corpus rebuild, `persist`, `installFullSnapshot`, `forceCorpusApply`를 동기 실행하지 않는다.
- 읽기 경로는 cache/load 결과를 `classifyProjectionMismatch`로 분류한 뒤, metadata + `servedTokenizerIdentity` + DB tokenizer + snippet tokenizer를 가진 served-index record를 활성화한다. Orama query tokenizer와 snippet/query tokenization은 항상 이 served record에서 온다.
- `match`: artifact tier와 served tokenizer가 맞을 때만 serve한다. Intl tier는 Intl tokenizer로 serve한다. Kiwi tier는 live Kiwi analyzer lease 안에서 tokenizer를 bind할 수 있을 때만 serve한다.
- `tier-only-upgrade`: Kiwi가 expected여도 persisted artifact가 valid Intl tier이면 즉시 Intl tokenizer로 serve한다. 이때 `fts_index_stale_tier` warning을 노출하고 `requestProjectionReconcile('stale-tier')`를 fire-and-forget으로 호출한다.
- `incompatible`: structurally incompatible artifact, old sidecar, 누락 metadata, persisted Kiwi tier를 Intl tokenizer로 읽어야 하는 상황, 또는 Kiwi tier인데 live lease가 없는 cold-load는 serve하지 않는다. 기존 degraded/uninitialized FTS path로 내려가고 non-blocking reconcile만 요청한다.
- 이 gate의 핵심은 "served-tokenizer invariant"다. Intl-built index는 Intl tokenizer로만 query하고, Kiwi-built index는 live Kiwi lease가 있을 때만 query한다. Degrade 중 Kiwi index를 Intl query tokenizer로 조용히 검색하지 않는다.

### 3.8 Reconcile ownership + degrade trigger
- Reconcile ownership은 coordinator/`ConsumerDriver`에 있다. Orama read path는 주입된 `requestProjectionReconcile?: (reason: OramaReconcileReason) => void` callback만 호출한다.
- coordinator는 `createOramaProjectionReconcileRequester`를 만들고 하나의 `OramaBaseProjection`에 전달한다. 이 projection의 single read port가 registered CorpusConsumer와 bound FTS capability 양쪽으로 노출된다. requester는 coordinator layer에서 single-flight하며, 현재 Corpus snapshot에 대해 `driver.forceCorpusApply(snapshot, { reason: 'projection-artifact-lag', consumers: [ORAMA_BASE_CONSUMER_ID] })`를 호출한다.
- degrade 방향도 coordinator trigger가 primary다. `KiwiAnalyzerManager.markDegraded`는 degraded state를 기록하고 `observeDegraded` observer를 fire-and-forget microtask로 schedule한 뒤 terminal load error를 던진다. observer는 throw가 전파된 뒤 비동기로 실행된다. bundled Orama loader는 이 observer를 `host.scope`에 등록한다. scope dispose 시 observer가 process-singleton manager에서 제거되어 disposed coordinator driver를 붙잡지 않는다.
- degraded observer는 exception-isolated/fire-and-forget이다. observer가 throw하거나 늦어져도 Kiwi terminal-error path를 망가뜨리지 않는다.
- degraded observer는 `createOramaProjectionReconcileRequester.requestKiwiDegradedReconcile`로 연결된다. 이 경로는 `invalidateTextSnapshot('kiwi-degraded')` 후 Orama consumer를 force apply해서, corpus edit이나 restart 없이 persisted index가 Intl tier로 수렴하게 한다. `OramaBaseProjection.onApplyFailure`는 supplemental coverage일 뿐 primary degrade signal이 아니다.

### 3.9 Statusline 인디케이터
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

## 7. 단계 구분 (구현 상태)

### Phase 1 — 다국어 기본 (Intl 라우터)  *[구현 완료]*
- `createOramaTokenizer`를 **범용 Intl.Segmenter + 영어 stemmer(ASCII)** 커스텀 토크나이저로 교체했다.
- 라우터(스크립트 분할 → run별 토큰화 → 단일 스트림). ko가 effective analyzer로 활성화되지 않은 run은 Intl(+라틴 stemmer)을 사용한다.
- `KbOramaTokenizer` 타입을 `DefaultTokenizer`→최소 `Tokenizer`로.
- `ORAMA_PROJECTION_SCHEMA_VERSION`/projection identity drift → 기존 사용자 자동 재색인.
- **성과**: 한국어/CJK가 즉시 검색 가능(기존 "0건" 버그 해결). 신규 의존성·메모리 0.
- 위험: 낮음. 영어 동작은 사실상 동등(Intl 분절 + stemming).

### Phase 2 — 증분 projection  *[구현 완료, Phase 3의 전제]*
- full-rebuild 중심 동작을 델타(insert/update/remove) 적용으로 전환했다.
- 설치 스냅샷 대비 엔트리 `contentHash` 델타 산출 → 영속 Orama db에 적용 → 커서/freshness 전진.
- **성과**: 편집당 변경분만 재토큰화. Intl 대형 KB 재빌드 비용↓, 그리고 **Kiwi가 실용 가능해지는 핵심 조건**.
- 위험: 중–상. 핵심 authority(projection) 변경 → 광범위 테스트 필요. Phase 1과 독립적으로도 Intl에 이득이지만, 단독으로는 사용자 체감이 작음.

### Phase 3 — 한국어 형태소(Kiwi) opt-in  *[구현 완료]*
- `CORAL_KB_EXTRA_LANGS` 파싱(소문자 정규화) + 게이트.
- Kiwi `cong`을 설치형 아티팩트로(equip 또는 ko 선언 + 한글 코퍼스 감지 시 백그라운드 fetch).
- 논블로킹 부팅: fetch 동안 Intl 서빙 → 모델 준비 → 백그라운드 (증분) 재색인 → 준비되면 한글 run을 Kiwi로 스왑.
- lazy load + 5분 idle eviction(검색·색인 활동이 타이머 리셋; eviction 중 검색은 재로드 대기, Intl 폴백 금지).
- identity 해시에 tokenizer identity와 선언 분석기 집합 포함(토글 시 재색인).
- read path는 pure consumer다. tier mismatch를 읽기 중 rebuild하지 않고, served-tokenizer invariant를 지키며 §3.7의 serve-stale gate를 적용한다.
- reconcile은 coordinator-owned다. `requestProjectionReconcile`은 single-flight requester를 거쳐 `ConsumerDriver.forceCorpusApply`로 들어가고, Kiwi terminal degrade는 §3.8의 scoped `observeDegraded` registration이 primary trigger다.
- statusline fetch/재색인 인디케이터.
- **성과**: 한국어 검색 정확도/랭킹 대폭 향상(opt-in). 미설정 사용자엔 영향 0.
- 위험: 중. WASM 메모리 회수 검증, 콜드 재로드 UX, 백그라운드 재색인 진행 표시.

**의존성**: Phase 1은 독립 가치가 있었고, Phase 3는 Phase 2가 필요했다(Kiwi+full-rebuild는 매 편집 분 단위라 비실용). 현재 구현은 Phase 1–3과 serve-stale/reconcile 보강을 함께 포함한다.

## 8. 운영/향후 검증
- Emscripten WASM 힙이 dispose 후 실제 GC 회수되는지(잔존 참조 제거, eviction–재로드 경합).
- 대형 KB 최초 Kiwi 재색인(분 단위) 진행 표시 UX와 statusline 표현 고도화.
- 장기 운영에서 모델 fetch 실패/terminal degrade 반복 시 사용자 메시지 품질.
- 회귀 테스트 축: 다국어 tokenize, 색인=쿼리 대칭, identity 변경 재색인, 스크립트 라우팅, 증분 델타, serve-stale tier gate, degrade reconcile, old-sidecar boot repair, lost-update guard.

## 9. 영향 코드 영역
- `src/engines/orama/document-builder.ts` — 토크나이저/라우터.
- `src/engines/orama/schema.ts` — `KbOramaTokenizer` 타입.
- `src/engines/orama/backend.ts` — served-index read path, pure-consumer reconcile request, projection apply, lost-update guard.
- `src/engines/orama/artifact-port.ts` — projection identity metadata, identity hash, `classifyProjectionMismatch`.
- `src/engines/orama/snapshot.ts` — metadata-bearing load/persist/cache and tier-appropriate analyzer getter.
- `src/coordinator/expansion/lifecycle.ts` — `createOramaProjectionReconcileRequester`, Kiwi fetch-triggered reindex, degrade reconcile wiring.
- `src/coordinator/index.ts` — coordinator wiring and Orama-only boot `FreshnessTimeout` fallback.
- `src/engines/kiwi/analyzer-manager.ts` — lazy lease lifecycle, idle eviction, `observeDegraded` registration.
- 코퍼스 델타/스냅샷 측(`src/kb/corpus/…`) — projection input/freshness source.
- coordinator/env 결선 — `CORAL_KB_EXTRA_LANGS` → declared/effective analyzers.
- Kiwi 엔진 모듈 + installer(설치형 아티팩트).
- statusline — fetch/재색인 인디케이터.
- 테스트(`tests/unit/…`, 통합).
