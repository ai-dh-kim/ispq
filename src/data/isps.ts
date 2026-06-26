// 타깃 ISP / ASN 단일 소스 (PRD §3). 프론트엔드와 모크 생성기가 함께 사용.
// 한국 ISP는 상단 고정, 해외 ISP는 국가별 그룹.

export interface Isp {
  id: string;
  name: string;
  asns: string[];
  hidden?: boolean; // 선택 목록엔 안 보이지만 데이터는 생성(합산/통합 entry용)
  // 멀티 ASN ISP: 박스 하나 안에서 ASN을 개별 선택. 각 unit은 별도 데이터 entry로 생성된다.
  // note: ASN의 망 역할(예: 가입자/백본) — 선택 박스에 작게 표기해 해석 오해 방지.
  asnUnits?: { id: string; asn: string; note?: string }[];
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
      // AS3786=상위(백본/IX단), AS17858=하위 BGP(가입자/eyeball). 가정용 실측은 17858이 대표적이며
      // 3786은 측정 경로상 ~94Mbps 부근에 고정되는 경향(통합값 해석 시 참고).
      { id: 'lgu', name: 'LG U+', asns: ['AS3786', 'AS17858'],
        asnUnits: [
          { id: 'lgu-3786', asn: 'AS3786', note: '백본/IX' },
          { id: 'lgu-17858', asn: 'AS17858', note: '가입자' },
        ] },
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

// 합산(통합) 매핑: member ASN unit이 "모두" 선택되면 차트에서 combo 하나(합산값)로 합쳐 표시.
export const COMBINE_GROUPS: Record<string, string[]> = {};
for (const g of ISP_GROUPS) for (const isp of g.isps) if (isp.asnUnits) COMBINE_GROUPS[isp.id] = isp.asnUnits.map((u) => u.id);
