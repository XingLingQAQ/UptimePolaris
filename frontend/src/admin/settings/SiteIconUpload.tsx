import { Button } from '@heroui/react';
import { Check, Loader2, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { siteIconApi } from './api';
import type { SiteIconInfo } from './types';

/** Client-side size cap mirrored from the Worker; the server still decides. / 与 Worker 一致的前端大小上限；最终仍由服务端决定。 */
const MAX_BYTES = 256 * 1024;

/** What the file picker offers. The Worker decides from the bytes regardless. / 文件选择器提供的类型；Worker 仍根据文件字节判断。 */
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/vnd.microsoft.icon,.ico';

function formatKb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Upload, preview and remove the stored icon.
 *
 * The upload wins over `site.icon` because `/api/public/icon` checks the stored
 * row first. The preview comes from the response's data URL, not the live
 * endpoint, so it shows exactly what was stored rather than a cached copy.
 * 上传优先于 `site.icon`；预览用返回的 data URL，避免缓存显示旧图。
 */
export function SiteIconUpload() {
  const t = useTranslations('admin.settings');
  const inputRef = useRef<HTMLInputElement>(null);
  const [icon, setIcon] = useState<SiteIconInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void siteIconApi
      .read()
      .then((next) => {
        if (live) setIcon(next);
      })
      // A failed read is "not loaded", not "nothing stored". / 读取失败是“未加载”，不是“未存储”。
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const pick = useCallback(() => inputRef.current?.click(), []);

  const upload = useCallback(
    async (file: File) => {
      setError(null);
      if (file.size > MAX_BYTES) {
        setError(t('siteIconTooLarge', { max: MAX_BYTES / 1024 }));
        return;
      }
      setBusy(true);
      try {
        await siteIconApi.upload(file);
        setIcon(await siteIconApi.read());
      } catch (cause) {
        /** Map upload error codes to actions; different causes get different next steps. / 把上传错误码映射为操作建议；不同原因给不同下一步。 */
        const code = cause instanceof Error ? cause.message : '';
        setError(
          code === 'too_large'
            ? t('siteIconTooLarge', { max: MAX_BYTES / 1024 })
            : code === 'unsupported_type'
              ? t('siteIconUnsupported')
              : t('siteIconFailed'),
        );
      } finally {
        setBusy(false);
        // Cleared so picking the same file twice still fires `change`. / 清空输入，使连续两次选择同一文件时仍触发 `change`。
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [t],
  );

  const remove = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await siteIconApi.remove();
      setIcon({ uploaded: false });
    } catch {
      setError(t('siteIconFailed'));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const uploaded = icon?.uploaded === true ? icon : null;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-3">
        {/*
          The frame keeps its size whether or not an image is loaded, so the row
          does not jump once the preview resolves.

          不论图片是否加载，容器保持相同大小，避免预览出现时该行跳动。
        */}
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-medium border border-[var(--polaris-line-soft)] bg-default-50">
          {uploaded ? (
            <img src={uploaded.dataUrl} alt="" className="h-full w-full object-contain" />
          ) : (
            <Upload size={16} className="text-default-300" aria-hidden="true" />
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-tiny text-default-600">
            {icon === null
              ? t('siteIconLoading')
              : uploaded
                ? t('siteIconUploaded', {
                    name: uploaded.filename ?? uploaded.contentType,
                    size: formatKb(uploaded.byteSize),
                  })
                : t('siteIconGenerated')}
          </span>
          {error ? <span className="text-tiny text-danger">{error}</span> : null}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <Button
            size="sm"
            variant="flat"
            className="text-tiny"
            isDisabled={busy}
            onPress={pick}
            startContent={busy ? <Loader2 size={13} className="animate-spin" /> : uploaded ? <Check size={13} /> : <Upload size={13} />}
          >
            {uploaded ? t('siteIconReplace') : t('siteIconUpload')}
          </Button>
          {uploaded ? (
            <Button
              isIconOnly
              size="sm"
              variant="light"
              color="danger"
              className="shrink-0"
              aria-label={t('siteIconRemove')}
              isDisabled={busy}
              onPress={() => void remove()}
            >
              <Trash2 size={14} />
            </Button>
          ) : null}
        </div>
      </div>
      <span className="text-tiny leading-snug text-default-500">{t('siteIconUploadHint')}</span>
    </div>
  );
}
