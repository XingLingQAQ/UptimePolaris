import { useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { AlertTriangle, ChevronDown, Monitor, Thermometer, Zap } from 'lucide-react';
import { asGpuStats, asSensorStats } from '../../../../shared/agent-hardware';
import { Meter } from '../../components/ui/MetricMeters';
import { IconTile } from '../components/IconTile';
import { formatBytes, formatPercent } from '../format';

const SENSOR_PREVIEW_LIMIT = 6;

function formatOneDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function TemperatureReading({ value }: { value: number | null | undefined }) {
  const t = useTranslations('admin.agents');
  if (value == null) return <>—</>;
  const tone = value >= 95
    ? 'text-danger-600 dark:text-danger-400'
    : value >= 85 ? 'text-warning-700 dark:text-warning-400' : 'text-foreground';
  return (
    <span className={`inline-flex items-center gap-1.5 ${tone}`}>
      {value >= 85 ? (
        <>
          <AlertTriangle size={13} className="shrink-0" aria-hidden="true" />
          <span className="sr-only">{t('hardwareHighTemperature')}</span>
        </>
      ) : null}
      {t('hardwareTemperatureValue', { value: formatOneDecimal(value) })}
    </span>
  );
}

function readStats<T>(raw: string | null | undefined, parse: (value: unknown) => T[] | null | undefined): T[] | null {
  if (!raw) return null;
  try { return parse(JSON.parse(raw)) ?? null; } catch { return null; }
}

export function AgentHardwareCards({ gpusJson, sensorsJson }: {
  gpusJson?: string | null;
  sensorsJson?: string | null;
}) {
  const t = useTranslations('admin.agents');
  const gpus = useMemo(() => readStats(gpusJson, asGpuStats), [gpusJson]);
  const sensors = useMemo(() => {
    const rows = readStats(sensorsJson, asSensorStats);
    return rows?.sort((a, b) => Number(b.temp_c >= 85) - Number(a.temp_c >= 85)) ?? null;
  }, [sensorsJson]);
  const [expandedSensors, setExpandedSensors] = useState(false);
  if (!gpus?.length && !sensors?.length) return null;
  const maxTemp = sensors?.length ? Math.max(...sensors.map(sensor => sensor.temp_c)) : null;
  const visibleSensors = expandedSensors ? sensors : sensors?.slice(0, SENSOR_PREVIEW_LIMIT);

  return (
    <>
      {gpus && gpus.length > 0 ? (
        <section className="polaris-card overflow-hidden" aria-label={t('sectionGpus')}>
          <div className="flex items-center justify-between gap-2 px-4 py-3">
            <h3 className="flex items-center gap-2.5 text-small font-semibold">
              <IconTile icon={<Monitor />} hue="default" size="sm" />{t('sectionGpus')}
              <span className="rounded-full bg-[var(--polaris-active)] px-2 py-0.5 text-[11px] font-medium tabular-nums text-default-500">{gpus.length}</span>
            </h3>
          </div>
          <div className="polaris-divide border-t border-[var(--polaris-line-soft)]">
            {gpus.map(gpu => {
              const hasMem = gpu.mem_used_bytes != null || gpu.mem_total_bytes != null;
              const memPct = gpu.mem_used_bytes != null && gpu.mem_total_bytes != null && gpu.mem_total_bytes > 0
                ? (gpu.mem_used_bytes / gpu.mem_total_bytes) * 100 : null;
              return (
                <div key={gpu.index} className="space-y-3 px-4 py-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <div className="min-w-0 flex-1 basis-40">
                      <p className="break-words text-small font-medium [overflow-wrap:anywhere]">{gpu.name}</p>
                      <p className="mt-0.5 break-words text-tiny text-default-500 [overflow-wrap:anywhere]">
                        {t('gpuIndex', { index: gpu.index })}{gpu.vendor ? ` · ${gpu.vendor}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="polaris-well inline-flex items-center gap-1.5 px-2.5 py-1 text-tiny tabular-nums">
                        <Thermometer size={12} className="shrink-0 text-default-400" aria-hidden="true" />
                        <span className="sr-only">{t('hardwareTemperature')}: </span>
                        <TemperatureReading value={gpu.temp_c} />
                      </span>
                      <span className="polaris-well inline-flex items-center gap-1.5 px-2.5 py-1 text-tiny tabular-nums">
                        <Zap size={12} className="shrink-0 text-default-400" aria-hidden="true" />
                        <span className="sr-only">{t('gpuPower')}: </span>
                        {gpu.power_w == null ? '—' : t('hardwarePowerValue', { value: formatOneDecimal(gpu.power_w) })}
                      </span>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex items-baseline justify-between gap-2 text-tiny">
                        <span className="text-default-500">{t('gpuUtilization')}</span>
                        <span className="shrink-0 font-medium tabular-nums">{formatPercent(gpu.util_pct)}</span>
                      </div>
                      {gpu.util_pct != null ? (
                        <Meter value={gpu.util_pct} tone={gpu.util_pct >= 90 ? 'warn' : 'primary'} label={t('gpuUtilizationFor', { name: gpu.name })} />
                      ) : null}
                    </div>
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex items-baseline justify-between gap-2 text-tiny">
                        <span className="text-default-500">{t('gpuMemory')}</span>
                        <span className="shrink-0 font-medium tabular-nums">
                          {hasMem ? `${formatBytes(gpu.mem_used_bytes)} / ${formatBytes(gpu.mem_total_bytes)}` : '—'}
                        </span>
                      </div>
                      {memPct != null ? (
                        <Meter value={memPct} tone={memPct >= 90 ? 'down' : memPct >= 75 ? 'warn' : 'primary'} label={t('gpuMemoryFor', { name: gpu.name })} />
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
      {sensors && sensors.length > 0 ? (
        <section className="polaris-card overflow-hidden" aria-label={t('sectionSensors')}>
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <h3 className="flex items-center gap-2.5 text-small font-semibold">
              <IconTile icon={<Thermometer />} hue="default" size="sm" />{t('sectionSensors')}
              <span className="rounded-full bg-[var(--polaris-active)] px-2 py-0.5 text-[11px] font-medium tabular-nums text-default-500">{sensors.length}</span>
            </h3>
            <span className="flex items-center gap-2 text-tiny tabular-nums">
              <span className="text-default-500">{t('hardwarePeakTemperature')}</span>
              <TemperatureReading value={maxTemp} />
            </span>
          </div>
          <div className="border-t border-[var(--polaris-line-soft)] p-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {visibleSensors?.map((sensor, index) => (
                <div key={`${sensor.name}-${index}`} className="polaris-well flex items-center justify-between gap-3 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-small" title={sensor.name}>{sensor.name}</span>
                    {sensor.kind ? (
                      <span className="shrink-0 rounded border border-[var(--polaris-line-soft)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-default-500">
                        {t(`sensorKind.${sensor.kind}`)}
                      </span>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-small font-medium tabular-nums"><TemperatureReading value={sensor.temp_c} /></span>
                </div>
              ))}
            </div>
            {sensors.length > SENSOR_PREVIEW_LIMIT ? (
              <button
                type="button"
                aria-expanded={expandedSensors}
                onClick={() => setExpandedSensors(value => !value)}
                className="mt-2.5 flex w-full cursor-pointer items-center justify-center gap-1 rounded-lg border border-[var(--polaris-line-soft)] py-1.5 text-tiny font-medium text-default-500 transition-colors hover:bg-[var(--polaris-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {expandedSensors ? t('hardwareShowLess') : t('hardwareShowAll', { count: sensors.length })}
                <ChevronDown size={14} className={expandedSensors ? 'rotate-180 transition-transform' : 'transition-transform'} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
    </>
  );
}
