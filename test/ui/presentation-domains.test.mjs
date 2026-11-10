// 验证域名编辑草稿、清空、校验和失败重试。
// Check domain drafts, clearing, validation, and failure retries.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('../../frontend/node_modules/esbuild');
const source = path => readFileSync(path, 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const compile = (source, name, env, loader = 'tsx') => Function(
  ...Object.keys(env),
  esbuild.transformSync(`${source}\nreturn ${name};`, { loader, jsx: 'transform' }).code,
)(...Object.values(env));

const presentation = source('shared/presentation.ts');
const normalizeSource = presentation.slice(presentation.indexOf('export function normalizeDomain'), presentation.indexOf('export function parsePresentation')).replace('export function', 'function');
const normalizeDomain = compile(normalizeSource, 'normalizeDomain', {}, 'ts');
const hookSource = source('frontend/src/admin/useAutoSave.tsx');
const hook = hookSource.slice(hookSource.indexOf('export function useAutoSave'), hookSource.indexOf('export function AutoSaveStatus')).replace('export function', 'function');
const panelSource = source('frontend/src/admin/settings/PresentationPanel.tsx').slice(source('frontend/src/admin/settings/PresentationPanel.tsx').indexOf('export function PresentationPanel')).replace('export function', 'function');

function fixture(initial = []) {
  let states = [], deps = [], cursor = 0, effects = [], failed = false;
  const writes = [];
  let config = { agentEnabled: true, domains: structuredClone(initial) };
  const useState = initial => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; };
  const useRef = initial => { const i = cursor++; return states[i] ??= { current: initial }; };
  const useEffect = (fn, next) => { const i = cursor++; if (!deps[i] || next.some((value, j) => value !== deps[i][j])) { deps[i] = next; effects.push(fn); } };
  const useCallback = fn => { cursor++; return fn; };
  const useAutoSave = compile(hook, 'useAutoSave', { useState, useRef, useEffect, useCallback });
  const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
  const updatePresentation = async edit => { const next = edit(structuredClone(config)); writes.push(next.domains); if (failed) throw Error('fixture failure'); config = next; };
  const env = { React, useState, useEffect, useAutoSave, updatePresentation, normalizeDomain, usePresentation: () => ({ data: { config } }), useTranslations: () => key => key, useApiErrorMessage: () => String };
  for (const name of ['Button', 'Input', 'Skeleton', 'Switch', 'MotionDisclosure', 'AutoSaveStatus', 'CloudDownload', 'Globe', 'Monitor', 'Plus', 'Server', 'Trash2']) env[name] = name;
  const Panel = compile(panelSource, 'PresentationPanel', env);
  const render = () => { cursor = 0; effects = []; const result = Panel(); effects.forEach(fn => fn()); return result; };
  const findAll = (node, predicate) => !node || typeof node !== 'object' ? [] : [...(predicate(node) ? [node] : []), ...(node.props?.children ?? []).flat(Infinity).flatMap(child => findAll(child, predicate))];
  const section = (tree, kind) => findAll(tree, node => node.type === 'section' && node.props['aria-label'] === kind)[0];
  const add = (tree, kind) => findAll(section(tree, kind), node => node.type === 'Button').at(-1).props.onPress();
  const input = (tree, kind, index = 0) => findAll(section(tree, kind), node => node.type === 'Input')[index];
  const remove = (tree, kind, index = 0) => findAll(section(tree, kind), node => node.type === 'Button')[index].props.onPress();
  const status = tree => findAll(tree, node => node.type === 'AutoSaveStatus')[0].props;
  render(); render();
  return { render, add, input, remove, status, writes, get config() { return config; }, set failed(value) { failed = value; } };
}

{
  const f = fixture(); let tree = f.render();
  f.add(tree, 'monitor'); tree = f.render();
  f.input(tree, 'monitor').props.onValueChange('Single.Example.com'); tree = f.render();
  f.input(tree, 'monitor').props.onBlur(); await wait(10);
  assert.deepEqual(f.config.domains, [{ hostname: 'single.example.com', page: 'monitor' }]);
}
{
  const f = fixture(); let tree = f.render();
  f.add(tree, 'agent'); tree = f.render(); f.add(tree, 'monitor'); tree = f.render();
  f.input(tree, 'monitor').props.onValueChange('valid.example.com'); tree = f.render();
  f.input(tree, 'monitor').props.onBlur(); await wait(10);
  assert.deepEqual(f.config.domains, [{ hostname: 'valid.example.com', page: 'monitor' }], 'empty drafts do not block a valid row');
  tree = f.render(); f.input(tree, 'agent').props.onValueChange('bad/path'); tree = f.render();
  f.input(tree, 'agent').props.onBlur(); await wait(10);
  assert.equal(f.writes.length, 1, 'invalid nonempty rows cancel pending domain writes');
  assert.ok(findAlert(tree = f.render()));
  f.input(tree, 'agent').props.onValueChange('valid.example.com'); tree = f.render();
  f.input(tree, 'agent').props.onBlur(); await wait(10);
  assert.equal(f.writes.length, 1, 'duplicate hostnames are rejected');
  tree = f.render(); f.input(tree, 'agent').props.onValueChange('server.example.com'); tree = f.render();
  f.input(tree, 'agent').props.onBlur(); await wait(10);
  assert.deepEqual(f.config.domains, [{ hostname: 'server.example.com', page: 'agent' }, { hostname: 'valid.example.com', page: 'monitor' }]);
}
{
  const original = [{ hostname: 'existing.example.com', page: 'monitor' }];
  const f = fixture(original); let tree = f.render();
  f.input(tree, 'monitor').props.onValueChange(''); tree = f.render();
  f.input(tree, 'monitor').props.onBlur(); await wait(10); tree = f.render();
  assert.ok(findAlert(tree), 'cleared saved mapping is invalid on blur');
  assert.deepEqual(f.writes, [], 'clearing a saved mapping must not write a deletion');
  assert.deepEqual(f.config.domains, original);
  f.remove(tree, 'monitor'); await wait(650);
  assert.deepEqual(f.config.domains, [], 'the remove button explicitly deletes the mapping');
}
{
  const f = fixture(); let tree = f.render();
  f.add(tree, 'monitor'); tree = f.render();
  f.input(tree, 'monitor').props.onValueChange('filled.example.com'); tree = f.render();
  f.input(tree, 'monitor').props.onValueChange(''); tree = f.render();
  f.input(tree, 'monitor').props.onBlur(); await wait(10); tree = f.render();
  assert.ok(findAlert(tree), 'a filled draft cannot become an empty placeholder again');
  assert.deepEqual(f.writes, [], 'clearing a filled draft cancels its pending write');
}
{
  const f = fixture(); let tree = f.render();
  f.add(tree, 'monitor'); tree = f.render(); f.input(tree, 'monitor').props.onValueChange('first.example.com'); tree = f.render();
  f.add(tree, 'agent'); tree = f.render(); f.remove(tree, 'monitor'); tree = f.render();
  f.input(tree, 'agent').props.onValueChange('last.example.com'); tree = f.render(); f.input(tree, 'agent').props.onBlur(); await wait(10);
  assert.deepEqual(f.config.domains, [{ hostname: 'last.example.com', page: 'agent' }], 'quick add/remove saves the latest rows');
}
{
  const f = fixture(); let tree = f.render(); f.add(tree, 'monitor'); tree = f.render();
  f.input(tree, 'monitor').props.onValueChange('retry.example.com'); tree = f.render(); f.failed = true;
  f.input(tree, 'monitor').props.onBlur(); await wait(10); tree = f.render(); assert.equal(f.status(tree).state, 'error');
  f.add(tree, 'agent'); tree = f.render(); assert.equal(f.status(tree).state, 'error', 'adding a blank draft preserves retry');
  f.failed = false; f.status(tree).retry(); await wait(10); tree = f.render();
  assert.equal(f.status(tree).state, 'saved'); assert.deepEqual(f.config.domains, [{ hostname: 'retry.example.com', page: 'monitor' }]);
}
function findAlert(node) {
  if (!node || typeof node !== 'object') return false;
  return node.props?.role === 'alert' || (node.props?.children ?? []).flat(Infinity).some(findAlert);
}
console.log('presentation domains: untouched placeholders, cleared mappings, validation, blur, latest edit and retry passed');
