import { requestJson } from '@/api/client';
import { useBackendCapabilities } from '@/api/backend';
import { ApiError } from '@/api/errors';
import { Button, Checkbox, Input } from '@heroui/react';
import { AlertTriangle, ArrowRight, CheckCircle2, Database } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';

type MigrationPreview = {
  ok: true;
  tables: Array<{ name: string; rows: number }>;
  totalRows: number;
  targetNeedsInitialization: boolean;
};

type MigrationError = 'invalidUrl' | 'previewFailed' | 'executeFailed' | 'resultUnknown' |
  'targetNotEmpty' | 'schemaMismatch' | 'sourceTooLarge' | 'sourceUnavailable' | 'sourceChanged' | 'invalidTarget' | 'unsupportedValue';

function migrationError(error: unknown, operation: 'preview' | 'execute'): MigrationError {
  if (error instanceof ApiError) {
    const codes: Record<string, MigrationError> = {
      target_not_empty: 'targetNotEmpty', schema_mismatch: 'schemaMismatch', source_too_large: 'sourceTooLarge',
      source_unavailable: 'sourceUnavailable', source_changed: 'sourceChanged', invalid_target: 'invalidTarget', unsupported_value: 'unsupportedValue',
    };
    if (Object.hasOwn(codes, error.code)) return codes[error.code];
    if (operation === 'execute' && error.status === 0) return 'resultUnknown';
  } else if (operation === 'execute') return 'resultUnknown';
  return operation === 'preview' ? 'previewFailed' : 'executeFailed';
}

// 执行须经过预览和确认；失败后清除预览，防止直接重试未知结果的复制。
// Require preview and confirmation before execution; clear preview after failure before another copy attempt.
export function DatabaseMigration() {
  const backend = useBackendCapabilities();
  const isGo = backend.data?.runtime === 'go';
  const t = useTranslations('admin.databaseMigration');
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'preview' | 'execute'>('idle');
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<MigrationError | null>(null);
  const busy = phase !== 'idle';

  async function inspect() {
    setPreview(null);
    setConfirmed(false);
    setComplete(false);
    setError(null);
    try {
      const parsed = new URL(url.trim());
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === '/') throw new Error();
    } catch {
      setError('invalidUrl');
      return;
    }
    setPhase('preview');
    try {
      const result = await requestJson<MigrationPreview>('/api/admin/database-migration/preview', {
        method: 'POST', body: JSON.stringify({ url: url.trim() }),
      });
      setPreview(result);
    } catch (cause) {
      setError(migrationError(cause, 'preview'));
    } finally {
      setPhase('idle');
    }
  }

  async function migrate() {
    if (!preview || !confirmed || busy) return;
    setPhase('execute');
    setError(null);
    try {
      const result = await requestJson<MigrationPreview & { copied: true }>('/api/admin/database-migration/execute', {
        method: 'POST', body: JSON.stringify({ url: url.trim(), confirmed: true }),
      });
      setPreview(result);
      setUrl('');
      setConfirmed(false);
      setComplete(true);
    } catch (cause) {
      setError(migrationError(cause, 'execute'));
      setConfirmed(false);
      setPreview(null);
    } finally {
      setPhase('idle');
    }
  }

  return (
    <section className="mt-2 border-t border-[var(--polaris-line-soft)] pt-4" aria-labelledby="database-migration-title">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-default-400"><Database size={16} aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <h3 id="database-migration-title" className="text-small font-semibold">{t('title')}</h3>
          <p className="mt-1 text-tiny leading-relaxed text-default-500">{t(isGo ? 'descriptionGo' : 'description')}</p>
          <p className="mt-1 text-tiny leading-relaxed text-default-500">{t(isGo ? 'scopeGo' : 'scope')}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-4">
        <div className="rounded-medium border border-warning/30 bg-warning/10 px-3 py-3 text-tiny text-foreground">
          <div className="flex items-start gap-2">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
            <div>
              <p>{t('warning')}</p>
              <p className="mt-1">{t('targetExclusive')}</p>
            </div>
          </div>
        </div>

        <Input
          type="password"
          label={t('urlLabel')}
          labelPlacement="outside"
          placeholder="postgresql://user:password@host:5432/database"
          autoComplete="off"
          spellCheck="false"
          value={url}
          isDisabled={busy}
          onValueChange={(value) => {
            setUrl(value);
            setPreview(null);
            setConfirmed(false);
            setComplete(false);
            setError(null);
          }}
          description={t('urlHint')}
        />

        {error ? (
          <p role="alert" className="rounded-medium border border-danger/20 bg-danger/[0.06] px-3 py-2 text-tiny text-danger-600">
            {t(error)}
          </p>
        ) : null}

        {preview ? (
          <div className="polaris-well flex flex-col gap-3 p-3" aria-live="polite">
            <div className="flex items-center gap-2 text-small font-semibold">
              {complete ? <CheckCircle2 size={15} className="text-success" /> : <Database size={15} className="text-default-400" />}
              {complete ? t('complete') : t('previewReady')}
            </div>
            <p className="text-tiny text-default-500">{t('summary', { tables: preview.tables.length, rows: preview.totalRows })}</p>
            {!complete ? <p className="text-tiny text-default-500">{t(preview.targetNeedsInitialization ? 'targetWillInitialize' : 'targetAlreadyInitialized')}</p> : null}
            <details className="text-tiny">
              <summary className="cursor-pointer text-default-600">{t('showTables')}</summary>
              <ul className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                {preview.tables.map((table) => (
                  <li key={table.name} className="flex justify-between gap-4"><span className="break-all font-mono">{table.name}</span><span className="tabular-nums">{table.rows.toLocaleString()}</span></li>
                ))}
              </ul>
            </details>
            {complete ? <p className="text-tiny text-default-500">{t('afterMigration')}</p> : (
              <Checkbox isSelected={confirmed} onValueChange={setConfirmed} isDisabled={busy} size="sm">
                <span className="text-tiny">{t('confirm')}</span>
              </Checkbox>
            )}
          </div>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="flat" isDisabled={busy || !url.trim()} isLoading={phase === 'preview'} onPress={() => void inspect()}>
            {phase === 'preview' ? t('checking') : t('preview')}
          </Button>
          {preview && !complete ? (
            <Button color="primary" size="sm" isDisabled={busy || !confirmed} isLoading={phase === 'execute'} startContent={phase === 'execute' ? null : <ArrowRight size={15} />} onPress={() => void migrate()}>
              {phase === 'execute' ? t('migrating') : t('execute')}
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
