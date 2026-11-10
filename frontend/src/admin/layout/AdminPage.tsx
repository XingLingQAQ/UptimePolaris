import { PROJECT_NAME } from '@/lib/project';
import { ChevronLeft } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router';

interface AdminPageProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  back?: { href: string; label: string };
  children: ReactNode;
}

export function AdminPage({ title, description, actions, back, children }: AdminPageProps) {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · ${PROJECT_NAME}`;
    return () => { document.title = previous; };
  }, [title]);

  return (
    <>
      <header
        className="px-4 pt-6 pb-5 sm:px-6 lg:px-8 lg:pt-7"
      >
        <div className="mx-auto flex w-full max-w-[1360px] flex-wrap items-end gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            {back ? (
              <Link
                to={back.href}
                className="mb-1.5 inline-flex items-center gap-1 text-[12.5px] text-[var(--polaris-ink-3)] transition-colors hover:text-[var(--polaris-ink)]"
              >
                <ChevronLeft size={14} />
                {back.label}
              </Link>
            ) : null}
            <h1 className="truncate text-[22px] leading-8 font-semibold tracking-[-0.02em] text-[var(--polaris-ink)]">{title}</h1>
            {description ? <p className="mt-0.5 text-[13px] text-[var(--polaris-ink-3)]">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </header>
      <div
        className="polaris-page-content flex min-h-0 flex-1 flex-col px-4 sm:px-6 lg:px-8"
      >
        <div className="mx-auto flex w-full max-w-[1360px] flex-1 flex-col">{children}</div>
      </div>
    </>
  );
}
