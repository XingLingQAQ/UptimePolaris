import { Hono } from 'hono';
import type { PublicServer } from '../../../../../shared/public-servers';
import { DEFAULT_PAGE_VIEW, type PageView } from '../../../../../shared/presentation';
import type { Env } from '../../types';
import { getDB } from '../db/factory';
import { agentIsOnline, agentStaleAfterSec } from '../agent/liveness';
import { requestPage } from './context';
import { loadAgentTagLinks } from './taxonomy';

const number = (value: unknown): number | null => value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
export async function publicServers(env: Env, request: Request): Promise<PublicServer[]> {
  const { kind, enabled, configured, page } = await requestPage(env,request);
  if (kind !== 'agent' || !enabled || !configured) return [];
  return publicServersForPage(env, page);
}
export function publicCountryCode(value: unknown): string | null {
  const last = typeof value === 'string' ? value.split(',').pop()?.trim() ?? '' : '';
  return /^[A-Za-z]{2}$/.test(last) ? last.toUpperCase() : null;
}

export async function publicServersForPage(env: Env, page: PageView = DEFAULT_PAGE_VIEW): Promise<PublicServer[]> {
  const db = getDB(env), now = Math.floor(Date.now()/1000);
  const rows = await db.query<Record<string, unknown>>(`SELECT a.id,a.name,a.group_id,g.name AS group_name,
    ml.os,ml.arch,ml.region,ml.reported_at,ml.report_interval_secs,ml.cpu_usage,
    ml.mem_used,ml.mem_total,ml.disk_used,ml.disk_total,ml.load_1,
    ml.net_up_rate,ml.net_down_rate,ml.net_up_total,ml.net_down_total,ml.uptime
    FROM agents a LEFT JOIN agent_groups g ON g.id=a.group_id
    LEFT JOIN machine_live ml ON ml.agent_id=a.id WHERE a.active=1 AND a.is_public=1 ORDER BY COALESCE(g.weight,0),a.name`);
  const links = await loadAgentTagLinks(env);
  return rows.map(row => {
    const has = (metric: string) => page.metrics.includes(metric);
    const result: PublicServer = {
      id:String(row.id),name:String(row.name),online:agentIsOnline(number(row.reported_at),now,agentStaleAfterSec(number(row.report_interval_secs))),reportedAt:number(row.reported_at),
      group:row.group_id && row.group_name ? {id:String(row.group_id),name:String(row.group_name)} : null,
      tags:links.filter(tag => tag.agent_id === row.id).map(({id,name,color}) => ({id,name,color})),
      ...(page.showOs ? {os:row.os == null ? null : String(row.os),arch:row.arch == null ? null : String(row.arch)} : {}),
      ...(has('cpu') ? {cpu:number(row.cpu_usage)} : {}),
      ...(has('memory') ? {memoryUsed:number(row.mem_used),memoryTotal:number(row.mem_total)} : {}),
      ...(has('disk') ? {diskUsed:number(row.disk_used),diskTotal:number(row.disk_total)} : {}),
      ...(has('load') ? {load:number(row.load_1)} : {}),
      ...(has('network') ? {upload:number(row.net_up_rate),download:number(row.net_down_rate)} : {}),
      ...(has('traffic') ? {sent:number(row.net_up_total),received:number(row.net_down_total)} : {}),
      ...(has('uptime') ? {uptime:number(row.uptime)} : {}),
    };
    const country = page.showCountry ? publicCountryCode(row.region) : null;
    if (country) result.region = country;
    return result;
  });
}

export const serverRoutes = new Hono<{ Bindings: Env }>();
serverRoutes.get('/api/public/servers', async c => c.json({ servers:await publicServers(c.env,c.req.raw),now:Math.floor(Date.now()/1000) },200,{'cache-control':'public, max-age=0, s-maxage=15'}));
serverRoutes.get('/api/public/servers/:id', async c => {
  const server = (await publicServers(c.env,c.req.raw)).find(row => row.id === c.req.param('id'));
  if (!server) return c.json({error:'not_found'},404);
  const {page} = await requestPage(c.env,c.req.raw), db = getDB(c.env), now = Math.floor(Date.now()/1000);
  const rows = page.showHistory ? await db.query<Record<string, unknown>>(`SELECT bucket_ts,cpu_avg,mem_pct_avg,net_up_bytes,net_down_bytes,network_duration_sec FROM machine_history WHERE agent_id=${db.type==='postgres'?'$1':'?'} AND bucket_ts>=${db.type==='postgres'?'$2':'?'} AND quality='aggregate' ORDER BY bucket_ts LIMIT 1440`,[server.id,now-page.historyHours*3600]) : [];
  const history = rows.map(row => ({ ts:Number(row.bucket_ts),
    ...(page.metrics.includes('cpu') ? {cpu:number(row.cpu_avg)} : {}),
    ...(page.metrics.includes('memory') ? {memory:number(row.mem_pct_avg)} : {}),
    ...(page.metrics.includes('network') ? {upload:Number(row.network_duration_sec)>0&&row.net_up_bytes!=null?Number(row.net_up_bytes)/Number(row.network_duration_sec):null,download:Number(row.network_duration_sec)>0&&row.net_down_bytes!=null?Number(row.net_down_bytes)/Number(row.network_duration_sec):null} : {}),
  }));
  return c.json({server,history,now},200,{'cache-control':'public, max-age=0, s-maxage=15'});
});
