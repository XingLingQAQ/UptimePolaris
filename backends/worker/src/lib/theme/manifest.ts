import type { PageKind } from '../../../../../shared/presentation';

export interface ThemeOption {
  key: string; label: string;
  type: 'string' | 'textarea' | 'color' | 'number' | 'boolean' | 'select' | 'monitor' | 'agent';
  default?: string | number | boolean; choices?: string[];
  description?: string; min?: number; max?: number; step?: number;
}
export interface ThemeDefinition {
  id: string; name: string; target: PageKind; entry: string;
  capabilities: Array<'public.status' | 'public.config' | 'public.monitors' | 'public.monitor-detail' | 'public.agent-detail' | 'public.servers' | 'public.server-detail'>;
  options: ThemeOption[];
}
export interface ThemeManifest {
  schema: 2; id: string; short: string; name: string; version: string;
  description?: string; author?: string; themes: ThemeDefinition[];
}
export type ManifestResult = { ok: true; manifest: ThemeManifest; raw: Record<string, unknown> } | { ok: false; error: string };
const idPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const capabilitySets = {
  monitor: new Set(['public.config','public.status','public.monitors','public.monitor-detail','public.agent-detail']),
  agent: new Set(['public.config','public.servers','public.server-detail']),
};
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function known(value: Record<string, unknown>, fields: string[]) { return Object.keys(value).every(key => fields.includes(key)); }
export function validateShort(value: unknown): string | null {
  return typeof value === 'string' && idPattern.test(value) && !['admin','api','assets','login','setup'].includes(value) ? value : null;
}
export function validOption(option: ThemeOption, value: unknown): boolean {
  if (option.type === 'boolean') return typeof value === 'boolean';
  if (option.type === 'number') return typeof value === 'number' && Number.isFinite(value) && (option.min === undefined || value >= option.min) && (option.max === undefined || value <= option.max);
  if (typeof value !== 'string' || value.length > (option.type === 'textarea' ? 16000 : 2048)) return false;
  if (option.type === 'color') return /^#[a-f0-9]{6}$/i.test(value);
  if (option.type === 'select') return option.choices?.includes(value) === true;
  return true;
}
export function parseManifest(value: unknown): ManifestResult {
  const fail = (error: string): ManifestResult => ({ ok: false, error });
  if (!object(value)) return fail('manifest_not_object');
  if (!known(value,['schema','id','short','name','version','description','author','themes'])) return fail('manifest_field_unknown');
  if (value.schema !== 2) return fail('manifest_schema_unsupported');
  if (typeof value.id !== 'string' || !idPattern.test(value.id)) return fail('manifest_id_invalid');
  const short = validateShort(value.short);
  if (!short) return fail('manifest_short_invalid');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120) return fail('manifest_name_invalid');
  if (typeof value.version !== 'string' || value.version.length > 95 || !versionPattern.test(value.version)) return fail('manifest_version_invalid');
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 500) || value.author !== undefined && (typeof value.author !== 'string' || value.author.length > 120)) return fail('manifest_metadata_invalid');
  if (!Array.isArray(value.themes) || !value.themes.length || value.themes.length > 20) return fail('manifest_themes_invalid');
  const themes: ThemeDefinition[] = [], ids = new Set<string>();
  for (const item of value.themes) {
    if (!object(item) || !known(item,['id','name','target','entry','capabilities','options'])) return fail('manifest_theme_invalid');
    if (typeof item.id !== 'string' || !idPattern.test(item.id) || ids.has(item.id)) return fail('manifest_theme_id_invalid');
    ids.add(item.id);
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120 || !['monitor','agent'].includes(String(item.target))) return fail('manifest_theme_invalid');
    if (typeof item.entry !== 'string' || !isSafeThemePath(item.entry) || !/\.html?$/i.test(item.entry)) return fail('manifest_entry_invalid');
    const target = item.target as PageKind;
    if (!Array.isArray(item.capabilities) || item.capabilities.some(cap => !capabilitySets[target].has(String(cap)))) return fail('manifest_capability_invalid');
    if (!Array.isArray(item.options) || item.options.length > 100) return fail('manifest_options_invalid');
    const options: ThemeOption[] = [], keys = new Set<string>();
    for (const raw of item.options) {
      if (!object(raw) || !known(raw,['key','label','type','default','choices','description','min','max','step'])) return fail('manifest_option_invalid');
      if (typeof raw.key !== 'string' || !/^[a-z][a-zA-Z0-9_]{0,63}$/.test(raw.key) || keys.has(raw.key) || typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 120) return fail('manifest_option_invalid');
      keys.add(raw.key);
      if (!['string','textarea','color','number','boolean','select','monitor','agent'].includes(String(raw.type))) return fail('manifest_option_type_invalid');
      if (raw.type === 'monitor' && target !== 'monitor' || raw.type === 'agent' && target !== 'agent') return fail('manifest_option_target_invalid');
      if (raw.type === 'select' && (!Array.isArray(raw.choices) || !raw.choices.length || raw.choices.length > 100 || raw.choices.some(v => typeof v !== 'string'))) return fail('manifest_option_choices_invalid');
      if (['min','max','step'].some(k => raw[k] !== undefined && (raw.type !== 'number' || typeof raw[k] !== 'number' || !Number.isFinite(raw[k])))) return fail('manifest_option_range_invalid');
      if (typeof raw.min === 'number' && typeof raw.max === 'number' && raw.min > raw.max || typeof raw.step === 'number' && raw.step <= 0) return fail('manifest_option_range_invalid');
      if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 500)) return fail('manifest_option_invalid');
      const option = raw as unknown as ThemeOption;
      if (raw.default !== undefined && !validOption(option, raw.default)) return fail('manifest_option_default_invalid');
      options.push({ ...option, label: option.label.trim() });
    }
    themes.push({ id: item.id, name: item.name.trim(), target, entry: item.entry, capabilities: [...new Set(item.capabilities)] as ThemeDefinition['capabilities'], options });
  }
  const manifest: ThemeManifest = { schema: 2, id: value.id, short, name: value.name.trim(), version: value.version, themes, ...(typeof value.description === 'string' ? { description: value.description } : {}), ...(typeof value.author === 'string' ? { author: value.author } : {}) };
  return { ok: true, manifest, raw: manifest as unknown as Record<string, unknown> };
}
export function isSafeThemePath(path: string): boolean {
  return !!path && path.length <= 240 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && path.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));
}
