import { requestJson } from '@/api/client';
import { Button } from '@heroui/react';
import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { ThemePreview } from './types';

const capabilitiesByMethod: Record<string, string> = {
  status: 'public.status',
  config: 'public.config',
  monitors: 'public.monitors',
  'monitor-detail': 'public.monitor-detail',
  'agent-detail': 'public.agent-detail',
  servers: 'public.servers',
  'server-detail': 'public.server-detail',
};

export function ThemePreviewFrame({ preview, onClose }: { preview: ThemePreview; onClose: () => void }) {
  const t = useTranslations('admin.themes');
  const frame = useRef<HTMLIFrameElement>(null);
  const nonce = useMemo(() => crypto.randomUUID(), [preview.versionKey, preview.definition.id]);
  const [state, setState] = useState<{ html: string | null; error: string | null }>({ html: null, error: null });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadEntry() {
      try {
        if (!/^themes\/[a-z0-9-]+\/[0-9A-Za-z.+-]+\/[a-f0-9]{64}\/[0-9a-f-]{36}$/.test(preview.prefix)) throw new Error(t('previewInvalid'));
        if (!preview.definition.entry || preview.definition.entry.startsWith('/') || preview.definition.entry.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error(t('previewInvalid'));
        const encodedEntry = preview.definition.entry.split('/').map(encodeURIComponent).join('/');
        const assetPath = `/theme/${preview.prefix}/${encodedEntry}`;
        const assetUrl = new URL(assetPath, window.location.origin);
        if (assetUrl.origin !== window.location.origin || !assetUrl.pathname.startsWith('/theme/')) throw new Error(t('previewInvalid'));
        const response = await fetch(assetUrl, { credentials: 'omit', redirect: 'error' });
        if (!response.ok) throw new Error(`${t('previewLoadFailed')} (${response.status})`);
        let html = await response.text();
        if (cancelled) return;
        const entryDirectory = preview.definition.entry.includes('/') ? preview.definition.entry.slice(0, preview.definition.entry.lastIndexOf('/') + 1) : '';
        const baseHref = `/theme/${preview.prefix}/${entryDirectory.split('/').map(encodeURIComponent).join('/')}`;
        const capabilities = preview.definition.capabilities.join(' ');
        const sdk = `<script src="/polaris-theme-sdk.js" data-nonce="${nonce}" data-capabilities="${capabilities}"><\/script>`;
        const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${window.location.origin}; style-src 'unsafe-inline' ${window.location.origin}; img-src data: ${window.location.origin}; font-src data: ${window.location.origin}; connect-src 'none'; media-src ${window.location.origin}; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri ${window.location.origin}">`;
        // 预览使用受控资源根目录和 CSP，不采用主题自带的 base。 / Use a controlled asset root and CSP for previews, not the theme’s base.
        html = html.replace(/<base\b[^>]*>/gi, '');
        const head = html.match(/<head\b[^>]*>/i);
        const injection = `<base href="${baseHref}">${csp}${sdk}${preview.headCode}`;
        if (head?.index !== undefined) html = html.slice(0, head.index + head[0].length) + injection + html.slice(head.index + head[0].length);
        else {
          const prefix = html.match(/^(?:\s*<!doctype[^>]*>)?\s*(?:<html\b[^>]*>)?/i)?.[0] ?? '';
          html = prefix + `<head>${injection}</head>` + html.slice(prefix.length);
        }
        setState({ html, error: null });
      } catch (error) {
        if (!cancelled) setState({ html: null, error: error instanceof Error ? error.message : String(error) });
      }
    }
    void loadEntry();
    return () => { cancelled = true; };
  }, [nonce, preview, t]);

  useEffect(() => {
    const pending = new Map<string, AbortController>();
    const send = (requestId: string, ok: boolean, data?: unknown, error?: string) => frame.current?.contentWindow?.postMessage({ type: 'polaris-theme:response', nonce, requestId, ok, data, error }, '*');

    async function publicRead(method: string, params: unknown, signal: AbortSignal) {
      if (!Object.hasOwn(capabilitiesByMethod, method) || !preview.definition.capabilities.includes(capabilitiesByMethod[method])) throw new Error('Method is not declared by this theme');
      if (params != null && (typeof params !== 'object' || Array.isArray(params))) throw new Error('Invalid parameters');
      const values = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
      const allowedParams = method === 'config' || method === 'monitors' ? ['pageId'] : method === 'monitor-detail' || method === 'agent-detail' ? ['id', 'minutes'] : method === 'server-detail' ? ['id'] : [];
      if (Object.keys(values).some((key) => !allowedParams.includes(key))) throw new Error('Invalid parameters');
      const pageId = values.pageId;
      if (pageId !== undefined && (typeof pageId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(pageId))) throw new Error('Invalid page id');
      const query = pageId ? `?pageId=${encodeURIComponent(pageId)}` : '';
      if (method === 'status') return publicFetch('/api/public/status', signal);
      if (method === 'config') {
        const config = await publicFetch(`/api/public/config${query}`, signal) as Record<string, unknown>;
        return { ...config, theme: { short: preview.manifest.short, name: preview.manifest.name, version: preview.manifest.version }, theme_settings: preview.values, theme_content_html: preview.contentHtml };
      }
      if (method === 'monitors') return publicFetch(`/api/public/monitors${query}`, signal);
      if (method === 'servers') return publicFetch('/api/public/servers', signal);
      if (method === 'server-detail') {
        if (typeof values.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(values.id)) throw new Error('Invalid server id');
        return publicFetch(`/api/public/servers/${encodeURIComponent(values.id)}`, signal);
      }
      if (method === 'monitor-detail' || method === 'agent-detail') {
        if (typeof values.id !== 'string' || !(/^[0-9]{1,12}$/.test(values.id) || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(values.id))) throw new Error('Invalid monitor id');
        const status = await publicFetch('/api/public/status', signal) as { monitors?: Array<Record<string, unknown>> };
        if (!Array.isArray(status.monitors)) throw new Error('Public monitor list is unavailable');
        const monitor = status.monitors.find((row) => row.id === values.id || String(row.num_id) === values.id);
        if (!monitor || !Number.isSafeInteger(Number(monitor.num_id))) throw new Error('Monitor not found');
        if (method === 'agent-detail' && monitor.type !== 'agent') throw new Error('Agent not found');
        if (method === 'agent-detail') {
          const minutes = values.minutes ?? 60;
          if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('Invalid minutes');
          return publicFetch(`/api/public/agent/detail/${encodeURIComponent(String(monitor.num_id))}?minutes=${minutes}`, signal);
        }
        return publicFetch(`/api/public/monitors/${encodeURIComponent(String(monitor.num_id))}`, signal);
      }
      throw new Error('Method is not available');
    }

    async function publicFetch(path: string, signal: AbortSignal) {
      const url = new URL(path, window.location.origin);
      url.searchParams.set('preview', preview.definition.target);
      return requestJson<unknown>(url.pathname + url.search, { method: 'GET', redirect: 'error', signal });
    }

    function handle(event: MessageEvent) {
      // sandbox 使用不透明来源，因此同时校验窗口引用与本次预览的 nonce。 / The sandbox has an opaque origin, so check both the window reference and preview nonce.
      if (event.source !== frame.current?.contentWindow || event.data?.nonce !== nonce) return;
      if (event.data.type === 'polaris-theme:ready') {
        frame.current?.contentWindow?.postMessage({ type: 'polaris-theme:ready-ack', nonce }, '*');
        setReady(true);
        return;
      }
      const message = event.data;
      if (message.type !== 'polaris-theme:request' || typeof message.requestId !== 'string' || !/^\d{1,12}$/.test(message.requestId) || pending.has(message.requestId)) return;
      const controller = new AbortController();
      pending.set(message.requestId, controller);
      const timeout = window.setTimeout(() => controller.abort(), 12000);
      void publicRead(message.method, message.params, controller.signal)
        .then((data) => send(message.requestId, true, data), (error: unknown) => send(message.requestId, false, undefined, error instanceof Error ? error.message : String(error)))
        .finally(() => { window.clearTimeout(timeout); pending.delete(message.requestId); });
    }

    window.addEventListener('message', handle);
    return () => { window.removeEventListener('message', handle); pending.forEach((controller) => controller.abort()); pending.clear(); };
  }, [nonce, preview]);

  return <div className="fixed inset-0 z-[100] flex flex-col bg-background">
    <div className="flex items-center justify-between gap-3 border-b border-divider px-4 py-3"><div className="min-w-0"><p className="truncate text-small font-medium">{t('previewTitle', { name: preview.manifest.name })}</p><p className="text-tiny text-default-500">{preview.manifest.version} · {ready ? t('previewConnected') : t('previewLoading')}</p></div><Button size="sm" variant="light" isIconOnly aria-label={t('previewClose')} onPress={onClose}><X size={17} /></Button></div>
    {state.error ? <p className="m-4 rounded-medium border border-danger/40 bg-danger/5 p-3 text-small text-danger">{state.error}</p> : null}
    {state.html ? <iframe ref={frame} title={t('previewTitle', { name: preview.manifest.name })} sandbox="allow-scripts" srcDoc={state.html} className="min-h-0 flex-1 border-0 bg-white" /> : !state.error ? <div className="p-5 text-small text-default-500">{t('previewLoading')}</div> : null}
  </div>;
}
