(() => {
  const script = document.currentScript;
  const capabilities = new Set((script?.dataset.capabilities ?? '').split(/\s+/));
  const nonce = script?.dataset.nonce;
  let sequence = 0;
  const pending = new Map();

  function publicFetch(path, fresh = false) {
    if (!path.startsWith('/api/public/')) return Promise.reject(new Error('Invalid public path'));
    return fetch(path, { method: 'GET', credentials: 'omit', redirect: 'error', ...(fresh ? { cache: 'no-store' } : {}) }).then(async (response) => {
      if (!response.ok) throw new Error(`Public request failed (${response.status})`);
      return response.json();
    });
  }

  function query(params) {
    if (params == null) return '';
    if (typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid parameters');
    if (Object.keys(params).some((key) => key !== 'pageId')) throw new Error('Invalid parameters');
    if (params.pageId === undefined) return '';
    if (typeof params.pageId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(params.pageId)) throw new Error('Invalid page id');
    return `?pageId=${encodeURIComponent(params.pageId)}`;
  }

  function noParams(params) {
    if (params == null || (typeof params === 'object' && !Array.isArray(params) && Object.keys(params).length === 0)) return;
    throw new Error('Invalid parameters');
  }

  async function restRead(method, params) {
    if (method === 'status' && capabilities.has('public.status')) {
      noParams(params);
      return publicFetch('/api/public/status');
    }
    if (method === 'config' && capabilities.has('public.config')) {
      const suffix = query(params);
      return publicFetch(`/api/public/config${suffix}${suffix ? '&' : '?'}fresh=1`, true);
    }
    if (method === 'monitors' && capabilities.has('public.monitors')) return publicFetch(`/api/public/monitors${query(params)}`);
    if (method === 'servers' && capabilities.has('public.servers')) {
      noParams(params);
      return publicFetch('/api/public/servers');
    }
    if (method === 'server-detail' && capabilities.has('public.server-detail')) {
      if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some((key) => key !== 'id') || typeof params.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(params.id)) throw new Error('Invalid server id');
      return publicFetch(`/api/public/servers/${encodeURIComponent(params.id)}`);
    }
    if (method !== 'monitor-detail' && method !== 'agent-detail') throw new Error('Method is not declared by this theme');
    const capability = method === 'agent-detail' ? 'public.agent-detail' : 'public.monitor-detail';
    if (!capabilities.has(capability)) throw new Error('Method is not declared by this theme');
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some((key) => key !== 'id' && key !== 'minutes')) throw new Error('Invalid parameters');
    const minutes = params.minutes ?? 60;
    if (method === 'agent-detail' && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) throw new Error('Invalid minutes');
    const id = params.id;
    if (typeof id !== 'string' || !(/^[0-9]{1,12}$/.test(id) || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) throw new Error('Invalid monitor id');
    const status = await publicFetch('/api/public/status');
    if (!Array.isArray(status.monitors)) throw new Error('Public monitor list is unavailable');
    const monitor = status.monitors.find((row) => row.id === id || String(row.num_id) === id);
    if (!monitor || !Number.isSafeInteger(Number(monitor.num_id))) throw new Error('Monitor not found');
    if (method === 'agent-detail' && monitor.type !== 'agent') throw new Error('Agent not found');
    const publicId = encodeURIComponent(String(monitor.num_id));
    return method === 'agent-detail'
      ? publicFetch(`/api/public/agent/detail/${publicId}?minutes=${minutes}`)
      : publicFetch(`/api/public/monitors/${publicId}`);
  }

  function previewRead(method, params) {
    const requestId = String(++sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Preview request timed out'));
      }, 15000);
      pending.set(requestId, { resolve, reject, timer });
      parent.postMessage({ type: 'polaris-theme:request', nonce, requestId, method, params }, '*');
    });
  }

  if (nonce) {
    window.addEventListener('message', (event) => {
      if (event.source !== parent || event.data?.nonce !== nonce) return;
      if (event.data?.type === 'polaris-theme:ready-ack') {
        clearInterval(readyTimer);
        return;
      }
      if (event.data?.type !== 'polaris-theme:response') return;
      const task = pending.get(event.data.requestId);
      if (!task) return;
      clearTimeout(task.timer);
      pending.delete(event.data.requestId);
      event.data.ok ? task.resolve(event.data.data) : task.reject(new Error(event.data.error || 'Public request failed'));
    });
    parent.postMessage({ type: 'polaris-theme:ready', nonce }, '*');
    let readyAttempts = 0;
    const readyTimer = setInterval(() => {
      if (++readyAttempts >= 100) return clearInterval(readyTimer);
      parent.postMessage({ type: 'polaris-theme:ready', nonce }, '*');
    }, 100);
  }

  window.polarisTheme = Object.freeze({
    read(method, params) {
      if (nonce) {
        return previewRead(method, params);
      }
      return restRead(method, params);
    },
  });
})();
