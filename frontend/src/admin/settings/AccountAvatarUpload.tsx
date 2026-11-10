import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { AccountAvatar } from '@/auth/AccountAvatar';
import { accountAvatarApi } from '@/auth/api';
import { useAccountAvatar } from '@/auth/useAccountAvatar';
import { Button } from '@heroui/react';
import { Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

const MAX_SOURCE_MB = 5;
const MAX_SOURCE_BYTES = MAX_SOURCE_MB * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

async function prepareAvatar(file: File): Promise<Blob> {
  if (file.size > MAX_SOURCE_BYTES) throw new Error('avatar_source_too_large');
  if (!IMAGE_TYPES.has(file.type)) throw new Error('avatar_invalid');
  let image: ImageBitmap;
  try { image = await createImageBitmap(file); }
  catch { throw new Error('avatar_invalid'); }
  try {
    if (image.width * image.height > 32_000_000) throw new Error('avatar_dimensions');
    const edge = Math.min(image.width, image.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('avatar_invalid');
    context.drawImage(image, (image.width - edge) / 2, (image.height - edge) / 2, edge, edge, 0, 0, 256, 256);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('avatar_invalid')), 'image/png',
    ));
  } finally {
    image.close();
  }
}

export function AccountAvatarUpload({ username }: { username: string }) {
  const t = useTranslations('admin');
  const messageForError = useApiErrorMessage();
  const { data, error: loadError, isLoading, mutate } = useAccountAvatar();
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const busy = useRef(false);
  const pending = useRef<Blob | null>(null);
  const [operation, setOperation] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function upload(file?: File) {
    if (busy.current) return;
    busy.current = true;
    setOperation('upload');
    setError(null);
    try {
      if (file) {
        pending.current = null;
        pending.current = await prepareAvatar(file);
      }
      if (!mounted.current || !pending.current) return;
      await mutate(await accountAvatarApi.upload(pending.current), { revalidate: false });
      pending.current = null;
    } catch (cause) {
      if (mounted.current) {
        const code = cause instanceof Error ? cause.message : '';
        setError(code === 'avatar_source_too_large' ? t('account.avatarTooLarge', { max: MAX_SOURCE_MB })
          : code === 'avatar_dimensions' ? t('account.avatarDimensions')
          : code === 'avatar_invalid' ? t('account.avatarInvalid') : messageForError(cause));
      }
    } finally {
      busy.current = false;
      if (mounted.current) {
        setOperation(null);
        if (input.current) input.current.value = '';
      }
    }
  }

  async function remove() {
    if (busy.current) return;
    busy.current = true;
    pending.current = null;
    setOperation('remove');
    setError(null);
    try {
      await mutate(await accountAvatarApi.remove(), { revalidate: false });
    } catch (cause) {
      if (mounted.current) setError(messageForError(cause));
    } finally {
      busy.current = false;
      if (mounted.current) setOperation(null);
    }
  }

  const disabled = operation !== null || isLoading || !username;
  return (
    <div className="flex min-w-0 flex-col gap-2" aria-busy={operation !== null}>
      <div className="polaris-well flex flex-wrap items-center gap-3 px-3.5 py-3">
        <button type="button" aria-label={t('account.avatarChange')} disabled={disabled}
          onClick={() => input.current?.click()}
          className="inline-flex shrink-0 rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-wait">
          <AccountAvatar username={username} src={data?.url} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-small font-semibold">{username}</p>
          <p className="text-[11px] text-default-400">{t('console.role')}</p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button size="sm" variant="flat" isDisabled={disabled} isLoading={operation === 'upload'}
            startContent={operation === 'upload' ? undefined : <Upload size={14} />}
            onPress={() => pending.current ? void upload() : input.current?.click()}>
            {operation === 'upload' ? t('account.avatarUploading')
              : pending.current ? t('account.avatarRetry')
              : data?.uploaded ? t('account.avatarChange') : t('account.avatarUpload')}
          </Button>
          {data?.uploaded ? (
            <Button isIconOnly size="sm" variant="light" color="danger" aria-label={t('account.avatarRemove')}
              isDisabled={disabled} isLoading={operation === 'remove'} onPress={() => void remove()}>
              <Trash2 size={14} />
            </Button>
          ) : null}
        </div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
          aria-label={t('account.avatarUpload')}
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
      </div>
      <p role="status" className="text-tiny leading-relaxed text-default-500">
        {isLoading ? t('account.avatarLoading') : t('account.avatarHint', { max: MAX_SOURCE_MB })}
      </p>
      {error || loadError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-tiny text-danger">
          <p>{error ?? t('account.avatarLoadFailed')}</p>
          {loadError ? <Button size="sm" variant="light" onPress={() => void mutate()}>{t('action.retry')}</Button> : null}
        </div>
      ) : null}
    </div>
  );
}
