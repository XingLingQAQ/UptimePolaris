export interface AgentContainer {
  id: string;
  name: string;
  image?: string;
  runtime: 'docker' | 'podman';
  state: 'running' | 'exited' | 'restarting' | 'paused' | 'dead' | 'created' | 'unknown';
  health?: 'healthy' | 'unhealthy' | 'starting' | 'none';
  cpu_pct?: number | null;
  mem_used_bytes?: number | null;
  mem_limit_bytes?: number | null;
  restart_count?: number | null;
  uptime_sec?: number | null;
}

const METRICS = {
  cpu_pct: 100_000,
  mem_used_bytes: Number.MAX_SAFE_INTEGER,
  mem_limit_bytes: Number.MAX_SAFE_INTEGER,
  restart_count: 1_000_000,
  uptime_sec: 3_153_600_000,
} as const;

function validText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit * 2 && value.trim().length > 0 &&
    Array.from(value).length <= limit && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

export function asContainerStats(value: unknown): AgentContainer[] | null | undefined {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const out: AgentContainer[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const row = item as Record<string, unknown>;
    if (!validText(row.id, 64) || ids.has(row.id) || !validText(row.name, 128) ||
        !['docker', 'podman'].includes(row.runtime as string) ||
        !['running', 'exited', 'restarting', 'paused', 'dead', 'created', 'unknown'].includes(row.state as string)) return undefined;
    ids.add(row.id);
    const container: AgentContainer = { id: row.id, name: row.name,
      runtime: row.runtime as AgentContainer['runtime'], state: row.state as AgentContainer['state'] };
    if (row.image !== undefined) {
      if (!validText(row.image, 256)) return undefined;
      container.image = row.image;
    }
    if (row.health !== undefined) {
      if (!['healthy', 'unhealthy', 'starting', 'none'].includes(row.health as string)) return undefined;
      container.health = row.health as AgentContainer['health'];
    }
    for (const key of Object.keys(METRICS) as (keyof typeof METRICS)[]) {
      const metric = row[key];
      if (metric === undefined) continue;
      if (metric !== null && (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0 ||
          metric > METRICS[key] || key !== 'cpu_pct' && !Number.isSafeInteger(metric))) return undefined;
      container[key] = metric as number | null;
    }
    out.push(container);
  }
  return out;
}
