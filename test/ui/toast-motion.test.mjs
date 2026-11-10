// 检查提示动效适配与当前 Sonner 样式的对应关系。
// Check toast motion adaptation against the installed Sonner styles.

﻿import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const postcss = require('postcss');
const upstream = postcss.parse(await readFile(new URL('../../frontend/node_modules/sonner/dist/styles.css', import.meta.url), 'utf8'));
const local = postcss.parse(await readFile(new URL('../../frontend/src/styles/toast-motion.css', import.meta.url), 'utf8'));
const full = "html[data-motion='full'] ";
const reduced = "html[data-motion='reduced'] ";

function declaration(root, selector, property, media) {
  const matches = [];
  root.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    const inMedia = rule.parent.type === 'atrule' && rule.parent.name === 'media' ? rule.parent.params : undefined;
    if (inMedia !== media) return;
    rule.walkDecls(property, (decl) => matches.push(decl));
  });
  assert.equal(matches.length, 1, `${selector}: expected one ${property} in ${media ?? 'root'}`);
  return matches[0];
}

function restore(selector, property, target = selector) {
  const original = declaration(upstream, selector, property);
  const override = declaration(local, full + target, property, '(prefers-reduced-motion: reduce)');
  assert.equal(override.value, original.value, `${target}: ${property}`);
  assert.equal(override.important, true, `${target}: ${property} must override Sonner`);
}

test('full motion restores Sonner transitions when the OS prefers reduced motion', () => {
  for (const selector of [
    '[data-sonner-toast]',
    "[data-sonner-toast][data-removed='true'][data-front='false'][data-swipe-out='false'][data-expanded='false']",
    "[data-sonner-toast][data-swiping='true']",
    '[data-sonner-toast] > *',
  ]) restore(selector, 'transition');
  restore("[data-sonner-toast][data-styled='true'] [data-button]", 'transition', "[data-sonner-toast][data-styled='true'] > [data-button]");
  restore("[data-sonner-toast][data-styled='true'] [data-close-button]", 'transition', "[data-sonner-toast][data-styled='true'] > [data-close-button]");
});

test('full motion restores all swipe directions and loading bar phases', () => {
  const swipe = "[data-sonner-toast][data-swipe-out='true'][data-y-position='bottom']";
  const target = "[data-sonner-toast][data-swipe-out='true'][data-y-position]";
  for (const property of ['animation-duration', 'animation-timing-function', 'animation-fill-mode']) restore(swipe, property, target);
  for (const direction of ['left', 'right', 'up', 'down']) {
    restore(`[data-sonner-toast][data-swipe-out='true'][data-swipe-direction='${direction}']`, 'animation-name');
  }
  restore('.sonner-loading-bar', 'animation');
  for (let index = 1; index <= 12; index++) restore(`.sonner-loading-bar:nth-child(${index})`, 'animation-delay');
});

test('reduced motion gives animation-dependent states their static end state', () => {
  const icon = "[data-sonner-toast][data-promise='true'] [data-icon] > svg";
  assert.equal(declaration(upstream, icon, 'opacity').value, '0');
  assert.equal(declaration(local, reduced + icon, 'opacity').value, '1');
  assert.equal(declaration(local, reduced + icon, 'transform').value, 'scale(1)');
  assert.equal(declaration(local, reduced + ".sonner-loading-wrapper[data-visible='false']", 'opacity').value, '0');
  assert.equal(declaration(local, reduced + "[data-sonner-toast][data-removed='true'][data-swipe-out='true']", 'opacity').value, '0');
});

test('Sonner still has the important OS motion override this adapter targets', () => {
  for (const selector of ['[data-sonner-toast]', '[data-sonner-toast] > *', '.sonner-loading-bar']) {
    for (const property of ['transition', 'animation']) {
      const original = declaration(upstream, selector, property, '(prefers-reduced-motion)');
      assert.equal(original.value, 'none');
      assert.equal(original.important, true);
    }
  }
});
