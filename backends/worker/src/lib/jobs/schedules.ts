/**
 * Cron schedule strings, shared between wrangler.toml and the handler.
 *
 * These live outside src/index.ts on purpose: the Workers modules runtime
 * treats every named export of the entry module as a handler or Durable Object
 * class, and rejects anything that is not callable.
 * wrangler.toml 和处理器共用的 Cron 表达式。它们刻意放在 src/index.ts 之外：
 * Workers 模块运行时将入口的所有具名导出视为处理器或 Durable Object 类，
 * 并拒绝不可调用的导出。
 */
export const CRON_TICK = '* * * * *';
export const CRON_SYNC = '10 0 * * *';
