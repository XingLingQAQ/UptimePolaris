import { WORLD } from './world-dots';

/**
 * Approximate geographic centres by ISO 3166-1 alpha-2 code, [latitude, longitude]. The map marks a country, never a
 * city, so a centre is precise enough; codes missing here are listed beside the map instead of being guessed.
 *
 * 按 ISO 3166-1 两位代码记录的国家/地区近似地理中心 [纬度, 经度]。地图只标注国家/地区而非城市，因此近似中心已足够；
 * 表中没有的代码会列在地图旁，不做猜测。
 */
export const COUNTRY_CENTRES: Record<string, readonly [number, number]> = {
  US: [39.8, -98.6], CA: [56.1, -106.3], MX: [23.6, -102.5], GT: [15.8, -90.2], CR: [9.7, -83.8], PA: [8.5, -80.8], CU: [21.5, -77.8], DO: [18.7, -70.2], PR: [18.2, -66.6],
  BR: [-14.2, -51.9], AR: [-38.4, -63.6], CL: [-35.7, -71.5], CO: [4.6, -74.3], PE: [-9.2, -75.0], VE: [6.4, -66.6], EC: [-1.8, -78.2], UY: [-32.5, -55.8], PY: [-23.4, -58.4], BO: [-16.3, -63.6],
  GB: [54.0, -2.0], UK: [54.0, -2.0], IE: [53.4, -8.2], FR: [46.2, 2.2], DE: [51.2, 10.4], NL: [52.1, 5.3], BE: [50.5, 4.5], LU: [49.8, 6.1], CH: [46.8, 8.2], AT: [47.5, 14.6],
  IT: [42.8, 12.6], ES: [40.5, -3.7], PT: [39.4, -8.2], DK: [56.3, 9.5], NO: [60.5, 8.5], SE: [60.1, 18.6], FI: [61.9, 25.7], IS: [64.9, -19.0], EE: [58.6, 25.0], LV: [56.9, 24.6],
  LT: [55.2, 23.9], PL: [51.9, 19.1], CZ: [49.8, 15.5], SK: [48.7, 19.7], HU: [47.2, 19.5], RO: [45.9, 25.0], BG: [42.7, 25.5], GR: [39.1, 21.8], RS: [44.0, 21.0], HR: [45.1, 15.2],
  SI: [46.2, 15.0], BA: [43.9, 17.7], AL: [41.2, 20.2], MK: [41.6, 21.7], MD: [47.4, 28.4], UA: [48.4, 31.2], BY: [53.7, 28.0], RU: [61.5, 105.3], MT: [35.9, 14.4], CY: [35.1, 33.4],
  TR: [39.0, 35.2], IL: [31.0, 34.9], JO: [30.6, 36.2], LB: [33.9, 35.9], SA: [23.9, 45.1], AE: [23.4, 53.8], QA: [25.4, 51.2], BH: [26.0, 50.6], KW: [29.3, 47.5], OM: [21.5, 55.9],
  IR: [32.4, 53.7], IQ: [33.2, 43.7], GE: [42.3, 43.4], AM: [40.1, 45.0], AZ: [40.1, 47.6], KZ: [48.0, 66.9], UZ: [41.4, 64.6], KG: [41.2, 74.8], MN: [46.9, 103.8],
  EG: [26.8, 30.8], MA: [31.8, -7.1], DZ: [28.0, 1.7], TN: [33.9, 9.5], NG: [9.1, 8.7], GH: [7.9, -1.0], KE: [0.0, 37.9], ET: [9.1, 40.5], TZ: [-6.4, 34.9], ZA: [-30.6, 22.9], SN: [14.5, -14.5], CI: [7.5, -5.5],
  IN: [20.6, 79.0], PK: [30.4, 69.3], BD: [23.7, 90.4], LK: [7.9, 80.8], NP: [28.4, 84.1], CN: [35.9, 104.2], HK: [22.3, 114.2], MO: [22.2, 113.5], TW: [23.7, 121.0],
  JP: [36.2, 138.3], KR: [35.9, 127.8], SG: [1.35, 103.8], MY: [4.2, 102.0], TH: [15.9, 101.0], VN: [14.1, 108.3], PH: [12.9, 121.8], ID: [-0.8, 113.9], KH: [12.6, 105.0],
  MM: [21.9, 96.0], LA: [19.9, 102.5], AU: [-25.3, 133.8], NZ: [-40.9, 174.9],
};

/** Map coordinates in a box `WORLD.cols × WORLD.rows` wide, equirectangular like the dot grid. / 与点阵一致的等距圆柱投影坐标。 */
export function project([lat, lon]: readonly [number, number]) {
  return { x: (lon - WORLD.lon0) / WORLD.step, y: (WORLD.lat0 - lat) / WORLD.step };
}

let landPath: string | null = null;
/** The land grid as one SVG path of zero-length round-capped segments: a dot per land cell. / 陆地点阵：每个陆地格一个零长度圆头线段，合成一条路径。 */
export function landDots() {
  if (landPath) return landPath;
  const bytes = Uint8Array.from(atob(WORLD.land), character => character.charCodeAt(0));
  const parts: string[] = [];
  for (let index = 0; index < WORLD.cols * WORLD.rows; index++) {
    if (bytes[index >> 3] >> (index & 7) & 1) parts.push(`M${index % WORLD.cols + 0.5} ${Math.floor(index / WORLD.cols) + 0.5}h0`);
  }
  return landPath = parts.join('');
}

/** The ISO code a published region ends in: "Frankfurt, DE" and "DE" both give "DE". / 公开地区末尾的国家代码，“Frankfurt, DE”和“DE”都返回“DE”。 */
export function countryCode(region: string | null | undefined): string | null {
  const last = region?.split(',').pop()?.trim() ?? '';
  return /^[A-Za-z]{2}$/.test(last) ? last.toUpperCase() : null;
}

const names = new Map<string, Intl.DisplayNames | null>();
/** A country code in the reader's language, falling back to the code itself. / 以读者语言显示国家/地区名称，无法识别时显示代码。 */
export function countryName(code: string, locale: string) {
  if (!names.has(locale)) {
    try { names.set(locale, new Intl.DisplayNames([locale], { type: 'region' })); } catch { names.set(locale, null); }
  }
  try { return names.get(locale)?.of(code === 'UK' ? 'GB' : code) ?? code; } catch { return code; }
}

/** The place a machine reports, as words: the city when published, then the country. / 机器所在地的文字描述：有城市时先显示城市，再显示国家/地区。 */
export function regionLabel(region: string | null | undefined, locale: string) {
  if (!region) return null;
  const code = countryCode(region);
  if (!code) return region;
  const parts = region.split(',').map(part => part.trim()).filter(Boolean);
  const place = parts.length > 1 ? parts.slice(0, -1).join(', ') : null;
  return place ? `${place}, ${countryName(code, locale)}` : countryName(code, locale);
}
