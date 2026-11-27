import { useMemo } from 'react';
import { useTranslations } from 'use-intl';
import { Cpu, Thermometer, AlertTriangle } from 'lucide-react';
import { asGpuStats, asSensorStats } from '../../../../shared/agent-hardware';
import { Meter } from '../../components/ui/MetricMeters';
import { IconTile } from '../components/IconTile';
import { formatBytes, formatPercent } from '../format';

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
  const sensors = useMemo(() => readStats(sensorsJson, asSensorStats), [sensorsJson]);
  if (!gpus?.length && !sensors?.length) return null;
  const temperature = (value: number | null | undefined) => value == null ? '—' : t('hardwareTemperatureValue', { value });
  return <>
    {gpus?.length ? <section className="polaris-card overflow-hidden" aria-label={t('sectionGpus')}>
      <h3 className="flex items-center gap-2.5 px-4 py-3 text-small font-semibold">
        <IconTile icon={<Cpu />} hue="default" size="sm" />{t('sectionGpus')}
      </h3>
      <div className="polaris-divide border-t border-[var(--polaris-line-soft)]">
        {gpus.map(gpu => <div key={gpu.index} className="space-y-3 px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <p className="min-w-0 break-words text-small font-medium [overflow-wrap:anywhere]">{gpu.name}</p>
            <span className="min-w-0 break-words text-tiny text-default-500 [overflow-wrap:anywhere]">{t('gpuIndex', { index: gpu.index })}{gpu.vendor ? ` · ${gpu.vendor}` : ''}</span>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between gap-3 text-tiny">
              <span className="text-default-500">{t('gpuUtilization')}</span>
              <span className="font-medium tabular-nums">{formatPercent(gpu.util_pct)}</span>
            </div>
            {gpu.util_pct != null ? <Meter value={gpu.util_pct} label={t('gpuUtilizationFor', { name: gpu.name })} /> : null}
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            <div className="col-span-2 sm:col-span-1"><dt className="text-tiny text-default-500">{t('gpuMemory')}</dt><dd className="mt-0.5 text-small tabular-nums">{formatBytes(gpu.mem_used_bytes)} / {formatBytes(gpu.mem_total_bytes)}</dd></div>
            <div><dt className="text-tiny text-default-500">{t('hardwareTemperature')}</dt><dd className={`mt-0.5 text-small tabular-nums ${(gpu.temp_c ?? -100) >= 85 ? 'text-warning-700 dark:text-warning-400' : ''}`}>{temperature(gpu.temp_c)}</dd></div>
            <div><dt className="text-tiny text-default-500">{t('gpuPower')}</dt><dd className="mt-0.5 text-small tabular-nums">{gpu.power_w == null ? '—' : t('hardwarePowerValue', { value: gpu.power_w })}</dd></div>
          </dl>
        </div>)}
      </div>
    </section> : null}
    {sensors?.length ? <section className="polaris-card overflow-hidden" aria-label={t('sectionSensors')}>
      <h3 className="flex items-center gap-2.5 px-4 py-3 text-small font-semibold">
        <IconTile icon={<Thermometer />} hue="default" size="sm" />{t('sectionSensors')}
      </h3>
      <dl className="polaris-divide border-t border-[var(--polaris-line-soft)]">
        {sensors.map((sensor, index) => <div key={`${sensor.name}-${index}`} className="flex items-center justify-between gap-4 px-4 py-2.5">
          <dt className="min-w-0 break-words text-small [overflow-wrap:anywhere]">{sensor.name}</dt>
          <dd className={`flex shrink-0 items-center gap-1.5 text-small font-medium tabular-nums ${sensor.temp_c >= 85 ? 'text-warning-700 dark:text-warning-400' : ''}`}>
            {sensor.temp_c >= 85 ? <><AlertTriangle size={14} aria-hidden="true" /><span className="sr-only">{t('hardwareHighTemperature')}</span></> : null}{temperature(sensor.temp_c)}
          </dd>
        </div>)}
      </dl>
    </section> : null}
  </>;
}
