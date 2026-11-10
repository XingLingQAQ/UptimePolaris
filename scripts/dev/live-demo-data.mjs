export const DEMO_IDS = {
  groups: { production: 'd0000000-0000-4000-8000-000000000101', edge: 'd0000000-0000-4000-8000-000000000102', internal: 'd0000000-0000-4000-8000-000000000103' },
  agentGroups: { edge: 'd0000000-0000-4000-8000-000000000111', production: 'd0000000-0000-4000-8000-000000000112', data: 'd0000000-0000-4000-8000-000000000113' },
  tags: { edge: 'd0000000-0000-4000-8000-000000000201', api: 'd0000000-0000-4000-8000-000000000202', database: 'd0000000-0000-4000-8000-000000000203', critical: 'd0000000-0000-4000-8000-000000000204', backup: 'd0000000-0000-4000-8000-000000000205' },
  agentTags: { edge: 'd0000000-0000-4000-8000-000000000211', critical: 'd0000000-0000-4000-8000-000000000212', storage: 'd0000000-0000-4000-8000-000000000213', backup: 'd0000000-0000-4000-8000-000000000214' },
  monitors: {
    cloudflare: 'd0000000-0000-4000-8000-000000000301', apiGateway: 'd0000000-0000-4000-8000-000000000302', docs: 'd0000000-0000-4000-8000-000000000303',
    postgres: 'd0000000-0000-4000-8000-000000000304', redis: 'd0000000-0000-4000-8000-000000000305', backup: 'd0000000-0000-4000-8000-000000000306',
    edgeNode01: 'd0000000-0000-4000-8000-000000000307', edgeNode02: 'd0000000-0000-4000-8000-000000000308', paused: 'd0000000-0000-4000-8000-000000000309',
    statusPage: 'd0000000-0000-4000-8000-000000000310', edgeProbedApi: 'd0000000-0000-4000-8000-000000000311',
    udp: 'd0000000-0000-4000-8000-000000000312', icmp: 'd0000000-0000-4000-8000-000000000313',
  },
  agents: {
    edgeNode01: 'd0000000-0000-4000-8000-000000000307',
    frankfurt: 'd0000000-0000-4000-8000-000000000321',
    singapore: 'd0000000-0000-4000-8000-000000000322',
    saoPaulo: 'd0000000-0000-4000-8000-000000000323',
    toronto: 'd0000000-0000-4000-8000-000000000324',
    seoul: 'd0000000-0000-4000-8000-000000000325',
    awaitingInstall: 'd0000000-0000-4000-8000-000000000308',
  },
  channels: { telegram: 'd0000000-0000-4000-8000-000000000401', feishu: 'd0000000-0000-4000-8000-000000000402' },
};
export const DEMO_NUM_ID_BASE = 9001;
export const DEMO_MONITOR_IDS = Object.values(DEMO_IDS.monitors);
export const DEMO_AGENT_TOKEN = 'demo-agent-edge-node-01';
export const DEMO_PUSH_TOKEN = 'demo-push-nightly-backup';
export const DEMO_RUNTIME_DEFAULTS = { sample_interval_secs: 5, report_interval_secs: 15, include_nics: [], exclude_nics: ['lo'], include_mounts: [], exclude_mounts: ['/proc'], auto_update: false };

const agentFleet = [
  { key: 'edgeNode01', name: 'Demo · Tokyo Edge', token: DEMO_AGENT_TOKEN, group: 'edge', tags: ['edge'], os: 'Linux', arch: 'x86_64', region: 'Tokyo, JP', cpu: 32, memory: 54, disk: 41, load: 1.28, upload: 52000, download: 180000, sent: 8e9, received: 31e9, uptime: 86400 * 18, reported: 'online', profile: 'dynamic' },
  { key: 'frankfurt', name: 'Demo · Frankfurt API', token: 'demo-agent-frankfurt', group: 'production', tags: ['edge'], os: 'Linux', arch: 'x86_64', region: 'Frankfurt, DE', cpu: 68, memory: 78, disk: 62, load: 2.34, upload: 125000, download: 420000, sent: 84e9, received: 211e9, uptime: 86400 * 42, reported: 'online', profile: 'balanced' },
  { key: 'singapore', name: 'Demo · Singapore Hot Node', token: 'demo-agent-singapore', group: 'edge', tags: ['edge', 'critical'], os: 'Linux', arch: 'aarch64', region: 'Singapore, SG', cpu: 92, memory: 88, disk: 74, load: 6.82, upload: 380000, download: 820000, sent: 440e9, received: 1.2e12, uptime: 86400 * 7, reported: 'online', profile: 'hot' },
  { key: 'saoPaulo', name: 'Demo · São Paulo Archive', token: 'demo-agent-saopaulo', group: 'data', tags: ['backup'], os: 'FreeBSD', arch: 'x86_64', region: 'São Paulo, BR', cpu: 47, memory: 63, disk: 81, load: 1.76, upload: 18000, download: 64000, sent: 12e9, received: 77e9, uptime: 86400 * 93, reported: 'offline', profile: 'offline' },
  { key: 'toronto', name: 'Demo · Toronto Backup', token: 'demo-agent-toronto', group: 'data', tags: ['backup'], os: 'Windows', arch: 'x86_64', region: 'Toronto, CA', cpu: null, memory: null, disk: null, load: null, upload: null, download: null, sent: null, received: null, uptime: null, reported: 'unknown', profile: 'unknown' },
  { key: 'seoul', name: 'Demo · Seoul Storage', token: 'demo-agent-seoul', group: 'production', tags: ['storage', 'critical'], os: 'Linux', arch: 'x86_64', region: 'Seoul, KR', cpu: 34, memory: 55, disk: 94, load: 1.12, upload: 90000, download: 210000, sent: 122e9, received: 390e9, uptime: 86400 * 12, reported: 'online', profile: 'disk' },
];

export const DEMO_AGENT_FLEET = agentFleet;

export function demoPorts(env = process.env) {
  const http = Number(env.UPTIME_DEMO_HTTP_PORT ?? 8790);
  const tcp = Number(env.UPTIME_DEMO_TCP_PORT ?? 8791);
  const udp = Number(env.UPTIME_DEMO_UDP_PORT ?? 8792);
  if (![http, tcp, udp].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535) || new Set([http,tcp,udp]).size !== 3) throw new Error('Demo fixture ports must be distinct integers between 1024 and 65535');
  return { http, tcp, udp };
}

export function demoSkipReason(env = process.env) {
  const mode = env.UPTIME_DEMO_SEED?.trim().toLowerCase();
  if (['skip', 'off', '0', 'false'].includes(mode)) return `UPTIME_DEMO_SEED=${mode}`;
  if (env.CI === 'true' && mode === undefined) return 'CI=true';
  return null;
}

const q = value => value === null || value === undefined ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const source = { type: 'agent', agent_id: DEMO_IDS.monitors.edgeNode01 };

function monitors(ports = demoPorts()) {
  return [
    { key: 'cloudflare', name: 'Demo · HTTP + TLS / Domain / DNS', type: 'http', target: 'https://cloudflare.com', addons: true, tags: ['edge', 'critical'] },
    { key: 'apiGateway', name: 'Demo · HTTP JSON API', type: 'http', target: 'https://api.github.com', interval: 120, options: { headers: { accept: 'application/vnd.github+json' } }, tags: ['api'] },
    { key: 'docs', name: 'Demo · HTTP keyword', type: 'http', target: 'https://example.com', keyword: 'Example Domain', tags: ['api'] },
    { key: 'postgres', name: 'Demo · TCP public endpoint', type: 'tcp', target: 'example.com:443', tags: ['database'] },
    { key: 'redis', name: 'Demo · TCP banner via Agent', type: 'tcp', target: `127.0.0.1:${ports.tcp}`, options: { check_source: source, send: 'PING\r\n', expect: '+PONG' }, tags: ['database', 'edge'] },
    { key: 'backup', name: 'Demo · Push heartbeat', type: 'push', target: '', tags: ['backup'] },
    { key: 'edgeNode01', name: 'Demo · Simulated Linux Agent', type: 'agent', target: '', options: { probe_enabled: true }, tags: ['edge'] },
    { key: 'edgeNode02', name: 'Demo · Agent awaiting installation', type: 'agent', target: '', active: 0, options: { probe_enabled: false }, tags: ['edge'] },
    { key: 'paused', name: 'Demo · Paused monitor', type: 'http', target: 'https://example.net', active: 0, tags: [] },
    { key: 'statusPage', name: 'Demo · Slow HTTP via Agent', type: 'http', target: `http://127.0.0.1:${ports.http}/slow`, options: { check_source: source, maxLatencyMs: 500 }, tags: ['api', 'edge'] },
    { key: 'edgeProbedApi', name: 'Demo · HTTP via Agent', type: 'http', target: `http://127.0.0.1:${ports.http}/health`, options: { check_source: source }, tags: ['api', 'edge'] },
    { key: 'udp', name: 'Demo · UDP response via Agent', type: 'udp', target: `127.0.0.1:${ports.udp}`, options: { check_source: source, send: 'ping', expect: 'pong', encoding: 'text' }, tags: ['edge'] },
    { key: 'icmp', name: 'Demo · ICMP Ping via Agent', type: 'icmp', target: '127.0.0.1', options: { check_source: source }, tags: ['edge'] },
  ];
}

export const DEMO_MONITOR_NAMES = Object.fromEntries(monitors({ http: 8790, tcp: 8791 }).map(monitor => [DEMO_IDS.monitors[monitor.key], monitor.name]));

export function buildSeedStatements(at = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(at) || at <= 0) throw new Error('Seed timestamp must be positive epoch seconds');
  const statements = [];
  const agentGroups = [
    { key: 'edge', name: '边缘节点（示例）', weight: 10 },
    { key: 'production', name: '生产服务（示例）', weight: 20 },
    { key: 'data', name: '数据与备份（示例）', weight: 30 },
  ];
  for (const group of agentGroups) statements.push(`INSERT INTO agent_groups(id,name,weight,created_at,updated_at) VALUES(${q(DEMO_IDS.agentGroups[group.key])},${q(group.name)},${group.weight},${at},${at}) ON CONFLICT(id) DO UPDATE SET name=excluded.name,weight=excluded.weight,updated_at=excluded.updated_at;`);
  const groups = [
    { key: 'production', name: 'Demo · Public checks' }, { key: 'edge', name: 'Demo · Simulated host' }, { key: 'internal', name: 'Demo · Examples' },
  ];
  for (const [index, group] of groups.entries()) statements.push(`INSERT INTO monitor_groups(id,name,weight,created_at,updated_at) VALUES(${q(DEMO_IDS.groups[group.key])},${q(group.name)},${(index + 1) * 10},${at},${at}) ON CONFLICT(id) DO NOTHING;`);
  const tags = [{ key: 'edge', color: '#0EA5E9' }, { key: 'api', color: '#8B5CF6' }, { key: 'database', color: '#F59E0B' }, { key: 'critical', color: '#EF4444' }, { key: 'backup', color: '#10B981' }];
  for (const tag of tags) statements.push(`INSERT INTO tags(id,name,color,created_at,updated_at) VALUES(${q(DEMO_IDS.tags[tag.key])},${q(`demo:${tag.key}`)},${q(tag.color)},${at},${at}) ON CONFLICT(id) DO NOTHING;`);

  const agentTags = [{ key: 'edge', name: '边缘节点', color: '#0EA5E9' }, { key: 'critical', name: '重点关注', color: '#EF4444' }, { key: 'storage', name: '存储', color: '#8B5CF6' }, { key: 'backup', name: '备份', color: '#10B981' }];
  for (const tag of agentTags) statements.push(`INSERT INTO agent_tags(id,name,color,created_at,updated_at) VALUES(${q(DEMO_IDS.agentTags[tag.key])},${q(tag.name)},${q(tag.color)},${at},${at}) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,updated_at=excluded.updated_at;`);

  const examples = monitors();
  for (const machine of agentFleet) {
    const id = q(DEMO_IDS.agents[machine.key]);
    statements.push(`INSERT INTO agents(id,name,token,active,group_id,options_json,created_at,updated_at) VALUES(${id},${q(machine.name)},${q(machine.token)},${machine.key === 'awaitingInstall' ? 0 : 1},${q(DEMO_IDS.agentGroups[machine.group])},${q(JSON.stringify({ probe_enabled: machine.key !== 'awaitingInstall' }))},${at},${at}) ON CONFLICT(id) DO UPDATE SET name=excluded.name,active=excluded.active,group_id=excluded.group_id,options_json=excluded.options_json,updated_at=excluded.updated_at;`);
    for (const tag of machine.tags) statements.push(`INSERT OR IGNORE INTO agent_tag_links(agent_id,tag_id) VALUES(${id},${q(DEMO_IDS.agentTags[tag])});`);
  }
  statements.push(`INSERT INTO presentation_state(id,config_json,revision,updated_at) VALUES('main',${q(JSON.stringify({ agentEnabled: true, workerService: 'uptime-polaris', domains: [{ hostname: '127.0.0.1', page: 'agent' }, { hostname: 'localhost', page: 'agent' }], pages: { monitor: { theme: null, themeOptions: {} }, agent: { theme: null, themeOptions: {} } } }))},'demo-agent-page',${at}) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,revision=excluded.revision,updated_at=excluded.updated_at;`);
  statements.push(`UPDATE agents SET is_public=CASE WHEN id IN (${agentFleet.filter(machine => machine.key !== 'awaitingInstall').map(machine => q(DEMO_IDS.agents[machine.key])).join(',')}) THEN 1 ELSE 0 END;`);
  for (const machine of agentFleet.filter(item => item.key !== 'awaitingInstall')) {
    const id = q(DEMO_IDS.agents[machine.key]);
    const reportedAt = machine.reported === 'online' ? at : machine.reported === 'offline' ? at - 3600 : null;
    const values = [
      id, q(machine.os), q(machine.arch), q(`${machine.os} demo-kernel`), q('Polaris virtual CPU'), machine.arch === 'aarch64' ? 8 : 4,
      machine.cpu, machine.memory == null ? null : Math.round(16 * 1024 ** 3 * machine.memory / 100), machine.memory == null ? null : 16 * 1024 ** 3,
      machine.disk == null ? null : Math.round(2 * 1024 ** 4 * machine.disk / 100), machine.disk == null ? null : 2 * 1024 ** 4,
      machine.load, machine.load == null ? null : machine.load * 0.82, machine.load == null ? null : machine.load * 0.64,
      machine.upload, machine.download, machine.sent, machine.received, machine.uptime, reportedAt, at,
      q(machine.region), q(machine.key === 'seoul' ? 'Korea Telecom demo' : 'Local development simulation'), q(machine.profile), q('0.1.0-demo'), 60,
    ];
    const columns = ['agent_id','os','arch','kernel','cpu_model','cpu_cores','cpu_usage','mem_used','mem_total','disk_used','disk_total','load_1','load_5','load_15','net_up_rate','net_down_rate','net_up_total','net_down_total','uptime','reported_at','updated_at','region','isp','virtualization','version','report_interval_secs'];
    statements.push(`INSERT INTO machine_live(${columns.join(',')}) VALUES(${values.map(value => value === null ? 'NULL' : typeof value === 'string' && value.startsWith("'") ? value : q(value)).join(',')}) ON CONFLICT(agent_id) DO UPDATE SET ${columns.slice(1).map(column => `${column}=excluded.${column}`).join(',')};`);
    if (machine.cpu != null) {
      for (let index = 1; index <= 96; index++) {
        if (machine.key === 'singapore' && index % 19 === 0) continue;
        const ts = Math.floor((at - index * 900) / 60) * 60;
        const wave = Math.sin((index + machine.cpu) / 7);
        const cpu = Math.max(0, Math.min(100, machine.cpu + wave * (machine.profile === 'hot' ? 6 : 3)));
        const memory = Math.max(0, Math.min(100, machine.memory + Math.cos(index / 9) * 2));
        const up = Math.max(0, Math.round(machine.upload * (1 + Math.sin(index / 5) * 0.18)));
        const down = Math.max(0, Math.round(machine.download * (1 + Math.cos(index / 6) * 0.16)));
        statements.push(`INSERT INTO machine_history(agent_id,bucket_ts,cpu_avg,cpu_max,mem_pct_avg,mem_pct_max,load_1_avg,load_5_avg,sample_count,duration_sec,quality,net_up_bytes,net_down_bytes,network_duration_sec) VALUES(${id},${ts},${cpu.toFixed(2)},${Math.min(100, cpu + 4).toFixed(2)},${memory.toFixed(2)},${Math.min(100, memory + 3).toFixed(2)},${(machine.load * (1 + wave * 0.08)).toFixed(3)},${(machine.load * 0.8).toFixed(3)},12,840,'aggregate',${up * 840},${down * 840},840) ON CONFLICT(agent_id,bucket_ts) DO UPDATE SET cpu_avg=excluded.cpu_avg,cpu_max=excluded.cpu_max,mem_pct_avg=excluded.mem_pct_avg,mem_pct_max=excluded.mem_pct_max,load_1_avg=excluded.load_1_avg,load_5_avg=excluded.load_5_avg,net_up_bytes=excluded.net_up_bytes,net_down_bytes=excluded.net_down_bytes,network_duration_sec=excluded.network_duration_sec;`);
      }
    }
  }
  for (const [index, monitor] of examples.entries()) {
    const id = DEMO_IDS.monitors[monitor.key];
    const number = DEMO_NUM_ID_BASE + index;
    const num = `CASE WHEN EXISTS(SELECT 1 FROM monitors WHERE num_id=${number} AND id<>${q(id)}) THEN (SELECT COALESCE(MAX(num_id),0)+1 FROM monitors) ELSE ${number} END`;
    const group = monitor.options?.check_source || monitor.type === 'agent' ? DEMO_IDS.groups.edge : monitor.type === 'push' || monitor.active === 0 ? DEMO_IDS.groups.internal : DEMO_IDS.groups.production;
    const agentId = monitor.type === 'agent' ? id : monitor.options?.check_source?.agent_id ?? null;
    statements.push(`INSERT INTO monitors(id,num_id,name,type,target,method,expected_status,keyword,interval_sec,timeout_ms,warn_days,check_ssl,check_domain,check_dns,options_json,push_token,agent_id,group_id,active,created_at,updated_at)
      VALUES(${q(id)},${num},${q(monitor.name)},${q(monitor.type)},${q(monitor.target)},'GET','200-299',${q(monitor.keyword)},${monitor.interval ?? 60},10000,14,${monitor.addons ? 1 : 0},${monitor.addons ? 1 : 0},${monitor.addons ? 1 : 0},${q(JSON.stringify(monitor.type === 'agent' ? {} : monitor.options ?? {}))},${q(monitor.type === 'push' ? DEMO_PUSH_TOKEN : null)},${q(agentId)},${q(group)},${monitor.active ?? 1},${at},${at})
      ON CONFLICT(id) DO NOTHING;`);
    for (const tag of monitor.tags) statements.push(`INSERT OR IGNORE INTO monitor_tags(monitor_id,tag_id) SELECT ${q(id)},${q(DEMO_IDS.tags[tag])} WHERE (SELECT created_at FROM monitors WHERE id=${q(id)})=${at};`);
  }
  const channels = [
    { key: 'telegram', name: 'Demo · Telegram (disabled)', type: 'telegram', config: { bot_token: 'demo-token-not-a-real-bot', chat_id: '-1000000000000' } },
    { key: 'feishu', name: 'Demo · Feishu (disabled)', type: 'feishu', config: { webhook_url: 'https://example.invalid/open-apis/bot/v2/hook/demo' } },
  ];
  for (const channel of channels) statements.push(`INSERT INTO notifications(id,name,type,config_json,active,created_at,updated_at) VALUES(${q(DEMO_IDS.channels[channel.key])},${q(channel.name)},${q(channel.type)},${q(JSON.stringify(channel.config))},0,${at},${at}) ON CONFLICT(id) DO NOTHING;`);
  for (const channel of channels) statements.push(`INSERT OR IGNORE INTO notification_groups(notification_id,group_id) SELECT ${q(DEMO_IDS.channels[channel.key])},${q(DEMO_IDS.groups[channel.key === 'telegram' ? 'production' : 'edge'])} WHERE (SELECT created_at FROM notifications WHERE id=${q(DEMO_IDS.channels[channel.key])})=${at};`);
  return { statements, summary: { groups: groups.length + agentGroups.length, tags: tags.length + agentTags.length, monitors: examples.length, agents: agentFleet.length, events: 0, channels: channels.length, deliveries: 0, statements: statements.length } };
}
