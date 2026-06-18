# 글로벌 오픈 API 기반 유선 브로드밴드 품질 대시보드

NW 운용/관리 부서용 고신뢰도 유선 브로드밴드 품질 대시보드. ISP/ASN별 품질
지표를 집계·정제하여 ISP 간 비교와 피크타임 성능 분석을 제공한다.

[`prd.md`](prd.md) 기반 · **React + Vite + TypeScript**, **ApexCharts**, 단일
정적 모크(`quality_data.json`) 페치 구조. UI 언어는 한국어.

## 아키텍처

```
  생성기 ─────────────────────►  public/quality_data.json  ─────►  React SPA
  scripts/generate-mock.ts        (단일 다중 해상도 모크)            (티어 선택 후
  10분 정제 + FR-03 절단           라이브 API 호출 없음                 차트 렌더)
```

- 클라이언트는 **라이브 API를 호출하지 않고** 단일 `quality_data.json` 만
  페치한다. 번들에 자격증명이 포함되지 않는다 (NFR-02).
- **단일 파일 + 10분 정제 + 최대 1년 범위**의 물리적 충돌을 해소하기 위해
  하나의 파일을 **다중 해상도(티어)** 로 구성한다:

  | 티어 | 해상도 | 보존 | 용도(범위) |
  |------|--------|------|------------|
  | `fine` | 10분 | 2일 | 24시간·2일 + **피크타임 분석** (실제 원샘플 FR-03 절단) |
  | `mid` | 1시간 | 30일 | 7일·30일 |
  | `coarse` | 1일 | 365일 | 90일·180일·**1년** |

  각 티어 버킷이 절단평균 메타(총샘플/잔존)를 보유하므로 모든 범위에서 커스텀
  툴팁(NFR)이 동작한다. 범위 선택에 따라 프론트가 티어를 자동 선택하고, 버킷
  단위(10분/1시간/1일)는 티어 기본 해상도 이상으로만 선택 가능하다.

## 실행

```bash
npm install
npm run mock     # public/quality_data.json 생성 (약 10MB)
npm run dev      # http://localhost:5173
```

- `npm run build` → 타입체크(`tsc --noEmit`) 후 `dist/` 프로덕션 번들
- `npm run typecheck` → 타입 검사만
- `npm run mock` → 모크 재생성 (`node scripts/generate-mock.ts`, Node 24 타입 스트리핑)

## 정기 갱신 (FR-07)
`.github/workflows/collect.yml` 이 10분마다 생성기를 실행해 `quality_data.json`
을 커밋한다. 실 연동 시 제공자 자격증명을 GitHub Actions 시크릿으로 설정하고
`generate-mock.ts` 의 `simulateSamples`/`synthAggregate` 를 실제 API 어댑터로
교체한다 (`.env.example` 참고).

## PRD 요구사항 매핑

| 요구 | 위치 |
|------|------|
| FR-01 10분 그리드 + 조회 한도 | `scripts/generate-mock.ts` (티어 그리드), `src/config.ts` |
| FR-02 소스별 지표 | `src/data/metrics.ts` |
| FR-03 절단평균 / 저표본 검증 / 하드 필터 | `src/lib/stats.ts` (생성기·UI 공유), 저표본 마커 `src/components/MetricChart.tsx` |
| FR-04 피크타임 분석 | `src/lib/peak.ts`, `src/components/PeakTimeWidget.tsx` (항상 fine 티어) |
| FR-05 80vh 멀티셀렉트 드롭다운 | `src/components/IspMultiSelect.tsx` + `.ms-*` CSS |
| FR-06 다크/라이트 테마 + 영속화 | `src/theme.ts`, `src/index.css` |
| FR-07 정적 JSON 갱신 크론 | `.github/workflows/collect.yml`, `scripts/generate-mock.ts` |
| NFR-01 추적성 툴팁(총/절단/잔존) | `src/components/MetricChart.tsx` 커스텀 툴팁 |
| NFR-02 자격증명 마스킹 | 생성기/CI 환경변수만 사용, 클라이언트 미포함 |
| NFR-03 테마 즉시 변환 | `theme.mode` + `key={theme}` (`MetricChart.tsx`) |

### ISP / ASN 범위
PRD §3의 전 통신사를 `src/data/isps.ts` 에 수록. 한국 통신사 상단 고정, 해외는
국가별 그룹. SK 브로드밴드의 선택적 `AS9644`(SKT 모바일)는 유선 데이터 오염
방지를 위해 드롭다운 토글로 제공.

## 알려진 근사/한계
- FR-03 "점선 세그먼트" 저표본 표시는 ApexCharts가 세그먼트 단위 점선을
  지원하지 않아 **경고 마커 + 툴팁**으로 근사.
- `fine` 티어만 실제 원샘플을 생성·절단하고, `mid`/`coarse` 는 대표 집계
  메타를 합성한다(수천 샘플 생성 회피, 단일 파일 크기 유지). 실 연동 시 각
  티어를 해당 제공자 집계로 채우면 된다.
- 단일 모크 파일은 약 10MB(프로덕션에서 gzip 시 ~2MB). 더 긴 보존이나 더 높은
  해상도가 필요하면 티어 파라미터(`scripts/generate-mock.ts`)를 조정한다.
