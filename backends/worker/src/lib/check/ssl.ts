import { UP, WARN } from '../../types';
import { ExternalBudgetExceeded, type ExternalRequestBudget } from '../http/request-budget';
import { CtSourceError, ctSources, providerKey } from './ct/providers';
import { dnsName, type CtCertificate } from './ct/records';
import type { CheckResult } from './types';

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_LIMIT = 128;

export interface SslCheckOptions {
  host: string;
  timeoutMs: number;
  warnDays: number;
  budget?: ExternalRequestBudget;
}

interface CachedCertificate {
  certificate: CtCertificate;
  checkedAt: number;
}

const cache = new Map<string, CachedCertificate>();

export function sslProviderKey(): string { return providerKey(); }

function reading(value: CachedCertificate, host: string, started: number, warnDays: number): CheckResult {
  const certificate = value.certificate;
  const days = (certificate.notAfter - Date.now()) / 86_400_000;
  const revocation = certificate.revoked ? ' · certificate revoked' : '';
  return {
    status: !certificate.revoked && days > warnDays ? UP : WARN,
    latencyMs: Date.now() - started, statusCode: 0,
    observedAt: Math.floor(value.checkedAt / 1000), daysLeft: days,
    ...(certificate.revoked ? { revoked: true } : {}),
    message: `SSL: ${host} · expires ${new Date(certificate.notAfter).toISOString().slice(0, 10)} · ${Math.round(days)} days left${revocation} · ${certificate.issuer || 'issuer unknown'}`,
  };
}

/** CT 记录不证明目标当前部署了哪张证书。 / CT records do not prove which certificate the target currently serves. */
export async function checkSsl(options: SslCheckOptions): Promise<CheckResult> {
  const started = Date.now();
  const host = dnsName(options.host);
  if (!host) return { status: WARN, latencyMs: 0, statusCode: 0, message: 'SSL monitoring requires a public DNS hostname; expiry unknown.' };
  const key = `${providerKey()}|${host}`;
  const cached = cache.get(key);
  if (cached && cached.checkedAt <= started && started - cached.checkedAt < CACHE_TTL_MS &&
    Math.floor(cached.checkedAt / 86_400_000) === Math.floor(started / 86_400_000)) return reading(cached, host, started, options.warnDays);
  cache.delete(key);

  const sources = ctSources();
  const failures: string[] = [];
  const overall = new AbortController();
  const deadline = started + options.timeoutMs;
  const timer = setTimeout(() => overall.abort(), options.timeoutMs);
  try {
    for (let index = 0; index < sources.length; index++) {
      if (overall.signal.aborted || Date.now() >= deadline) break;
      const source = sources[index];
      const controller = new AbortController();
      const onOverallAbort = () => controller.abort();
      overall.signal.addEventListener('abort', onOverallAbort, { once: true });
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new CtSourceError('timed out'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      const sourceTimer = setTimeout(() => controller.abort(), Math.max(1, Math.floor((deadline - Date.now()) / (sources.length - index))));
      try {
        const certificate = await Promise.race([source.query({ host, signal: controller.signal, budget: options.budget }), aborted]);
        if (controller.signal.aborted || Date.now() >= deadline) throw new CtSourceError('timed out');
        if (certificate) {
          const result = { certificate, checkedAt: Date.now() };
          if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
          cache.set(key, result);
          return reading(result, host, started, options.warnDays);
        }
        failures.push(`${source.name}: no matching started certificate`);
      } catch (error) {
        if (error instanceof ExternalBudgetExceeded) throw error;
        failures.push(`${source.name}: ${controller.signal.aborted ? 'timed out' : error instanceof CtSourceError ? error.message : 'unavailable'}`);
      } finally {
        clearTimeout(sourceTimer);
        overall.signal.removeEventListener('abort', onOverallAbort);
        controller.signal.removeEventListener('abort', onAbort);
        controller.abort();
      }
    }
    return {
      status: WARN, latencyMs: Date.now() - started, statusCode: 0,
      message: `SSL check ${overall.signal.aborted ? 'timed out' : 'failed'}; expiry unknown. ${failures.join('; ')}. Try again later.`,
    };
  } catch (error) {
    if (error instanceof ExternalBudgetExceeded) return {
      status: WARN, latencyMs: 0, statusCode: 0, observedAt: 0,
      message: 'SSL check deferred: Worker request budget exhausted; expiry unknown.',
    };
    return { status: WARN, latencyMs: Date.now() - started, statusCode: 0, message: 'Could not check the SSL certificate; expiry unknown. Try again later.' };
  } finally {
    clearTimeout(timer);
    overall.abort();
  }
}
