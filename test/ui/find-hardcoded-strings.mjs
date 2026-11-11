/* 扫描绕过语言包的界面文字，并检查语言文件的损坏字符。
 * Scan for interface text outside locale catalogs and corrupted characters in locale files. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const uiRequire = createRequire(new URL('../../frontend/package.json', import.meta.url));
const { parse, TYPE } = uiRequire('@formatjs/icu-messageformat-parser');
const ts = uiRequire('typescript');

function messageArguments(message) {
  const names = new Set();
  function visit(elements) {
    for (const element of elements) {
      if (element.type === TYPE.tag) names.add(`tag:${element.value}`);
      else if (element.type !== TYPE.literal && element.type !== TYPE.pound) names.add(element.value);
      if (element.options) for (const option of Object.values(element.options)) visit(option.value);
      if (element.children) visit(element.children);
    }
  }
  visit(parse(message, { ignoreTag: !/<([a-z][\w-]*)>.*<\/\1>/s.test(message) }));
  return [...names].sort();
}

function messageFormats(message) {
  const formats = new Set();
  function visit(elements) {
    for (const element of elements) {
      if ([TYPE.number, TYPE.date, TYPE.time, TYPE.select].includes(element.type)) {
        formats.add(`${element.value}:${element.type}`);
      }
      if (element.options) for (const option of Object.values(element.options)) visit(option.value);
      if (element.children) visit(element.children);
    }
  }
  visit(parse(message, { ignoreTag: !/<([a-z][\w-]*)>.*<\/\1>/s.test(message) }));
  return [...formats].sort();
}

const ROOT = 'frontend/src';

/**
 * Files whose non-localised literals are correct.
 *
 * Kept deliberately short and justified: an allowlist that grows quietly turns
 * the guard into decoration.
 * 非本地化字面量合理的文件；名单有意保持精简且每项有理由，避免允许列表静默增长使守卫形同虚设。
 */
const ALLOWED = [
  // Locale *names* belong in their own language - a reader looking for their
  // language should recognise it, not read it translated into the current one.
  // 语言名称使用其自身语言，便于读者识别。
  /src[\\/]i18n[\\/]config\.ts$/,
  // Dev-only style harness, never part of a build a user sees.
  // 仅供开发使用的样式工具，不进入用户构建。
  /src[\\/]dev[\\/]/,
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Remove comments without breaking string literals. / 移除注释，同时保留字符串字面量。 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let state = 'code'; // code | line | block | single | double | template / 代码、行注释、块注释、单引号、双引号、模板
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'template';
      out += c; i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } i++; continue; }
    if (state === 'block') { if (c === '*' && n === '/') { state = 'code'; i += 2; } else i++; continue; }
    // Inside a string: keep it, and honour escapes so a \" does not end it early.
    // 字符串内的内容需保留，并识别转义以免提前结束字符串。
    if (c === '\\') { out += c + (n ?? ''); i += 2; continue; }
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'template' && c === '`')) {
      state = 'code';
    }
    out += c; i++;
  }
  return out;
}

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

function flatten(value, prefix = '', out = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) flatten(child, path, out);
    else if (typeof child === 'string') out.set(path, child);
  }
  return out;
}

const LOCALES = ['en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'pt-BR', 'ru-RU', 'zh-CN', 'zh-HK', 'zh-TW'];
const catalogs = new Map();
let localeErrors = 0;

function hasCorruptedText(value) {
  if (/^\?+$/.test(value) || /\?{2,}|\uFFFD/.test(value)) return true;
  const withoutUrls = value.replace(/(?:https?:\/\/|www\.)[^\s]*/gi, '');
  return /\p{L}\?\p{L}/u.test(withoutUrls);
}

function hasMalformedAccent(value, source) {
  const withoutUrls = value.replace(/(?:https?:\/\/|www\.)[^\s]*/gi, '');
  if (!withoutUrls.includes('?')) return false;
  if (source.trimEnd().endsWith('?') && withoutUrls.trimEnd().endsWith('?')) {
    return withoutUrls.slice(0, -1).includes('?');
  }
  return true;
}

for (const locale of LOCALES) {
  const file = `frontend/src/locales/${locale}.json`;
  let catalog;
  try {
    catalog = {
      ...JSON.parse(readFileSync(file, 'utf8')),
      admin: JSON.parse(readFileSync(`frontend/src/locales/admin/${locale}.json`, 'utf8')),
    };
  } catch (error) {
    console.error(`${file}: invalid JSON (${error.message})`);
    localeErrors++;
    continue;
  }
  catalogs.set(locale, flatten(catalog));
  for (const [key, value] of catalogs.get(locale)) {
    try {
      messageArguments(value);
    } catch (error) {
      console.error(`${file}:${key}: invalid ICU message (${error.message})`);
      localeErrors++;
    }
    if (hasCorruptedText(value)) {
      console.error(`${file}:${key}: corrupted translation`);
      localeErrors++;
    }
  }
}

if (hasCorruptedText('l?aper?u') &&
    !hasCorruptedText('https://example.test/?lang=fr') &&
    !hasCorruptedText('Disponible? Réessayez.') &&
    !hasMalformedAccent('Disponible?', 'Available?') &&
    !hasMalformedAccent('Êtes-vous prêt?', 'Are you ready?') &&
    hasMalformedAccent('?mettez', 'Create') &&
    hasMalformedAccent('est? indisponible', 'is unavailable') &&
    !hasMalformedAccent('Ready?', 'Ready?')) {
  console.log('locale corruption guard edge cases passed');
} else {
  console.error('locale corruption guard edge cases failed');
  localeErrors++;
}

/**
 * Keys every catalog must carry, in every locale.
 *
 * These public keys are required even in the English source catalog.
 * 所有语言包均须包含这些公开键，包括英文源语言包。
 */
const REQUIRED_KEYS = ['node.ungrouped', 'common.status.warn', 'timer.staleData'];
for (const locale of LOCALES) {
  const translated = catalogs.get(locale);
  if (!translated) continue;
  for (const key of REQUIRED_KEYS) {
    if (!translated.has(key) || !translated.get(key).trim()) {
      console.error(`frontend/src/locales/${locale}.json:${key}: missing required key`);
      localeErrors++;
    }
  }
}
for (const locale of LOCALES) {
  const translated = catalogs.get(locale);
  if (!translated?.has('node.ungrouped')) continue;
  if (/[\u4e00-\u9fff]/.test(translated.get('node.ungrouped')) && !['zh-CN', 'zh-HK', 'zh-TW', 'ja-JP'].includes(locale)) {
    console.error(`frontend/src/locales/${locale}.json:node.ungrouped: untranslated CJK label`);
    localeErrors++;
  }
}

const english = catalogs.get('en-US');
if (english) {
  for (const locale of ['fr-FR', 'pt-BR']) {
    const translated = catalogs.get(locale);
    if (!translated) continue;
    for (const [key, value] of translated) {
      if (hasMalformedAccent(value, english.get(key) ?? '')) {
        console.error(`frontend/src/locales/${locale}.json:${key}: malformed accent question mark`);
        localeErrors++;
      }
    }
  }

  const cjkLocales = new Set(['ja-JP', 'ko-KR', 'zh-CN', 'zh-HK', 'zh-TW']);
  const corruptionRepairKeys = new Set([
    'admin.form.probeSource', 'admin.form.probeSourceHint', 'admin.form.workerSource',
    'admin.form.agentReady', 'admin.form.agentOffline', 'admin.form.agentUpgrade',
    'admin.form.sourcesLoading', 'admin.form.sourceUnavailable', 'admin.form.sourceUnavailableBadge',
    'admin.form.sourcesFailed', 'admin.form.retrySources', 'admin.form.sourceAddonsUnsupported',
    'admin.form.removedAgent', 'admin.nav.enrollment',
    ...[...english.keys()].filter((key) => key.startsWith('admin.themes.')),
    ...[
      'title', 'description', 'group', 'days', 'maxUses', 'create', 'oneTime', 'copy', 'installHint',
      'issued', 'refresh', 'usesCount', 'expires', 'revoked', 'revoke', 'empty', 'platform', 'mode',
      'noBuilds', 'pending', 'copied',
    ].map((key) => `admin.enrollment.${key}`),
  ]);
  const requiredKeys = [...english.keys()];
  for (const locale of LOCALES.slice(1)) {
    const translated = catalogs.get(locale);
    if (!translated) continue;
    for (const key of requiredKeys) {
      if (!translated.has(key)) {
        console.error(`frontend/src/locales/${locale}.json:${key}: missing translation key`);
        localeErrors++;
      }
    }
    for (const key of translated.keys()) {
      if (!english.has(key)) {
        console.error(`frontend/src/locales/${locale}.json:${key}: extra translation key`);
        localeErrors++;
      }
    }
    for (const [key, source] of english) {
      const target = translated.get(key);
      if (target === undefined) continue;
      if (corruptionRepairKeys.has(key) && cjkLocales.has(locale) && target === source) {
        console.error(`frontend/src/locales/${locale}.json:${key}: untranslated English fallback`);
        localeErrors++;
      }
      try {
        if (JSON.stringify(messageArguments(source)) !== JSON.stringify(messageArguments(target))) {
          console.error(`frontend/src/locales/${locale}.json:${key}: placeholder mismatch`);
          localeErrors++;
        }
        if (JSON.stringify(messageFormats(source)) !== JSON.stringify(messageFormats(target))) {
          console.error(`frontend/src/locales/${locale}.json:${key}: format mismatch`);
          localeErrors++;
        }
      } catch { /* Syntax failures were reported with their catalog key above. / 上方已按语言键报告语法错误。 */ }
    }
  }

  const translatedAgentKeys = [
    'installMode', 'platform', 'mode_system_linux', 'mode_user_linux', 'mode_system_darwin',
    'mode_user_darwin', 'mode_system_windows', 'mode_user_windows', 'dockerCommand', 'installDir',
    'serviceName', 'mode_system', 'mode_user', 'sampleInterval', 'reportInterval', 'includeNics',
    'excludeNics', 'includeMounts', 'excludeMounts', 'diskScope', 'cadenceInvalid', 'noBuilds',
    'availableBuilds', 'autoUpdate', 'latestVersion', 'upgradeCommand', 'windowsUpdateHint', 'dockerUpdateHint',
  ].map((key) => `admin.agent.${key}`).concat('admin.form.agentThresholdInvalid');
  for (const locale of ['fr-FR', 'pt-BR']) {
    const translated = catalogs.get(locale);
    if (!translated) continue;
    for (const key of translatedAgentKeys) {
      if (translated.get(key) === english.get(key)) {
        console.error(`frontend/src/locales/${locale}.json:${key}: untranslated English fallback`);
        localeErrors++;
      }
    }
  }

  for (const locale of LOCALES.slice(1)) {
    const translated = catalogs.get(locale);
    if (!translated) continue;
    for (const [key, value] of translated) {
      if (key.startsWith('admin.themes.') && /komari|theme[-_]market|protocol compatibility/i.test(value)) {
        console.error(`frontend/src/locales/${locale}.json:${key}: obsolete theme protocol reference`);
        localeErrors++;
      }
    }
  }
}


function checkStaticTranslations(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bindings = new Map();
  function scopeOf(node) {
    let current = node.parent;
    while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
    return current;
  }
  function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'useTranslations') {
      const args = node.initializer.arguments;
      if (args.length === 0 || (args.length === 1 && ts.isStringLiteral(args[0]))) {
        const scope = scopeOf(node);
        if (!bindings.has(scope)) bindings.set(scope, new Map());
        bindings.get(scope).set(node.name.text, args.length ? args[0].text : '');
      }
    }
    ts.forEachChild(node, collect);
  }
  function check(node) {
    if (/[\\/]components[\\/]status-page[\\/](StatusPageShell|Footer)\.tsx$/.test(file) &&
        ts.isJsxText(node) && /[a-zA-Z]{3,}/.test(node.text)) {
      const value = node.text.trim();
      if (value) {
        const line = tree.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        console.error(`${file}:${line}: hardcoded UI text ${value}`);
        localeErrors++;
      }
    }
    if (ts.isCallExpression(node)) checkTranslationCall(node);
    ts.forEachChild(node, check);
  }
  // 仅检查可静态解析的命名空间、键和参数对象。
  // Check only statically resolvable namespaces, keys, and argument objects.
  function checkTranslationCall(node) {
    const callee = ts.isPropertyAccessExpression(node.expression) && ['rich', 'markup', 'raw', 'has'].includes(node.expression.name.text)
      ? node.expression.expression : node.expression;
    if (!ts.isIdentifier(callee) || !node.arguments.length || !ts.isStringLiteral(node.arguments[0])) return;
    let scope = scopeOf(node);
    let namespace;
    while (scope) {
      if (bindings.get(scope)?.has(callee.text)) { namespace = bindings.get(scope).get(callee.text); break; }
      scope = scopeOf(scope);
    }
    if (namespace === undefined || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'has')) return;
    const key = [namespace, node.arguments[0].text].filter(Boolean).join('.');
    if (!english.has(key)) {
      const line = tree.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      console.error(`${file}:${line}: missing static translation ${key}`);
      localeErrors++;
      return;
    }
    checkMessageValues(node, key);
  }
  function checkMessageValues(node, key) {
    const values = node.arguments[1];
    if (values && !(ts.isObjectLiteralExpression(values) && values.properties.every((p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))))) return;
    const supplied = new Set(values ? values.properties.map((p) => p.name.text) : []);
    const required = messageArguments(english.get(key)).map((name) => name.replace(/^tag:/, ''));
    const missing = required.filter((name) => !supplied.has(name));
    if (missing.length) {
      const line = tree.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      console.error(`${file}:${line}: ${key} missing values ${missing.join(', ')}`);
      localeErrors++;
    }
  }
  collect(tree);
  check(tree);
}

let hits = 0;
const files = walk(ROOT).filter((f) => !ALLOWED.some((re) => re.test(f)));

for (const file of files) {
  const original = readFileSync(file, 'utf8');
  checkStaticTranslations(file, original);
  const src = stripComments(original);
  src.split(/\r?\n/).forEach((line, idx) => {
    if (!CJK.test(line)) return;
    // A translated call is the correct place for CJK-free markup; here we are
    // looking for CJK that is NOT inside t(...) - but t() results never contain
    // CJK literals, so any CJK remaining is a hardcoded string.
    // 翻译调用是无中文字符字面量的标记内容的正确位置；此处查找 t(...) 之外的中文字符。
    // t() 结果不包含中文字面量，因此剩余中文字符均为硬编码文本。
    if (/^\s*(import|\/\/|\*)/.test(line)) return;
    // 名称列表的顿号是数据分隔符，不是绕过翻译的界面文案。
    // The ideographic comma in a joined name list is punctuation, not untranslated interface copy.
    if (!CJK.test(line.replace(/\.join\(['"]、['"]\)/g, ''))) return;
    hits++;
    console.log(`${file}:${idx + 1}  ${line.trim().slice(0, 120)}`);
  });
}

console.log(hits ? `\n${hits} hardcoded string(s) found` : '\nno hardcoded CJK outside the catalogs');
process.exit(hits || localeErrors ? 1 : 0);
