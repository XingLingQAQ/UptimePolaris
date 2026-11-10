/**
 * Unit tests for the pure logic: target parsing, status matching, rollup math.
 *
 * Run: npx esbuild test/unit.test.mjs --bundle --platform=node --format=esm \
 *        --outfile=artifacts/tmp/unit.bundle.mjs && node artifacts/tmp/unit.bundle.mjs
 */
import { parseExpected } from '../backends/worker/src/lib/check/http.ts';
import { parseHostPort } from '../backends/worker/src/lib/check/tcp.ts';
import { registrableDomain } from '../backends/worker/src/lib/check/domain.ts';
import { mergeDay, overallAvailability, dayKey } from '../backends/worker/src/lib/monitor/daily-stats.ts';

let pass = 0;
let fail = 0;

function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`);
}

function throws(label, fn) {
  try {
    fn();
    fail++;
    console.log(`  FAIL  ${label} (expected throw)`);
  } catch {
    pass++;
    console.log(`  PASS  ${label}`);
  }
}

console.log('\nparseExpected');
eq('range 200-299 accepts 200', parseExpected('200-299')(200), true);
eq('range 200-299 accepts 299', parseExpected('200-299')(299), true);
eq('range 200-299 rejects 300', parseExpected('200-299')(300), false);
eq('range 200-299 rejects 199', parseExpected('200-299')(199), false);
eq('list accepts member', parseExpected('200,301,302')(301), true);
eq('list rejects non-member', parseExpected('200,301,302')(404), false);
eq('mixed list+range', parseExpected('200-204,301')(301), true);
eq('whitespace tolerated', parseExpected('200 - 299')(250), true);
eq('single code', parseExpected('204')(204), true);

console.log('\nparseHostPort');
eq('simple', parseHostPort('db.example.com:5432'), { host: 'db.example.com', port: 5432 });
eq('strips scheme', parseHostPort('tcp://example.com:443'), { host: 'example.com', port: 443 });
eq('ipv4', parseHostPort('1.2.3.4:80'), { host: '1.2.3.4', port: 80 });
eq('ipv6 bracket', parseHostPort('[::1]:443'), { host: '::1', port: 443 });
throws('missing port', () => parseHostPort('example.com'));
throws('port out of range', () => parseHostPort('example.com:99999'));
throws('port not a number', () => parseHostPort('example.com:abc'));

console.log('\nregistrableDomain');
eq('apex', registrableDomain('example.com'), 'example.com');
eq('subdomain', registrableDomain('api.example.com'), 'example.com');
eq('deep subdomain', registrableDomain('a.b.c.example.com'), 'example.com');
eq('two-part tld', registrableDomain('www.example.co.uk'), 'example.co.uk');
eq('two-part tld apex', registrableDomain('example.co.uk'), 'example.co.uk');
eq('strips scheme+path', registrableDomain('https://example.com/path?x=1'), 'example.com');
eq('trailing dot', registrableDomain('example.com.'), 'example.com');
eq('uppercase', registrableDomain('EXAMPLE.COM'), 'example.com');
eq('com.cn', registrableDomain('www.example.com.cn'), 'example.com.cn');

console.log('\nmergeDay');
const d1 = { d: '2026-10-01', t: 1440, u: 1440, w: 0, avg: 100 };
const d2 = { d: '2026-10-02', t: 1440, u: 1430, w: 0, avg: 110 };
const d1b = { d: '2026-10-01', t: 1440, u: 1400, w: 0, avg: 120 };
eq('adds new day', mergeDay([d1], d2).map(x => x.d), ['2026-10-01', '2026-10-02']);
eq('replaces same day', mergeDay([d1], d1b)[0].u, 1400);
eq('stays sorted', mergeDay([d2], d1).map(x => x.d), ['2026-10-01', '2026-10-02']);
eq('null start', mergeDay(null, d1).length, 1);
eq('idempotent', mergeDay(mergeDay([d1], d2), d2).length, 2);

console.log('\noverallAvailability');
eq('all up', overallAvailability([d1, d2]), (1440 + 1430) / 2880);
eq('empty is 100%', overallAvailability([]), 1);
eq('warn counts as available',
  overallAvailability([{ d: '2026-10-01', t: 10, u: 8, w: 2, avg: 0 }]), 1);
eq('down counts against',
  overallAvailability([{ d: '2026-10-01', t: 10, u: 8, w: 0, avg: 0 }]), 0.8);

console.log('\ndayKey');
eq('utc day', dayKey(Date.parse('2026-10-04T23:59:59Z') / 1000), '2026-10-04');
eq('utc rollover', dayKey(Date.parse('2026-10-05T00:00:00Z') / 1000), '2026-10-05');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
