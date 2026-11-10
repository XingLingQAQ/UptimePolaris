import { PAGE_KINDS, type PageKind, type PageSettings } from '../../../../../shared/presentation';
import type { Env } from '../../types';
import { getDB } from '../db/factory';
import { themeSQL } from '../db/sql/themes';
import { loadPresentation } from '../presentation/store';
import { visibilityRevisionWrite } from '../public/cache';
import { parseManifest, validOption } from './manifest';
import { acquireThemeLease } from './lease';
import { deleteThemeFiles, themeStoragePrefix, themeVersionEntryAvailable } from './storage';

export interface ThemeRow {
  short: string; id: string; name: string; version: string; description: string | null;
  author: string | null; source_url: string | null; manifest_json: string;
  installed_at: number; updated_at: number; deleting: number;
}
export interface ThemeVersionRow {
  id: string; version: string; digest: string; prefix: string; manifest_json: string; installed_at: number;
}
export async function listThemes(env: Env): Promise<ThemeRow[]> {
  const db = getDB(env); return db.query<ThemeRow>(themeSQL[db.type].list);
}
export async function getTheme(env: Env, short: string): Promise<ThemeRow | null> {
  const db = getDB(env); return db.queryOne<ThemeRow>(themeSQL[db.type].byShort,[short]);
}
export async function getThemeVersion(env: Env, id: string, version: string): Promise<ThemeVersionRow | null> {
  const db = getDB(env); return db.queryOne<ThemeVersionRow>(themeSQL[db.type].version,[id,version]);
}
export async function pageTheme(env: Env, kind: PageKind, page: PageSettings) {
  if (!page.theme) return null;
  const theme = await getTheme(env, page.theme.short);
  if (!theme || theme.deleting) return null;
  const version = await getThemeVersion(env, theme.id, page.theme.version);
  if (!version) return null;
  let parsed;
  try { parsed = parseManifest(JSON.parse(version.manifest_json)); } catch { return null; }
  if (!parsed.ok || parsed.manifest.id !== theme.id || parsed.manifest.short !== theme.short) return null;
  const definition = parsed.manifest.themes.find(item => item.id === page.theme?.theme && item.target === kind);
  return definition ? { theme, version, manifest: parsed.manifest, definition } : null;
}
export async function validatePageTheme(env: Env, kind: PageKind, page: PageSettings): Promise<boolean> {
  if (!page.theme) return Object.keys(page.themeOptions).length === 0;
  const selected = await pageTheme(env,kind,page);
  if (!selected || !await themeVersionEntryAvailable(env,selected.version.prefix,selected.definition.entry)) return false;
  const options = new Map(selected.definition.options.map(option => [option.key,option]));
  for (const [key,value] of Object.entries(page.themeOptions)) {
    const option = options.get(key);
    if (!option || !validOption(option,value)) return false;
    if (option.type === 'monitor' || option.type === 'agent') {
      const db = getDB(env), table = option.type === 'monitor' ? 'monitors' : 'agents';
      if (!await db.queryOne(`SELECT id FROM ${table} WHERE id=${db.type === 'postgres' ? '$1' : '?'}`,[value])) return false;
    }
  }
  return true;
}
export type RemoveThemeResult = { ok: true } | { ok: false; error: string; deactivated: boolean };
export async function removeTheme(env: Env, short: string): Promise<RemoveThemeResult> {
  const theme = await getTheme(env,short);
  if (!theme) return { ok:false,error:'theme_not_found',deactivated:false };
  const lease = await acquireThemeLease(env,theme.id ?? `legacy:${short}`);
  if (!lease) return { ok:false,error:'theme_busy',deactivated:false };
  try { return await removeLeasedTheme(env,short,theme.id,lease); }
  finally { try { await lease.release(); } catch { } }
}

async function removeLeasedTheme(env: Env, short: string, expectedId: string, lease: { token: string; renew: () => Promise<void> }): Promise<RemoveThemeResult> {
  const db = getDB(env), theme = await getTheme(env,short);
  if (!theme) return { ok:false,error:'theme_not_found',deactivated:false };
  if (theme.id !== expectedId) return { ok:false,error:'theme_busy',deactivated:false };
  const versions = await db.query<ThemeVersionRow>(themeSQL[db.type].versionsById,[theme.id]);
  const prefix = themeStoragePrefix(theme.id);
  if (versions.length && !prefix) return { ok:false,error:'theme_delete_invalid_path',deactivated:false };
  if ((versions.length || theme.deleting && prefix) && !env.THEMES) return { ok:false,error:'theme_delete_storage_unavailable',deactivated:false };
  let deactivated = false, marked = false;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await loadPresentation(env);
      for (const kind of PAGE_KINDS) {
        if (state.config.pages[kind].theme?.short === short) { state.config.pages[kind].theme = null; state.config.pages[kind].themeOptions = {}; delete state.config.pages[kind].headCode; delete state.config.pages[kind].contentHtml; deactivated = true; }
      }
      const next = crypto.randomUUID(), now = Math.floor(Date.now() / 1000), pg = db.type === 'postgres';
      const write = pg
        ? "INSERT INTO presentation_state(id,config_json,revision,updated_at) VALUES('main',$1,$2,$3) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,revision=excluded.revision,updated_at=excluded.updated_at WHERE presentation_state.revision=$4"
        : "INSERT INTO presentation_state(id,config_json,revision,updated_at) VALUES('main',?,?,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,revision=excluded.revision,updated_at=excluded.updated_at WHERE presentation_state.revision=?";
      const guard = pg ? '$2' : '?';
      const storageGuard = env.THEMES ? '' : ' AND NOT EXISTS (SELECT 1 FROM theme_versions WHERE id=themes.id)';
      const leaseGuard = pg ? ' AND EXISTS (SELECT 1 FROM theme_operations WHERE id=$3 AND token=$4 AND expires_at>=$5)' : ' AND EXISTS (SELECT 1 FROM theme_operations WHERE id=? AND token=? AND expires_at>=?)';
      const changes = await db.commit([
        ...(pg ? [{ sql: "SELECT pg_advisory_xact_lock(hashtext('polaris-presentation-theme'))" }] : []),
        { sql: write, params: [JSON.stringify(state.config),next,now,state.revision] },
        { sql: `UPDATE themes SET deleting=1 WHERE short=${pg ? '$1' : '?'} AND EXISTS (SELECT 1 FROM presentation_state WHERE id='main' AND revision=${guard})${storageGuard}${leaseGuard}`, params: [short,next,theme.id ?? `legacy:${short}`,lease.token,Date.now()] },
        { sql: `DELETE FROM theme_versions WHERE id=${pg ? '$1' : '?'} AND EXISTS (SELECT 1 FROM presentation_state WHERE id='main' AND revision=${guard}) AND EXISTS (SELECT 1 FROM themes WHERE id=theme_versions.id AND deleting=1)${leaseGuard}`, params: [theme.id,next,theme.id ?? `legacy:${short}`,lease.token,Date.now()] },
        visibilityRevisionWrite(now,pg),
      ]);
      const offset = pg ? 1 : 0;
      if (changes[offset] === 1 && changes[offset + 1] === 1) { marked = true; break; }
      if (changes[offset] === 1 && changes[offset + 1] === 0) {
        try { await lease.renew(); } catch { return { ok:false,error:'theme_busy',deactivated }; }
        if (!env.THEMES) return { ok:false,error:'theme_delete_storage_unavailable',deactivated };
        return { ok:false,error:'theme_not_found',deactivated };
      }
    }
  } catch { return { ok:false,error:'theme_delete_registry_failed',deactivated:false }; }
  if (!marked) return { ok:false,error:'presentation_conflict',deactivated:false };
  try { if (prefix && env.THEMES) await deleteThemeFiles(env.THEMES,prefix,lease.renew); }
  catch { return { ok:false,error:'theme_delete_failed',deactivated }; }
  try {
    await lease.renew();
    const remove = db.type === 'postgres'
      ? 'DELETE FROM themes WHERE short=$1 AND deleting=1 AND EXISTS (SELECT 1 FROM theme_operations WHERE id=$2 AND token=$3 AND expires_at>=$4)'
      : 'DELETE FROM themes WHERE short=? AND deleting=1 AND EXISTS (SELECT 1 FROM theme_operations WHERE id=? AND token=? AND expires_at>=?)';
    if ((await db.execute(remove,[short,theme.id ?? `legacy:${short}`,lease.token,Date.now()])).rowsAffected !== 1) return { ok:false,error:'theme_busy',deactivated };
  }
  catch { return { ok:false,error:'theme_delete_registry_failed',deactivated }; }
  return { ok:true };
}
