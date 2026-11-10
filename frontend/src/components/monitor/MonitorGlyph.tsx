import clsx from 'clsx';

import { Activity, Cpu, Globe, Network, RadioTower, ShieldCheck, Webhook } from 'lucide-react';
import { useState } from 'react';
import type { Tone } from '../../types/tone';
import type { GlyphSize } from '../ui/GlyphTile';
import { GlyphTile, TILE } from '../ui/GlyphTile';

/**
 * Monitor mark: proxied favicon for public web targets, transport glyph
 * otherwise.
 *
 * Kept out of `admin/glyphs.tsx` so the public bundle does not pull in
 * `simple-icons` for notification logos. The favicon has no referrer and the
 * glyph sits underneath, so a missing or blocked icon still renders.
 * 拆出管理端图标，避免公开包引入 simple-icons；图标加载失败时保留内置图形。
 */

/** Public pages and the console share protocol icons. / 公开页与控制台共用协议图标。 */
export type GlyphType = import('../../../../shared/backend-capabilities').MonitorType;

const TYPE_GLYPH: Record<GlyphType, typeof Globe> = {
  http: Globe,
  tcp: Network,
  udp: RadioTower,
  icmp: Activity,
  dns: Globe,
  tls: ShieldCheck,
  websocket: RadioTower,
  push: Webhook,
  agent: Cpu,
};

/**
 * Hostname whose favicon may be requested, or null.
 *
 * Only public-looking names: the fetch goes through the Worker proxy, not the
 * visitor's browser, so a private target is not probed by every visitor and the
 * Worker caches one fetch per site per week. `site.syncMonitorIcons` gates it.
 * 只取公开主机名；经 Worker 代理抓取并按周缓存，避免每个访客探测内网。
 */
function faviconHost(type: GlyphType, target: string): string | null {
  if (type !== 'http' || !target) return null;
  let host: string;
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host.includes('.') || host.includes(':')) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|corp|intranet|localdomain|test|invalid)$/.test(host)) return null;
  return host;
}

export function MonitorGlyph({
  type,
  target,
  monitorId,
  size = 'md',
  badge,
}: {
  type: GlyphType;
  target: string;
  monitorId?: number;
  size?: GlyphSize;
  badge?: Tone | 'maintenance';
}) {
  const host = faviconHost(type, target);
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading');
  const Glyph = TYPE_GLYPH[type];
  const px = TILE[size].px;

  return (
    <GlyphTile size={size} badge={badge}>
      <Glyph
        size={Math.round(px * 0.9)}
        className={clsx('transition-opacity', host && state === 'ok' ? 'opacity-0' : 'opacity-100')}
      />
      {host && monitorId && state !== 'failed' ? (
        <img
          src={`/api/public/monitor-icon?id=${monitorId}${['monitor', 'agent'].includes(new URLSearchParams(window.location.search).get('preview') ?? '') ? `&preview=${encodeURIComponent(new URLSearchParams(window.location.search).get('preview')!)}` : ''}`}
          alt=""
          width={px}
          height={px}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={(event) => {
            // A 1x1 tracking pixel or an empty response is not an icon. / 1×1 跟踪像素或空响应不是有效图标。
            setState(event.currentTarget.naturalWidth >= 8 ? 'ok' : 'failed');
          }}
          onError={() => setState('failed')}
          className={clsx(
            'absolute rounded-[3px] transition-opacity duration-300',
            state === 'ok' ? 'opacity-100' : 'opacity-0',
          )}
          style={{ width: px, height: px }}
        />
      ) : null}
    </GlyphTile>
  );
}
