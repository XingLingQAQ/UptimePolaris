import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../../frontend/src/locales/admin/', import.meta.url));
const locales = ['en-US', 'zh-CN', 'zh-TW', 'zh-HK', 'ja-JP', 'ko-KR', 'fr-FR', 'pt-BR', 'ru-RU'];

function messageKeys(value, path = '', keys = new Set()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid message namespace: ' + path);
  for (const [key, child] of Object.entries(value)) {
    const name = path ? path + '.' + key : key;
    if (typeof child === 'string') {
      if (!child.trim()) throw new Error('Empty translation: ' + name);
      keys.add(name);
    } else messageKeys(child, name, keys);
  }
  return keys;
}

// JSON catalogs are the source of truth.
// JSON 语言包是翻译源。
const catalogs = locales.map(locale => {
  const path = join(directory, locale + '.json');
  const source = readFileSync(path, 'utf8');
  const messages = JSON.parse(source);
  return { locale, path, source, messages, keys: messageKeys(messages) };
});
const required = catalogs[0].keys;
for (const catalog of catalogs) {
  const missing = [...required].filter(key => !catalog.keys.has(key));
  if (missing.length) throw new Error(catalog.locale + ' is missing translations: ' + missing.join(', '));
}

for (const catalog of catalogs) {
  const formatted = JSON.stringify(catalog.messages, null, 2) + '\n';
  if (formatted !== catalog.source) writeFileSync(catalog.path, formatted, 'utf8');
}
console.log('Formatted ' + catalogs.length + ' admin catalogs; existing translations preserved.');
