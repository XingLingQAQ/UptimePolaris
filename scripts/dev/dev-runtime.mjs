import { createServer as createHttpServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { createConnection, createServer as createTcpServer } from 'node:net';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseAgentRuntimeConfig } from '../../shared/agent-runtime-config.ts';
import { networkProbe, networkProbeCapabilities } from './probe-network.mjs';
import { DEMO_AGENT_TOKEN, DEMO_PUSH_TOKEN, DEMO_RUNTIME_DEFAULTS, demoPorts, demoSkipReason } from './live-demo-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const seconds = () => Math.floor(Date.now() / 1000);
const GiB = 1024 ** 3;

export function localWorkerOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('The development runtime only connects to a loopback Worker');
  return url.origin;
}

function matches(value, pattern) {
  const parts = pattern.split('*');
  if (parts.length === 1) return value === pattern;
  if (!value.startsWith(parts[0])) return false;
  let offset = parts[0].length;
  for (const part of parts.slice(1, -1)) {
    const found = value.indexOf(part, offset);
    if (found < 0) return false;
    offset = found + part.length;
  }
  const end = parts.at(-1);
  return value.endsWith(end) && value.length - end.length >= offset;
}
const selected = (name, include, exclude) => (!include.length || include.some(pattern => matches(name, pattern))) && !exclude.some(pattern => matches(name, pattern));

async function readLimited(response, maximum = 1024 * 1024) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('response body exceeds the probe limit');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

function acceptsStatus(spec, status) {
  return String(spec).split(',').some(part => {
    const range = part.trim().split('-').map(Number);
    return range.length === 1 ? range[0] === status : status >= range[0] && status <= range[1];
  });
}

async function httpProbe(job, signal) {
  const options = job.options ?? {};
  const headers = new Headers({ 'user-agent': 'uptime-polaris-dev-simulated-agent', ...options.headers });
  if (options.auth?.type === 'basic') headers.set('authorization', `Basic ${Buffer.from(`${options.auth.username ?? ''}:${options.auth.password ?? ''}`).toString('base64')}`);
  if (options.auth?.type === 'bearer') headers.set('authorization', `Bearer ${options.auth.token ?? ''}`);
  const response = await fetch(job.target, { method: job.method ?? 'GET', headers, ...(options.body ? { body: options.body } : {}), redirect: 'follow', signal });
  let message = '';
  if (!acceptsStatus(job.expected_status, response.status)) message = `unexpected status ${response.status}`;
  if (!message && options.headerName && (response.headers.get(options.headerName) === null || !response.headers.get(options.headerName).includes(options.headerExpected ?? ''))) message = 'expected response header was not found';
  if (!message && (job.keyword || options.jsonPath)) {
    const body = await readLimited(response);
    if (job.keyword && !body.includes(job.keyword)) message = 'expected response text was not found';
    if (options.jsonPath) {
      let value = JSON.parse(body);
      const path = options.jsonPath.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
      for (const key of path) value = value !== null && typeof value === 'object' ? value[key] : undefined;
      if (String(value) !== String(options.jsonExpected ?? '')) message = 'JSON response did not match';
    }
  } else await response.body?.cancel();
  return { status: message ? 0 : 1, status_code: response.status, message };
}

function tcpProbe(job, signal) {
  return new Promise((resolveProbe, reject) => {
    const url = new URL(job.target.startsWith('tcp://') ? job.target : `tcp://${job.target}`);
    const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) });
    let complete = false;
    let banner = '';
    const finish = (error, result) => {
      if (complete) return;
      complete = true;
      signal.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error); else resolveProbe(result);
    };
    const abort = () => finish(new Error('probe timed out or was stopped'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    socket.on('error', error => finish(error));
    socket.on('connect', () => {
      if (job.options?.send) socket.write(job.options.send);
      if (!job.options?.expect) finish(null, { status: 1, status_code: 0, message: '' });
    });
    socket.on('data', chunk => {
      banner += chunk.toString('utf8');
      if (banner.includes(job.options?.expect ?? '')) finish(null, { status: 1, status_code: 0, message: '' });
      else if (banner.length > 4096) finish(null, { status: 0, status_code: 0, message: 'expected banner was not found' });
    });
    socket.on('end', () => finish(null, { status: 0, status_code: 0, message: 'expected banner was not found' }));
  });
}

async function executeProbe(job, shutdown) {
  const start = performance.now();
  const signal = AbortSignal.any([shutdown, AbortSignal.timeout(Math.min(60000, Math.max(1, Number(job.timeout_ms) || 10000)))]);
  let result;
  try {
    result = job.type === 'udp' || job.type === 'icmp' ? await networkProbe(job, signal)
      : job.type === 'tcp' ? await tcpProbe(job, signal) : await httpProbe(job, signal);
    const latency = performance.now() - start;
    if (result.status === 1 && Number(job.options?.maxLatencyMs) > 0 && latency > Number(job.options.maxLatencyMs)) result = { ...result, status: 2, message: 'response exceeded the configured latency threshold' };
  } catch (error) { const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : null; result = { status: 0, status_code: 0, message: signal.aborted ? 'probe timed out or was stopped' : code ? `probe failed (${code})` : 'probe request failed' }; }
  return { run_id: job.run_id, lease_token: job.lease_token, observed_at: seconds(), latency_ms: Math.round(performance.now() - start), ...result, message: result.message.slice(0, 512) };
}

async function fixtures() {
  const ports = demoPorts();
  const sockets = new Set();
  const http = createHttpServer((request, response) => {
    const send = () => { response.writeHead(request.url === '/failure' ? 503 : 200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: request.url !== '/failure', source: 'local development demo service' })); };
    if (request.url === '/slow') { const timer = setTimeout(send, 900); response.once('close', () => clearTimeout(timer)); } else send();
  });
  const tcp = createTcpServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.setTimeout(5000, () => socket.destroy()); socket.once('data', () => socket.end('+PONG\r\n')); });
  const udp = createSocket('udp4');
  let udpListening = false;
  udp.on('message', (_message, peer) => udp.send(Buffer.from('pong'),peer.port,peer.address));
  const listen = (server, port) => new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolveListen(); }); });
  const close = async () => {
    http.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await Promise.all([http, tcp].filter(server => server.listening).map(server => new Promise(done => server.close(done))));
    if (udpListening) await new Promise(done => udp.close(done));
  };
  try {
    await listen(http, ports.http); await listen(tcp, ports.tcp);
    await new Promise((resolve,reject)=>{udp.once('error',reject);udp.bind(ports.udp,'127.0.0.1',()=>{udp.removeListener('error',reject);udpListening=true;resolve();});});
  }
  catch (error) { await close(); throw error; }
  return close;
}

function sampleMachine(started, current, counters) {
  const uptime = Math.max(0, (Date.now() - started) / 1000);
  const cpu = Math.round((26 + 17 * Math.sin(uptime / 27) + 7 * Math.sin(uptime / 7)) * 100) / 100;
  const memory = Math.round(8 * GiB * (0.48 + 0.06 * Math.sin(uptime / 53)));
  const elapsed = Math.max(0, (Date.now() - counters.at) / 1000);
  const up = Math.round(45000 + 18000 * (1 + Math.sin(uptime / 13)));
  const down = Math.round(130000 + 65000 * (1 + Math.sin(uptime / 19)));
  counters.up += Math.round(up * elapsed); counters.down += Math.round(down * elapsed); counters.at = Date.now();
  const interfaces = [{ name: 'eth0', up_rate: up, down_rate: down, total_up_bytes: counters.up, total_down_bytes: counters.down }, { name: 'lo', up_rate: 0, down_rate: 0, total_up_bytes: 0, total_down_bytes: 0 }].filter(nic => selected(nic.name, current.include_nics, current.exclude_nics));
  const mounts = [{ name: '/', total_bytes: 96 * GiB, used_bytes: Math.round(38 * GiB + uptime * 800) }, { name: '/data', total_bytes: 256 * GiB, used_bytes: Math.round(112 * GiB + uptime * 1200) }].filter(mount => selected(mount.name, current.include_mounts, current.exclude_mounts)).map(mount => ({ ...mount, free_bytes: mount.total_bytes - mount.used_bytes, used_percent: mount.used_bytes / mount.total_bytes * 100 }));
  return { summaries: [], cpu: { usage: cpu }, ram: { total: 8 * GiB, used: memory }, swap: { total: 2 * GiB, used: 0 }, load: { load1: cpu / 25, load5: cpu / 30, load15: cpu / 35 }, disk: { total: mounts.reduce((total, mount) => total + mount.total_bytes, 0), used: mounts.reduce((total, mount) => total + mount.used_bytes, 0) }, network: { up: interfaces.reduce((sum, nic) => sum + nic.up_rate, 0), down: interfaces.reduce((sum, nic) => sum + nic.down_rate, 0), totalUp: interfaces.reduce((sum, nic) => sum + nic.total_up_bytes, 0), totalDown: interfaces.reduce((sum, nic) => sum + nic.total_down_bytes, 0) }, connections: { tcp: 34 + Math.round(cpu), udp: 8 }, uptime: Math.floor(uptime), process: 112, message: 'Simulated Linux machine for local development', interfaces, mounts, observed_at: seconds() };
}

function finalizedBucket(bucket) {
  const points = bucket.points;
  const mean = get => points.reduce((sum, point) => sum + get(point), 0) / points.length;
  const duration = Math.max(0, points.at(-1).observed_at - points[0].observed_at);
  return { bucket_ts: bucket.ts, sample_count: points.length, cpu_samples: points.length, cpu_avg: mean(point => point.cpu.usage), cpu_max: Math.max(...points.map(point => point.cpu.usage)), mem_samples: points.length, mem_pct_avg: mean(point => point.ram.used / point.ram.total * 100), mem_pct_max: Math.max(...points.map(point => point.ram.used / point.ram.total * 100)), load_1_avg: mean(point => point.load.load1), load_5_avg: mean(point => point.load.load5), net_up_bytes: Math.max(0, points.at(-1).network.totalUp - points[0].network.totalUp), net_down_bytes: Math.max(0, points.at(-1).network.totalDown - points[0].network.totalDown), duration_sec: duration, network_duration_sec: duration };
}

export async function startDevRuntime({ origin = process.env.UPTIME_DEV_WORKER_URL ?? 'http://127.0.0.1:8787', demo = !demoSkipReason(), scheduled = true } = {}) {
  origin = localWorkerOrigin(origin);
  const version = '0.0.0-simulator';
  const shutdown = new AbortController();
  const signal = shutdown.signal;
  const stopFixtures = demo ? await fixtures() : async () => {};
  const warned = new Map();
  const warn = (key, message) => { if (Date.now() - (warned.get(key) ?? 0) > 30000) { warned.set(key, Date.now()); console.error(`[dev-live] ${message}`); } };
  const request = async (path, body, timeout = 15000) => {
    const response = await fetch(new URL(path, origin), { method: body === undefined ? 'GET' : 'POST', headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
    const text = await readLimited(response, 128 * 1024);
    let result;
    try { result = JSON.parse(text); } catch { throw new Error('local Worker returned a non-JSON response'); }
    if (!response.ok || result.ok === false) { const error = new Error(`local Worker rejected request (${response.status})`); error.status = response.status; error.code = result.error; throw error; }
    return result;
  };
  const ready = (async () => {
    while (!signal.aborted) {
      try { await request('/api/public/config', undefined, 1500); return true; }
      catch { if (!signal.aborted) warn('startup', 'Waiting for the local Worker to start.'); }
      try { await sleep(500, undefined, { signal }); } catch { return false; }
    }
    return false;
  })();
  let current = { ...DEMO_RUNTIME_DEFAULTS };
  let revision = null;
  let configurationError = null;
  const configFile = join(root, '.wrangler', 'dev-demo', 'agent-config.json');
  if (demo) {
    try { const saved = JSON.parse(await readFile(configFile, 'utf8')); const parsed = parseAgentRuntimeConfig(saved.config); if (parsed) { current = { ...parsed, auto_update: false }; revision = typeof saved.revision === 'string' && /^[a-f0-9]{32}$/.test(saved.revision) ? saved.revision : null; } }
    catch (error) { if (error.code !== 'ENOENT') warn('configuration', 'Could not read saved simulator settings; using simulator defaults.'); }
  }
  let boot = Date.now();
  const counters = { at: boot, up: 0, down: 0 };
  let announce = true;
  let nextReport = 0;
  let configurationWake = new AbortController();
  let bucket = null;
  const summaries = [];
  const frames = [];
  const results = new Map();
  const commandResults = new Map();
  const uploadResults = async () => {
    for (const [key, body] of results) {
      try { await request(`/api/public/agent/results/${DEMO_AGENT_TOKEN}`, body); results.delete(key); }
      catch (error) { if ([404, 409].includes(error.status)) results.delete(key); else throw error; }
    }
    for (const [key, body] of commandResults) {
      try { await request(`/api/public/agent/commands/${DEMO_AGENT_TOKEN}/result`, body); commandResults.delete(key); }
      catch (error) { if ([404, 409].includes(error.status)) commandResults.delete(key); else throw error; }
    }
  };
  const installation = { service_tier: 'development-simulator', config_path: configFile, executable_path: process.execPath, auto_update_supported: false };
  const exchangeConfiguration = async () => {
    const report = () => ({ revision, config: current, installation, error: configurationError });
    const reply = await request(`/api/public/agent/config/${DEMO_AGENT_TOKEN}`, report());
    if (!reply.runtime_config) return;
    const next = parseAgentRuntimeConfig(reply.runtime_config.config);
    try {
      if (!next || next.auto_update || !/^[a-f0-9]{32}$/.test(reply.runtime_config.revision)) throw new Error('unsupported simulator configuration');
      await mkdir(dirname(configFile), { recursive: true });
      const temporary = join(dirname(configFile), `agent-config-${crypto.randomUUID()}.tmp`);
      try { await writeFile(temporary, JSON.stringify({ config: next, revision: reply.runtime_config.revision }, null, 2), { flag: 'wx', mode: 0o600 }); await rename(temporary, configFile); }
      finally { await rm(temporary, { force: true }); }
      current = next; revision = reply.runtime_config.revision; configurationError = null; announce = true; bucket = null; nextReport = 0;
      configurationWake.abort(); configurationWake = new AbortController();
    } catch { configurationError = 'Could not persist or apply simulated Agent configuration'; }
    await request(`/api/public/agent/config/${DEMO_AGENT_TOKEN}`, report());
  };
  const loops = [];
  const run = (key, delay, action, wake) => {
    loops.push((async () => {
      if (!await ready) return;
      let healthy = false;
      while (!signal.aborted) {
        try {
          await action();
          if (!healthy) console.log(`[dev-live] ${key} connected.`);
          healthy = true;
        }
        catch (error) {
          healthy = false;
          const code = typeof error.code === 'string' && /^[a-zA-Z0-9_ -]{1,80}$/.test(error.code) ? `; ${error.code}` : '';
          if (!signal.aborted) warn(key, error.code === 'scheduled-disabled'
            ? 'Scheduled checks are unavailable. Use npm run dev and ensure /__scheduled is included in assets.run_worker_first.'
            : `${key} failed${error.status ? ` (HTTP ${error.status}${code})` : code}; retrying.`);
        }
        try { await sleep(typeof delay === 'function' ? delay() : delay, undefined, { signal: wake ? AbortSignal.any([signal, wake()]) : signal }); } catch {}
      }
    })());
  };
  if (demo) {
    run('Agent reporting', () => current.sample_interval_secs * 1000, async () => {
      const point = sampleMachine(boot, current, counters);
      const minute = Math.floor(point.observed_at / 60) * 60;
      if (bucket && bucket.ts !== minute) { summaries.push(finalizedBucket(bucket)); if (summaries.length > 32) summaries.shift(); bucket = null; }
      bucket ??= { ts: minute, points: [] }; bucket.points.push(point);
      if (Date.now() >= nextReport) { frames.push({ jsonrpc: '2.0', id: null, method: 'report', params: { ...point, summaries: summaries.splice(0, 32) } }); nextReport = Date.now() + current.report_interval_secs * 1000; }
      if (frames.length > 128) frames.shift();
      if (announce) { await request(`/api/public/agent/push/${DEMO_AGENT_TOKEN}`, { jsonrpc: '2.0', id: 1, method: 'basicReport', params: { name: 'demo-tokyo-edge', os: 'Linux (simulated)', arch: 'x86_64', kernel: '6.8.0-simulated', cpu_model: 'Simulated 4-core CPU', cpu_cores: 4, mem_total: 8 * GiB, version, transport: 'http', report_interval_secs: current.report_interval_secs, capabilities: ['probe_http', 'probe_tcp', ...networkProbeCapabilities, 'commands', 'config_v1'], isp: 'Local development simulation', region: 'Tokyo, JP', virtualization: 'simulated' } }); announce = false; }
      while (frames.length) {
        const batch = []; let work = 0;
        for (const frame of frames) { const cost = 2 + (frame.params.summaries?.length ?? 0); if (work + cost > 40) break; batch.push(frame); work += cost; }
        await request(`/api/public/agent/push/${DEMO_AGENT_TOKEN}`, batch);
        frames.splice(0, batch.length);
      }
    }, () => configurationWake.signal);
    run('Agent control polling', 5000, async () => {
      await exchangeConfiguration();
      await uploadResults();
      const response = await request(`/api/public/agent/jobs/${DEMO_AGENT_TOKEN}`);
      const jobs = Array.isArray(response.jobs) ? response.jobs.slice(0, 4) : [];
      const observations = await Promise.all(jobs.map(job => executeProbe(job, signal)));
      for (const observation of observations) results.set(observation.run_id, observation);
      for (const command of Array.isArray(response.commands) ? response.commands.slice(0, 8) : []) {
        let ok = true; let message = '';
        if (command.action === 're_report') { announce = true; message = 'Simulated machine will send its identity again'; }
        else if (command.action === 'check_update') { const manifest = await request('/api/public/agent/manifest'); message = `Simulator ${version}; packaged release ${manifest.version}`; }
        else if (command.action === 'restart') { boot = Date.now(); counters.at = boot; counters.up = 0; counters.down = 0; bucket = null; announce = true; nextReport = 0; configurationWake.abort(); configurationWake = new AbortController(); message = 'Simulated machine restarted; no host process or service was changed'; }
        else { ok = false; message = 'Development simulator does not install or upgrade host binaries'; }
        commandResults.set(command.id, { id: command.id, lease_token: command.lease_token, ok, message });
      }
      if (results.size > 128) results.delete(results.keys().next().value);
      if (commandResults.size > 128) commandResults.delete(commandResults.keys().next().value);
      await uploadResults();
    });
    run('Push heartbeat', 30000, () => request(`/api/public/push/${DEMO_PUSH_TOKEN}?status=1&msg=${encodeURIComponent('Local development timer heartbeat')}`, {}));
  }
  if (scheduled) run('Scheduled checks', () => 60000 - Date.now() % 60000 + 500, async () => {
    const url = new URL('/__scheduled', origin); url.searchParams.set('cron', '* * * * *');
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]), redirect: 'error' });
    if (!response.ok || !(await readLimited(response, 4096)).includes('Ran scheduled event')) { const error = new Error('local scheduled route is unavailable'); error.code = 'scheduled-disabled'; throw error; }
  });
  console.log(`[dev-live] ${demo ? 'Seeded machine fleet, one live simulator, real probe jobs, Push heartbeats, and' : 'Enabled'} normal minute checks at ${origin}.`);
  return { async close() { shutdown.abort(); await Promise.allSettled(loops); await stopFixtures(); } };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const runtime = await startDevRuntime();
  const close = () => { void runtime.close().then(() => { process.exitCode = 0; }); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
