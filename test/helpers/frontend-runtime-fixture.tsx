// 以真实 React 组件暴露语言、轮询和动效交互夹具。
// Expose locale, polling, and motion fixtures using real React components.

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { useSWRConfig } from 'swr';
import { IntlProvider, useLocale } from '../../frontend/src/i18n/IntlProvider';
import { useAgentCommands } from '../../frontend/src/admin/agents/useAgentCommands';
import { usePublicConfigResource } from '../../frontend/src/config/usePublicConfig';
import { BrandLoader } from '../../frontend/src/components/ui/BrandLoader';
import { useMotionList } from '../../frontend/src/lib/useMotionList';
import { setMotionPreference } from '../../frontend/src/lib/motion-preference';
import { PageConfigProvider } from '../../frontend/src/components/context/PageConfigContext';
import { MonitorDetailContent } from '../../frontend/src/components/monitor/MonitorDetailContent';
import { SWR_KEYS } from '../../frontend/src/components/status-page/useStatusPageData';
import fr from '../../frontend/src/locales/fr-FR.json';
import zh from '../../frontend/src/locales/zh-CN.json';

declare global {
  interface Window {
    fixture: {
      catalogs: Record<string, () => Promise<{ default: typeof fr }>>;
      release: (locale: string) => void;
      commandResponse: { status: number; commands?: Array<{ state: string }> };
      nextCommandResponse: { status: number; commands?: Array<{ state: string }> } | null;
      configStatus: number;
      monitorStatus: number;
      updates: number;
      start: () => void;
    };
  }
}

const waiting = new Map<string, Array<() => void>>();
window.fixture = {
  catalogs: Object.fromEntries(Object.entries({ 'fr-FR': fr, 'zh-CN': zh }).map(([locale, messages]) => [
    `../locales/${locale}.json`, () => new Promise((resolve) => {
      const callbacks = waiting.get(locale) ?? [];
      callbacks.push(() => resolve({ default: messages }));
      waiting.set(locale, callbacks);
    }),
  ])),
  release(locale) { for (const callback of waiting.get(locale) ?? []) callback(); waiting.delete(locale); },
  commandResponse: { status: 200, commands: [{ state: 'pending' }] }, nextCommandResponse: null, configStatus: 200, monitorStatus: 200, updates: 0,
  start: () => {},
};

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.pathname.endsWith('/commands')) {
    const response = window.fixture.nextCommandResponse ?? window.fixture.commandResponse;
    window.fixture.nextCommandResponse = null;
    return Response.json(response.status === 200 ? { enabled: true, commands: response.commands } : { error: 'request_failed' }, { status: response.status });
  }
  if (url.pathname === '/fixture-config' || url.pathname === '/api/public/config') {
    return Response.json(window.fixture.configStatus === 200 ? { title: 'cached configuration' } : { error: 'request_failed' }, { status: window.fixture.configStatus });
  }
  if (url.pathname === '/api/public/monitors') {
    return Response.json(window.fixture.monitorStatus === 200 ? {
      monitorGroups: [{ monitorList: [{ id: 2, name: 'Detail fixture', type: 'http', url: 'https://example.test' }] }],
      data: { heartbeatList: {}, uptimeList: {} },
    } : { error: 'request_failed' }, { status: window.fixture.monitorStatus });
  }
  if (url.pathname === '/api/public/monitors/2') return Response.json({ days: [] });
  if (url.pathname.startsWith('/api/recent/')) {
    return Response.json({ days: [] });
  }
  return originalFetch(input, init);
};

function LocaleFixture() {
  const { locale, setLocale, applyDefaultLocale } = useLocale();
  return <section>
    <output id="locale">{locale}</output>
    <button id="default-fr" onClick={() => void applyDefaultLocale('fr-FR')}>Default French</button>
    <button id="choose-zh" onClick={() => void setLocale('zh-CN')}>Choose Chinese</button>
  </section>;
}

function CommandsFixture() {
  const [agentId, setAgentId] = useState('a');
  const [mode, setMode] = useState<'version' | 'dialog'>('version');
  const { history, error, refresh } = useAgentCommands({
    agentId, enabled: true, mode, onCommandsLoaded: () => {}, onUpdated: () => { window.fixture.updates++; },
  });
  return <section>
    <output id="command-state">{error ? 'error' : history?.commands[0]?.state ?? 'loading'}</output>
    <button id="command-refresh" onClick={refresh}>Refresh</button>
    <button id="command-agent" onClick={() => setAgentId('b')}>Change agent</button>
    <button id="command-mode" onClick={() => setMode('dialog')}>Change mode</button>
  </section>;
}

function ConfigFixture() {
  const resource = usePublicConfigResource('/fixture-config');
  return <section>
    <output id="config-state">{resource.data ? 'present' : 'absent'}:{resource.error instanceof Error ? 'error' : 'ok'}</output>
    <button id="config-refresh" onClick={() => void resource.refresh().catch(() => {})}>Refresh config</button>
  </section>;
}

function MotionFixture() {
  const [items, setItems] = useState<number[]>([]);
  const listRef = useMotionList<HTMLDivElement>();
  return <section>
    <BrandLoader />
    <button id="motion-reduced" onClick={() => setMotionPreference('reduced')}>Reduced</button>
    <button id="motion-full" onClick={() => setMotionPreference('full')}>Full</button>
    <button id="motion-add" onClick={() => setItems(current => [...current, current.length])}>Add</button>
    <div id="motion-list" ref={listRef} style={{ position: 'absolute', top: 0, left: 0 }}>
      {items.map(item => <div key={item}>{item}</div>)}
    </div>
  </section>;
}

function DetailFixture() {
  const { mutate } = useSWRConfig();
  return <>
    <button id="monitor-refresh" onClick={() => void mutate(SWR_KEYS.MONITOR('default')).catch(() => {})}>Refresh monitor</button>
    <PageConfigProvider initialConfig={{ pageId: 'default', defaultPageId: 'default', pageIds: ['default'], pages: [], siteMeta: { title: 'Fixture' } } as never} configKey="/fixture-config">
      <MonitorDetailContent monitorId="2" />
    </PageConfigProvider>
  </>;
}

window.fixture.start = () => createRoot(document.getElementById('root')!).render(
  <MemoryRouter><IntlProvider>
    <LocaleFixture /><CommandsFixture /><ConfigFixture /><MotionFixture /><DetailFixture />
  </IntlProvider></MemoryRouter>,
);
