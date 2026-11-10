import { Select } from '@/components/ui/MotionOverlays';
import { Button, Input, SelectItem } from '@heroui/react';
import { Clock, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useMotionList } from '@/lib/useMotionList';
import {
  parseWindow,
  type MaintenanceWindow,
} from '../../../../shared/maintenance-window';

function once(): MaintenanceWindow {
  const start = new Date(Date.now() + 3600000);
  start.setUTCSeconds(0, 0);
  return {
    kind: 'once',
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 3600000).toISOString(),
  };
}
// 无效时间保留在本地草稿，只有完整有效的窗口才向父级提交。
// Retain invalid times in the local draft and publish only fully valid windows.
export function MaintenanceWindowEditor({
  windows,
  onChange,
  onInvalid,
}: {
  windows: MaintenanceWindow[];
  onChange: (value: MaintenanceWindow[]) => void;
  onInvalid: () => void;
}) {
  const t = useTranslations('admin.settings');
  const [draft, setDraft] = useState(windows);
  const rows = useMotionList();
  const rowIds = useRef<string[]>([]);
  rowIds.current.length = Math.min(rowIds.current.length, draft.length);
  while (rowIds.current.length < draft.length) rowIds.current.push(crypto.randomUUID());
  const reported = useRef(JSON.stringify(windows));
  useEffect(() => {
    const value = JSON.stringify(windows);
    if (value !== reported.current) {
      setDraft(windows);
      reported.current = value;
    }
  }, [windows]);
  const invalid = draft.some((window) => !parseWindow(window));
  function change(next: MaintenanceWindow[], ids = rowIds.current) {
    rowIds.current = ids;
    setDraft(next);
    if (next.some((window) => !parseWindow(window))) { reported.current = JSON.stringify(windows); onInvalid(); return; }
    reported.current = JSON.stringify(next);
    onChange(next);
  }
  const update = (index: number, next: MaintenanceWindow) =>
    change(draft.map((window, i) => (i === index ? next : window)));
  return (
    <div className="flex flex-col gap-3">
      <p className="text-small text-default-500">{t('maintenanceHint')}</p>
      {!draft.length ? (
        <p className="flex items-center gap-2 py-2 text-small text-default-500">
          <Clock size={15} />
          {t('noWindows')}
        </p>
      ) : null}
      <div ref={rows} className="flex flex-col gap-3">
        {draft.map((window, index) => (
          <div
            key={rowIds.current[index]}
            className="flex flex-col gap-3 border-b border-[var(--polaris-line-soft)] pb-4 last:border-0"
          >
            <div className="flex items-start gap-2">
              <Select
                size="sm"
                className="max-w-44"
                label={t('maintenanceRepeat')}
                selectedKeys={[window.kind]}
                disallowEmptySelection
                onChange={(event) =>
                  update(
                    index,
                    event.target.value === 'weekly'
                      ? { kind: 'weekly', day: 0, start: '02:00', end: '04:00' }
                      : once(),
                  )
                }
              >
                <SelectItem key="once">{t('maintenanceOnce')}</SelectItem>
                <SelectItem key="weekly">{t('maintenanceWeekly')}</SelectItem>
              </Select>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                color="danger"
                aria-label={t('removeWindow')}
                onPress={() => change(draft.filter((_, i) => i !== index), rowIds.current.filter((_, i) => i !== index))}
              >
                <Trash2 size={15} />
              </Button>
            </div>
            {window.kind === 'weekly' ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Select
                  size="sm"
                  label={t('day')}
                  selectedKeys={[String(window.day)]}
                  disallowEmptySelection
                  onChange={(event) =>
                    update(index, { ...window, day: Number(event.target.value) })
                  }
                >
                  {[0, 1, 2, 3, 4, 5, 6].map((day) => (
                    <SelectItem key={day}>{t(`weekday${day}`)}</SelectItem>
                  ))}
                </Select>
                <Input
                  size="sm"
                  type="time"
                  label={t('startTime')}
                  value={window.start}
                  onValueChange={(start) => update(index, { ...window, start })}
                />
                <Input
                  size="sm"
                  type="time"
                  label={t('endTime')}
                  value={window.end}
                  onValueChange={(end) => update(index, { ...window, end })}
                />
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Input
                  size="sm"
                  type="datetime-local"
                  label={t('startTime')}
                  value={window.startsAt.slice(0, 16)}
                  onValueChange={(startsAt) =>
                    update(index, {
                      ...window,
                      startsAt: startsAt ? startsAt + ':00.000Z' : '',
                    })
                  }
                />
                <Input
                  size="sm"
                  type="datetime-local"
                  label={t('endTime')}
                  value={window.endsAt.slice(0, 16)}
                  onValueChange={(endsAt) =>
                    update(index, {
                      ...window,
                      endsAt: endsAt ? endsAt + ':00.000Z' : '',
                    })
                  }
                />
              </div>
            )}
          </div>
        ))}
      </div>
      {invalid ? (
        <p role="alert" className="text-small text-danger">
          {t('maintenanceWindowInvalid')}
        </p>
      ) : null}
      <div>
        <Button
          size="sm"
          variant="flat"
          startContent={<Plus size={15} />}
          isDisabled={draft.length >= 32}
          onPress={() => change([...draft, once()], [...rowIds.current, crypto.randomUUID()])}
        >
          {t('addWindow')}
        </Button>
      </div>
    </div>
  );
}
