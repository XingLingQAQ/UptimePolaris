import {
  DEFAULT_PAGE_VIEW,
  defaultPresentation,
  parsePresentation,
  type PageKind,
  type PageSettings,
  type PageView,
  type PresentationConfig,
  type PresentationState,
} from '../../../../../shared/presentation';
import type { Env } from '../../types';
import { getDB } from '../db/factory';
import { visibilityRevisionWrite } from '../public/cache';

export async function loadPresentation(env: Env): Promise<PresentationState> {
  const row = await getDB(env).queryOne<{
    config_json: string;
    revision: string;
  }>("SELECT config_json,revision FROM presentation_state WHERE id='main'");
  if (!row) return { config: defaultPresentation(), revision: 'initial' };
  const config = parsePresentation(JSON.parse(row.config_json));
  if (!config || typeof row.revision !== 'string' || !row.revision) throw new Error('invalid_presentation');
  return { config, revision: row.revision };
}
export async function savePresentation(
  env: Env,
  config: PresentationConfig,
  revision: string,
): Promise<boolean> {
  const db = getDB(env),
    now = Math.floor(Date.now() / 1000),
    next = crypto.randomUUID();
  const params: unknown[] = [JSON.stringify(config), next, now, revision];
  const checks = Object.values(config.pages).flatMap((page) => {
    if (!page.theme) return [];
    params.push(page.theme.short, page.theme.version);
    const arg = (n: number) => (db.type === 'postgres' ? `$${n}` : `?${n}`);
    return [
      `EXISTS (SELECT 1 FROM themes t JOIN theme_versions v ON v.id=t.id WHERE t.deleting=0 AND t.short=${arg(params.length - 1)} AND v.version=${arg(params.length)})`,
    ];
  });
  const exists = checks.join(' AND ') || '1=1';
  const sql =
    db.type === 'postgres'
      ? `INSERT INTO presentation_state(id,config_json,revision,updated_at) SELECT 'main',$1,$2,$3 WHERE ${exists} ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,revision=excluded.revision,updated_at=excluded.updated_at WHERE presentation_state.revision=$4`
      : `INSERT INTO presentation_state(id,config_json,revision,updated_at) SELECT 'main',?1,?2,?3 WHERE ${exists} ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,revision=excluded.revision,updated_at=excluded.updated_at WHERE presentation_state.revision=?4`;
  const writes = [
    { sql, params },
    visibilityRevisionWrite(now, db.type === 'postgres'),
  ];
  if (db.type === 'postgres')
    writes.unshift({
      sql: "SELECT pg_advisory_xact_lock(hashtext('polaris-presentation-theme'))",
      params: [],
    });
  const changes = await db.commit(writes);
  return changes[db.type === 'postgres' ? 1 : 0] === 1;
}
export async function agentPresentationEnabled(env: Env): Promise<boolean> {
  return (await loadPresentation(env)).config.agentEnabled;
}
export interface PageContext {
  kind: PageKind;
  page: PageSettings & PageView;
  enabled: boolean;
  configured: boolean;
  config: PresentationConfig;
  revision: string;
  preview: boolean;
}
export async function resolvePage(
  env: Env,
  url: URL,
  preview?: PageKind,
): Promise<PageContext> {
  const { config, revision } = await loadPresentation(env);
  const domains = config.agentEnabled ? config.domains : [];
  const domain = domains.find(
    (entry) => entry.hostname === url.hostname.toLowerCase().replace(/\.$/, ''),
  );
  const kind = preview ?? domain?.page ?? 'monitor';
  return {
    kind,
    page: {
      ...DEFAULT_PAGE_VIEW,
      layout: kind === 'agent' ? 'cards' : 'list',
      ...config.pages[kind],
    },
    enabled: !!preview || kind !== 'agent' || config.agentEnabled,
    configured: !!preview || !domains.length || !!domain,
    config,
    revision,
    preview: !!preview,
  };
}
