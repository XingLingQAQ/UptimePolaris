/* 验证周维护计划到实际 UTC 窗口的转换，包括跨午夜边界。
 * Check conversion of weekly maintenance schedules to concrete UTC windows, including midnight boundaries. */
import assert from 'node:assert/strict';
import { windowContains } from '../../backends/worker/src/lib/settings/maintenance';
import { buildMaintenanceNotices, maintenanceState } from '../../backends/worker/src/lib/public/maintenance';
import { maintenancePage } from '../../backends/worker/src/lib/public/maintenance-page';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    fail++;
    console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Wednesday 2026-10-21 12:00 UTC. / UTC 时间 2026-10-21 周三 12:00。 */
const WED_NOON = Date.UTC(2026, 9, 21, 12, 0) / 1000;

console.log('\nwindow status\n');

check('a window containing now is under-maintenance', () => {
  // Wednesday 11:00-13:00, and now is 12:00.
  // 周三 11:00–13:00，当前为 12:00。
  const [notice] = buildMaintenanceNotices([{ kind: 'weekly', day: 3, start: '11:00', end: '13:00' }], WED_NOON);
  assert.equal(notice.status, 'under-maintenance');
  assert.equal(notice.timeslotList[0].startDate, '2026-10-21T11:00:00Z');
  assert.equal(notice.timeslotList[0].endDate, '2026-10-21T13:00:00Z');
});

check('a window later this week is scheduled', () => {
  // Friday 01:00-02:00, now Wednesday noon.
  // 周五 01:00–02:00，当前为周三中午。
  const [notice] = buildMaintenanceNotices([{ kind: 'weekly', day: 5, start: '01:00', end: '02:00' }], WED_NOON);
  assert.equal(notice.status, 'scheduled');
  assert.equal(notice.timeslotList[0].startDate, '2026-10-23T01:00:00Z');
});

check('a window that already passed rolls to next week', () => {
  // Monday 01:00-02:00, now Wednesday noon.
  // 周一 01:00–02:00，当前为周三中午。
  const [notice] = buildMaintenanceNotices([{ kind: 'weekly', day: 1, start: '01:00', end: '02:00' }], WED_NOON);
  assert.equal(notice.status, 'scheduled');
  assert.equal(notice.timeslotList[0].startDate, '2026-10-26T01:00:00Z');
});

check('an end before the start crosses midnight', () => {
  // Wednesday 23:00 -> Thursday 01:00, and now is Thursday 00:30.
  // 周三 23:00 至周四 01:00，当前为周四 00:30。
  const THU_0030 = Date.UTC(2026, 9, 22, 0, 30) / 1000;
  const [notice] = buildMaintenanceNotices([{ kind: 'weekly', day: 3, start: '23:00', end: '01:00' }], THU_0030);
  assert.equal(notice.status, 'under-maintenance', `expected in-progress, got ${notice.status}`);
  assert.equal(notice.timeslotList[0].startDate, '2026-10-21T23:00:00Z');
  assert.equal(notice.timeslotList[0].endDate, '2026-10-22T01:00:00Z');
  assert.equal(notice.durationMinutes, 120);
});

check('public notices and alert suppression agree across midnight and the week boundary', () => {
  const window = { kind: 'weekly', day: 6, start: '23:00', end: '01:00' };
  for (const iso of ['2026-10-17T00:30:00Z', '2026-10-17T23:30:00Z', '2026-10-18T00:30:00Z', '2026-10-18T01:00:00Z']) {
    const at = new Date(iso);
    const [notice] = buildMaintenanceNotices([window], at.getTime() / 1000);
    assert.equal(notice.status === 'under-maintenance', windowContains(window, at), iso);
  }
});

check('no windows produces no notices', () => {
  assert.deepEqual(buildMaintenanceNotices([], WED_NOON), []);
});

check('the notice carries a UTC timezone and offset', () => {
  const [notice] = buildMaintenanceNotices([{ kind: 'weekly', day: 3, start: '11:00', end: '13:00' }], WED_NOON);
  assert.equal(notice.timezone, 'UTC');
  assert.equal(notice.timezoneOffset, '+00:00');
  assert.equal(notice.durationMinutes, 120);
});

check('ids are unique across windows', () => {
  const out = buildMaintenanceNotices(
    [
      { kind: 'weekly', day: 1, start: '01:00', end: '02:00' },
      { kind: 'weekly', day: 3, start: '11:00', end: '13:00' },
    ],
    WED_NOON,
  );
  assert.equal(new Set(out.map((n) => n.id)).size, out.length);
});

check('public state selects the active window and orders upcoming windows', () => {
  const state = maintenanceState([
    { kind: 'weekly', day: 5, start: '01:00', end: '02:00' },
    { kind: 'weekly', day: 3, start: '11:00', end: '13:00' },
    { kind: 'weekly', day: 4, start: '01:00', end: '02:00' },
  ], new Date(WED_NOON * 1000), { enabled: false, title: 'Upgrade', description: 'Details' });
  assert.equal(state.active, true);
  assert.equal(state.title, 'Upgrade');
  assert.equal(state.description, 'Details');
  assert.equal(state.endsAt, '2026-10-21T13:00:00.000Z');
  assert.deepEqual(state.scheduled.map((period) => period.startsAt), [
    '2026-10-22T01:00:00.000Z', '2026-10-23T01:00:00.000Z',
  ]);
  assert.equal(maintenanceState([{ kind: 'weekly', day: 3, start: '11:00', end: '13:00' }], new Date('2026-10-21T13:00:00Z')).active, false);
});

check('manual maintenance remains active without an end and returns to the schedule when disabled', () => {
  const windows = [{ kind: 'weekly', day: 3, start: '11:00', end: '13:00' }];
  const at = new Date(WED_NOON * 1000);
  const content = { title: 'Deployment', description: 'Please return later.' };
  const manual = maintenanceState(windows, at, { ...content, enabled: true });
  assert.equal(manual.source, 'manual');
  assert.equal(manual.active, true);
  assert.equal(manual.endsAt, null);
  assert.equal(manual.title, content.title);
  const scheduled = maintenanceState(windows, at, { ...content, enabled: false });
  assert.equal(scheduled.source, 'scheduled');
  assert.equal(scheduled.active, true);
  assert.equal(scheduled.endsAt, '2026-10-21T13:00:00.000Z');
  assert.equal(maintenanceState([], at, { ...content, enabled: true }).active, true);
  assert.equal(maintenanceState([], at, { ...content, enabled: false }).source, null);
});

check('one-time windows expire without repeating and announcement differs from maintenance text', () => {
  const window = { kind: 'once' as const, startsAt: '2026-10-21T13:00:00Z', endsAt: '2026-10-21T15:00:00Z' };
  const options = { enabled: false, title: 'Work in progress', description: 'Please return later', announcement: { title: 'Upcoming upgrade', description: 'Starts at 13:00 UTC' } };
  const before = maintenanceState([window], new Date('2026-10-21T12:00:00Z'), options);
  assert.equal(before.active, false);
  assert.equal(before.scheduled[0].title, 'Upcoming upgrade');
  assert.equal(before.scheduled[0].description, 'Starts at 13:00 UTC');
  const during = maintenanceState([window], new Date('2026-10-21T14:00:00Z'), options);
  assert.equal(during.active, true); assert.equal(during.title, 'Work in progress');
  const after = maintenanceState([window], new Date('2026-10-28T14:00:00Z'), options);
  assert.equal(after.active, false); assert.deepEqual(after.scheduled, []);
  assert.deepEqual(buildMaintenanceNotices([window], Date.parse('2026-10-21T15:00:00Z') / 1000), []);
});

check('maintenance content is escaped and login remains accessible', () => {
  const html = maintenancePage({ title: '<script>alert(1)</script>', description: 'a & b' }, 'en-US');
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert/);
  assert.match(html, /a &amp; b/);
  assert.match(html, /href="\/login"/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
