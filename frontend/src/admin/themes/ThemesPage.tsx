import { useMotionList } from '@/lib/useMotionList';
import { useBackendCapabilities } from '@/api/backend';
import { Modal } from '@/components/ui/MotionOverlays';
import { UnauthorizedError } from '@/api/errors';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { Button, Input, ModalBody, ModalContent, ModalFooter, ModalHeader, Skeleton } from '@heroui/react';
import clsx from 'clsx';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Eye,
  FileArchive,
  Layers,
  Loader2,
  Package,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from '@/components/ui/toast';
import { useTranslations } from 'use-intl';
import { EmptyState } from '../components/ConsolePrimitives';
import { SwatchArt } from '../components/illustrations';
import { Panel, PanelHeader } from '../components/Panel';
import { AdminPage } from '../layout/AdminPage';
import { themesApi } from './api';
import { ThemePreviewFrame } from './ThemePreviewFrame';
import { PageThemes } from './PageThemes';
import { mutate } from 'swr';
import {
  PRESENTATION_KEY,
  updatePresentation,
  usePresentation,
} from '../settings/presentation-api';
import type { PageKind, PageTheme } from '../../../../shared/presentation';
import type { InstalledTheme, ThemePreview } from './types';

/** 管理已安装主题及其安装、预览和版本操作。 / Manage installed themes, installation, previews, and versions. */
export function ThemesPage() {
  const backend = useBackendCapabilities();
  const versions = useMotionList<HTMLUListElement>();
  const t = useTranslations('admin.themes');
  const apiErrorMessage = useApiErrorMessage();
  const navigate = useNavigate();
  const [themes, setThemes] = useState<InstalledTheme[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [checkingStorage, setCheckingStorage] = useState(false);
  const loadRequest = useRef(0);
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<ThemePreview | null>(null);
  const previewRequest = useRef(0);
  const [previewBusy, setPreviewBusy] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<InstalledTheme | null>(
    null,
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const removing = useRef(false);
  const presentation = usePresentation();
  const p = useTranslations('admin.presentation');
  const r2Unavailable = backend.data?.runtime === 'worker' &&
    (backend.data.themes.installationAvailable === false || (themes !== null && !storageReady));

  async function applyTheme(kind: PageKind, selection: PageTheme | null) {
    if (busy !== null || checkingStorage || (selection && (!storageReady || r2Unavailable))) return;
    setBusy(
      selection
        ? 'apply:' +
            selection.short +
            ':' +
            selection.version +
            ':' +
            selection.theme
        : 'reset:' + kind,
    );
    try {
      await updatePresentation((config) => ({
        ...config,
        pages: {
          ...config.pages,
          [kind]: { theme: selection, themeOptions: {} },
        },
      }));
      toast.success(
        t(selection ? 'appliedToast' : 'restoredToast', { page: p(kind) }),
      );
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const login = useCallback(
    () =>
      navigate('/login', { replace: true, state: { from: '/admin/themes' } }),
    [navigate],
  );
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    try {
      const result = await themesApi.list();
      if (request !== loadRequest.current) return;
      setThemes(result.themes);
      setStorageReady(result.storageReady);
      setLoadError(null);
    } catch (error) {
      if (request !== loadRequest.current) return;
      if (error instanceof UnauthorizedError) login();
      else setLoadError(apiErrorMessage(error));
    }
  }, [apiErrorMessage, login]);

  useEffect(() => {
    void load();
    return () => { loadRequest.current++; };
  }, [load]);

  async function checkStorage() {
    if (checkingStorage || busy !== null) return;
    setCheckingStorage(true);
    try {
      const [capabilities] = await Promise.allSettled([backend.mutate(), load()]);
      if (capabilities.status === 'rejected') setLoadError(apiErrorMessage(capabilities.reason));
    } finally {
      setCheckingStorage(false);
    }
  }

  const install = async (action: () => Promise<unknown>) => {
    if (!storageReady || r2Unavailable || checkingStorage) return;
    setBusy('install');
    try {
      await action();
      setUrl('');
      setFile(null);
      await load();
      toast.success(t('installDone'));
    } catch (error) {
      if (error instanceof UnauthorizedError) login();
      else toast.error(apiErrorMessage(error), { duration: 8000 });
    } finally {
      setBusy(null);
    }
  };

  const updateTheme = async (theme: InstalledTheme) => {
    if (!storageReady || r2Unavailable || checkingStorage) return;
    setBusy(`update:${theme.short}`);
    try {
      const result = await themesApi.updateCheck(theme.short);
      if (!result.available) {
        toast.info(t('noUpdate'));
        return;
      }
      await themesApi.install(theme.sourceUrl!);
      await load();
      toast.success(t('updateInstalled'));
    } catch (error) {
      if (error instanceof UnauthorizedError) login();
      else toast.error(apiErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  async function openPreview(short: string, versionKey: string, theme: string) {
    if (!storageReady || r2Unavailable || checkingStorage) return;
    const request = ++previewRequest.current;
    setPreviewBusy(`${short}:${versionKey}:${theme}`);
    try {
      const result = await themesApi.preview(short, versionKey, theme);
      if (request === previewRequest.current) setPreview(result);
    } catch (error) {
      if (request !== previewRequest.current) return;
      if (error instanceof UnauthorizedError) login();
      else toast.error(apiErrorMessage(error));
    } finally {
      if (request === previewRequest.current) setPreviewBusy(null);
    }
  }

  async function deleteTheme() {
    if (!pendingDelete || busy !== null || removing.current) return;
    removing.current = true;
    setBusy(`delete:${pendingDelete.short}`);
    setDeleteError(null);
    try {
      await themesApi.remove(pendingDelete.short);
      await mutate(PRESENTATION_KEY);
      setThemes(
        (current) =>
          current?.filter((theme) => theme.short !== pendingDelete.short) ??
          null,
      );
      setPendingDelete(null);
      previewRequest.current++;
      setPreviewBusy(null);
      setPreview(null);
      await load();
      toast.success(t('deleted'));
    } catch (error) {
      if (error instanceof UnauthorizedError) login();
      else {
        setDeleteError(apiErrorMessage(error));
        await load();
      }
    } finally {
      removing.current = false;
      setBusy(null);
    }
  }

  return (
    <AdminPage
      title={t('title')}
      description={t('subtitle')}
      actions={
        <Button
          size="sm"
          variant="flat"
          startContent={<RefreshCw size={15} />}
          isLoading={checkingStorage}
          isDisabled={busy !== null}
          onPress={() => void checkStorage()}
        >
          {t(r2Unavailable ? 'checkStorage' : 'refresh')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {loadError ? (
          <Panel>
            <p role="alert" className="text-small text-danger">
              {loadError}
            </p>
          </Panel>
        ) : null}
        {r2Unavailable ? (
          <Panel>
            <PanelHeader icon={<Package />} title={t('storageUnavailableTitle')} />
            <p role="status" className="max-w-2xl text-small leading-relaxed text-[var(--polaris-ink-3)]">
              {t('storageUnavailable')}
            </p>
          </Panel>
        ) : !storageReady && themes !== null && backend.data?.themes.storage === 'filesystem' ? (
          <div role="status" className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-small text-warning-700">
            {t('storageUnavailableFilesystem')}
          </div>
        ) : null}
        {themes ? (
          <PageThemes
            themes={r2Unavailable ? [] : themes}
            busy={busy !== null || checkingStorage}
            onReset={(kind) => void applyTheme(kind, null)}
            onPreview={(short, version, theme) =>
              void openPreview(short, version, theme)
            }
          />
        ) : null}
        {!r2Unavailable ? <Panel>
          <PanelHeader
            icon={<Package />}
            hue="pink"
            title={t('installTitle')}
            description={t('installHint')}
          />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
              <Input
                size="sm"
                type="url"
                value={url}
                onValueChange={setUrl}
                placeholder="https://example.com/theme.zip"
                aria-label={t('urlLabel')}
                isDisabled={!storageReady || busy !== null || checkingStorage}
                classNames={{
                  base: 'min-w-0 flex-1',
                  mainWrapper: 'h-full',
                  inputWrapper: 'h-full min-h-14',
                  input: 'text-tiny',
                }}
                startContent={
                  <ArrowDownToLine
                    className="shrink-0 text-default-400"
                    size={15}
                  />
                }
              />
              <Button
                size="sm"
                color="primary"
                className="h-auto min-h-14 shrink-0"
                startContent={
                  busy === 'install' ? (
                    <Loader2 className="animate-spin" size={15} />
                  ) : (
                    <ArrowDownToLine size={15} />
                  )
                }
                isDisabled={!storageReady || !url.trim() || busy !== null || checkingStorage}
                onPress={() =>
                  void install(() => themesApi.install(url.trim()))
                }
              >
                {t('installUrl')}
              </Button>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
              <ZipDropZone
                file={file}
                disabled={!storageReady || busy !== null || checkingStorage}
                onFile={setFile}
              />
              <Button
                size="sm"
                variant="flat"
                className="h-auto min-h-14 shrink-0"
                startContent={<ArrowUpFromLine size={15} />}
                isDisabled={!storageReady || !file || busy !== null || checkingStorage}
                onPress={() =>
                  file && void install(() => themesApi.upload(file))
                }
              >
                {t('uploadZip')}
              </Button>
            </div>
          </div>
        </Panel> : null}

        {!r2Unavailable || (themes?.length ?? 0) > 0 ? <Panel padded={false}>
          <div className="p-4 pb-0 sm:p-5 sm:pb-0">
            <PanelHeader
              icon={<Layers />}
              hue="pink"
              title={t('installedTitle')}
              description={t('installedHint')}
            />
          </div>
          {themes === null && loadError ? null : themes === null ? (
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-20 rounded-xl" />
            </div>
          ) : themes.length === 0 ? (
            <EmptyState
              art={<SwatchArt />}
              title={t('empty')}
              hint={t('installHint')}
              className="py-10"
            />
          ) : (
            <ul ref={versions} className="polaris-divide border-t border-[var(--polaris-line)]">
              {themes.map((theme) => <ThemeCard key={theme.id} theme={theme} storageReady={storageReady && !r2Unavailable} presentation={presentation.data} busy={busy ?? (checkingStorage ? 'refresh' : null)} previewBusy={previewBusy} openPreview={openPreview} applyTheme={applyTheme} updateTheme={updateTheme} onDelete={(theme) => { setDeleteError(null); setPendingDelete(theme); }} />)}
            </ul>
          )}
        </Panel> : null}
      </div>
      {preview ? (
        <ThemePreviewFrame preview={preview} onClose={() => { previewRequest.current++; setPreviewBusy(null); setPreview(null); }} />
      ) : null}
      <Modal
        isOpen={pendingDelete !== null}
        onClose={() => {
          if (!removing.current) setPendingDelete(null);
        }}
        isDismissable={busy === null}
        isKeyboardDismissDisabled={busy !== null}
        hideCloseButton={busy !== null}
        size="md"
        scrollBehavior="inside"
      >
        <ModalContent>
          <ModalHeader className="break-words">
            {t('deleteTitle', { name: pendingDelete?.name ?? '' })}
          </ModalHeader>
          <ModalBody>
            <p className="text-small text-default-600">
              {t('deleteDescription')}
            </p>
            <p className="text-small text-warning-700">
              {t('deletePageReferences')}
            </p>
            {deleteError ? (
              <p role="alert" className="text-small text-danger">
                {deleteError}
              </p>
            ) : null}
          </ModalBody>
          <ModalFooter>
            <Button
              variant="flat"
              autoFocus
              isDisabled={busy !== null}
              onPress={() => setPendingDelete(null)}
            >
              {t('cancel')}
            </Button>
            <Button
              color="danger"
              isDisabled={busy !== null}
              isLoading={busy === `delete:${pendingDelete?.short}`}
              onPress={() => void deleteTheme()}
            >
              {t('delete')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </AdminPage>
  );
}

/** A dropped file is usable only as a single ZIP package. / 拖入的文件仅接受单个 ZIP 包。 */
function isZipFile(file: File) {
  const type = file.type.toLowerCase();
  return /\.zip$/i.test(file.name) && (!type || type.includes('zip'));
}

/**
 * ZIP picker that also accepts a drag and drop.
 *
 * A browser never forwards a drop on a `<label>` to the file input inside it, so
 * the zone handles the drag itself and feeds the same `file` state as the picker.
 * The inner input stays for click-to-pick and keyboard access.
 *
 * 浏览器不会把拖到 label 上的文件转交给内部文件输入框，因此由区域接收拖放，
 * 并与点击选择共用同一份文件状态；内部输入框继续负责点击和键盘操作。
 */
function ZipDropZone({ file, disabled, onFile }: {
  file: File | null;
  disabled: boolean;
  onFile: (file: File | null) => void;
}) {
  const t = useTranslations('admin.themes');
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState(false);
  const active = dragging && !disabled;

  return (
    <label
      aria-disabled={disabled}
      onDragEnter={(event) => {
        event.preventDefault();
        if (disabled) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
      }}
      onDragLeave={() => {
        if (disabled) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (disabled) return;
        const files = event.dataTransfer.files;
        if (files.length !== 1 || !isZipFile(files[0])) {
          setRejected(true);
          return;
        }
        setRejected(false);
        onFile(files[0]);
      }}
      className={clsx(
        'flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-xl border border-dashed px-3.5 py-2.5 transition-colors',
        disabled
          ? 'cursor-not-allowed border-[var(--polaris-line-strong)] bg-[var(--polaris-well)] opacity-60'
          : active
            ? 'cursor-copy border-primary bg-primary/[0.06] ring-2 ring-primary/20'
            : rejected
              ? 'cursor-pointer border-danger/50 bg-[var(--polaris-well)] hover:border-primary/50 hover:bg-primary/[0.04]'
              : 'cursor-pointer border-[var(--polaris-line-strong)] bg-[var(--polaris-well)] hover:border-primary/50 hover:bg-primary/[0.04]',
      )}
    >
      <FileArchive size={18} className="shrink-0 text-default-400" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-tiny font-medium">
          {file ? file.name : t('dropHint')}
        </span>
        {rejected ? (
          <span role="alert" className="block text-[11px] text-danger">
            {t('dropInvalid')}
          </span>
        ) : (
          <span className="block text-[11px] text-default-400">
            application/zip
          </span>
        )}
      </span>
      <input
        type="file"
        accept=".zip,application/zip"
        aria-label={t('uploadLabel')}
        disabled={disabled}
        onChange={(event) => {
          setRejected(false);
          onFile(event.currentTarget.files?.[0] ?? null);
        }}
        className="sr-only"
      />
    </label>
  );
}

/**
 * A small stand-in for a theme's look.
 *
 * Themes ship no screenshot, so the card gets a miniature status page tinted by
 * a hue derived from the theme's short name - stable for a theme, different
 * between themes, and plainly a placeholder rather than a claim about the
 * theme's actual design.
 *
 * 主题不附带截图，因此用主题 short 名称推导稳定色调，绘制微型状态页作为占位图；
 * 同一主题保持一致，不同主题有所区别，并明确不代表主题的实际设计。
 */
function ThemeThumb({ seed }: { seed: string }) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++)
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return (
    <div
      aria-hidden="true"
      className="flex h-16 w-24 shrink-0 flex-col gap-1.5 overflow-hidden rounded-lg p-2 ring-1 ring-[var(--polaris-line)]"
      style={{
        background: `linear-gradient(160deg, hsl(${hue} 40% 97%), hsl(${(hue + 40) % 360} 35% 92%))`,
      }}
    >
      <span
        className="h-1.5 w-10 rounded-full"
        style={{ background: `hsl(${hue} 45% 42%)` }}
      />
      {[0, 1, 2].map((row) => (
        <span key={row} className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span className="h-1 flex-1 rounded-full bg-white/80" />
        </span>
      ))}
    </div>
  );
}

function ThemeCard({ theme, storageReady, presentation, busy, previewBusy, openPreview, applyTheme, updateTheme, onDelete }: {
  theme: InstalledTheme;
  storageReady: boolean;
  presentation: ReturnType<typeof usePresentation>['data'];
  busy: string | null;
  previewBusy: string | null;
  openPreview: (short: string, version: string, definition: string) => Promise<void>;
  applyTheme: (kind: PageKind, selection: PageTheme | null) => Promise<void>;
  updateTheme: (theme: InstalledTheme) => Promise<void>;
  onDelete: (theme: InstalledTheme) => void;
}) {
  const t = useTranslations('admin.themes');
  return (
    <li
      key={theme.id}
      className="flex flex-wrap items-center gap-4 p-4 sm:p-5"
    >
      <ThemeThumb seed={theme.short} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-small font-semibold">
            {theme.name}
          </span>
        </div>
        <p className="mt-1 break-all font-mono text-[11.5px] text-default-400">
          {theme.short} · {theme.version}
          {theme.author ? ` · ${theme.author}` : ''}
        </p>
        {!theme.supported ? (
          <p className="mt-1 text-tiny text-warning-700">
            {t('unsupported')}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {theme.versions.flatMap((version) => version.themes.map((definition) => <VersionRow key={`${version.versionKey}:${definition.id}`} theme={theme} version={version} definition={definition} storageReady={storageReady} presentation={presentation} busy={busy} previewBusy={previewBusy} openPreview={openPreview} applyTheme={applyTheme} />))}

        {theme.sourceUrl ? (
          <Button
            size="sm"
            variant="flat"
            isDisabled={!storageReady || busy !== null}
            isLoading={busy === `update:${theme.short}`}
            onPress={() => void updateTheme(theme)}
          >
            {t('checkUpdate')}
          </Button>
        ) : null}
        <Button
          size="sm"
          color="danger"
          variant="light"
          startContent={<Trash2 size={14} />}
          aria-label={t('deleteTitle', { name: theme.name })}
          isDisabled={busy !== null}
          onPress={() => {
            onDelete(theme);
          }}
        >
          {t('delete')}
        </Button>
      </div>
    </li>
  );
}

function VersionRow({ theme, version, definition, storageReady, presentation, busy, previewBusy, openPreview, applyTheme }: {
  theme: InstalledTheme;
  version: InstalledTheme['versions'][number];
  definition: InstalledTheme['versions'][number]['themes'][number];
  storageReady: boolean;
  presentation: ReturnType<typeof usePresentation>['data'];
  busy: string | null;
  previewBusy: string | null;
  openPreview: (short: string, version: string, definition: string) => Promise<void>;
  applyTheme: (kind: PageKind, selection: PageTheme | null) => Promise<void>;
}) {
  const t = useTranslations('admin.themes');
  const p = useTranslations('admin.presentation');

  const active = presentation?.config.pages[definition.target].theme;
  const selected =
    active?.short === theme.short &&
    active.version === version.versionKey &&
    active.theme === definition.id;
  const canApply =
    definition.target === 'monitor' ||
    presentation?.config.agentEnabled;
  return (
    <div
      key={`${version.versionKey}:${definition.id}`}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--polaris-line)] bg-[var(--polaris-well)] px-3 py-2"
    >
      <span
        className="max-w-64 break-words text-small"
        title={version.versionKey}
      >
        {definition.name} · {version.version} ·{' '}
        {p(definition.target)}
      </span>
      <Button
        size="sm"
        isIconOnly
        variant="light"
        aria-label={t('previewVersion')}
        isDisabled={
          busy !== null || !storageReady || !definition.available
        }
        isLoading={
          previewBusy ===
          `${theme.short}:${version.versionKey}:${definition.id}`
        }
        onPress={() =>
          void openPreview(
            theme.short,
            version.versionKey,
            definition.id,
          )
        }
      >
        <Eye size={14} />
      </Button>
      {canApply ? (
        <Button
          size="sm"
          variant="flat"
          color="primary"
          isDisabled={
            busy !== null ||
            !storageReady ||
            !definition.available ||
            !presentation ||
            selected
          }
          isLoading={
            busy ===
            `apply:${theme.short}:${version.versionKey}:${definition.id}`
          }
          onPress={() =>
            void applyTheme(definition.target, {
              short: theme.short,
              version: version.versionKey,
              theme: definition.id,
            })
          }
        >
          {selected ? (
            <>
              <Check size={14} />
              {t('applied')}
            </>
          ) : (
            t('apply')
          )}
        </Button>
      ) : null}
    </div>
  );
}
