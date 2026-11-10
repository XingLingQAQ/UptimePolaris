import clsx from 'clsx';
import { useState } from 'react';

export function AccountAvatar({ username, src, size = 'md', className }: {
  username: string;
  src?: string | null;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return (
    <span aria-hidden="true" className={clsx(
      'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--polaris-ink)] font-semibold text-[var(--polaris-canvas)]',
      size === 'sm' ? 'h-7 w-7 text-[12px]' : 'h-10 w-10 text-medium',
      className,
    )}>
      {src && src !== failedSource ? (
        <img src={src} alt="" className="h-full w-full object-cover" onError={() => setFailedSource(src)} />
      ) : username.slice(0, 1).toUpperCase()}
    </span>
  );
}
