import { type Locale, defaultLocale, locales } from './config';

const validLocales = new Map(locales.map(({ key }) => [key.toLowerCase(), key]));

export function resolveLocaleFromCandidates(candidates: readonly string[]): Locale {
  for (const candidate of candidates) {
    try {
      const locale = new Intl.Locale(candidate.trim());
      const exact = validLocales.get(locale.baseName.toLowerCase());
      if (exact) return exact;
      if (locale.language === 'zh') {
        if (locale.script === 'Hans') return 'zh-CN';
        if (locale.script === 'Hant') return locale.region === 'HK' || locale.region === 'MO' ? 'zh-HK' : 'zh-TW';
        if (locale.region === 'HK' || locale.region === 'MO') return 'zh-HK';
        if (locale.region === 'TW') return 'zh-TW';
        return 'zh-CN';
      }
      const matchingLocale = locales.find(({ key }) => key.toLowerCase().split('-')[0] === locale.language);
      if (matchingLocale) return matchingLocale.key;
    } catch {
      continue;
    }
  }
  return defaultLocale;
}
