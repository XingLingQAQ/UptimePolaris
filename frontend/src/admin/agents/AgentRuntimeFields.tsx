import { Input, Switch } from '@heroui/react';
import { useTranslations } from 'use-intl';
import { useState } from 'react';
import type { AgentRuntimeConfig } from '../../../../shared/agent-runtime-config';

/** 编辑 Agent 采样、上报间隔和网卡、挂载点过滤条件。 / Edit Agent sampling and reporting intervals and network interface and mount filters. */
export function AgentRuntimeFields({ value, onChange, disabled, autoUpdateSupported }: {
  value: AgentRuntimeConfig; onChange: (next: AgentRuntimeConfig) => void; disabled: boolean; autoUpdateSupported: boolean;
}) {
  const t = useTranslations('admin.agent');
  // 保留输入中的逗号和空格，提交给父组件时再解析为列表。 / Preserve commas and spaces while editing; parse the list before passing it to the parent.
  const [filters, setFilters] = useState(() => ({ include_nics: value.include_nics.join(', '), exclude_nics: value.exclude_nics.join(', '), include_mounts: value.include_mounts.join(', '), exclude_mounts: value.exclude_mounts.join(', ') }));
  const cadenceInvalid = !Number.isInteger(value.sample_interval_secs) || !Number.isInteger(value.report_interval_secs) || value.sample_interval_secs < 1 || value.sample_interval_secs > value.report_interval_secs || value.report_interval_secs > 1800;
  return <div className="flex flex-col gap-3">
    <div className="grid gap-3 sm:grid-cols-2">
      <Input type="number" name="sample_interval_secs" label={t('sampleInterval')} min={1} max={1800} value={String(value.sample_interval_secs || '')} onValueChange={(input) => onChange({ ...value, sample_interval_secs: Number(input) })} isDisabled={disabled} isInvalid={cadenceInvalid} />
      <Input type="number" name="report_interval_secs" label={t('reportInterval')} min={1} max={1800} value={String(value.report_interval_secs || '')} onValueChange={(input) => onChange({ ...value, report_interval_secs: Number(input) })} isDisabled={disabled} isInvalid={cadenceInvalid} />
      {(['include_nics', 'exclude_nics', 'include_mounts', 'exclude_mounts'] as const).map((key, index) => <Input key={key} name={key} label={t(['includeNics', 'excludeNics', 'includeMounts', 'excludeMounts'][index])} value={filters[key]} onValueChange={(input) => { setFilters((previous) => ({ ...previous, [key]: input })); onChange({ ...value, [key]: input.split(',').map((entry) => entry.trim()).filter(Boolean) }); }} isDisabled={disabled} />)}
    </div>
    {cadenceInvalid ? <p role="alert" className="text-tiny text-danger">{t('cadenceInvalid')}</p> : null}
    <div className="polaris-well px-3.5 py-3"><Switch name="auto_update" isSelected={value.auto_update} onValueChange={(auto_update) => onChange({ ...value, auto_update })} isDisabled={disabled || !autoUpdateSupported}>{t('autoUpdate')}</Switch><p className="mt-1 text-tiny text-default-500">{t(autoUpdateSupported ? 'autoUpdateHint' : 'autoUpdateUnavailable')}</p></div>
  </div>;
}
