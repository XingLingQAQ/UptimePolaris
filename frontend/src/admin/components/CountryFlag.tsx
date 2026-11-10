import {
  FlagAe, FlagAr, FlagAt, FlagAu, FlagBe, FlagBg, FlagBr, FlagCa, FlagCh, FlagCl, FlagCn, FlagCz, FlagDe, FlagDk,
  FlagEe, FlagEs, FlagFi, FlagFr, FlagGb, FlagGr, FlagHk, FlagHu, FlagId, FlagIe, FlagIl, FlagIn, FlagIs, FlagIt,
  FlagJp, FlagKr, FlagKz, FlagLt, FlagLu, FlagLv, FlagMo, FlagMx, FlagMy, FlagNl, FlagNo, FlagNz, FlagPh, FlagPl,
  FlagPt, FlagRo, FlagRu, FlagSa, FlagSe, FlagSg, FlagTh, FlagTr, FlagTw, FlagUa, FlagUs, FlagVn, FlagZa,
} from '@sankyu/react-circle-flags';
import { Globe } from 'lucide-react';
import type { ComponentType } from 'react';

/** Import selected flags rather than the full dynamic registry; unknown regions use the globe icon. / 仅导入选定旗帜，不引入完整动态注册表；未知地区使用地球图标。 */
const FLAGS: Record<string, ComponentType<{ width?: number; height?: number; title?: string }>> = {
  ae: FlagAe, ar: FlagAr, at: FlagAt, au: FlagAu, be: FlagBe, bg: FlagBg, br: FlagBr, ca: FlagCa, ch: FlagCh,
  cl: FlagCl, cn: FlagCn, cz: FlagCz, de: FlagDe, dk: FlagDk, ee: FlagEe, es: FlagEs, fi: FlagFi, fr: FlagFr,
  gb: FlagGb, gr: FlagGr, hk: FlagHk, hu: FlagHu, id: FlagId, ie: FlagIe, il: FlagIl, in: FlagIn, is: FlagIs,
  it: FlagIt, jp: FlagJp, kr: FlagKr, kz: FlagKz, lt: FlagLt, lu: FlagLu, lv: FlagLv, mo: FlagMo, mx: FlagMx,
  my: FlagMy, nl: FlagNl, no: FlagNo, nz: FlagNz, ph: FlagPh, pl: FlagPl, pt: FlagPt, ro: FlagRo, ru: FlagRu,
  sa: FlagSa, se: FlagSe, sg: FlagSg, th: FlagTh, tr: FlagTr, tw: FlagTw, ua: FlagUa, us: FlagUs, vn: FlagVn,
  za: FlagZa, uk: FlagGb,
};

/**
 * The ISO country code an agent's region ends in.
 *
 * The agent assembles `region` from ipinfo as "City, CC" (or "Region, CC"),
 * so the last comma-separated part is the two-letter country when there is one.
 *
 * Agent 将 ipinfo 地区拼成“城市或地区, 国家代码”；最后一段如为两个字母即为国家代码。
 */
export function countryOf(region: string | null | undefined): string | null {
  if (!region) return null;
  const last = region.split(',').pop()?.trim() ?? '';
  return /^[A-Za-z]{2}$/.test(last) ? last.toUpperCase() : null;
}

/** The place part of a region, without its country code. / 地区中除国家代码外的地点部分。 */
export function placeOf(region: string | null | undefined): string | null {
  if (!region) return null;
  const parts = region.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1 && /^[A-Za-z]{2}$/.test(parts[parts.length - 1])) parts.pop();
  return parts.join(', ') || null;
}

export function CountryFlag({ code, size = 16 }: { code: string | null; size?: number }) {
  const Flag = code ? FLAGS[code.toLowerCase()] : undefined;
  if (!Flag) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-default-100 text-default-400"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <Globe size={Math.round(size * 0.7)} />
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 overflow-hidden rounded-full ring-1 ring-black/5" style={{ width: size, height: size }}>
      <Flag width={size} height={size} title={code ?? undefined} />
    </span>
  );
}
