
import { APP_VERSION as packageJsonVersion } from '@/lib/version';
import { PROJECT_NAME, PROJECT_REPOSITORY_URL } from '@/lib/project';
import type { SiteConfig } from '@/types/config';
import { useTranslations } from 'use-intl';

interface FooterProps {
  config?: Pick<SiteConfig, 'footerText'>;
}

/** The site's own footer text, and the credit line for the software behind the page. / 站点页脚文字及页面所用软件的署名。 */
export function Footer({ config }: FooterProps) {
  const t = useTranslations();
  const footerText = config?.footerText ?? '';

  const credit = 'text-[var(--polaris-ink-3)] underline-offset-2 transition-colors hover:text-[var(--polaris-ink)] hover:underline';

  return (
    <footer className="relative z-10 mt-16 border-t border-[var(--polaris-line)]">
      <div className="mx-auto flex w-full max-w-[var(--polaris-page-width,1120px)] flex-col gap-2 px-4 py-6 sm:flex-row sm:items-center sm:px-6">
        {footerText ? <div className="text-[13px] text-[var(--polaris-ink-3)]">{footerText}</div> : null}
        <div className="flex items-center gap-1 text-[12px] text-[var(--polaris-ink-4)] sm:ml-auto">
          {t.rich('statusPage.poweredBy', {
            project: (chunks) => <a href={PROJECT_REPOSITORY_URL} target="_blank" rel="noreferrer" className={credit}>{chunks}</a>,
            projectName: `${PROJECT_NAME} v${packageJsonVersion}`,
          })}
        </div>
      </div>
    </footer>
  );
}
