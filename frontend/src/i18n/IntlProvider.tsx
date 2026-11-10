import { defaultLocale, type Locale } from '@/i18n/config';
import { resolveLocaleFromCandidates } from '@/i18n/resolve-locale';
import { RouteLoading } from '@/routes/RouteStates';
import { readLocalPreference, writeLocalPreference } from '@/lib/browser-preferences';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { IntlProvider as UseIntlProvider } from 'use-intl';
import enUS from '../locales/en-US.json';
import { mergeMessages, type MessageTree } from './merge-messages';

const STORAGE_KEY = 'uptime-polaris-locale';
const publicCatalogs = import.meta.glob<{ default: MessageTree }>(['../locales/*.json', '!../locales/en-US.json']);
const adminCatalogs = import.meta.glob<{ default: MessageTree }>('../locales/admin/*.json');
const loadedPublic = new Map<Locale, MessageTree>([[defaultLocale, enUS]]);

interface LocaleContextValue {
  locale: Locale;
  setLocale: (next: Locale) => Promise<void>;
  applyDefaultLocale: (next: string, signal?: AbortSignal) => Promise<void>;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function detectInitialLocale(): Locale {
  const stored = readLocalPreference(STORAGE_KEY);
  return stored ? resolveLocaleFromCandidates([stored]) : detectBrowserLocale();
}

function detectBrowserLocale(): Locale {
  return resolveLocaleFromCandidates(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

async function loadMessages(locale: Locale, admin: boolean): Promise<MessageTree> {
  const [publicMessages, adminMessages, adminFallback] = await Promise.all([
    loadedPublic.get(locale) ?? publicCatalogs[`../locales/${locale}.json`]().then((module) => module.default),
    admin ? adminCatalogs[`../locales/admin/${locale}.json`]().then((module) => module.default) : null,
    admin ? adminCatalogs[`../locales/admin/${defaultLocale}.json`]().then((module) => module.default) : null,
  ]);
  const messages = mergeMessages(enUS, publicMessages);
  loadedPublic.set(locale, messages);
  return adminMessages && adminFallback ? { ...messages, admin: mergeMessages(adminFallback, adminMessages) } : messages;
}

export function getRootErrorCopy(): { title: string; description: string; reload: string } {
  let locale = defaultLocale;
  try { locale = detectInitialLocale(); } catch {}
  const messages = loadedPublic.get(locale) ?? enUS;
  return {
    title: (messages.errorPage as MessageTree).title as string,
    description: (messages.errorPage as MessageTree).recoveryHint as string,
    reload: (messages.errorPage as MessageTree).reload as string,
  };
}

export function IntlProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectInitialLocale);
  const { pathname } = useLocation();
  const admin = pathname === '/login' || pathname === '/setup' || pathname === '/admin' || pathname.startsWith('/admin/');
  const [catalog, setCatalog] = useState({ locale: defaultLocale, admin: false, messages: enUS as MessageTree });
  const [error, setError] = useState<unknown>(null);
  const requestId = useRef(0);
  const userIntent = useRef(false);
  const currentLocale = useRef(locale);
  const currentAdmin = useRef(admin);
  currentAdmin.current = admin;

  useEffect(() => {
    let cancelled = false;
    void loadMessages(locale, admin).then((messages) => {
      if (!cancelled && currentLocale.current === locale && currentAdmin.current === admin) {
        setError(null);
        setCatalog({ locale, admin, messages });
      }
    }).catch((error: unknown) => {
      if (!cancelled && currentLocale.current === locale && currentAdmin.current === admin) setError(error);
    });
    return () => { cancelled = true; };
  }, [locale, admin]);

  const changeLocale = useCallback(async (next: Locale, isDefault: boolean, signal?: AbortSignal) => {
    if (signal?.aborted || (isDefault && (currentAdmin.current || userIntent.current || readLocalPreference(STORAGE_KEY)))) return;
    if (!isDefault) userIntent.current = true;
    const request = ++requestId.current;
    while (request === requestId.current) {
      const admin = currentAdmin.current;
      let messages: MessageTree;
      try {
        messages = await loadMessages(next, admin);
      } catch (error) {
        if (request !== requestId.current || signal?.aborted) return;
        throw error;
      }
      if (request !== requestId.current || signal?.aborted) return;
      if (isDefault && (currentAdmin.current || userIntent.current || readLocalPreference(STORAGE_KEY))) return;
      if (admin !== currentAdmin.current) continue;
      currentLocale.current = next;
      setError(null);
      setCatalog({ locale: next, admin, messages });
      setLocaleState(next);
      if (!isDefault) {
        writeLocalPreference(STORAGE_KEY, next);
      }
      return;
    }
  }, []);

  const setLocale = useCallback((next: Locale) => changeLocale(next, false), [changeLocale]);
  const applyDefaultLocale = useCallback(
    (next: string, signal?: AbortSignal) => changeLocale(next === 'auto' ? detectBrowserLocale() : resolveLocaleFromCandidates([next]), true, signal),
    [changeLocale],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale, applyDefaultLocale }), [locale, setLocale, applyDefaultLocale]);
  if (error) throw error;

  return (
    <LocaleContext.Provider value={value}>
      <UseIntlProvider locale={locale} messages={catalog.messages as never} timeZone="UTC" now={new Date()}>
        {catalog.locale === locale && catalog.admin === admin ? children : <RouteLoading />}
      </UseIntlProvider>
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used within IntlProvider');
  return ctx;
}
