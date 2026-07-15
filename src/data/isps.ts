// 타깃 ISP / ASN 단일 소스 (PRD §3). 프론트엔드와 모크 생성기가 함께 사용.
// 한국 ISP는 상단 고정, 해외 ISP는 국가별 그룹.

export interface Isp {
  id: string;
  name: string;
  asns: string[];
  hidden?: boolean; // 선택 목록엔 안 보이지만 데이터는 생성(합산/통합 entry용)
  // 멀티 ASN ISP: 박스 하나 안에서 ASN을 개별 선택. 각 unit은 별도 데이터 entry로 생성된다.
  asnUnits?: { id: string; asn: string }[];
}

export interface IspGroup {
  id: string;
  label: string;
  pinned?: boolean;
  isps: Isp[];
}

export const ISP_GROUPS: IspGroup[] = [
  {
    id: 'KR',
    label: '한국 (고정)',
    pinned: true,
    isps: [
      // LG U+: 박스 하나 안에서 ASN 2개를 개별 선택. 둘 다 선택 시 합산(통합 id: lgu)으로 표시.
      { id: 'lgu', name: 'LG U+', asns: ['AS3786', 'AS17858'],
        asnUnits: [{ id: 'lgu-3786', asn: 'AS3786' }, { id: 'lgu-17858', asn: 'AS17858' }] },
      { id: 'kt', name: 'KT', asns: ['AS4766'] },
      { id: 'skb', name: 'SK 브로드밴드', asns: ['AS9318'] },
    ],
  },
  // 해외는 각국 대표(1위) 통신사 1개만 — 데이터 용량·대시보드 정리.
  { id: 'US', label: '미국', isps: [{ id: 'comcast', name: 'Comcast Xfinity', asns: ['AS7922'] }] },
  { id: 'CA', label: '캐나다', isps: [{ id: 'bell', name: 'Bell', asns: ['AS577'] }] },
  { id: 'UK', label: '영국', isps: [{ id: 'bt', name: 'BT', asns: ['AS2856'] }] },
  { id: 'DE', label: '독일', isps: [{ id: 'dtag', name: 'Deutsche Telekom', asns: ['AS3320'] }] },
  { id: 'FR', label: '프랑스', isps: [{ id: 'orange', name: 'Orange', asns: ['AS3215'] }] },
  { id: 'IT', label: '이탈리아', isps: [{ id: 'tim', name: 'TIM', asns: ['AS3269'] }] },
  { id: 'ES', label: '스페인', isps: [{ id: 'movistar', name: 'Telefónica/Movistar', asns: ['AS3352'] }] },
  { id: 'NL', label: '네덜란드', isps: [{ id: 'kpn', name: 'KPN', asns: ['AS1136'] }] },
  { id: 'JP', label: '일본', isps: [{ id: 'ntt', name: 'NTT/OCN', asns: ['AS4713'] }] },
  { id: 'AU', label: '호주', isps: [{ id: 'telstra', name: 'Telstra', asns: ['AS1221'] }] },
];

export interface FlatIsp extends Isp {
  groupId: string;
  groupLabel: string;
  pinned: boolean;
}

// 멀티 ASN ISP는 (통합 entry: 데이터만, hidden) + (ASN unit별 개별 entry)로 평탄화.
export const ALL_ISPS: FlatIsp[] = ISP_GROUPS.flatMap((g) =>
  g.isps.flatMap((isp): FlatIsp[] => {
    const flat = { groupId: g.id, groupLabel: g.label, pinned: !!g.pinned };
    if (isp.asnUnits) {
      return [
        { ...isp, ...flat, hidden: true }, // 통합(combined) — 선택 박스로는 노출, 데이터 entry는 hidden
        ...isp.asnUnits.map((u) => ({ id: u.id, name: `${isp.name} (${u.asn})`, asns: [u.asn], ...flat })),
      ];
    }
    return [{ ...isp, ...flat }];
  })
);

export const ISP_BY_ID: Record<string, FlatIsp> = Object.fromEntries(
  ALL_ISPS.map((i) => [i.id, i])
);

// --- NIA 속도측정 전용 국내 사업자 목록 (2026-07-15) ---
// NIA 통계(collect-nia.ts)는 ASN이 아닌 사업자 단위라 케이블사가 포함된다. 전역 ISP_GROUPS(ASN 기반,
// 모든 탭 공용 선택 목록)와 분리해 NIA 탭에서만 선택/표시한다. kt/skb/lgu는 기존 id 재사용(색·이름 동일),
// LG U+는 NIA가 브랜드 단위라 ASN unit 없이 통합(lgu) 하나로 선택한다. id는 nia_cache.json 키와 일치.
export interface NiaIsp { id: string; name: string }
export const NIA_ISPS: NiaIsp[] = [
  { id: 'kt', name: 'KT' },
  { id: 'skb', name: 'SK 브로드밴드' },
  { id: 'lgu', name: 'LG U+' },
  { id: 'dlive', name: "딜라이브 (D'LIVE)" },
  { id: 'lghv', name: 'LG헬로비전' },
  { id: 'hcn', name: 'HCN' },
  { id: 'cmb', name: 'CMB' },
  { id: 'etc', name: '기타 (그 외 사업자)' },
];
export const NIA_NAME_BY_ID: Record<string, string> = Object.fromEntries(NIA_ISPS.map((i) => [i.id, i.name]));
// ISP_GROUPS에 없는 NIA 전용 id(케이블사 등) — generate-mock이 이들에 대해선 NIA 지표만 생성한다.
export const NIA_EXTRA_IDS: string[] = NIA_ISPS.map((i) => i.id).filter((id) => !ISP_BY_ID[id]);

// 합산(통합) 매핑: member ASN unit이 "모두" 선택되면 차트에서 combo 하나(합산값)로 합쳐 표시.
export const COMBINE_GROUPS: Record<string, string[]> = {};
for (const g of ISP_GROUPS) for (const isp of g.isps) if (isp.asnUnits) COMBINE_GROUPS[isp.id] = isp.asnUnits.map((u) => u.id);
