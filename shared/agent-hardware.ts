export interface AgentGpu {
  index: number;
  name: string;
  vendor?: string;
  util_pct?: number | null;
  mem_used_bytes?: number | null;
  mem_total_bytes?: number | null;
  temp_c?: number | null;
  power_w?: number | null;
}

export interface AgentSensor {
  name: string;
  kind?: 'cpu' | 'disk' | 'gpu' | 'other';
  temp_c: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && value.trim().length > 0 &&
    Array.from(value).length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

const GPU_METRICS = {
  util_pct: [0, 100],
  mem_used_bytes: [0, Number.MAX_SAFE_INTEGER],
  mem_total_bytes: [0, Number.MAX_SAFE_INTEGER],
  temp_c: [-100, 250],
  power_w: [0, 10_000],
} as const;

export function asGpuStats(value: unknown): AgentGpu[] | null | undefined {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const out: AgentGpu[] = [];
  const indices = new Set<number>();
  for (const item of value) {
    const row = record(item);
    if (!row || !inRange(row.index, 0, 65535) || !Number.isInteger(row.index) ||
        indices.has(row.index) || !validName(row.name)) return undefined;
    const gpu: AgentGpu = { index: row.index, name: row.name };
    indices.add(gpu.index);
    if (row.vendor !== undefined) {
      if (!validName(row.vendor)) return undefined;
      gpu.vendor = row.vendor;
    }
    for (const key of Object.keys(GPU_METRICS) as (keyof typeof GPU_METRICS)[]) {
      const metric = row[key];
      if (metric === undefined) continue;
      const [min, max] = GPU_METRICS[key];
      if (metric !== null && (!inRange(metric, min, max) ||
          (key === 'mem_used_bytes' || key === 'mem_total_bytes') && !Number.isSafeInteger(metric))) return undefined;
      gpu[key] = metric as number | null;
    }
    if (gpu.mem_used_bytes != null && gpu.mem_total_bytes != null && gpu.mem_used_bytes > gpu.mem_total_bytes) return undefined;
    out.push(gpu);
  }
  return out;
}

export function asSensorStats(value: unknown): AgentSensor[] | null | undefined {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const out: AgentSensor[] = [];
  for (const item of value) {
    const row = record(item);
    if (!row || !validName(row.name) || !inRange(row.temp_c, -100, 250)) return undefined;
    const sensor: AgentSensor = { name: row.name, temp_c: row.temp_c };
    if (row.kind !== undefined) {
      if (!['cpu', 'disk', 'gpu', 'other'].includes(row.kind as string)) return undefined;
      sensor.kind = row.kind as AgentSensor['kind'];
    }
    out.push(sensor);
  }
  return out;
}
