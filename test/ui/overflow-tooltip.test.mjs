// 验证溢出提示只读取实际裁剪文字。
// Check that overflow hints use only text that is actually clipped.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['frontend/src/components/ui/OverflowTooltip.tsx'], bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic' });
const { overflowTarget } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
class ElementFixture {}
class TextFixture extends ElementFixture {
  constructor({ text = 'A complete diagnostic message', width = 100, scrollWidth = 300, height = 20, scrollHeight = 20, overflow = 'ellipsis', clamp = 'none', parent = null, input = false } = {}) {
    super(); Object.assign(this, { textContent: text, clientWidth: width, scrollWidth, clientHeight: height, scrollHeight, style: { textOverflow: overflow, webkitLineClamp: clamp }, parentElement: parent, input });
  }
  matches() { return this.input; }
}
globalThis.Element = ElementFixture;
globalThis.HTMLElement = TextFixture;
globalThis.document = { body: new ElementFixture() };
globalThis.getComputedStyle = element => element.style;
const truncated = new TextFixture();
assert.equal(overflowTarget(truncated), truncated);
assert.equal(overflowTarget(new TextFixture({ scrollWidth: 100 })), null);
assert.equal(overflowTarget(new TextFixture({ overflow: 'clip' })), null);
assert.equal(overflowTarget(new TextFixture({ input: true })), null);
assert.equal(overflowTarget(new TextFixture({ text: '   ' })), null);
assert.equal(overflowTarget(new TextFixture({ scrollWidth: 20, parent: truncated })), truncated);
const clamped = new TextFixture({ overflow: 'clip', scrollWidth: 100, height: 40, scrollHeight: 120, clamp: '2' });
assert.equal(overflowTarget(clamped), clamped);
const summary = new TextFixture({ text: '+3', scrollWidth: 10 });
summary.dataset = { fullText: 'alpha, beta, gamma' };
assert.equal(overflowTarget(summary), summary, 'collapsed lists expose their complete items');
const explicitTooltip = new TextFixture();
explicitTooltip.closest = () => explicitTooltip;
assert.equal(overflowTarget(explicitTooltip), null, 'existing tooltips never receive a nested overflow hint');
assert.equal(overflowTarget(null), null);
console.log('PASS overflow hints select genuinely clipped text, multiline clamps and nested targets without exposing input values');
