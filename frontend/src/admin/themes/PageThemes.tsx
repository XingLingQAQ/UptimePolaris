import { Drawer, Select } from '@/components/ui/MotionOverlays';
import { useEffect, useState } from 'react';
import {
  Button,
  DrawerBody,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  Input,
  SelectItem,
  Skeleton,
  Switch,
  Textarea,
} from '@heroui/react';
import { Eye, Monitor, RotateCcw, Server, Settings2 } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { ApiError } from '@/api/errors';
import { HEAD_CODE_MAX_BYTES, CONTENT_HTML_MAX_BYTES, utf8Length } from '../../../../shared/presentation';
import type {
  PageKind,
  PageSettings,
  PageTheme,
} from '../../../../shared/presentation';
import {
  usePresentation,
  updatePresentation,
} from '../settings/presentation-api';
import { useFleet, useOverview } from '../useConsoleData';
import { Panel, PanelHeader } from '../components/Panel';
import type { InstalledTheme, ThemeDefinition, ThemeOption } from './types';

function sameTheme(a: PageTheme | null, b: PageTheme | null) {
  return (
    a?.short === b?.short && a?.version === b?.version && a?.theme === b?.theme
  );
}

// 页面选版、启用状态与选项分别保存；冲突更新由展示配置接口处理。
// Save theme selection, enabled state, and options separately through the presentation configuration API.
export function PageThemes({
  themes,
  busy,
  onReset,
  onPreview,
}: {
  themes: InstalledTheme[];
  busy: boolean;
  onReset: (kind: PageKind) => void;
  onPreview: (short: string, version: string, theme: string) => void;
}) {
  const t = useTranslations('admin.themes'),
    p = useTranslations('admin.presentation'),
    message = useApiErrorMessage();
  const data = usePresentation();
  const [editing, setEditing] = useState<{
    kind: PageKind;
    page: PageSettings;
    definition: ThemeDefinition;
  } | null>(null);
  if (data.error)
    return (
      <Panel>
        <p role="alert" className="text-small text-danger">
          {message(data.error)}
        </p>
        <Button size="sm" variant="light" onPress={() => void data.mutate()}>
          {p('retry')}
        </Button>
      </Panel>
    );
  if (!data.data) return <Skeleton className="h-44 rounded-xl" />;
  const kinds: PageKind[] = data.data.config.agentEnabled
    ? ['monitor', 'agent']
    : ['monitor'];
  return (
    <>
      <div
        className={
          'grid grid-cols-1 gap-4 ' +
          (kinds.length === 2 ? 'lg:grid-cols-2' : '')
        }
      >
        {kinds.map((kind) => {
          const page = data.data!.config.pages[kind];
          const theme = themes.find(
            (theme) => theme.short === page.theme?.short,
          );
          const version = theme?.versions.find(
            (version) => version.versionKey === page.theme?.version,
          );
          const definition = version?.themes.find(
            (definition) =>
              definition.id === page.theme?.theme && definition.target === kind,
          );
          const Icon = kind === 'monitor' ? Monitor : Server;
          return (
            <Panel key={kind}>
              <PanelHeader
                icon={<Icon />}
                title={t(kind === 'monitor' ? 'monitorBoard' : 'serverBoard')}
              />
              <div className="flex min-h-20 flex-col justify-center gap-1">
                <h3 className="break-words text-lg font-semibold text-[var(--polaris-ink)]">
                  {page.theme
                    ? (theme?.name ?? page.theme.short)
                    : p('builtIn')}
                </h3>
                <p className="break-words text-small text-default-500">
                  {page.theme
                    ? [
                        definition?.name ?? page.theme.theme,
                        version?.version ?? page.theme.version,
                      ].join(' · ')
                    : t('builtInHint')}
                </p>
                {page.theme && !definition?.available ? (
                  <p role="status" className="text-small text-warning-700">
                    {t('unsupported')}
                  </p>
                ) : null}
              </div>
              <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--polaris-line-soft)] pt-4">
                {page.theme ? (
                  <Button
                    size="sm"
                    variant="flat"
                    startContent={<Eye size={14} />}
                    isDisabled={busy || !definition?.available}
                    onPress={() =>
                      onPreview(
                        page.theme!.short,
                        page.theme!.version,
                        page.theme!.theme,
                      )
                    }
                  >
                    {t('previewPage')}
                  </Button>
                ) : (
                  <Button
                    as="a"
                    size="sm"
                    variant="flat"
                    href={'/?preview=' + kind}
                    target="_blank"
                    rel="noopener noreferrer"
                    startContent={<Eye size={14} />}
                  >
                    {t('previewPage')}
                  </Button>
                )}
                {definition?.available ? (
                  <Button
                    size="sm"
                    variant="flat"
                    startContent={<Settings2 size={14} />}
                    isDisabled={busy}
                    onPress={() => setEditing({ kind, page, definition })}
                  >
                    {t('configure')}
                  </Button>
                ) : null}
                {page.theme ? (
                  <Button
                    size="sm"
                    variant="light"
                    startContent={<RotateCcw size={14} />}
                    isDisabled={busy}
                    onPress={() => onReset(kind)}
                  >
                    {t('restoreBuiltIn')}
                  </Button>
                ) : null}
              </div>
            </Panel>
          );
        })}
      </div>
      {editing ? (
        <ThemeOptionsDrawer {...editing} onClose={() => setEditing(null)} />
      ) : null}
    </>
  );
}

function ThemeOptionsDrawer({
  kind,
  page,
  definition,
  onClose,
}: {
  kind: PageKind;
  page: PageSettings;
  definition: ThemeDefinition;
  onClose: () => void;
}) {
  const t = useTranslations('admin.themes');
  const message = useApiErrorMessage();
  const [values, setValues] = useState(page.themeOptions);
  const [headCode, setHeadCode] = useState(page.headCode ?? '');
  const [contentHtml, setContentHtml] = useState(page.contentHtml ?? '');
  const [saved, setSaved] = useState({ values: page.themeOptions, headCode: page.headCode ?? '', contentHtml: page.contentHtml ?? '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [success, setSuccess] = useState(false);
  const dirty = JSON.stringify(values) !== JSON.stringify(saved.values) || headCode !== saved.headCode || contentHtml !== saved.contentHtml;
  const contentValid = utf8Length(headCode) <= HEAD_CODE_MAX_BYTES && utf8Length(contentHtml) <= CONTENT_HTML_MAX_BYTES;
  const optionsValid = definition.options.every((option) => {
    const value = values[option.key];
    return option.type !== 'number' || value === undefined || (typeof value === 'number' && Number.isFinite(value) && (option.min === undefined || value >= option.min) && (option.max === undefined || value <= option.max));
  });
  async function save() {
    if (saving || !dirty || !contentValid || !optionsValid) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updatePresentation((config) => {
        if (!sameTheme(config.pages[kind].theme, page.theme)) throw new ApiError('presentation_conflict', 409);
        return { ...config, pages: { ...config.pages, [kind]: { ...config.pages[kind], themeOptions: values, headCode, contentHtml } } };
      });
      const next = result.config.pages[kind];
      setSaved({ values: next.themeOptions, headCode: next.headCode ?? '', contentHtml: next.contentHtml ?? '' });
      setSuccess(true);
    } catch (reason) {
      setError(reason);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Drawer isOpen hideCloseButton onClose={onClose} isDismissable={!dirty && !saving} isKeyboardDismissDisabled={dirty || saving} placement="right" size="lg" scrollBehavior="inside">
      <DrawerContent className="bg-[var(--polaris-canvas)]">
        <DrawerHeader className="flex flex-col gap-1 pr-12">
          <span>{t('configure')}</span>
          <span className="text-small font-normal text-default-500">{definition.name}</span>
        </DrawerHeader>
        <DrawerBody className="gap-5 py-5">
          <p className="text-small text-default-500">{t('settingsScope')}</p>
          <fieldset disabled={saving} className="contents"><ThemeOptions
            definition={definition}
            values={values}
            onChange={(key, value) => {
              setValues((current) => {
                const next = { ...current, [key]: value };
                if (value === undefined) delete next[key];
                return next;
              });
              setSuccess(false);
            }}
          /></fieldset>
          {!optionsValid ? <p role="alert" className="text-small text-danger">{t('optionNumberInvalid')}</p> : null}
          <div className="space-y-4 border-t border-[var(--polaris-line-soft)] pt-5">
            <p className="text-small text-warning-700">{t('customCodeWarning')}</p>
            {([
              { key: 'headCode' as const, value: headCode, set: setHeadCode, limit: HEAD_CODE_MAX_BYTES },
              { key: 'contentHtml' as const, value: contentHtml, set: setContentHtml, limit: CONTENT_HTML_MAX_BYTES },
            ]).map(({ key, value, set, limit }) => (
              <div key={key}>
                <Textarea
                  label={t(key === 'headCode' ? 'headCodeLabel' : 'contentHtmlLabel')}
                  description={t(key === 'headCode' ? 'headCodeHelp' : 'contentHtmlHelp')}
                  value={value}
                  minRows={5}
                  isDisabled={saving}
                  isInvalid={utf8Length(value) > limit}
                  onValueChange={(next) => { set(next); setSuccess(false); }}
                />
                <p className="mt-1 text-right text-tiny text-default-500">{utf8Length(value)} / {limit} {t('bytes')}</p>
              </div>
            ))}
          </div>
          {error ? <p role="alert" className="text-small text-danger">{message(error)}</p> : null}
          {success && !dirty ? <p role="status" className="text-small text-success">{t('settingsSaved')}</p> : null}
          {dirty ? <p role="status" className="text-small text-warning-700">{t('settingsUnsaved')}</p> : null}
        </DrawerBody>
        <DrawerFooter>
          <Button variant="light" isDisabled={saving} onPress={onClose}>{dirty ? t('discardSettings') : t('closeSettings')}</Button>
          <Button color="primary" isLoading={saving} isDisabled={!dirty || !contentValid || !optionsValid} onPress={() => void save()}>{t('saveSettings')}</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function ThemeOptions({
  definition,
  values,
  onChange,
}: {
  definition: ThemeDefinition;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const t = useTranslations('admin.presentation'),
    settings = useTranslations('admin.settings'),
    themes = useTranslations('admin.themes'),
    message = useApiErrorMessage();
  const monitors = useOverview(
    definition.options.some((option) => option.type === 'monitor'),
  );
  const agents = useFleet(
    definition.options.some((option) => option.type === 'agent'),
  );
  function render(option: ThemeOption) {
    const value = values[option.key] ?? option.default;
    const props = { label: option.label, description: option.description };
    if (option.type === 'boolean')
      return (
        <Switch
          key={option.key}
          isSelected={value === true}
          onValueChange={(next) => onChange(option.key, next)}
        >
          {option.label}
        </Switch>
      );
    if (['select', 'monitor', 'agent'].includes(option.type)) {
      const items =
        option.type === 'monitor'
          ? (monitors.data?.monitors.filter((item) => Boolean(item.is_public) && Boolean(item.active)).map((item) => ({
              key: item.id,
              label: item.name,
            })) ?? [])
          : option.type === 'agent'
            ? (agents.data?.agents.filter((item) => Boolean(item.is_public) && Boolean(item.active)).map((item) => ({
                key: item.id,
                label: item.name,
              })) ?? [])
            : (option.choices ?? []).map((item) => ({
                key: item,
                label: item,
              }));
      const error =
        option.type === 'monitor'
          ? monitors.error
          : option.type === 'agent'
            ? agents.error
            : null;
      return (
        <div key={option.key}>
          <Select
            {...props}
            selectedKeys={
              typeof value === 'string' &&
              items.some((item) => item.key === value)
                ? [value]
                : []
            }
            isLoading={
              option.type === 'monitor'
                ? monitors.isLoading
                : option.type === 'agent'
                  ? agents.isLoading
                  : false
            }
            isDisabled={!!error}
            onChange={(event) =>
              onChange(option.key, event.target.value || undefined)
            }
          >
            {items.map((item) => (
              <SelectItem key={item.key}>{item.label}</SelectItem>
            ))}
          </Select>
          {(option.type === 'monitor' || option.type === 'agent') && typeof value === 'string' && !error && (option.type === 'monitor' ? !!monitors.data : !!agents.data) && !items.some((item) => item.key === value) ? <p className="mt-1 text-small text-warning-700">{themes('referenceNotPublic')}</p> : null}
          {value !== undefined && value !== null ? <Button size="sm" variant="light" onPress={() => onChange(option.key, undefined)}>{settings('resetToDefault')}</Button> : null}
          {error ? (
            <p role="alert" className="mt-1 text-small text-danger">
              {message(error)}
              <Button
                size="sm"
                variant="light"
                onPress={() =>
                  void (option.type === 'agent'
                    ? agents.mutate()
                    : monitors.mutate())
                }
              >
                {t('retry')}
              </Button>
            </p>
          ) : null}
        </div>
      );
    }
    if (option.type === 'textarea')
      return (
        <Textarea
          key={option.key}
          {...props}
          value={String(value ?? '')}
          maxLength={16000}
          onValueChange={(next) => onChange(option.key, next)}
        />
      );
    if (option.type === 'number')
      return (
        <NumberOption
          key={option.key}
          option={option}
          value={value}
          onChange={(next) => onChange(option.key, next)}
        />
      );
    return (
      <Input
        key={option.key}
        {...props}
        type={option.type === 'color' ? 'color' : 'text'}
        maxLength={option.type === 'string' ? 2048 : undefined}
        value={String(value ?? '')}
        onValueChange={(next) => onChange(option.key, next)}
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">{definition.options.map(render)}</div>
  );
}

function NumberOption({
  option,
  value,
  onChange,
}: {
  option: ThemeOption;
  value: unknown;
  onChange: (value: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(String(value ?? ''));
  useEffect(() => setDraft(String(value ?? '')), [value]);
  return (
    <Input
      type="number"
      label={option.label}
      description={option.description}
      min={option.min}
      max={option.max}
      step={option.step}
      value={draft}
      onValueChange={(next) => {
        setDraft(next);
        if (next === '') onChange(undefined);
        else if (Number.isFinite(Number(next))) onChange(Number(next));
      }}
    />
  );
}
