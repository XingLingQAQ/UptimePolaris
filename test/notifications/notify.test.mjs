import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
/* 使用 D1 与替代 fetch 验证渠道配置、提供商响应、队列和语言；不发送真实通知。
 * Use D1 and stubbed fetch to check channel settings, provider responses, queues, and languages without sending notifications. */
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';

const TELEGRAM_FIXTURE_TOKEN = ['123456789', 'TEST_TOKEN_NOT_A_REAL_SECRET_000'].join(':');

const HARNESS = `
import { Hono } from 'hono';
import { dispatch, retryPending } from './backends/worker/src/lib/notification/dispatch';
import { sendToChannel } from './backends/worker/src/lib/notification/send';
import { validateConfig } from './backends/worker/src/lib/notification/channels';
import { buildMessage } from './backends/worker/src/lib/notification/message';
import { notifyRoutes } from './backends/worker/src/lib/notification/routes.ts';
import { writeSettings, clearSetting } from './backends/worker/src/lib/settings/store.ts';

const TELEGRAM_FIXTURE_TOKEN = ['123456789', 'TEST_TOKEN_NOT_A_REAL_SECRET_000'].join(':');

let clock = 1750000000000;
Date.now = () => clock;

/** Route app mounted like production; the auth gate is out of scope here. / 按生产方式挂载路由；认证入口不在测试范围。 */
const routes = new Hono();
routes.route('/', notifyRoutes);

/** Injected fetch and sent record; lets tests assert a second channel still sends after a failure. / 注入 fetch 和 sent 记录；用于断言失败后第二个渠道仍会发送。 */
let fake = null;
const sent = [];
const failures = [];
/** Headers of the most recent request, for the webhook's bearer check. / 最近一次请求的头，用于检查 webhook bearer。 */
let lastHeaders = null;
const realError = console.error.bind(console);
console.error = (...args) => {
  const line = args.map(String).join(' ');
  // Structured lines are captured rather than printed: dispatch is expected to
  // log on every failure, and echoing them would bury the test's own output.
  // 捕获而非打印结构化日志：dispatch 预期在每次失败时记录，直接输出会淹没测试结果。
  try { JSON.parse(line); failures.push(line); } catch { realError(line); }
};

globalThis.fetch = async (url, init) => {
  const u = String(url);
  const body = init && typeof init.body === 'string' ? init.body : '';
  sent.push({ url: u, body });
  if (!fake) throw new Error('no fake transport installed');
  return fake(u, init, body);
};

const telegramOk = async () => Response.json({ ok: true, result: { message_id: 1 } });
const feishuOk = async () => Response.json({ code: 0, msg: 'success' });

/** Insert a channel and read it back, so the row is exercised as stored. / 插入并读回渠道，按实际存储的行进行测试。 */
async function mk(env, type, config, active = 1) {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    'INSERT INTO notifications (id, name, type, config_json, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
  ).bind(id, type + '-channel', type, JSON.stringify(config), active, now, now).run();
  const row = await env.DB.prepare('SELECT * FROM notifications WHERE id = ?').bind(id).first();
  return {
    id: row.id, name: row.name, type: row.type,
    config: JSON.parse(row.config_json), active: row.active,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

const event = (over) => Object.assign({
  monitorName: 'prod site',
  monitorTarget: 'https://example.com',
  monitorType: 'http',
  status: 0,
  prevStatus: 1,
  message: 'HTTP 500',
  at: 1750000000,
}, over || {});

function reset() { sent.length = 0; failures.length = 0; }

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    const json = (o) => Response.json(o);
    const clean = () => env.DB.prepare('DELETE FROM notifications').run();

    if (p === '/message-language') {
      reset();
      const input = await req.json();
      fake = async () => Response.json({ ok: true, code: 0 });
      const channel = {
        id: 'localized', name: 'localized', type: input.type, active: 1, group_ids: [],
        created_at: 0, updated_at: 0,
        config: {
          bot_token: 'fixture', chat_id: '1', webhook_url: 'https://hook.fixture.test',
          url: 'https://hook.fixture.test', urls: 'json://fixture', sendkey: 'sctp123tfixture',
          ...(input.language === undefined ? {} : { language: input.language }),
        },
      };
      const notificationEvent = event(input.event);
      if (input.event?.prevStatus === null) delete notificationEvent.prevStatus;
      const result = await sendToChannel(channel, notificationEvent);
      return json({ result, sent });
    }

    if (p === '/language-route-sent') return json({ sent });

    if (p === '/notification-boundary') {
      reset(); await clean();
      await env.DB.prepare('DELETE FROM pending_notifications').run();
      await env.DB.prepare('DELETE FROM notification_deliveries').run();
      const input = await req.json();
      const created = await routes.fetch(new Request('http://x/api/notifications', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'boundary fixture', type: input.type, config: input.config }),
      }), env);
      if (created.status !== 201) throw new Error('boundary channel rejected: ' + await created.text());
      const { id } = await created.json();
      const channels = await routes.fetch(new Request('http://x/api/notifications'), env).then(r => r.json());
      const channel = channels.channels.find(row => row.id === id);
      fake = async () => {
        if (input.throw) throw new Error(input.reason);
        if (input.type === 'telegram') return Response.json({ ok: false, description: input.reason });
        return new Response(input.reason, { status: 503 });
      };
      const direct = await sendToChannel(channel, event());
      const test = await routes.fetch(new Request('http://x/api/notifications/' + id + '/test', { method: 'POST' }), env).then(r => r.json());
      await dispatch(env, [event({ monitorId: 'boundary-monitor' })]);
      const deliveries = await routes.fetch(new Request('http://x/api/notifications/deliveries'), env).then(r => r.json());
      return json({ direct, test, deliveries, failures });
    }

    if (p === '/language-retry') {
      reset(); await clean();
      await env.DB.prepare('DELETE FROM pending_notifications').run();
      const cn = await mk(env, 'webhook', { url: 'https://cn.fixture.test', language: 'zh-CN' });
      const en = await mk(env, 'webhook', { url: 'https://en.fixture.test', language: 'en-US' });
      fake = async () => { throw new Error('fixture unavailable'); };
      await dispatch(env, [event({ monitorId: 'localized-retry' })]);
      const initial = sent.map(row => ({ url: row.url, payload: JSON.parse(row.body) }));
      const updated = await routes.fetch(new Request('http://x/api/notifications/' + en.id, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: { url: 'https://en.fixture.test', language: 'fr-FR' } }),
      }), env);
      reset();
      fake = async () => new Response(null, { status: 204 });
      clock += 31_000;
      await retryPending(env, Math.floor(clock / 1000));
      clock = 1750000000000;
      const retried = sent.map(row => ({ url: row.url, payload: JSON.parse(row.body) }));
      const pending = await env.DB.prepare('SELECT COUNT(*) AS n FROM pending_notifications').first();
      return json({ updated: updated.status, initial, retried, pending: pending.n });
    }

    if (p === '/retry-order') {
      reset(); await clean();
      await env.DB.prepare('DELETE FROM pending_notifications').run();
      await mk(env, 'webhook', { url: 'https://hook.fixture.test' });
      const delivered = [];
      fake = async () => { throw new Error('fixture unavailable'); };
      const at = Math.floor(clock / 1000);
      await dispatch(env, [event({ monitorId: 'ordered', status: 0, at })]);
      clock += 10_000;
      fake = async (_url, _init, body) => {
        delivered.push(JSON.parse(body).status);
        return new Response(null, { status: 204 });
      };
      await dispatch(env, [event({ monitorId: 'ordered', prevStatus: 0, status: 1, at: at + 10 })]);
      const duringBackoff = [...delivered];
      clock += 21_000;
      await retryPending(env, Math.floor(clock / 1000));
      await retryPending(env, Math.floor(clock / 1000));
      clock = 1750000000000;
      return json({ duringBackoff, delivered });
    }

    if (p === '/retry-maintenance') {
      reset(); await clean();
      await env.DB.prepare('DELETE FROM pending_notifications').run();
      await mk(env, 'webhook', { url: 'https://hook.fixture.test' });
      clock = Date.parse('2026-10-26T01:59:00Z');
      await writeSettings(env, { 'maintenance.scheduleEnabled': true, 'alerts.maintenanceWindows': [{ kind: 'weekly', day: 1, start: '02:00', end: '03:00' }] });
      fake = async () => { throw new Error('fixture unavailable'); };
      await dispatch(env, [event({ monitorId: 'maintenance', at: clock / 1000 })]);
      const delivered = [];
      fake = async () => { delivered.push(clock); return new Response(null, { status: 204 }); };
      clock = Date.parse('2026-10-26T02:10:00Z');
      await retryPending(env, clock / 1000);
      const during = delivered.length;
      clock = Date.parse('2026-10-26T03:01:00Z');
      await retryPending(env, clock / 1000);
      await clearSetting(env, 'alerts.maintenanceWindows');
      await clearSetting(env, 'maintenance.scheduleEnabled');
      clock = 1750000000000;
      return json({ during, after: delivered.length });
    }

    // The channel routes answer for their own prefix, exactly as they will when
    // backends/worker/src/api.ts mounts this app.
    // 渠道路由响应其自身前缀，与 backends/worker/src/api.ts 挂载时一致。
    if (p.startsWith('/api/notifications')) return routes.fetch(req, env);

    if (p === '/logical-failure') {
      reset(); await clean();
      const tg = await mk(env, 'telegram', { bot_token: 'T', chat_id: '1' });
      const fs = await mk(env, 'feishu', { webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' });

      // HTTP 200 with a body that says the send failed. This is the trap.
      // HTTP 200 但正文表示发送失败，这是需要防范的陷阱。
      fake = async () => Response.json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' });
      const telegram = await sendToChannel(tg, event());

      fake = async () => Response.json({ code: 19001, msg: 'param invalid: incoming webhook access token invalid' });
      const feishu = await sendToChannel(fs, event());

      // And the converse: a 200 that says ok must be reported as delivered.
      // 反之，200 且正文表示成功时必须记为送达。
      fake = telegramOk;
      const telegramGood = await sendToChannel(tg, event());

      return json({ telegram, feishu, telegramGood });
    }

    if (p === '/escaping') {
      reset(); await clean();
      const tg = await mk(env, 'telegram', { bot_token: 'T', chat_id: '1' });
      const fs = await mk(env, 'feishu', { webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' });
      const tricky = event({ monitorName: 'a<b>&"c"', status: 1, prevStatus: 0, message: '', statusCode: 503, latencyMs: 812 });

      fake = telegramOk;
      await sendToChannel(tg, tricky);
      const telegramBody = JSON.parse(sent[0].body);

      fake = feishuOk;
      await sendToChannel(fs, tricky);
      const feishuBody = JSON.parse(sent[1].body);

      return json({
        telegramText: telegramBody.text,
        telegramParseMode: telegramBody.parse_mode,
        telegramNoPreview: telegramBody.disable_web_page_preview,
        feishuText: feishuBody.content.text,
        plainText: buildMessage(tricky),
      });
    }

    if (p === '/resilience') {
      reset(); await clean();
      await mk(env, 'telegram', { bot_token: 'THROW', chat_id: '1' });
      await mk(env, 'telegram', { bot_token: 'HANG', chat_id: '2' });
      const survivor = await mk(env, 'feishu', { webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' });

      fake = (url, init) => {
        if (url.includes('/botTHROW/')) return Promise.reject(new TypeError('network error'));
        if (url.includes('/botHANG/')) {
          // Never answers on its own; only the caller's AbortSignal ends it.
          // 不会自行响应，只能由调用方的 AbortSignal 结束。
          return new Promise((_, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')));
          });
        }
        return feishuOk(url, init);
      };

      let threw = null;
      try {
        await dispatch(env, [event()], 40);
      } catch (e) {
        threw = String(e && e.message || e);
      }

      return json({
        threw,
        delivered: sent.filter((s) => s.url.includes('open.feishu.cn')).length,
        attempted: sent.length,
        ids: [survivor.id],
        failures,
      });
    }

    if (p === '/active-only') {
      reset(); await clean();
      await mk(env, 'telegram', { bot_token: 'T', chat_id: '1' }, 0);
      await mk(env, 'feishu', { webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' }, 1);
      fake = feishuOk;
      await dispatch(env, [event()]);
      return json({ urls: sent.map((s) => s.url) });
    }

    if (p === '/empty') {
      reset(); await clean();
      fake = async () => { throw new Error('dispatch with nothing to send must not fetch'); };
      await dispatch(env, [event()]);
      await dispatch(env, []);
      return json({ fetches: sent.length, failures: failures.length });
    }

    if (p === '/validate') {
      return json({
        telegramOk: validateConfig('telegram', { bot_token: 'T', chat_id: '1' }),
        telegramNoToken: validateConfig('telegram', { chat_id: '1' }),
        telegramNoChat: validateConfig('telegram', { bot_token: 'T' }),
        feishuOk: validateConfig('feishu', { webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' }),
        feishuNoUrl: validateConfig('feishu', {}),
        feishuPlaintext: validateConfig('feishu', { webhook_url: 'http://open.feishu.cn/open-apis/bot/v2/hook/abc' }),
        feishuGarbage: validateConfig('feishu', { webhook_url: 'not-a-url' }),
        // New URL fields must refuse plaintext http; Apprise needs a destination or key. / 新 URL 字段必须拒绝明文 http；Apprise 需要目标或 key。
        slackOk: validateConfig('slack', { webhook_url: 'https://hooks.slack.com/services/T/B/x' }),
        slackPlaintext: validateConfig('slack', { webhook_url: 'http://hooks.slack.com/services/T/B/x' }),
        slackMissing: validateConfig('slack', {}),
        discordOk: validateConfig('discord', { webhook_url: 'https://discord.com/api/webhooks/1/x' }),
        discordPlaintext: validateConfig('discord', { webhook_url: 'http://discord.com/api/webhooks/1/x' }),
        webhookOk: validateConfig('webhook', { url: 'https://example.com/hook' }),
        webhookNoSecret: validateConfig('webhook', { url: 'https://example.com/hook' }),
        webhookPlaintext: validateConfig('webhook', { url: 'http://example.com/hook' }),
        appriseStatelessOk: validateConfig('apprise', {
          url: 'https://apprise.example.com/notify', urls: 'tgram://bot/chat',
        }),
        appriseStatefulOk: validateConfig('apprise', {
          url: 'https://apprise.example.com/notify', key: 'my-config',
        }),
        // Neither a destination nor a key: Apprise has nowhere to send and would
        // answer 200 having notified nobody.
        // 无目的地也无密钥时，Apprise 无处发送，可能返回 200 但无人收到通知。
        appriseNoDestination: validateConfig('apprise', { url: 'https://apprise.example.com/notify' }),
        appriseNoUrl: validateConfig('apprise', { urls: 'tgram://bot/chat' }),
        apprisePlaintext: validateConfig('apprise', { url: 'http://apprise.example.com/notify', urls: 'tgram://x' }),
        // Apprise URLs are not HTTP URLs, so the https rule must NOT be demanded
        // of them - only of the gateway URL.
        // Apprise URL 不是 HTTP URL；HTTPS 规则只适用于网关 URL，不能强加于目的地。
        appriseMailtoIsFine: validateConfig('apprise', {
          url: 'https://apprise.example.com/notify', urls: 'mailto://user:pass@example.com',
        }),
        serverchanOk: validateConfig('serverchan', { sendkey: 'sctp1234tabcdef' }),
        serverchanMissing: validateConfig('serverchan', { sendkey: '   ' }),
        // A type written by a newer deployment than this code.
        // 模拟由比当前代码更新的部署写入的类型。
        unknownType: validateConfig('mastodon', { url: 'https://example.com' }),
      });
    }

    if (p === '/apprise') {
      reset(); await clean();

      /** Regression: stateless Apprise needs \`urls\`; a \`key\` in the body notifies nobody. / 回归：无状态 Apprise 需要 \`urls\`；把 key 放正文会导致无人收到通知。 */
      const stateless = await mk(env, 'apprise', {
        url: 'https://apprise.example.com/notify',
        urls: 'tgram://bot/chat, mailto://a@b.c',
      });
      fake = async () => Response.json({ error: null });
      await sendToChannel(stateless, event());
      const statelessBody = JSON.parse(sent[0].body);
      const statelessUrl = sent[0].url;

      /** Stateful: key in the path, no \`urls\`. / 有状态：key 放在路径，不传 \`urls\`。 */
      const stateful = await mk(env, 'apprise', {
        url: 'https://apprise.example.com/notify',
        key: 'my-config-id',
      });
      fake = async () => Response.json({ error: null });
      await sendToChannel(stateful, event());
      const statefulBody = JSON.parse(sent[1].body);
      const statefulUrl = sent[1].url;

      /** 424 means at least one destination failed; no success field exists in the body. / 424 表示至少一个目标失败；正文没有 success 字段。 */
      fake = async () => new Response('2025-01-01 - ERROR - Failed to send to Telegram', { status: 424 });
      const failed = await sendToChannel(stateless, event());

      // A plain 200 whose body is a log listing is a success: the log is not a
      // verdict, and treating an unexpected body as failure would report delivered
      // alerts as broken.
      // 普通 200 的正文是日志列表，不是结果判定；把意外正文视为失败会误报已送达的告警。
      fake = async () => new Response('2025-01-01 12:00:00,000 - INFO - Sent to Telegram', { status: 200 });
      const logged = await sendToChannel(stateless, event());

      return json({ statelessBody, statelessUrl, statefulBody, statefulUrl, failed, logged });
    }

    if (p === '/other-providers') {
      reset(); await clean();

      const slack = await mk(env, 'slack', { webhook_url: 'https://hooks.slack.com/services/T/B/x' });
      const discord = await mk(env, 'discord', { webhook_url: 'https://discord.com/api/webhooks/1/x' });
      const hook = await mk(env, 'webhook', { url: 'https://example.com/hook', secret: 'sekret' });
      const sc = await mk(env, 'serverchan', { sendkey: 'sctp1234tabcdef' });

      // Slack: 200 with the literal text "ok" - not JSON, so a JSON parse would
      // report a delivered message as broken.
      // Slack 的 200 正文是字面文本 ok 而非 JSON；尝试解析 JSON 会误报发送失败。
      fake = async () => new Response('ok', { status: 200 });
      const slackRes = await sendToChannel(slack, event());
      const slackBody = JSON.parse(sent[0].body);

      // Discord: 204 with no body at all.
      // Discord 返回无正文的 204。
      fake = async () => new Response(null, { status: 204 });
      const discordRes = await sendToChannel(discord, event());
      const discordBody = JSON.parse(sent[1].body);

      // Slack failure is a 4xx whose body is plain text, and it must be surfaced.
      // Slack 失败返回 4xx 和纯文本正文，必须向上展示。
      fake = async () => new Response('invalid_payload', { status: 400 });
      const slackBad = await sendToChannel(slack, event());

      // Webhook: structured body, bearer from 'secret'.
      // Webhook 使用结构化正文，bearer 来自 secret。
      fake = async (url, init) => {
        lastHeaders = init.headers;
        return new Response('', { status: 200 });
      };
      const hookRes = await sendToChannel(hook, event());
      const hookBody = JSON.parse(sent[sent.length - 1].body);
      const hookAuth = lastHeaders && (lastHeaders.authorization ?? lastHeaders.Authorization);

      // ServerChan: 200 with a non-zero code, the same body trap as Telegram.
      // ServerChan 返回 200 但 code 非零，与 Telegram 一样存在正文陷阱。
      fake = async () => Response.json({ code: 40001, message: 'bad pushtoken' });
      const scBad = await sendToChannel(sc, event());
      const scUrl = sent[sent.length - 1].url;

      // The modern sctp key puts its account id in the hostname instead.
      // 新版 sctp 密钥将账号 ID 放在主机名中。
      const scModern = await mk(env, 'serverchan', { sendkey: 'sctp1234tabcdef' });
      fake = async () => Response.json({ code: 0, message: 'ok' });
      const scOk = await sendToChannel(scModern, event());
      const scModernUrl = sent[sent.length - 1].url;

      return json({
        slackRes, slackBody, discordRes, discordBody, slackBad,
        hookRes, hookBody, hookAuth,
        scBad, scUrl, scOk, scModernUrl,
      });
    }

    if (p === '/deliveries-run') {
      reset(); await clean();
      await env.DB.prepare('DELETE FROM notification_deliveries').run();
      const created = await routes.fetch(new Request('http://x/api/notifications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ops', type: 'telegram', config: { bot_token: 'T', chat_id: '1' } }),
      }), env);
      const { id } = await created.json();

      // Success half.
      // 成功场景 / Success case
      fake = telegramOk;
      await dispatch(env, [event({ monitorId: 'mon-1', monitorName: 'prod site', status: 0, at: 1750000000 })]);

      // Failure half, with a token echoed back by the provider so the scrubber
      // has something real to remove.
      // 失败场景：供应商回显令牌，以便验证脱敏确实移除了它。
      fake = async () => Response.json({
        ok: false,
        description: 'Bad Request: invalid token ' + TELEGRAM_FIXTURE_TOKEN,
      });
      await dispatch(env, [event({ monitorId: 'mon-2', monitorName: 'edge', status: 2, at: 1750000060 })]);

      return json({ id });
    }

    if (p === '/routes-setup') {
      reset(); await clean();
      // Answers correctly per URL, so a route test does not have to know which
      // provider shape the channel it just created happens to need.
      // 根据 URL 返回对应响应，使路由测试无需知道新建渠道所需的供应商响应格式。
      fake = (url, init) => (url.includes('api.telegram.org') ? telegramOk() : feishuOk(url, init));
      return json({});
    }

    return json({ error: 'unknown route: ' + p }, 404);
  },
};
`;

async function harness() {
  const built = await build({
    stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    format: 'esm',
    write: false,
    target: 'es2022',
    logLevel: 'error',
    // Workers-only module, reached through notify.ts -> checks.ts -> check/tcp.ts.
    // The same stub test/auth/auth.test.mjs uses, and the connect path is never run.
    // Workers 专用模块经 notify.ts -> checks.ts -> check/tcp.ts 到达；
    // 使用 test/auth/auth.test.mjs 相同的替身，connect 路径不会执行。
    plugins: [
      {
        name: 'stub-sockets',
        setup(b) {
          b.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'sockets', namespace: 'stub' }));
          b.onResolve({ filter: /^postgres$/ }, () => ({ path: 'postgres-stub', namespace: 'pgstub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: 'export const connect = () => { throw new Error("no sockets"); };',
          }));
          b.onLoad({ filter: /.*/, namespace: 'pgstub' }, () => ({
            contents: `export default function postgres() { throw new Error('postgres is stubbed in this test bundle'); }`,
          }));
        },
      },
    ],
  });

  const mf = new Miniflare({
    modules: true,
    script: built.outputFiles[0].text,
    compatibilityDate: '2025-01-01',
    d1Databases: { DB: 'notify-test' },
  });

  // Apply every migration in filename order, as shipped. / 按文件名顺序应用全部迁移。
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);

  return mf;
}

// --- tiny assertion runner -------------------------------------------------
// 简易断言执行器 / Tiny assertion runner

let pass = 0;
let fail = 0;

function check(name, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

const mf = await harness();
const origin = 'http://localhost';
const call = async (path) => {
  const res = await mf.dispatchFetch(`${origin}${path}`);
  if (res.status !== 200) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
};
const raw = (path, init) => mf.dispatchFetch(`${origin}${path}`, init);
const postJson = (path, body, method = 'POST') =>
  raw(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// --- a 200 that says the send failed ---------------------------------------
// 200 响应但正文表示发送失败 / A 200 response reporting failure

console.log('\nHTTP 200 carrying a logical failure\n');
{
  const r = await call('/logical-failure');

  check('telegram {ok:false} on 200 is a failure', r.telegram.ok === false, r.telegram);
  check(
    "telegram surfaces the provider's description",
    r.telegram.error === 'Bad Request: chat not found',
    r.telegram,
  );
  check('telegram {ok:true} on 200 is a success', r.telegramGood.ok === true, r.telegramGood);

  check('feishu {code:19001} on 200 is a failure', r.feishu.ok === false, r.feishu);
  check(
    "feishu surfaces the sanitized provider message",
      r.feishu.error === 'param invalid: incoming web[redacted] access token invalid',
    r.feishu,
  );
}

// --- escaping ---------------------------------------------------------------
// 转义 / Escaping

console.log('\nHTML escaping (telegram parses HTML, feishu does not)\n');
{
  const r = await call('/escaping');

  check(
    'monitor name with < > & " is escaped for telegram',
    r.telegramText.includes('a&lt;b&gt;&amp;&quot;c&quot;'),
    r.telegramText,
  );
  check('no raw markup is left in the telegram body', !r.telegramText.includes('<b>'), r.telegramText);
  check('telegram sends parse_mode HTML', r.telegramParseMode === 'HTML', r.telegramParseMode);
  check('telegram link previews are disabled', r.telegramNoPreview === true, r.telegramNoPreview);

  // The other half of the difference: escaping feishu's text would show the
  // operator `&amp;` in the message they receive.
  // 另一种情况：若转义飞书文本，操作员收到的消息会显示 &amp;。
  check('feishu text is left unescaped', r.feishuText.includes('a<b>&"c"'), r.feishuText);

  check(
    'body carries the recovery transition and the UTC time',
    r.plainText.includes('DOWN -> UP') && r.plainText.includes('2025-06-15 15:06:40 UTC'),
    r.plainText,
  );
  check('body carries response facts and an actionable next step',
    r.plainText.includes('Response code: 503') && r.plainText.includes('Latency: 812 ms') && r.plainText.includes('Action:'),
    r.plainText);
}

// --- one bad channel must not stop the others ------------------------------
// 单个渠道故障不得阻止其他渠道 / One bad channel must not stop others

console.log('\ndispatch survives a throwing and a hanging channel\n');
{
  const r = await call('/resilience');

  check('dispatch did not throw', r.threw === null, r.threw);
  check('every channel was attempted', r.attempted === 3, r.attempted);
  check('the healthy channel still received its message', r.delivered === 1, r);
  check(
    'one structured notify_failed line per failed channel',
    r.failures.length === 2 && r.failures.every((l) => JSON.parse(l).event === 'notify_failed'),
    r.failures,
  );
  check(
    'the failure log names the channel and never its config',
    r.failures.every((l) => {
      const o = JSON.parse(l);
      return Boolean(o.channel) && Boolean(o.err) && !JSON.stringify(o).includes('bot_token');
    }),
    r.failures,
  );
}

// --- inactive channels ------------------------------------------------------
// 停用渠道 / Inactive channels

console.log('\ninactive channels\n');
{
  const r = await call('/active-only');
  check(
    'only the active channel was sent to',
    r.urls.length === 1 && r.urls[0].includes('open.feishu.cn'),
    r.urls,
  );
}

console.log('\nnothing to send\n');
{
  const r = await call('/empty');
  check('no channels means no outbound request at all', r.fetches === 0, r);
  check('and no failure logged', r.failures === 0, r);
}

// --- validation -------------------------------------------------------------
// 校验 / Validation

console.log('\nvalidateConfig\n');
{
  const r = await call('/validate');
  check('telegram accepts bot_token + chat_id', r.telegramOk === null, r.telegramOk);
  check('telegram rejects a missing token', r.telegramNoToken === 'telegram_token_required', r.telegramNoToken);
  check('telegram rejects a missing chat', r.telegramNoChat === 'telegram_chat_required', r.telegramNoChat);
  check('feishu accepts an https webhook', r.feishuOk === null, r.feishuOk);
  check('feishu rejects a missing url', r.feishuNoUrl === 'feishu_url_required', r.feishuNoUrl);
  check('feishu rejects http, which would leak the token', r.feishuPlaintext === 'feishu_url_invalid', r.feishuPlaintext);
  check('feishu rejects an unparseable url', r.feishuGarbage === 'feishu_url_invalid', r.feishuGarbage);

  check('slack accepts an https webhook', r.slackOk === null, r.slackOk);
  check('slack rejects http, which would leak the token', r.slackPlaintext === 'slack_url_invalid', r.slackPlaintext);
  check('slack rejects a missing url', r.slackMissing === 'slack_url_required', r.slackMissing);

  check('discord accepts an https webhook', r.discordOk === null, r.discordOk);
  check('discord rejects http', r.discordPlaintext === 'discord_url_invalid', r.discordPlaintext);

  check('webhook accepts an https url', r.webhookOk === null, r.webhookOk);
  check('webhook does not require a secret', r.webhookNoSecret === null, r.webhookNoSecret);
  check('webhook rejects http', r.webhookPlaintext === 'webhook_url_invalid', r.webhookPlaintext);

  check('apprise accepts url + urls (stateless)', r.appriseStatelessOk === null, r.appriseStatelessOk);
  check('apprise accepts url + key (stateful)', r.appriseStatefulOk === null, r.appriseStatefulOk);
  /** No destination and no key means Apprise notifies nobody. / 没有目标也没有 key，Apprise 不会通知任何人。 */
  check('apprise rejects url with neither urls nor key',
    r.appriseNoDestination === 'apprise_urls_required', r.appriseNoDestination);
  check('apprise requires the gateway url', r.appriseNoUrl === 'apprise_url_required', r.appriseNoUrl);
  check('apprise rejects a plaintext gateway', r.apprisePlaintext === 'apprise_url_invalid', r.apprisePlaintext);
  check('apprise accepts a non-http destination scheme (mailto://)',
    r.appriseMailtoIsFine === null, r.appriseMailtoIsFine);

  check('serverchan accepts a key', r.serverchanOk === null, r.serverchanOk);
  check('serverchan rejects a blank key', r.serverchanMissing === 'serverchan_key_required', r.serverchanMissing);

  // A row can name a type this build does not know; that is reported, not ignored.
  // 数据行可能指定当前构建未知的类型；应报告而不是忽略。
  check('an unknown type is refused', r.unknownType === 'unsupported_type', r.unknownType);
}

// --- apprise -----------------------------------------------------------------
// Apprise 渠道 / Apprise channel

console.log('\napprise: the destinations are not optional\n');
{
  const r = await call('/apprise');

  /** Regression: missing `urls` falls back to Apprise's own config or returns 400. / 回归：缺少 `urls` 会退回 Apprise 自身配置或返回 400。 */
  check('stateless sends urls', typeof r.statelessBody.urls === 'string' && r.statelessBody.urls.includes('tgram://'),
    JSON.stringify(r.statelessBody));
  check('stateless posts to the url as given', r.statelessUrl === 'https://apprise.example.com/notify', r.statelessUrl);
  check('stateless sends no key field', r.statelessBody.key === undefined, JSON.stringify(r.statelessBody));
  check('the message goes in body', typeof r.statelessBody.body === 'string' && r.statelessBody.body.includes('prod site'),
    JSON.stringify(r.statelessBody.body));
  check('a title is sent', typeof r.statelessBody.title === 'string', JSON.stringify(r.statelessBody.title));
  check('severity maps DOWN to failure', r.statelessBody.type === 'failure', r.statelessBody.type);

  // Stateful: the key is a path segment, and urls must be omitted so the saved
  // configuration supplies the destinations rather than being overridden.
  // 有状态模式中 key 是路径段，必须省略 urls，以使用而非覆盖已保存配置中的目的地。
  check('stateful puts the key in the path',
    r.statefulUrl === 'https://apprise.example.com/notify/my-config-id', r.statefulUrl);
  check('stateful omits urls', r.statefulBody.urls === undefined, JSON.stringify(r.statefulBody));

  // 424 is the real failure signal; the body-field check this replaced looked for
  // a `success` key that the API contract does not define.
  // 424 是真实失败信号；此前检查正文 success 字段，但 API 契约并未定义该字段。
  check('424 is reported as a failure', r.failed.ok === false, JSON.stringify(r.failed));
  check('and the provider log is surfaced', /Failed to send/.test(r.failed.error ?? ''), r.failed.error);

  // A 200 body is a log listing, not a verdict.
  // 200 正文是日志列表，而不是成功与否的判定。
  check('a 200 with a log body is a success', r.logged.ok === true, JSON.stringify(r.logged));
}

// --- the other providers -----------------------------------------------------
// 其他供应商 / Other providers

console.log('\nslack, discord, webhook, serverchan\n');
{
  const r = await call('/other-providers');

  // Slack answers 200 with the literal text `ok`, which is not JSON.
  // Slack 返回 200 和字面文本 ok，而非 JSON。
  check('slack: 200 "ok" is a success', r.slackRes.ok === true, JSON.stringify(r.slackRes));
  check('slack: message in text', r.slackBody.text.includes('prod site'), JSON.stringify(r.slackBody.text));
  check('slack: link unfurling is off', r.slackBody.unfurl_links === false, JSON.stringify(r.slackBody));
  check('slack: a 4xx body is surfaced', r.slackBad.ok === false && r.slackBad.error === 'invalid_payload',
    JSON.stringify(r.slackBad));

  // Discord answers 204 with no body at all - nothing to parse, nothing to miss.
  // Discord 返回无正文的 204，不需要解析正文。
  check('discord: 204 is a success', r.discordRes.ok === true, JSON.stringify(r.discordRes));
  check('discord: message in content', r.discordBody.content.includes('prod site'), JSON.stringify(r.discordBody));

  check('webhook: 2xx is a success', r.hookRes.ok === true, JSON.stringify(r.hookRes));
  check('webhook: body is structured, not prose', r.hookBody.monitor?.name === 'prod site',
    JSON.stringify(r.hookBody));
  check('webhook: transition is stated explicitly', r.hookBody.transition === 'UP -> DOWN',
    JSON.stringify(r.hookBody.transition));
  check('webhook: recovered is false for a DOWN', r.hookBody.recovered === false, JSON.stringify(r.hookBody.recovered));
  check('webhook: a machine-readable time', /^\d{4}-\d{2}-\d{2}T/.test(r.hookBody.time ?? ''),
    JSON.stringify(r.hookBody.time));
  check('webhook: secret becomes a bearer header', r.hookAuth === 'Bearer sekret', String(r.hookAuth));

  // ServerChan: 200 with a non-zero code is the same trap as Telegram.
  // ServerChan 的 200 和非零 code 与 Telegram 存在同样的陷阱。
  check('serverchan: non-zero code is a failure', r.scBad.ok === false, JSON.stringify(r.scBad));
  check('serverchan: the provider message is surfaced', r.scBad.error === 'bad pushtoken', r.scBad.error);
  check('serverchan: send URL uses the current account host', r.scUrl === 'https://1234.push.ft07.com/send/sctp1234tabcdef.send', r.scUrl);
  check('serverchan: sctp key puts the account id in the host',
    r.scModernUrl === 'https://1234.push.ft07.com/send/sctp1234tabcdef.send', r.scModernUrl);
  check('serverchan: a zero code is a success', r.scOk.ok === true, JSON.stringify(r.scOk));
}

// --- routes -----------------------------------------------------------------
// 路由 / Routes

console.log('\nchannel routes\n');
{
  const setup = await call('/routes-setup');
  check('table starts empty', setup !== undefined);

  const bad = await postJson('/api/notifications', {
    name: 'ops', type: 'telegram', config: { chat_id: '1' },
  });
  // The body is read once: a Response is single-use, and reading it again for the
  // detail argument would throw instead of reporting the failure.
  // 正文只能读取一次：Response 是一次性的，再次读取以生成详情会抛错而非报告失败。
  const badBody = await bad.json();
  check('POST rejects a config missing a field with 400', bad.status === 400, bad.status);
  check('and names the field', badBody.error === 'telegram_token_required', badBody);

  const created = await postJson('/api/notifications', {
    name: 'ops', type: 'feishu', config: { webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' },
  });
  check('POST creates a channel with 201', created.status === 201, created.status);
  const { id } = await created.json();

  const list = await call('/api/notifications');
  check(
    'GET returns the channel with its config, which the edit form needs',
    list.channels.length === 1 && list.channels[0].config.webhook_url.endsWith('/x'),
    list.channels,
  );

  const put = await postJson(`/api/notifications/${id}`, { active: 0 }, 'PUT');
  check('PUT updates', put.status === 200 && (await put.json()).ok === true, put.status);

  const missing = await postJson('/api/notifications/no-such-id', { active: 1 }, 'PUT');
  check('PUT on an unknown id is 404', missing.status === 404, missing.status);

  // A type change with no config must be refused rather than stored as a channel
  // whose config cannot satisfy its own type.
  // 更改类型但未提供配置时必须拒绝，不能存储配置不符合自身类型的渠道。
  const retype = await postJson(`/api/notifications/${id}`, { type: 'telegram' }, 'PUT');
  check('PUT changing type without a matching config is 400', retype.status === 400, retype.status);

  /** Test send always returns 200 so the provider's error text reaches the console. / 测试发送始终 200，让提供商错误文本到达控制台。 */
  const okTest = await raw(`/api/notifications/${id}/test`, { method: 'POST' });
  check('POST /test sends the synthetic event and reports {ok:true} on 200', okTest.status === 200 && (await okTest.json()).ok === true, okTest.status);

  const failedTest = await raw('/api/notifications/no-such-id/test', { method: 'POST' });
  check(
    'POST /test reports a failure in the body, still with 200',
    failedTest.status === 200 && (await failedTest.json()).ok === false,
    failedTest.status,
  );

  /* 删除一个渠道时仅清理其投递记录，保留另一个渠道的记录。
   * Deleting one channel must clear its delivery records while retaining the other channel's records. */
  const db = await mf.getD1Database('DB');
  const otherChannel = await postJson('/api/notifications', {
    name: 'bystander', type: 'telegram', config: { bot_token: 'T', chat_id: '2' },
  }).then((r) => r.json());
  const seedDelivery = (rowId, channelId) => db.prepare(
    'INSERT INTO notification_deliveries (id, channel_id, monitor_id, monitor_name, status, ok, latency_ms, error, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).bind(rowId, channelId, null, null, 0, 0, 12, 'chat not found', 1750000000).run();
  await seedDelivery('orphan-a', id);
  await seedDelivery('orphan-b', id);
  await seedDelivery('bystander-a', otherChannel.id);

  const del = await raw(`/api/notifications/${id}`, { method: 'DELETE' });
  check('DELETE removes it', del.status === 200 && (await del.json()).ok === true, del.status);

  const orphanCount = await db.prepare('SELECT COUNT(*) AS n FROM notification_deliveries WHERE channel_id = ?')
    .bind(id).first().then((row) => row.n);
  check('DELETE leaves no delivery history behind for the channel', orphanCount === 0, orphanCount);
  const bystanderCount = await db.prepare('SELECT COUNT(*) AS n FROM notification_deliveries WHERE channel_id = ?')
    .bind(otherChannel.id).first().then((row) => row.n);
  check("and another channel's history is untouched", bystanderCount === 1, bystanderCount);
  await raw(`/api/notifications/${otherChannel.id}`, { method: 'DELETE' });

  const gone = await raw(`/api/notifications/${id}`, { method: 'DELETE' });
  check('DELETE on an unknown id is 404', gone.status === 404, gone.status);
}

console.log('\nnotification outbound security\n');
{
  const targets = [
    ['https://probe-user:probe-password@health.example/check/path?token=probe-token#access_token=fragment-token', 'https://health.example/check/path', 'http'],
    ['probe-user:probe-password@db.example:5432/check?password=probe-token#access_token=fragment-token', 'db.example:5432/check', 'tcp'],
    ['db.example:5432', 'db.example:5432', 'tcp'],
  ];
  for (const type of ['telegram', 'feishu', 'slack', 'discord', 'webhook', 'apprise', 'serverchan']) {
    for (const [target, expected, monitorType] of targets) {
      const response = await postJson('/message-language', { type, language: 'en-US', event: { monitorTarget: target, monitorType, message: 'HTTP 503 at ' + target } });
      const result = await response.json();
      const rawBody = result.sent[0]?.body ?? '';
      const payload = type === 'serverchan' ? null : JSON.parse(rawBody);
      const text = type === 'serverchan' ? new URLSearchParams(rawBody).get('desp')
        : type === 'feishu' ? payload.content.text : type === 'discord' ? payload.content : type === 'apprise' ? payload.body : payload.text;
      check(type + ' sends a readable redacted target', result.result.ok === true && text.includes('Target: ' + expected) && text.includes('HTTP 503'), text);
      check(type + ' removes target credentials from all outbound fields', ['probe-user', 'probe-password', 'probe-token', 'fragment-token'].every(secret => !rawBody.includes(secret)), rawBody);
      if (type === 'webhook') check('webhook structured and rendered targets agree', payload.monitor.target === expected, payload.monitor);
    }
  }
  for (const [type, config, secrets] of [
    ['telegram', { bot_token: TELEGRAM_FIXTURE_TOKEN, chat_id: '1', language: 'zh-CN' }, [TELEGRAM_FIXTURE_TOKEN]],
    ['webhook', { url: 'https://hooks.example/private-hook-path?token=query-secret', secret: 'boundary+secret/value', language: 'zh-CN' }, ['https://hooks.example/private-hook-path?token=query-secret', 'private-hook-path', 'query-secret', 'boundary+secret/value']],
    ['apprise', { url: 'https://apprise.example/notify', urls: 'tgram://bot-user:bot-password@private-channel', language: 'zh-CN' }, ['tgram://bot-user:bot-password@private-channel', 'bot-user', 'bot-password']],
  ]) {
    const reason = 'http_503 provider unavailable ' + secrets.flatMap(value => [value, encodeURIComponent(value)]).join(' ');
    for (const thrown of [false, true]) {
      const response = await postJson('/notification-boundary', { type, config, reason, throw: thrown });
      const result = await response.json();
      check(type + ' ' + thrown + ' fails rather than claiming delivery', result.direct.ok === false && result.test.ok === false && result.deliveries.deliveries.length > 0 && result.failures.length > 0, result);
      check(type + ' ' + thrown + ' retains useful provider diagnostics', result.direct.error?.includes('provider unavailable') && result.direct.error?.includes('http_503'), result.direct);
      const surfaces = JSON.stringify(result);
      check(type + ' ' + thrown + ' scrubs direct result, test API, history and logs', secrets.every(secret => !surfaces.includes(secret) && !surfaces.includes(encodeURIComponent(secret))), result);
    }
  }
}

console.log('\nnotification languages\n');
{
  const codes = ['en-US', 'zh-CN', 'zh-TW', 'zh-HK', 'ja-JP', 'ko-KR', 'fr-FR', 'pt-BR', 'ru-RU'];
  const types = ['telegram', 'feishu', 'slack', 'discord', 'webhook', 'apprise', 'serverchan'];
  const name = 'a<b>&"c"{state}';
  const diagnostic = 'HTTP 503 {value} & <raw>';
  const catalogs = Object.fromEntries(codes.map(code => [code, JSON.parse(readFileSync('frontend/src/locales/admin/' + code + '.json', 'utf8')).notify.message]));
  const uiLocales = readFileSync('frontend/src/i18n/config.ts', 'utf8');
  for (const code of codes) check(code + ' is available in the interface', uiLocales.includes("key: '" + code + "'"));
  function content(type, body) {
    if (type === 'serverchan') {
      const form = new URLSearchParams(body);
      return { text: form.get('desp'), title: form.get('title') };
    }
    const payload = JSON.parse(body);
    return {
      text: type === 'feishu' ? payload.content.text : type === 'discord' ? payload.content : type === 'apprise' ? payload.body : payload.text,
      title: payload.title,
      payload,
    };
  }
  for (const language of codes) {
    const copy = catalogs[language];
    for (const type of types) {
      const response = await postJson('/message-language', { type, language, event: { monitorName: name, message: diagnostic } });
      const result = await response.json();
      const body = content(type, result.sent[0].body);
      check(language + ' ' + type + ' sends successfully', result.result.ok === true, result.result);
      check(language + ' ' + type + ' localizes fields and state', body.text.includes(copy.target.split('{value}')[0]) && body.text.includes(copy.down), body.text);
      check(language + ' ' + type + ' preserves raw values without interpreting placeholders', type === 'telegram'
        ? body.text.includes('a&lt;b&gt;&amp;&quot;c&quot;{state}') && body.text.includes('HTTP 503 {value} &amp; &lt;raw&gt;')
        : body.text.includes(name) && body.text.includes(diagnostic), body.text);
      if (body.title) check(language + ' ' + type + ' localizes its title', body.title.includes(copy.down), body.title);
      if (type === 'webhook') check(language + ' webhook keeps stable structured fields', body.payload.event === 'down' && body.payload.status === 0 && body.payload.transition === 'UP -> DOWN', body.payload);
    }
    for (const [label, over, expected] of [
      ['recovery', { status: 1, prevStatus: 0 }, copy.recovered.replace('{name}', 'prod site')],
      ['warning', { status: 2 }, copy.warn],
      ['first reading', { prevStatus: null }, copy.firstState.replace('{state}', copy.down)],
    ]) {
      const response = await postJson('/message-language', { type: 'feishu', language, event: over });
      const result = await response.json();
      const text = content('feishu', result.sent[0].body).text;
      check(language + ' localizes ' + label, text.includes(expected), text);
    }
    for (const [label, over, action] of [
      ['first normal reading', { status: 1, prevStatus: null }, copy.actionUpCurrent],
      ['normal status without a transition', { status: 1, prevStatus: 1 }, copy.actionUpCurrent],
      ['recovery from failure', { status: 1, prevStatus: 0 }, copy.actionUp],
      ['recovery from warning', { status: 1, prevStatus: 2 }, copy.actionUp],
      ['agent resource recovery', { monitorType: 'agent', eventKey: 'resource:cpu:recovery', status: 1, prevStatus: 2 }, copy.actionUp],
    ]) {
      const response = await postJson('/message-language', { type: 'feishu', language, event: over });
      const result = await response.json();
      const text = content('feishu', result.sent[0].body).text;
      check(language + ' selects the action for ' + label, text.includes(copy.action.replace('{value}', action)), text);
    }
  }

  await call('/routes-setup');
  const config = { webhook_url: 'https://hook.fixture.test', language: 'zh-CN' };
  const created = await postJson('/api/notifications', { name: 'localized', type: 'feishu', config }).then(r => r.json());
  const first = await call('/api/notifications');
  check('language is stored and read back through the channel API', first.channels[0].config.language === 'zh-CN', first.channels);
  await postJson('/api/notifications/' + created.id, { active: 0 }, 'PUT');
  const paused = await call('/api/notifications');
  check('partial channel updates preserve language and credentials', paused.channels[0].config.language === 'zh-CN' && paused.channels[0].config.webhook_url === config.webhook_url, paused.channels);
  for (const language of ['zz-ZZ', 'zh', '', null, 42, {}, []]) {
    const badConfig = { ...config, language };
    for (const [method, path] of [['POST', '/api/notifications'], ['PUT', '/api/notifications/' + created.id]]) {
      const response = await postJson(path, { name: 'invalid', type: 'feishu', config: badConfig }, method);
      const body = await response.json();
      check(method + ' rejects malformed or unsupported language ' + JSON.stringify(language), response.status === 400 && body.error === 'notification_language_invalid', body);
    }
  }
  const unchanged = await call('/api/notifications');
  check('invalid language writes do not modify or create channels', unchanged.channels.length === 1 && unchanged.channels[0].name === 'localized' && unchanged.channels[0].config.language === 'zh-CN', unchanged.channels);
  const test = await postJson('/api/notifications/' + created.id + '/test', {}).then(r => r.json());
  const testSent = await call('/language-route-sent');
  const testText = JSON.parse(testSent.sent.at(-1).body).content.text;
  check('saved language applies to the synthetic test name and message', test.ok && testText.includes(catalogs['zh-CN'].testName) && testText.includes(catalogs['zh-CN'].testBody), testText);
  await postJson('/api/notifications/' + created.id, { config: { ...config, language: 'ja-JP' } }, 'PUT');
  await postJson('/api/notifications/' + created.id + '/test', {});
  const changedSent = await call('/language-route-sent');
  const changedText = JSON.parse(changedSent.sent.at(-1).body).content.text;
  check('editing a saved language changes subsequent test sends', changedText.includes(catalogs['ja-JP'].testBody) && !changedText.includes(catalogs['zh-CN'].testBody), changedText);
  await raw('/api/notifications/' + created.id, { method: 'DELETE' });

  const retry = await call('/language-retry');
  check('one event can reach channels in different languages', retry.initial.some(x => x.url.includes('cn.fixture') && x.payload.text.includes(catalogs['zh-CN'].down)) && retry.initial.some(x => x.url.includes('en.fixture') && x.payload.text.includes(catalogs['en-US'].down)), retry.initial);
  check('persistent retries load each channel language independently', retry.updated === 200 && retry.retried.some(x => x.url.includes('cn.fixture') && x.payload.text.includes(catalogs['zh-CN'].down)) && retry.retried.some(x => x.url.includes('en.fixture') && x.payload.text.includes(catalogs['fr-FR'].down)) && retry.pending === 0, retry);
}

// --- delivery log -----------------------------------------------------------
// 投递日志 / Delivery log

console.log('\ndelivery log\n');
{
  /** Drive a real dispatch then read the log endpoints, so the route test is not against an empty table. / 驱动真实发送再读日志端点，避免对着空表测试。 */
  const channel = await call('/deliveries-run');

  const statsRes = await call('/api/notifications/stats');
  const stat = statsRes.channels[channel.id];
  check('stats: the channel appears', stat !== undefined, JSON.stringify(statsRes.channels));
  check('stats: two attempts counted', stat?.sent24h === 2, stat?.sent24h);
  check('stats: one failure counted', stat?.failed24h === 1, stat?.failed24h);
  check('stats: 24 hourly slots', Array.isArray(stat?.hourly) && stat.hourly.length === 24, stat?.hourly?.length);
  check('stats: latency is a number', typeof stat?.avgLatencyMs === 'number' && stat.avgLatencyMs >= 0, stat?.avgLatencyMs);

  const logRes = await call('/api/notifications/deliveries?limit=10');
  check('deliveries: both attempts are listed', logRes.deliveries.length === 2, logRes.deliveries.length);
  check(
    'deliveries: newest first',
    logRes.deliveries[0].created_at >= logRes.deliveries[1].created_at,
    logRes.deliveries.map((d) => d.created_at),
  );
  const failedRow = logRes.deliveries.find((d) => d.ok === false);
  check('deliveries: the failed one is marked failed', failedRow !== undefined);
  check(
    'deliveries: the provider error is surfaced',
    failedRow?.error?.includes('chat not found') || failedRow?.error?.includes('invalid token'),
    failedRow?.error,
  );
  check(
    'deliveries: a credential echoed by the provider is scrubbed',
    !failedRow?.error?.includes(TELEGRAM_FIXTURE_TOKEN),
    failedRow?.error,
  );
  check(
    'deliveries: monitor name is denormalised onto the row',
    logRes.deliveries.some((d) => d.monitor_name === 'prod site'),
    logRes.deliveries.map((d) => d.monitor_name),
  );

  // `limit` is clamped rather than trusted.
  // 限制 limit 范围，而非直接信任输入。
  const one = await call('/api/notifications/deliveries?limit=1');
  check('deliveries: limit is honoured', one.deliveries.length === 1, one.deliveries.length);
}

console.log('\nretry ordering and maintenance');
{
  const order = await call('/retry-order');
  check('recovery waits for the older failed transition', order.duringBackoff.length === 0, order);
  check('successful delivery preserves DOWN then UP order', JSON.stringify(order.delivered) === '[0,1]', order);
  const maintenance = await call('/retry-maintenance');
  check('maintenance blocks already queued retries', maintenance.during === 0, maintenance);
  check('queued retries resume after maintenance', maintenance.after === 1, maintenance);
}

await mf.dispose();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
