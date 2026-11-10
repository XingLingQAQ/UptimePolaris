import { BellRing, Globe, Network, Server } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';

export function AuthProductPanel() {
  const t = useTranslations('admin');
  return (
    <aside className="relative m-3 mr-0 hidden w-[52%] max-w-[760px] shrink-0 flex-col overflow-hidden rounded-[22px] border border-[var(--polaris-line)] bg-[var(--polaris-well)] lg:flex">
      <div aria-hidden="true" className="polaris-dots pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
      <div className="relative flex flex-1 flex-col items-center justify-center px-12 py-12 text-center xl:px-16">
        <p className="max-w-lg text-[32px] leading-[1.15] font-semibold tracking-[-0.03em]">{t('login.tagline')}</p>
        <p className="mt-3 max-w-md text-[14px] leading-relaxed text-[var(--polaris-ink-3)]">{t('login.blurb')}</p>
        <ul className="mt-7 flex flex-wrap justify-center gap-2">
          {([
            ['checks', <Globe key="checks" size={14} />],
            ['hosts', <Server key="hosts" size={14} />],
            ['alerts', <BellRing key="alerts" size={14} />],
          ] as const).map(([key, icon]) => (
            <li key={key} className="flex items-center gap-2 rounded-full border border-[var(--polaris-line)] bg-[var(--polaris-card)] py-1.5 pr-3.5 pl-3 text-[12.5px] text-[var(--polaris-ink-2)] shadow-[0_1px_1px_rgb(0_0_0/0.03)]">
              <span className="text-[var(--polaris-ink-4)]">{icon}</span>
              {t(`login.point.${key}`)}
            </li>
          ))}
        </ul>
        <ProductPreview />
      </div>
    </aside>
  );
}

function ProductPreview() {
  const t = useTranslations('admin');
  const rows: Array<{ host: string; ms: string; uptime: string; dip: number[]; icon: ReactNode }> = [
    { host: 'www.example.com', ms: '142ms', uptime: '99.98%', dip: [], icon: <Globe size={14} /> },
    { host: 'api.example.com', ms: '86ms', uptime: '99.91%', dip: [23], icon: <Globe size={14} /> },
    { host: 'db.example.net:5432', ms: '9ms', uptime: '100%', dip: [], icon: <Network size={14} /> },
  ];
  return (
    <div aria-hidden="true" className="relative mt-10 w-full max-w-[34rem] text-left">
      <div className="relative z-10 mx-auto -mb-4 flex w-max items-center gap-2 rounded-full bg-[var(--polaris-island)] px-3.5 py-1.5 text-[11.5px] font-medium text-white shadow-[0_8px_20px_-8px_rgb(0_0_0/0.5)]">
        <span className="polaris-live h-1.5 w-1.5 rounded-full bg-[#34d399]" />
        {t('island.allClear')}
        <span className="h-3 w-px bg-white/15" />
        <span className="text-zinc-400">{t('login.previewTitle')}</span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-[var(--polaris-line)] bg-[var(--polaris-card)] shadow-[0_24px_48px_-24px_rgb(0_0_0/0.25)]">
        <div className="flex items-center gap-2 border-b border-[var(--polaris-line-soft)] px-4 pt-6 pb-2.5 text-[11px] text-[var(--polaris-ink-4)]">
          <span className="flex-1">{t('col.monitor')}</span>
          <span className="w-14 text-right">{t('col.reading')}</span>
          <span className="w-14 text-right">{t('col.uptime')}</span>
          <span className="w-[136px]">{t('col.recent')}</span>
        </div>
        {rows.map(row => (
          <div key={row.host} className="flex items-center gap-2 border-b border-[var(--polaris-line-soft)] px-4 py-3 last:border-0">
            <span className="flex min-w-0 flex-1 items-center gap-2.5">
              <span className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--polaris-line)] text-[var(--polaris-ink-3)]">
                {row.icon}
                <span className="absolute -right-[3px] -bottom-[3px] h-2 w-2 rounded-full bg-success ring-2 ring-[var(--polaris-card)]" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-medium">{row.host}</span>
                <span className="block text-[11px] text-[var(--polaris-ink-4)]">{t('status.up')}</span>
              </span>
            </span>
            <span className="polaris-num w-14 text-right text-[12px]">{row.ms}</span>
            <span className="polaris-num w-14 text-right text-[12px] font-medium">{row.uptime}</span>
            <span className="flex h-4 w-[136px] items-stretch gap-[2px]">
              {Array.from({ length: 30 }, (_, i) => (
                <span key={i} className={`flex-1 rounded-[1.5px] ${row.dip.includes(i) ? 'bg-danger' : 'bg-[var(--polaris-rail-up)]'}`} />
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
