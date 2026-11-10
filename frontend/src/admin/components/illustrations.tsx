import clsx from 'clsx';

/**
 * Small line illustrations for empty states.
 *
 * Drawn in the console's own tokens - hairline neutrals with one primary
 * accent - so they read as part of the interface rather than as clip art. Each
 * shows the thing the empty list will hold once it has rows: a pulse for
 * monitors, a rack for agents, a bell for channels.
 *
 * 空状态线条插图采用控制台自身的中性色细线和一处主色强调，使其融入界面而非像剪贴画；
 * 每幅图表示空列表未来容纳的内容：脉冲对应监控项，机架对应 Agent，铃铛对应渠道。
 */

const frame = 'fill-[var(--polaris-card)] stroke-default-200';
const bar = 'fill-default-200';
const soft = 'fill-default-100';

function Halo() {
  return <circle cx="60" cy="44" r="40" className="fill-primary/[0.06]" />;
}

function Art({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 120 88" width="132" height="97" aria-hidden="true" className={clsx('overflow-visible', className)}>
      {children}
    </svg>
  );
}

export function PulseArt({ className }: { className?: string }) {
  return (
    <Art className={className}>
      <Halo />
      <rect x="16" y="18" width="88" height="54" rx="10" className={frame} strokeWidth="1.5" />
      <circle cx="28" cy="30" r="3" className="fill-success" />
      <rect x="35" y="28" width="30" height="4" rx="2" className={bar} />
      <rect x="84" y="28" width="10" height="4" rx="2" className={soft} />
      <path
        d="M26 54h14l5-11 7 20 6-15 4 6h32"
        fill="none"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-primary"
      />
      <circle cx="94" cy="54" r="3.5" className="fill-primary stroke-[var(--polaris-card)]" strokeWidth="2" />
    </Art>
  );
}

export function RackArt({ className }: { className?: string }) {
  return (
    <Art className={className}>
      <Halo />
      {[20, 42].map((y, i) => (
        <g key={y}>
          <rect x="22" y={y} width="76" height="18" rx="6" className={frame} strokeWidth="1.5" />
          <circle cx="33" cy={y + 9} r="2.5" className={i === 0 ? 'fill-success' : 'fill-primary'} />
          <circle cx="41" cy={y + 9} r="2.5" className="fill-default-200" />
          <rect x="62" y={y + 7} width="28" height="4" rx="2" className={bar} />
        </g>
      ))}
      <path d="M60 60v8m-14 0h28" fill="none" strokeWidth="1.5" strokeLinecap="round" className="stroke-default-300" />
      <circle cx="46" cy="68" r="2.5" className="fill-default-300" />
      <circle cx="74" cy="68" r="2.5" className="fill-primary" />
    </Art>
  );
}

export function BellArt({ className }: { className?: string }) {
  return (
    <Art className={className}>
      <Halo />
      <path
        d="M60 20c-10 0-17 8-17 18v10l-6 9h46l-6-9V38c0-10-7-18-17-18Z"
        strokeWidth="1.5"
        strokeLinejoin="round"
        className={frame}
      />
      <path d="M54 62a6 6 0 0 0 12 0" fill="none" strokeWidth="1.5" className="stroke-default-300" />
      <path
        d="M30 30c-3 5-3 13 0 18M90 30c3 5 3 13 0 18"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-primary/60"
      />
      <circle cx="73" cy="25" r="5" className="fill-primary stroke-[var(--polaris-card)]" strokeWidth="2.5" />
    </Art>
  );
}

export function FoldersArt({ className }: { className?: string }) {
  return (
    <Art className={className}>
      <Halo />
      <rect x="30" y="16" width="64" height="40" rx="8" className="fill-default-100 stroke-default-200" strokeWidth="1.5" />
      <rect x="24" y="24" width="64" height="40" rx="8" className={frame} strokeWidth="1.5" />
      <path d="M24 34h64" strokeWidth="1.5" className="stroke-default-200" />
      <circle cx="33" cy="29" r="2" className="fill-primary" />
      {[42, 50].map((y, i) => (
        <g key={y}>
          <circle cx="33" cy={y + 2} r="2.5" className={i === 0 ? 'fill-success' : 'fill-warning'} />
          <rect x="40" y={y} width={i === 0 ? 34 : 26} height="4" rx="2" className={bar} />
        </g>
      ))}
    </Art>
  );
}

export function SwatchArt({ className }: { className?: string }) {
  return (
    <Art className={className}>
      <Halo />
      <rect x="18" y="16" width="84" height="56" rx="9" className={frame} strokeWidth="1.5" />
      <path d="M18 27h84" strokeWidth="1.5" className="stroke-default-200" />
      {[25, 31, 37].map((x) => (
        <circle key={x} cx={x} cy="21.5" r="1.8" className="fill-default-300" />
      ))}
      <rect x="26" y="34" width="30" height="30" rx="6" className="fill-primary/15" />
      <rect x="62" y="35" width="32" height="5" rx="2.5" className={bar} />
      <rect x="62" y="45" width="24" height="5" rx="2.5" className={soft} />
      <rect x="62" y="55" width="28" height="9" rx="4.5" className="fill-primary" />
    </Art>
  );
}

export function TimelineArt({ className }: { className?: string }) {
  return (
    <Art className={className}>
      <Halo />
      <path d="M38 18v52" strokeWidth="1.5" strokeLinecap="round" className="stroke-default-200" />
      {[
        [22, 'fill-success', 40],
        [42, 'fill-danger', 28],
        [62, 'fill-primary', 34],
      ].map(([y, fill, w]) => (
        <g key={y as number}>
          <circle cx="38" cy={y as number} r="4" className={clsx(fill as string, 'stroke-[var(--polaris-card)]')} strokeWidth="2" />
          <rect x="48" y={(y as number) - 5} width={w as number} height="4" rx="2" className={bar} />
          <rect x="48" y={(y as number) + 2} width={(w as number) - 12} height="3" rx="1.5" className={soft} />
        </g>
      ))}
    </Art>
  );
}

export function SearchArt({ className }: { className?: string }) {
  return (
    <Art className={className}>
      <Halo />
      {[24, 36, 48].map((y, i) => (
        <rect key={y} x="22" y={y} width={[56, 44, 50][i]} height="5" rx="2.5" className={i === 1 ? soft : bar} />
      ))}
      <circle cx="74" cy="48" r="14" strokeWidth="2.25" className="fill-[var(--polaris-card)] stroke-primary" />
      <path d="M84 58l10 10" strokeWidth="3" strokeLinecap="round" className="stroke-primary" />
    </Art>
  );
}
