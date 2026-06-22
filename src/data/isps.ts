// 타깃 ISP / ASN 단일 소스 (PRD §3). 프론트엔드와 모크 생성기가 함께 사용.
// 한국 ISP는 상단 고정, 해외 ISP는 국가별 그룹.

export interface Isp {
  id: string;
  name: string;
  asns: string[];
  mergeable?: boolean;
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
      { id: 'lgu', name: 'LG U+', asns: ['AS3786', 'AS17858'], mergeable: true },
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

export const ALL_ISPS: FlatIsp[] = ISP_GROUPS.flatMap((g) =>
  g.isps.map((isp) => ({
    ...isp,
    groupId: g.id,
    groupLabel: g.label,
    pinned: !!g.pinned,
  }))
);

export const ISP_BY_ID: Record<string, FlatIsp> = Object.fromEntries(
  ALL_ISPS.map((i) => [i.id, i])
);
