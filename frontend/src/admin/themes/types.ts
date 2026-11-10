export interface ThemeOption {
  key: string; label: string;
  type: 'string' | 'textarea' | 'color' | 'number' | 'boolean' | 'select' | 'monitor' | 'agent';
  default?: string | number | boolean;
  choices?: string[];
  description?: string; min?: number; max?: number; step?: number;
}
export interface ThemeDefinition {
  id: string; name: string; target: 'monitor' | 'agent'; entry: string;
  capabilities: string[]; options: ThemeOption[]; available: boolean;
}
export interface ThemeManifest {
  schema: 2; id: string; short: string; name: string; version: string;
  description?: string; author?: string; themes: ThemeDefinition[];
}
export interface InstalledTheme {
  id: string; short: string; name: string; version: string; description: string | null;
  author: string | null; sourceUrl: string | null; supported: boolean;
  versions: Array<{ versionKey: string; version: string; prefix: string; themes: ThemeDefinition[] }>;
}
export interface InstallResult {
  ok: true; short: string; versionKey: string; manifest: ThemeManifest; files: number; bytes: number;
}
export interface ThemePreview {
  id: string; versionKey: string; prefix: string; manifest: ThemeManifest;
  definition: ThemeDefinition; values: Record<string, unknown>; headCode: string; contentHtml: string;
}
